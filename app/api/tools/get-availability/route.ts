import { getCalendar, ProviderError } from '@/lib/calendar';
import { fail, ok, readJson, SAY } from '@/lib/tool-response';

export const runtime = 'nodejs';

const MAX_RANGE_DAYS = 14;

/**
 * The only source of bookable times.
 *
 * Every slot comes back with a signed id. The model quotes the times to the
 * caller and passes the id back -- it never assembles a booking from a
 * datetime somebody said out loud.
 */
export async function POST(req: Request) {
  const body = await readJson(req);
  if (!body) return fail('bad_json', SAY.badRequest);

  const locationId = String(body.locationId ?? process.env.DEFAULT_LOCATION_ID ?? '');
  if (!locationId) return fail('no_location', SAY.generic);

  const from = body.dateFrom ? new Date(String(body.dateFrom)) : new Date();
  let to = body.dateTo ? new Date(String(body.dateTo))
                       : new Date(from.getTime() + 7 * 864e5);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return fail('bad_dates', SAY.badRequest);
  }
  // Cap the window. An agent asking for a year of availability is an agent
  // about to read a hundred options down the phone.
  const cap = new Date(from.getTime() + MAX_RANGE_DAYS * 864e5);
  if (to > cap) to = cap;

  try {
    const availability = await getCalendar().getAvailability({
      locationId,
      serviceType: body.serviceType ? String(body.serviceType) : undefined,
      providerId: body.providerId ? String(body.providerId) : undefined,
      from: from.toISOString(),
      to: to.toISOString(),
    });

    // Trim what the model sees. Six options is a conversation; sixty is a list
    // nobody can hold in their head over the phone.
    return ok({
      slots: availability.slots.slice(0, 6),
      totalAvailable: availability.slots.length,
      timezone: availability.timezone,
      nextAvailable: availability.nextAvailable ?? null,
    });
  } catch (err) {
    const retryable = err instanceof ProviderError ? err.retryable : false;
    console.error('get-availability failed', err);
    return fail('calendar_unavailable', SAY.calendarDown, { status: 502, retryable });
  }
}
