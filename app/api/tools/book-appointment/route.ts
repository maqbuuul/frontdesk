import { getCalendar, ProviderError, SlotTakenError } from '@/lib/calendar';
import { consumeHold, releaseHold, sql } from '@/lib/db';
import { fail, ok, readJson, SAY } from '@/lib/tool-response';

export const runtime = 'nodejs';

/**
 * Spends a hold and creates the appointment.
 *
 * Three guarantees, in order of how badly their absence would hurt:
 *
 *   1. It refuses any hold it did not issue, or that has expired or been
 *      spent. A model cannot talk its way into a booking.
 *
 *   2. It is idempotent on the hold. The transport retries on timeout, and a
 *      retry must not produce a second appointment for the same caller.
 *
 *   3. On a conflict it returns fresh alternatives rather than an error, so
 *      the agent can recover mid-conversation: "that just went, I can do 3:40".
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail('bad_json', SAY.badRequest);

  const holdId = String(body.holdId ?? '');
  const callId = body.callId ? String(body.callId) : undefined;
  const contact = (body.contact ?? {}) as Record<string, string>;
  const firstName = String(contact.firstName ?? '').trim();
  const phone = String(contact.phone ?? '').trim();

  if (!holdId) return fail('no_hold', SAY.slotGone);
  if (!firstName || phone.replace(/\D/g, '').length < 7) {
    return fail('bad_contact',
      "I just need a first name and a number I can reach you on.");
  }

  // If this hold already produced an appointment, return that one. This is the
  // retry path, and it must not book twice.
  try {
    const prior = await sql()`
      SELECT appointment_id, starts_at FROM calls
       WHERE appointment_id IS NOT NULL
         AND call_id = ${callId ?? null}
       LIMIT 1` as { appointment_id: string; starts_at: string }[];
    if (prior[0]?.appointment_id) {
      return ok({
        appointmentId: prior[0].appointment_id,
        startsAt: prior[0].starts_at,
        duplicate: true,
        confirmation: { smsQueued: false },
      });
    }
  } catch {
    // The idempotency lookup is an optimisation, not a gate. If it fails we
    // fall through to the hold check, which is the real guard.
  }

  const held = await consumeHold(holdId, callId);
  if (!held) {
    return fail('hold_invalid', SAY.slotGone, { status: 409 });
  }

  const calendar = getCalendar();
  try {
    const booking = await calendar.createBooking({
      locationId: held.location_id,
      startsAt: new Date(held.starts_at).toISOString(),
      providerId: held.provider_id ?? undefined,
      contact: {
        firstName,
        lastName: contact.lastName?.trim() || undefined,
        phone,
        email: contact.email?.trim() || undefined,
      },
      reason: body.reason ? String(body.reason) : undefined,
      idempotencyKey: holdId,
    });

    if (callId) {
      await sql()`
        UPDATE calls SET outcome = 'booked', appointment_id = ${booking.appointmentId}
         WHERE call_id = ${callId}`.catch(() => {});
    }

    await sql()`
      INSERT INTO appointments (appointment_id, location_id, contact_id, call_id,
                                booked_by, booked_at, starts_at, status)
      VALUES (${booking.appointmentId}, ${held.location_id}, ${phone},
              ${callId ?? null}, 'agent', now(), ${booking.startsAt}, 'booked')
      ON CONFLICT (appointment_id) DO NOTHING`.catch((e) => {
        // The appointment exists in the calendar; failing to mirror it here
        // must not tell the caller their booking failed.
        console.error('appointment mirror failed', e);
      });

    return ok({
      appointmentId: booking.appointmentId,
      startsAt: booking.startsAt,
      confirmation: { smsQueued: Boolean(process.env.N8N_BOOKED_WEBHOOK_URL) },
    });
  } catch (err) {
    // The hold is spent but no appointment exists. Put it back so the slot is
    // not stranded until it expires.
    await releaseHold(holdId).catch(() => {});

    if (err instanceof SlotTakenError) {
      let alternatives: { slotId: string; startsAt: string }[] = [];
      try {
        const from = new Date(held.starts_at);
        const fresh = await calendar.getAvailability({
          locationId: held.location_id,
          from: from.toISOString(),
          to: new Date(from.getTime() + 3 * 864e5).toISOString(),
        });
        alternatives = fresh.slots.slice(0, 3)
          .map((s) => ({ slotId: s.slotId, startsAt: s.startsAt }));
      } catch { /* recovering is best-effort */ }

      // Hand the alternatives back with the refusal. The agent can offer a
      // new time in the same breath instead of going quiet and re-querying.
      return fail('slot_taken', SAY.slotGone, { status: 409, extra: { alternatives } });
    }

    const retryable = err instanceof ProviderError ? err.retryable : false;
    console.error('book-appointment failed', err);
    return fail('booking_failed', SAY.generic, { status: 502, retryable });
  }
}
