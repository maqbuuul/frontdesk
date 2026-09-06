import type Anthropic from '@anthropic-ai/sdk';
import { runTurn } from '@/lib/agent/run';
import { sql } from '@/lib/db';
import { fail, ok, readJson, SAY } from '@/lib/tool-response';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * One turn of a conversation, on any transport.
 *
 * Voice platforms and WhatsApp both POST here with the caller's text and get a
 * reply back. Keeping the transports this thin is what made it possible to
 * debug the booking logic over WhatsApp — where a three-second pause costs
 * nothing — before putting it on a phone line where it costs everything.
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail('bad_json', SAY.badRequest);

  const callId = String(body.callId ?? '').trim();
  const message = String(body.message ?? '').trim();
  const transport = String(body.transport ?? 'whatsapp') as 'voice' | 'whatsapp' | 'sms';
  const fromPhone = String(body.from ?? '').trim();

  if (!callId || !message) return fail('bad_request', SAY.badRequest);

  const locationId = String(body.locationId ?? process.env.DEFAULT_LOCATION_ID ?? '');
  const origin = new URL(req.url).origin;

  // The transcript is the audit trail. When a booking is disputed weeks later,
  // this plus the recording is the evidence — so the row exists before the
  // model is called, not after it succeeds.
  let history: Anthropic.Beta.BetaMessageParam[] = [];
  try {
    const rows = await sql()`
      INSERT INTO calls (call_id, location_id, transport, from_phone, started_at, transcript)
      VALUES (${callId}, ${locationId}, ${transport}, ${fromPhone || null}, now(), '[]'::jsonb)
      ON CONFLICT (call_id) DO UPDATE SET location_id = EXCLUDED.location_id
      RETURNING transcript`;
    const stored = rows[0]?.transcript;
    if (Array.isArray(stored)) history = stored as Anthropic.Beta.BetaMessageParam[];
  } catch (err) {
    // A conversation that cannot be logged is still a conversation worth
    // having. Losing the transcript is bad; refusing the caller is worse.
    console.error('call row failed', err);
  }

  try {
    const turn = await runTurn({
      baseUrl: origin,
      callId,
      transport,
      fromPhone,
      history,
      userMessage: message,
      openNow: withinBusinessHours(),
    });

    const nextHistory: Anthropic.Beta.BetaMessageParam[] = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: turn.reply },
    ];
    const done = turn.outcome !== 'in_progress';

    await sql()`
      UPDATE calls
         SET transcript = ${JSON.stringify(nextHistory)}::jsonb,
             outcome    = ${done ? turn.outcome : null},
             ended_at   = ${done ? new Date().toISOString() : null}
       WHERE call_id = ${callId}`.catch(() => {});

    return ok({
      reply: turn.reply,
      outcome: turn.outcome,
      appointmentId: turn.appointmentId ?? null,
      toolCalls: turn.toolCalls,
    });
  } catch (err) {
    console.error('agent turn failed', err);
    return fail('agent_failed', SAY.generic, { status: 500, retryable: true });
  }
}

function withinBusinessHours(now = new Date()): boolean {
  const tz = process.env.LOCATION_TIMEZONE ?? 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: 'numeric', weekday: 'short', hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const day = parts.find((p) => p.type === 'weekday')?.value ?? '';
  return !['Sat', 'Sun'].includes(day)
    && hour >= Number(process.env.BUSINESS_OPEN_HOUR ?? 8)
    && hour < Number(process.env.BUSINESS_CLOSE_HOUR ?? 18);
}
