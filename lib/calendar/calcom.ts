import { issueSlotId } from '@/lib/slots';
import {
  type Availability, type AvailabilityQuery, type Booking, type BookingRequest,
  type CalendarProvider, type Contact, ProviderError, SlotTakenError,
} from './types';

/**
 * Cal.com adapter.
 *
 * NOTE ON RESPONSE SHAPES
 * -----------------------
 * Cal.com has moved its slots response between a date-keyed object and a flat
 * array across API versions. Rather than pin to one and break on upgrade, the
 * parser below accepts both and ignores anything it does not recognise.
 *
 * That is defensive on purpose: this was written without a live account to
 * curl, so the shapes come from the documented API rather than from an
 * observed response. `test/run.mts` pins the parser against both known shapes,
 * so if a third appears the failure is a red test rather than a caller being
 * offered a time that does not exist.
 */

const API = process.env.CALCOM_API_URL ?? 'https://api.cal.com/v2';

function headers() {
  const key = process.env.CALCOM_API_KEY;
  if (!key) throw new ProviderError('CALCOM_API_KEY is not set');
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'cal-api-version': process.env.CALCOM_API_VERSION ?? '2024-09-04',
  };
}

/** Accepts either `{ data: { "2026-09-10": [ {start} ] } }` or `{ data: [ {start} ] }`. */
export function parseSlots(body: unknown): { start: string; end?: string; providerId?: string }[] {
  const data = (body as { data?: unknown })?.data ?? body;
  const out: { start: string; end?: string; providerId?: string }[] = [];

  const take = (s: unknown) => {
    if (!s || typeof s !== 'object') return;
    const o = s as Record<string, unknown>;
    const start = (o.start ?? o.startTime ?? o.time) as string | undefined;
    if (typeof start !== 'string') return;
    out.push({
      start,
      end: typeof o.end === 'string' ? o.end : undefined,
      providerId: typeof o.userId === 'number' ? String(o.userId)
                : typeof o.userId === 'string' ? o.userId : undefined,
    });
  };

  if (Array.isArray(data)) data.forEach(take);
  else if (data && typeof data === 'object') {
    for (const v of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach(take);
    }
  }
  return out;
}

export class CalComProvider implements CalendarProvider {
  readonly name = 'cal.com';

  constructor(private eventTypeId = process.env.CALCOM_EVENT_TYPE_ID ?? '') {}

  async getAvailability(q: AvailabilityQuery): Promise<Availability> {
    const url = new URL(`${API}/slots`);
    url.searchParams.set('eventTypeId', this.eventTypeId);
    url.searchParams.set('start', q.from);
    url.searchParams.set('end', q.to);

    const res = await fetch(url, { headers: headers(), cache: 'no-store' });
    if (!res.ok) {
      throw new ProviderError(`cal.com slots ${res.status}`, res.status, res.status >= 500);
    }

    const raw = parseSlots(await res.json());
    const durationMin = Number(process.env.APPOINTMENT_MINUTES ?? 60);

    const slots = raw.map((s) => {
      const startsAt = new Date(s.start).toISOString();
      const endsAt = s.end
        ? new Date(s.end).toISOString()
        : new Date(new Date(s.start).getTime() + durationMin * 60_000).toISOString();
      return {
        slotId: issueSlotId({ loc: q.locationId, st: startsAt, et: endsAt, pr: s.providerId }),
        startsAt,
        endsAt,
        providerId: s.providerId,
      };
    });

    // Empty is not an error. It lets the agent say "nothing this week, earliest
    // is Tuesday" rather than failing the turn.
    return {
      slots,
      timezone: process.env.LOCATION_TIMEZONE ?? 'America/New_York',
      nextAvailable: slots.length === 0 ? undefined : slots[0].startsAt,
    };
  }

  async createBooking(r: BookingRequest): Promise<Booking> {
    const res = await fetch(`${API}/bookings`, {
      method: 'POST',
      headers: { ...headers(), 'Idempotency-Key': r.idempotencyKey },
      body: JSON.stringify({
        eventTypeId: Number(this.eventTypeId) || this.eventTypeId,
        start: r.startsAt,
        attendee: {
          name: [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' '),
          email: r.contact.email ?? `${r.contact.phone.replace(/\D/g, '')}@no-email.invalid`,
          phoneNumber: r.contact.phone,
          timeZone: process.env.LOCATION_TIMEZONE ?? 'America/New_York',
        },
        metadata: { reason: r.reason ?? '', locationId: r.locationId },
      }),
    });

    // 409 means somebody took it between the offer and the booking. That is the
    // race the slot hold exists to make rare -- but rare is not never, so it is
    // handled as a recoverable conflict rather than an error.
    if (res.status === 409) throw new SlotTakenError();
    if (!res.ok) {
      throw new ProviderError(`cal.com booking ${res.status}: ${await res.text()}`,
                              res.status, res.status >= 500);
    }

    const body = (await res.json()) as { data?: Record<string, unknown> };
    const d = body.data ?? {};
    const id = d.uid ?? d.id;
    if (!id) throw new ProviderError('cal.com booking returned no id');

    return {
      appointmentId: String(id),
      startsAt: String(d.start ?? r.startsAt),
      endsAt: typeof d.end === 'string' ? d.end : r.endsAt,
    };
  }

  /**
   * Cal.com has no contact book -- it stores attendees on bookings. So a
   * "known caller" is somebody with a booking against this number.
   */
  async findContactByPhone(locationId: string, phone: string): Promise<Contact | null> {
    const url = new URL(`${API}/bookings`);
    url.searchParams.set('attendeePhone', phone);
    const res = await fetch(url, { headers: headers(), cache: 'no-store' });
    if (!res.ok) return null;

    const body = (await res.json()) as { data?: unknown };
    const rows = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : [];
    if (rows.length === 0) return null;

    const now = Date.now();
    const upcoming = rows
      .filter((b) => new Date(String(b.start)).getTime() > now)
      .map((b) => ({ appointmentId: String(b.uid ?? b.id), startsAt: String(b.start) }));

    const past = rows
      .filter((b) => new Date(String(b.start)).getTime() <= now)
      .sort((a, b) => new Date(String(b.start)).getTime() - new Date(String(a.start)).getTime());

    const attendee = (rows[0].attendees as { name?: string }[] | undefined)?.[0];
    const [firstName, ...rest] = String(attendee?.name ?? '').split(' ');

    return {
      id: phone,
      firstName: firstName || undefined,
      lastName: rest.length ? rest.join(' ') : undefined,
      lastAppointmentAt: past[0] ? String(past[0].start) : undefined,
      upcoming,
    };
  }
}
