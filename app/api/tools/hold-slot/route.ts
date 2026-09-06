import { randomUUID } from 'node:crypto';
import { verifySlotId } from '@/lib/slots';
import { takeHold } from '@/lib/db';
import { fail, ok, readJson, SAY } from '@/lib/tool-response';

export const runtime = 'nodejs';

/**
 * Called the moment the agent OFFERS a time, before the caller has agreed.
 *
 * Between offering a slot and booking it, thirty to ninety seconds pass while
 * somebody finds their diary. Two callers can be offered the same slot in that
 * window. Without a hold the second booking either fails after the agent has
 * already promised it, or silently double-books.
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail('bad_json', SAY.badRequest);

  const slotId = String(body.slotId ?? '');
  const verdict = verifySlotId(slotId);
  if (!verdict.ok) {
    // A slot id we did not issue. Either a stale offer or a model that
    // invented a time -- both are refusals, not bookings.
    return fail(`slot_${verdict.reason}`, SAY.slotGone);
  }

  const seconds = Number(process.env.SLOT_HOLD_SECONDS ?? 180);
  const holdId = randomUUID();

  try {
    const held = await takeHold({
      holdId,
      slotId,
      locationId: verdict.claims.loc,
      callId: body.callId ? String(body.callId) : undefined,
      startsAt: verdict.claims.st,
      providerId: verdict.claims.pr,
      seconds,
    });

    // The unique index rejected it: somebody else holds this slot right now.
    if (!held) return fail('slot_held_elsewhere', SAY.slotGone, { status: 409 });

    return ok({ holdId: held.hold_id, expiresAt: held.expires_at });
  } catch (err) {
    console.error('hold-slot failed', err);
    return fail('hold_failed', SAY.generic, { status: 500, retryable: true });
  }
}
