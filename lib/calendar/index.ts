import type { CalendarProvider } from './types';
import { CalComProvider } from './calcom';
import { GhlProvider } from './ghl';

export * from './types';

/**
 * Which calendar is behind the agent is a deployment decision, not a code one.
 *
 * Cal.com is the default because it is what actually runs today. Set
 * CALENDAR_PROVIDER=gohighlevel once a GHL account exists -- nothing above
 * this line changes.
 */
export function getCalendar(): CalendarProvider {
  const which = (process.env.CALENDAR_PROVIDER ?? 'calcom').toLowerCase();
  switch (which) {
    case 'gohighlevel':
    case 'ghl':
      return new GhlProvider();
    case 'calcom':
    case 'cal.com':
      return new CalComProvider();
    default:
      throw new Error(`Unknown CALENDAR_PROVIDER: ${which}`);
  }
}
