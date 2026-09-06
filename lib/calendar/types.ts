/**
 * One interface, several calendars behind it.
 *
 * This exists because the calendar is the part of the stack most likely to be
 * decided by somebody else. A clinic already runs GoHighLevel, or Cal.com, or
 * a Google Calendar somebody's spouse set up in 2019. The agent should not
 * care, and neither should the tool layer.
 *
 * Practically it also meant the agent could be built and demonstrated while
 * GoHighLevel was unavailable -- the GHL adapter is written against their
 * documented API and swaps in when an account exists.
 */

export type Slot = {
  /** Opaque, signed, single-use. Issued by get-availability, spent by book. */
  slotId: string;
  startsAt: string; // ISO 8601
  endsAt: string;
  providerId?: string;
  providerName?: string;
};

export type AvailabilityQuery = {
  locationId: string;
  serviceType?: string;
  from: string;
  to: string;
  providerId?: string;
};

export type Availability = {
  slots: Slot[];
  timezone: string;
  /** Set when `slots` is empty, so the agent can say "earliest is Tuesday". */
  nextAvailable?: string;
};

export type BookingRequest = {
  locationId: string;
  startsAt: string;
  endsAt?: string;
  providerId?: string;
  contact: { firstName: string; lastName?: string; phone: string; email?: string };
  reason?: string;
  /** Passed to the provider for its own idempotency where supported. */
  idempotencyKey: string;
};

export type Booking = {
  appointmentId: string;
  startsAt: string;
  endsAt?: string;
  providerName?: string;
};

export type Contact = {
  id: string;
  firstName?: string;
  lastName?: string;
  tags?: string[];
  lastAppointmentAt?: string;
  upcoming?: { appointmentId: string; startsAt: string; providerName?: string }[];
};

/** Thrown when the slot went between offering it and booking it. */
export class SlotTakenError extends Error {
  constructor(message = 'That slot is no longer available') {
    super(message);
    this.name = 'SlotTakenError';
  }
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface CalendarProvider {
  readonly name: string;
  getAvailability(q: AvailabilityQuery): Promise<Availability>;
  createBooking(r: BookingRequest): Promise<Booking>;
  findContactByPhone(locationId: string, phone: string): Promise<Contact | null>;
}
