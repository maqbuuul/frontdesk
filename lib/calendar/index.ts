import type { CalendarProvider } from './types';
import { CalComProvider } from './calcom';
import { GhlProvider } from './ghl';
import { MockProvider } from './mock';

export * from './types';

/**
 * Which calendar is behind the agent is a deployment decision, not a code one.
 *
 * Cal.com is the default because it is what actually runs today. Set
 * CALENDAR_PROVIDER=gohighlevel once a GHL account exists -- nothing above
 * this line changes.
 *
 * `mock` is the zero-cost default: when no CALENDAR_PROVIDER is set and
 * neither CALCOM_API_KEY nor GHL_API_TOKEN exists, mock generates weekday
 * slots locally so `/api/agent` demos without keys or spend.
 */
export function getCalendar(): CalendarProvider {
  const raw = (process.env.CALENDAR_PROVIDER ?? '').toLowerCase();
  if (!raw) {
    if (process.env.CALCOM_API_KEY) return new CalComProvider();
    if (process.env.GHL_API_TOKEN) return new GhlProvider();
    return new MockProvider();
  }
  switch (raw) {
    case 'gohighlevel':
    case 'ghl':
      return new GhlProvider();
    case 'calcom':
    case 'cal.com':
      return new CalComProvider();
    case 'mock':
      return new MockProvider();
    default:
      throw new Error(`Unknown CALENDAR_PROVIDER: ${raw}`);
  }
}
