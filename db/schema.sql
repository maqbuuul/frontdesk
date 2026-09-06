-- Frontdesk store.
--
-- GoHighLevel is the source of truth for the calendar, the contact and the
-- opportunity. This database holds what GHL has no place to put: the
-- conversation, the slot holds that stop two callers taking one slot, and the
-- record of what the agent refused to do.
--
-- Design decisions worth knowing before changing anything here:
--
-- 1. `calls` is the audit trail. When a booking is disputed, this plus the
--    recording is the evidence. Nothing is deleted, only redacted in place.
--
-- 2. `slot_holds` is the concurrency primitive. It exists because offering a
--    time and booking it are seconds apart, and two callers can be offered the
--    same slot in that window.
--
-- 3. `escalations` is a first-class table, not a column on `calls`. What the
--    agent refuses is as important as what it does, and it gets read weekly.

CREATE TABLE IF NOT EXISTS locations (
    location_id       text PRIMARY KEY,          -- GHL sub-account
    business_name     text NOT NULL,
    timezone          text NOT NULL,
    calendar_id       text NOT NULL,
    phone             text,
    business_hours    jsonb NOT NULL DEFAULT '{}'::jsonb,
    services          jsonb NOT NULL DEFAULT '[]'::jsonb,
    escalation_number text,                      -- where `now` transfers go
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per conversation, on any transport.
CREATE TABLE IF NOT EXISTS calls (
    call_id         text PRIMARY KEY,            -- from the transport provider
    location_id     text NOT NULL REFERENCES locations(location_id),
    transport       text NOT NULL,               -- voice | whatsapp | sms
    direction       text NOT NULL DEFAULT 'inbound',
    from_phone      text,
    contact_id      text,                        -- GHL contact, once known
    started_at      timestamptz NOT NULL,
    ended_at        timestamptz,
    duration_secs   integer,

    outcome         text,                        -- booked | escalated | message
                                                 -- | abandoned | no_intent
    appointment_id  text,                        -- GHL appointment, if booked

    transcript      jsonb,                       -- [{role, text, at}]
    recording_url   text,
    summary         text,                        -- written by n8n post-call
    intent          text,

    -- what it cost, because at pay-per-appointment margins this matters
    cost_cents      integer,
    model_tokens    integer,

    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calls_location_idx ON calls (location_id, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_outcome_idx  ON calls (outcome, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_phone_idx    ON calls (from_phone);

-- The concurrency primitive.
--
-- Written when the agent OFFERS a time, not when the caller accepts. The
-- partial unique index is what actually prevents the double-book: at most one
-- live hold per slot, enforced by the database rather than by application
-- logic that races with itself.
CREATE TABLE IF NOT EXISTS slot_holds (
    hold_id       text PRIMARY KEY,
    slot_id       text NOT NULL,
    location_id   text NOT NULL REFERENCES locations(location_id),
    call_id       text REFERENCES calls(call_id),
    starts_at     timestamptz NOT NULL,
    provider_id   text,
    held_at       timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    consumed_at   timestamptz,                   -- set by book_appointment
    released_at   timestamptz                    -- expired, or caller declined
);

CREATE UNIQUE INDEX IF NOT EXISTS slot_holds_live_idx
    ON slot_holds (slot_id)
    WHERE consumed_at IS NULL AND released_at IS NULL;

CREATE INDEX IF NOT EXISTS slot_holds_expiry_idx
    ON slot_holds (expires_at)
    WHERE consumed_at IS NULL AND released_at IS NULL;

-- What the agent refused, and what happened next.
CREATE TABLE IF NOT EXISTS escalations (
    escalation_id  bigserial PRIMARY KEY,
    call_id        text NOT NULL REFERENCES calls(call_id),
    location_id    text NOT NULL REFERENCES locations(location_id),
    category       text NOT NULL,                -- see 02-escalation-policy.md
    urgency        text NOT NULL,                -- now | today | next_business_day
    caller_said    text,                         -- verbatim, for tuning
    agent_said     text,                         -- what the tool told it to say
    action         text NOT NULL,                -- transferred | message_taken
                                                 -- | callback_scheduled
    resolved_at    timestamptz,
    resolved_by    text,
    resolution     text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS escalations_open_idx
    ON escalations (location_id, created_at DESC)
    WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS messages (
    message_id      bigserial PRIMARY KEY,
    call_id         text REFERENCES calls(call_id),
    location_id     text NOT NULL REFERENCES locations(location_id),
    contact_phone   text NOT NULL,
    contact_name    text,
    summary         text NOT NULL,
    callback_window text,
    delivered_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The console's two main views.
-- ---------------------------------------------------------------------------

-- Containment: how much the agent handled without a human. The number a
-- clinic actually asks about.
CREATE OR REPLACE VIEW v_call_outcomes AS
SELECT location_id,
       date_trunc('day', started_at)::date          AS day,
       count(*)                                     AS calls,
       count(*) FILTER (WHERE outcome = 'booked')   AS booked,
       count(*) FILTER (WHERE outcome = 'escalated') AS escalated,
       count(*) FILTER (WHERE outcome = 'message')  AS messages,
       count(*) FILTER (WHERE outcome = 'abandoned') AS abandoned,
       round(100.0 * count(*) FILTER (WHERE outcome = 'booked')
             / nullif(count(*), 0), 1)              AS book_rate_pct,
       round(100.0 * count(*) FILTER (WHERE outcome IN ('booked','message'))
             / nullif(count(*), 0), 1)              AS containment_pct,
       round(avg(duration_secs))                    AS avg_secs,
       round(sum(cost_cents) / 100.0, 2)            AS cost_usd,
       round(sum(cost_cents) / 100.0
             / nullif(count(*) FILTER (WHERE outcome = 'booked'), 0), 2)
                                                    AS cost_per_booking_usd
FROM calls
GROUP BY 1, 2;

-- The escalation queue, which is the screen a human opens.
CREATE OR REPLACE VIEW v_escalation_queue AS
SELECT e.escalation_id, e.location_id, e.category, e.urgency,
       e.caller_said, e.action, e.created_at,
       c.from_phone, c.recording_url, c.summary,
       round(extract(epoch FROM now() - e.created_at) / 60)::int AS waiting_minutes
FROM escalations e
JOIN calls c USING (call_id)
WHERE e.resolved_at IS NULL
ORDER BY CASE e.urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END,
         e.created_at;

-- ---------------------------------------------------------------------------
-- Appointment outcomes.
--
-- GoHighLevel owns the appointment. This is a nightly mirror of its status, so
-- the one question worth asking can be answered: do the appointments the agent
-- booked get attended at the same rate as the ones a human booked?
--
-- `booked_by` is the whole point of the table. Without it there is no
-- comparison, only a booking count -- and a booking count flatters every
-- automated system ever built.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointments (
    appointment_id  text PRIMARY KEY,            -- GHL appointment
    location_id     text NOT NULL REFERENCES locations(location_id),
    contact_id      text,
    call_id         text REFERENCES calls(call_id),   -- null when a human booked it
    booked_by       text NOT NULL,               -- agent | human
    booked_at       timestamptz NOT NULL,
    starts_at       timestamptz NOT NULL,
    status          text NOT NULL,               -- booked | confirmed | attended
                                                 -- | no_show | cancelled
    status_at       timestamptz,
    synced_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appointments_booked_by_idx
    ON appointments (location_id, booked_by, starts_at DESC);
CREATE INDEX IF NOT EXISTS appointments_status_idx
    ON appointments (status, starts_at DESC);
