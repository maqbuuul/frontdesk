import { issueSlotId } from '@/lib/slots';
import {
  type Availability, type AvailabilityQuery, type Booking, type BookingRequest,
  type CalendarProvider, type Contact, ProviderError, SlotTakenError,
} from './types';

/**
 * GoHighLevel adapter.
 *
 * ⚠️ WRITTEN AGAINST THE DOCUMENTED API, NOT YET RUN AGAINST A LIVE ACCOUNT.
 *
 * GoHighLevel's trial requires a card, and mine are declined for US SaaS from
 * Kenya. Rather than block the build on that, the calendar sits behind an
 * interface: Cal.com is what runs and what gets demonstrated, and this is the
 * adapter that swaps in when an account exists.
 *
 * What to verify first when one does:
 *
 *   1. The free-slots response shape. GHL has returned both a date-keyed
 *      object (`{ "2026-09-10": { slots: [...] } }`) and a flat array. The
 *      parser accepts both; confirm which you actually get.
 *   2. Timezones. GHL returns times in the sub-account timezone, not UTC.
 *      Assume nothing -- this is the bug that books people at the wrong hour
 *      without ever raising an error.
 *   3. Whether duplicate booking returns 409 or 200-with-error-body. The
 *      conflict path below assumes 409.
 */

const API = 'https://services.leadconnectorhq.com';
const VERSION = '2021-04-15';

function headers() {
  const token = process.env.GHL_API_TOKEN;
  if (!token) throw new ProviderError('GHL_API_TOKEN is not set');
  return {
    Authorization: `Bearer ${token}`,
    Version: VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/** Accepts the date-keyed object and the flat array. See note 1 above. */
export function parseGhlSlots(body: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === 'string') out.push(v); };

  if (Array.isArray(body)) { body.forEach(push); return out; }
  if (!body || typeof body !== 'object') return out;

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === 'traceId' || key === '_dates_') continue;
    if (Array.isArray(value)) value.forEach(push);
    else if (value && typeof value === 'object') {
      const slots = (value as { slots?: unknown }).slots;
      if (Array.isArray(slots)) slots.forEach(push);
    }
  }
  return out;
}

export class GhlProvider implements CalendarProvider {
  readonly name = 'gohighlevel';

  constructor(
    private calendarId = process.env.GHL_CALENDAR_ID ?? '',
    private locationId = process.env.GHL_LOCATION_ID ?? '',
  ) {}

  async getAvailability(q: AvailabilityQuery): Promise<Availability> {
    const url = new URL(`${API}/calendars/${this.calendarId}/free-slots`);
    url.searchParams.set('startDate', String(new Date(q.from).getTime()));
    url.searchParams.set('endDate', String(new Date(q.to).getTime()));
    if (q.providerId) url.searchParams.set('userId', q.providerId);

    const res = await fetch(url, { headers: headers(), cache: 'no-store' });
    if (!res.ok) {
      throw new ProviderError(`ghl free-slots ${res.status}`, res.status, res.status >= 500);
    }

    const starts = parseGhlSlots(await res.json());
    const durationMin = Number(process.env.APPOINTMENT_MINUTES ?? 60);

    const slots = starts.map((s) => {
      const startsAt = new Date(s).toISOString();
      const endsAt = new Date(new Date(s).getTime() + durationMin * 60_000).toISOString();
      return {
        slotId: issueSlotId({ loc: q.locationId, st: startsAt, et: endsAt, pr: q.providerId }),
        startsAt,
        endsAt,
        providerId: q.providerId,
      };
    });

    return {
      slots,
      timezone: process.env.LOCATION_TIMEZONE ?? 'America/New_York',
      nextAvailable: slots[0]?.startsAt,
    };
  }

  async createBooking(r: BookingRequest): Promise<Booking> {
    const res = await fetch(`${API}/calendars/events/appointments`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        calendarId: this.calendarId,
        locationId: this.locationId || r.locationId,
        startTime: r.startsAt,
        endTime: r.endsAt,
        title: `${r.contact.firstName} — new patient`,
        appointmentStatus: 'confirmed',
        contact: {
          firstName: r.contact.firstName,
          lastName: r.contact.lastName,
          phone: r.contact.phone,
          email: r.contact.email,
        },
        // GHL custom fields the reporting layer keys off
        notes: r.reason ?? '',
      }),
    });

    if (res.status === 409) throw new SlotTakenError();
    if (!res.ok) {
      throw new ProviderError(`ghl appointment ${res.status}: ${await res.text()}`,
                              res.status, res.status >= 500);
    }

    const body = (await res.json()) as Record<string, unknown>;
    const id = body.id ?? (body.event as Record<string, unknown> | undefined)?.id;
    if (!id) throw new ProviderError('ghl booking returned no id');

    return { appointmentId: String(id), startsAt: r.startsAt, endsAt: r.endsAt };
  }

  async findContactByPhone(locationId: string, phone: string): Promise<Contact | null> {
    const url = new URL(`${API}/contacts/lookup`);
    url.searchParams.set('locationId', this.locationId || locationId);
    url.searchParams.set('phone', phone);

    const res = await fetch(url, { headers: headers(), cache: 'no-store' });
    if (!res.ok) return null;

    const body = (await res.json()) as { contacts?: Record<string, unknown>[] };
    const c = body.contacts?.[0];
    if (!c) return null;

    return {
      id: String(c.id),
      firstName: c.firstName as string | undefined,
      lastName: c.lastName as string | undefined,
      tags: Array.isArray(c.tags) ? (c.tags as string[]) : undefined,
      // Deliberately not reading clinical custom fields. The agent has no use
      // for them and the smallest surface is the right one around health data.
    };
  }
}
