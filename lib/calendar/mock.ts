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
 * Generates the next few weekday slots in the location timezone and
 * fake-books them. No network, no keys. The slot ids are still signed via
 * `issueSlotId`, so the "model cannot invent a time" rule is enforced exactly
 * as with Cal.com / GHL.
 *
 * The hours are built in the practice's zone and converted to UTC instants,
 * not assembled in UTC and hoped over. Doing it the other way offers a New
 * York patient a six in the morning appointment, and nothing raises: the call
 * sounds fine, the row looks fine, and it turns into a no-show.
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

  /** Civil date in `tz` for an instant -- the calendar day the practice is on. */
  private civilParts(at: Date, tz: string) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    }).formatToParts(at).reduce<Record<string, string>>((a, x) => {
      if (x.type !== 'literal') a[x.type] = x.value;
      return a;
    }, {});
    return {
      y: Number(p.year), m: Number(p.month), d: Number(p.day),
      h: Number(p.hour) % 24, min: Number(p.minute), s: Number(p.second),
      weekday: p.weekday,
    };
  }

  private offsetMs(at: Date, tz: string): number {
    const c = this.civilParts(at, tz);
    return Date.UTC(c.y, c.m - 1, c.d, c.h, c.min, c.s) - at.getTime();
  }

  /**
   * A wall-clock time in `tz` as a UTC instant.
   *
   * The offset is resolved twice on purpose. The first pass uses the offset at
   * the *guessed* instant, which is the wrong side of a DST boundary for the
   * hours around a clock change; the second pass corrects it. One pass is
   * right for most of the year, which is what makes it a bad bug -- it appears
   * twice a year and looks like the patient simply did not turn up.
   */
  private zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
    const guess = Date.UTC(y, m - 1, d, h, min);
    const once = guess - this.offsetMs(new Date(guess), tz);
    return new Date(guess - this.offsetMs(new Date(once), tz));
  }

  private nextSlots(count = 6): { startsAt: string; endsAt: string }[] {
    const out: { startsAt: string; endsAt: string }[] = [];
    const tz = this.tz();
    const minutes = Number(process.env.APPOINTMENT_MINUTES ?? 60);

    // Offer hours inside the practice's own opening times, not around them.
    const open = Number(process.env.BUSINESS_OPEN_HOUR ?? 8);
    const close = Number(process.env.BUSINESS_CLOSE_HOUR ?? 18);
    const hours = [10, 14].filter((h) => h >= open && h + minutes / 60 <= close);

    // Walk forward a civil day at a time in the practice's zone.
    const today = this.civilParts(new Date(), tz);
    let cursor = Date.UTC(today.y, today.m - 1, today.d);

    let guard = 0;
    while (out.length < count && guard++ < 30) {
      cursor += 86_400_000;                       // next civil day
      const c = new Date(cursor);
      const y = c.getUTCFullYear(), m = c.getUTCMonth() + 1, d = c.getUTCDate();

      for (const h of hours) {
        if (out.length >= count) break;
        const start = this.zonedToUtc(y, m, d, h, 0, tz);

        // Weekday test on the practice's calendar, not the server's.
        const wd = this.civilParts(start, tz).weekday;
        if (wd === 'Sat' || wd === 'Sun') break;

        if (start.getTime() < Date.now() + 60_000) continue;
        out.push({
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
        });
      }
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
