import { sql } from '@/lib/db';
import { fail, ok, readJson, SAY } from '@/lib/tool-response';

export const runtime = 'nodejs';

/**
 * The most important tool in the file. An agent that cannot stop is a
 * liability rather than a feature.
 *
 * Two things live here in code rather than in the prompt, deliberately:
 *
 *   - the urgency each category carries
 *   - what the caller is promised
 *
 * Both are commitments the business makes. They depend on staffing and on the
 * hour, and they must not drift with a model upgrade. A prompt that promises
 * "someone will call you within the hour" at 9pm has made a promise nobody can
 * keep.
 */

type Urgency = 'now' | 'today' | 'next_business_day';

const CATEGORIES: Record<string, Urgency> = {
  // hard stops -- see docs/02-escalation-policy.md
  clinical: 'now',
  emergency: 'now',
  billing: 'today',
  complaint: 'today',
  records: 'next_business_day',
  legal: 'next_business_day',
  // soft escalations
  confused: 'today',
  frustrated: 'now',
  out_of_scope: 'today',
  no_availability: 'today',
};

function withinBusinessHours(now = new Date()): boolean {
  const tz = process.env.LOCATION_TIMEZONE ?? 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: 'numeric', weekday: 'short', hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const day = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const open = Number(process.env.BUSINESS_OPEN_HOUR ?? 8);
  const close = Number(process.env.BUSINESS_CLOSE_HOUR ?? 18);
  const weekday = !['Sat', 'Sun'].includes(day);
  return weekday && hour >= open && hour < close;
}

/** What the caller hears. Written by a person, chosen by the hour. */
function promise(urgency: Urgency, openNow: boolean, transferred: boolean): string {
  if (urgency === 'now') {
    if (transferred) return "Let me put you through to someone now.";
    return openNow
      ? "I'm going to get someone to call you straight back — within the hour."
      : "I've flagged this as urgent and passed it to the on-call number now.";
  }
  if (urgency === 'today') {
    return openNow
      ? "I've passed that to the team — someone will come back to you before we close today."
      : "I've taken that down and the team will pick it up first thing tomorrow.";
  }
  return "I've made a note and someone will come back to you on the next working day.";
}

export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail('bad_json', SAY.badRequest);

  const rawCategory = String(body.category ?? '').toLowerCase().replace(/[^a-z_]/g, '');
  // An unrecognised category escalates rather than falling through. Getting
  // this wrong in the safe direction costs one transferred call.
  const category = rawCategory in CATEGORIES ? rawCategory : 'confused';
  const urgency = CATEGORIES[category];

  const summary = String(body.summary ?? '').trim() || '(no summary given)';
  const callerSaid = body.callerSaid ? String(body.callerSaid) : null;
  const callId = body.callId ? String(body.callId) : null;
  const locationId = String(body.locationId ?? process.env.DEFAULT_LOCATION_ID ?? '');

  const openNow = withinBusinessHours();
  const oncall = process.env.ONCALL_PHONE;
  const canTransfer = urgency === 'now' && openNow && Boolean(oncall);
  const action = canTransfer ? 'transferred'
               : urgency === 'now' ? 'message_taken'
               : 'message_taken';

  const toldCaller = promise(urgency, openNow, canTransfer);

  // Record first, notify second. A dropped escalation is the worst outcome in
  // the system and the easiest one not to notice, so the row is written before
  // anything that can fail over the network.
  let escalationId: string | null = null;
  try {
    const rows = await sql()`
      INSERT INTO escalations (call_id, location_id, category, urgency,
                               caller_said, agent_said, action)
      VALUES (${callId}, ${locationId}, ${category}, ${urgency},
              ${callerSaid}, ${toldCaller}, ${action})
      RETURNING escalation_id`;
    escalationId = String(rows[0].escalation_id);

    if (callId) {
      await sql()`UPDATE calls SET outcome = 'escalated' WHERE call_id = ${callId}`
        .catch(() => {});
    }
  } catch (err) {
    console.error('escalation write failed', err);
    // Even here it does not fail the turn -- the caller still gets told a
    // human is coming, and the router webhook below is a second chance.
  }

  const hook = process.env.N8N_ESCALATION_WEBHOOK_URL;
  if (hook) {
    fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ escalationId, callId, category, urgency, summary,
                             callerSaid, action, openNow, toldCaller }),
    }).catch(() => {});
  }

  return ok({ action, urgency, category, toldCaller, escalationId });
}
