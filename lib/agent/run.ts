import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt, type PromptContext } from './prompt';
import { TOOLS, TOOL_ROUTES, TERMINAL_TOOLS } from './tools';

/**
 * The agent loop.
 *
 * A manual loop rather than the SDK tool runner, for one reason: the tools are
 * HTTP endpoints on this same deployment rather than local functions, and the
 * loop needs to short-circuit the moment an escalation fires. That is the
 * "custom transport" case the SDK docs point at.
 *
 * Model configuration is a latency decision, not a capability one:
 *
 *   - effort "low". A receptionist turn is a lookup and a sentence. Thinking
 *     stays ON (adaptive is the default on Opus 5) because disabling it on
 *     this model can leak tool calls into visible text — lowering effort is
 *     the supported way to buy latency back.
 *
 *   - fast mode, opt-in. Up to ~2.5x output tokens/sec at premium pricing,
 *     which is worth it on a live phone call and wasteful over WhatsApp. Off
 *     unless AGENT_FAST_MODE is set.
 *
 *   - max_tokens 1024. Deliberately short: replies are one or two sentences,
 *     and a receptionist that monologues is a worse receptionist.
 */

const MODEL = process.env.AGENT_MODEL ?? 'claude-opus-5';

export type AgentTurn = {
  reply: string;
  outcome: 'in_progress' | 'booked' | 'escalated' | 'message_taken';
  appointmentId?: string;
  toolCalls: { name: string; ok: boolean }[];
};

export type RunOptions = {
  baseUrl: string;
  callId: string;
  transport: 'voice' | 'whatsapp' | 'sms';
  fromPhone: string;
  history: Anthropic.Beta.BetaMessageParam[];
  userMessage: string;
  openNow: boolean;
};

async function callTool(baseUrl: string, name: string, input: unknown, callId: string) {
  const path = TOOL_ROUTES[name];
  if (!path) return { ok: false, error: 'unknown_tool', agentShouldSay: "I can't do that one." };

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(input as object), callId }),
    });
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error(`tool ${name} failed`, err);
    return {
      ok: false,
      error: 'tool_unreachable',
      agentShouldSay: "I can't get to the diary this second. Let me take your number.",
    };
  }
}

export async function runTurn(opts: RunOptions): Promise<AgentTurn> {
  const client = new Anthropic();

  const ctx: PromptContext = {
    practiceName: process.env.PRACTICE_NAME ?? 'the practice',
    timezone: process.env.LOCATION_TIMEZONE ?? 'America/New_York',
    transport: opts.transport,
    openNow: opts.openNow,
    nowIso: new Date().toISOString(),
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...opts.history,
    { role: 'user', content: opts.userMessage },
  ];

  const toolCalls: AgentTurn['toolCalls'] = [];
  let outcome: AgentTurn['outcome'] = 'in_progress';
  let appointmentId: string | undefined;

  const fast = process.env.AGENT_FAST_MODE === 'true';
  const betas = ['server-side-fallback-2026-07-01', ...(fast ? ['fast-mode-2026-02-01'] : [])];

  // A booking is at most: lookup, availability, hold, book. Four tool rounds
  // plus a reply is generous; anything beyond it is a loop, not a conversation.
  for (let round = 0; round < 6; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: 'text', text: systemPrompt(ctx), cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low' },
      tools: TOOLS,
      messages,
      betas,
      fallbacks: 'default',
      ...(fast ? { speed: 'fast' as const } : {}),
    });

    // Safety classifiers can decline. Check before reading content, or you
    // read an empty array and say nothing at all down a live phone line.
    if (response.stop_reason === 'refusal') {
      return {
        reply: "I'm not able to help with that one — let me get a colleague to call you.",
        outcome: 'escalated',
        toolCalls,
      };
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();

    const toolUses = response.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      return { reply: text, outcome, appointmentId, toolCalls };
    }

    messages.push({ role: 'assistant', content: response.content });

    // Parallel calls come back in one message and their results must go back
    // in one message. Splitting them teaches the model to stop batching.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const result = await callTool(opts.baseUrl, use.name, use.input, opts.callId);
      const succeeded = result.ok !== false;
      toolCalls.push({ name: use.name, ok: succeeded });

      if (use.name === 'book_appointment' && succeeded) {
        outcome = 'booked';
        appointmentId = String(result.appointmentId ?? '');
      }
      if (use.name === 'escalate_to_human') outcome = 'escalated';
      if (use.name === 'take_message' && succeeded) outcome = 'message_taken';

      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: JSON.stringify(result),
        ...(succeeded ? {} : { is_error: true }),
      });
    }
    messages.push({ role: 'user', content: results });

    // Once a human owns the conversation, stop. One more model turn here is
    // one more chance to say something after the handoff line.
    const terminal = toolUses.find((u) => TERMINAL_TOOLS.has(u.name));
    if (terminal) {
      const said = results
        .map((r) => { try { return JSON.parse(String(r.content)); } catch { return {}; } })
        .find((r) => r.toldCaller)?.toldCaller as string | undefined;
      if (said) return { reply: said, outcome, appointmentId, toolCalls };
    }
  }

  // Ran out of rounds. Better to hand over than to keep going.
  return {
    reply: "Let me get someone to call you straight back rather than keep you here.",
    outcome: 'escalated',
    toolCalls,
  };
}
