import { randomUUID } from 'node:crypto';
import { issueSlotId } from '@/lib/slots';
import type {
  Availability,
  AvailabilityQuery,
  Booking,
  BookingRequest,
  CalendarProvider,
  Contact,
} from './types';

/**
 * Zero-cost calendar for demo / job-application use.
 *
 * Generates the next few weekday 10:00 / 14:00 slots in the location timezone
 * and fake-books them. No network, no keys. The slot ids are still signed via
 * `issueSlotId`, so the "model cannot invent a time" rule is enforced exactly
 * as with Cal.com / GHL.
 *
 * Enable with CALENDAR_PROVIDER=mock. This is the default when neither
 * CALCOM_API_KEY nor GHL_API_TOKEN is set, so `/api/agent` demos without
 * spending a token.
 */
export class MockProvider implements CalendarProvider {
  readonly name = 'mock';

  private tz(): string {
    return process.env.LOCATION_TIMEZONE ?? 'America/New_York';
  }

  private nextSlots(count = 6): { startsAt: string; endsAt: string }[] {
    const out: { startsAt: string; endsAt: string }[] = [];
    const minutes = Number(process.env.APPOINTMENT_MINUTES ?? 60);
    // Start tomorrow 10:00 local-ish (approximated in UTC; demo only).
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    let guard = 0;
    while (out.length < count && guard++ < 30) {
      const day = d.getUTCDay();
      if (day !== 0 && day !== 6) {
        for (const h of [10, 14]) {
          if (out.length >= count) break;
          const s = new Date(d);
          s.setUTCHours(h, 0, 0, 0);
          if (s.getTime() < Date.now() + 60_000) continue;
          out.push({
            startsAt: s.toISOString(),
            endsAt: new Date(s.getTime() + minutes * 60_000).toISOString(),
          });
        }
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  async getAvailability(q: AvailabilityQuery): Promise<Availability> {
    const slots = this.nextSlots(6).map((s) => ({
      slotId: issueSlotId({ loc: q.locationId, st: s.startsAt, et: s.endsAt }),
      startsAt: s.startsAt,
      endsAt: s.endsAt,
    }));
    return { slots, timezone: this.tz(), nextAvailable: slots[0]?.startsAt };
  }

  async createBooking(r: BookingRequest): Promise<Booking> {
    return {
      appointmentId: `mock_${randomUUID().slice(0, 8)}`,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
    };
  }

  async findContactByPhone(): Promise<Contact | null> {
    return null;
  }
}
