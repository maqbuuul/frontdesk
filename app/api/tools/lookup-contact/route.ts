import { getCalendar } from '@/lib/calendar';
import { ok, readJson, fail, SAY } from '@/lib/tool-response';

export const runtime = 'nodejs';

/**
 * Called before the greeting, every conversation.
 *
 * It changes the opening line: a returning patient gets "Hi Sarah — calling
 * about Thursday?" rather than "Can I take your name?". It also catches the
 * most common real reason for the call, which is somebody asking about an
 * appointment they already have.
 *
 * It never reads clinical history, even where the provider stores it. The
 * agent has no use for it, and the smallest surface is the right one when
 * health information is involved.
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail('bad_json', SAY.badRequest);

  const phone = String(body.phone ?? '').trim();
  if (!phone) return ok({ found: false });

  try {
    const locationId = String(body.locationId ?? process.env.DEFAULT_LOCATION_ID ?? '');
    const contact = await getCalendar().findContactByPhone(locationId, phone);
    if (!contact) return ok({ found: false });

    return ok({
      found: true,
      contact: {
        id: contact.id,
        firstName: contact.firstName ?? null,
        lastName: contact.lastName ?? null,
        lastAppointmentAt: contact.lastAppointmentAt ?? null,
      },
      upcoming: contact.upcoming ?? [],
    });
  } catch (err) {
    // Not knowing who is calling is survivable -- the agent just greets them
    // as new. Failing the turn over it is not.
    console.error('lookup-contact failed', err);
    return ok({ found: false });
  }
}
