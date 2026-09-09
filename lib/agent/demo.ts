import type { AgentTurn } from './run';

/**
 * Zero-token demo agent. Same tool layer, same signed-slot rule, no LLM.
 *
 * Used when ANTHROPIC_API_KEY is unset so the project still books end to
 * end for the job application video:
 *
 *   turn 1: booking intent -> get_availability + hold first slot -> offer 2 times
 *   turn 2: "yes / confirm / book it" -> book_appointment on the live hold
 *   any turn: clinical / emergency / billing keywords -> escalate_to_human
 *
 * Holds are looked up from Postgres (slot_holds) by callId, so no state is
 * carried in the reply text.
 */

const ESCALATION_PATTERNS: { re: RegExp; category: string }[] = [
  { re: /\b(pain|hurt|ache|swollen|swelling|bleed|emergency|tooth|jaw|medication|prescription|allergic)\b/i, category: 'clinical' },
  { re: /\b(cost|price|insurance|coverage|pay|bill|invoice)\b/i, category: 'billing' },
  { re: /\b(complaint|rude|manager|human|person|someone real)\b/i, category: 'complaint' },
];

const AFFIRMATIVE = /\b(yes|yeah|yep|confirm|book( it)?|first( one| time)?|that works|sounds good|ok(ay)?|please do)\b/i;
const BOOKING_INTENT = /\b(book|appointment|visit|see (someone|a doctor)|schedule|available|availability|this week|next week|morning|afternoon)\b/i;

async function postTool(baseUrl: string, path: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, any>;
}

function fmtWhen(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export async function runDemoTurn(opts: {
  baseUrl: string;
  callId: string;
  transport: string;
  fromPhone: string;
  userMessage: string;
  locationId: string;
}): Promise<AgentTurn> {
  const toolCalls: AgentTurn['toolCalls'] = [];
  const tz = process.env.LOCATION_TIMEZONE ?? 'America/New_York';
  const msg = opts.userMessage;

  // 1. Safety first: clinical / billing / complaint always escalates.
  const esc = ESCALATION_PATTERNS.find((p) => p.re.test(msg));
  if (esc) {
    const r = await postTool(opts.baseUrl, '/api/tools/escalate', {
      category: esc.category,
      summary: `Demo-mode escalation (${esc.category}): ${msg.slice(0, 140)}`,
      callerSaid: msg.slice(0, 500),
      callId: opts.callId,
      locationId: opts.locationId,
    });
    toolCalls.push({ name: 'escalate_to_human', ok: r.ok !== false });
    return {
      reply: typeof r.toldCaller === 'string' ? r.toldCaller : 'I have passed that to the team.',
      outcome: 'escalated',
      toolCalls,
    };
  }

  // 2. If there is a live hold for this call and the caller says yes, book it.
  // The hold is the state; the reply text carries nothing secret.
  let liveHold: { hold_id: string } | null = null;
  try {
    const { sql } = await import('@/lib/db');
    const rows = (await sql()`
      SELECT hold_id FROM slot_holds
       WHERE call_id = ${opts.callId}
         AND consumed_at IS NULL AND released_at IS NULL AND expires_at > now()
       ORDER BY expires_at DESC LIMIT 1`) as { hold_id: string }[];
    liveHold = rows[0] ?? null;
  } catch {
    liveHold = null;
  }

  if (liveHold && AFFIRMATIVE.test(msg)) {
    const firstName = 'Demo';
    const phone = opts.fromPhone || '+15551234567';
    const r = await postTool(opts.baseUrl, '/api/tools/book-appointment', {
      holdId: liveHold.hold_id,
      contact: { firstName, phone },
      reason: msg.slice(0, 200),
      callId: opts.callId,
    });
    toolCalls.push({ name: 'book_appointment', ok: r.ok !== false });
    if (r.ok !== false) {
      return {
        reply: `You are booked for ${fmtWhen(String(r.startsAt ?? ''), tz)}. Reply if you need to move it.`,
        outcome: 'booked',
        appointmentId: String(r.appointmentId ?? ''),
        toolCalls,
      };
    }
    // Hold died or booking failed: fall through to re-offer.
  }

  // 3. Booking intent (or anything else that is not an escalation): offer times.
  if (BOOKING_INTENT.test(msg) || !liveHold) {
    const avail = await postTool(opts.baseUrl, '/api/tools/get-availability', {
      locationId: opts.locationId,
    });
    const slots = Array.isArray(avail.slots) ? avail.slots.slice(0, 2) : [];
    toolCalls.push({ name: 'get_availability', ok: avail.ok !== false });
    if (avail.ok === false || slots.length === 0) {
      return {
        reply: 'I could not reach the diary just now. Can I take your number for a callback?',
        outcome: 'in_progress',
        toolCalls,
      };
    }
    const hold = await postTool(opts.baseUrl, '/api/tools/hold-slot', {
      slotId: slots[0].slotId,
      callId: opts.callId,
    });
    toolCalls.push({ name: 'hold_slot', ok: hold.ok !== false });
    const times = slots.map((s: any) => fmtWhen(String(s.startsAt), tz)).join(' or ');
    return {
      reply:
        `I have ${times}. I am holding the first one for a few minutes. ` +
        `Reply YES to book it. (Demo mode: rule-based, no LLM. Same tools and signed slots as the live agent.)`,
      outcome: 'in_progress',
      toolCalls,
    };
  }

  // 4. Live hold exists but caller said something else: repeat the offer.
  return {
    reply: 'I am still holding a time for you. Reply YES to book it, or tell me another day.',
    outcome: 'in_progress',
    toolCalls,
  };
}
