-- One practice, so the demo has somewhere to book into.
--
-- Every table in this schema references locations(location_id): a call, an
-- appointment, an escalation and a message all belong to a practice. That is
-- correct -- an appointment with no practice is not a thing -- but it means a
-- fresh database with no location row rejects every write the agent attempts,
-- and the failure surfaces as a foreign key violation on the first call rather
-- than as anything that names the real problem.
--
-- So this is not sample data. It is the minimum a deployment needs to answer
-- the phone at all, and DEFAULT_LOCATION_ID must match the id below.

INSERT INTO locations (
    location_id, business_name, timezone, calendar_id,
    phone, business_hours, services, escalation_number, active
) VALUES (
    'bright-smile-main',
    'Bright Smile Dental',
    'America/New_York',
    'mock-calendar',            -- the mock provider ignores this; Cal.com and GHL do not
    '+15551234567',
    '{"mon":["08:00","18:00"],"tue":["08:00","18:00"],"wed":["08:00","18:00"],
      "thu":["08:00","18:00"],"fri":["08:00","18:00"],"sat":[],"sun":[]}'::jsonb,
    '["new patient exam","cleaning","emergency","consultation"]'::jsonb,
    '+15551234567',
    true
)
ON CONFLICT (location_id) DO UPDATE
   SET business_name = excluded.business_name,
       timezone      = excluded.timezone,
       calendar_id   = excluded.calendar_id,
       phone         = excluded.phone,
       business_hours= excluded.business_hours,
       services      = excluded.services,
       escalation_number = excluded.escalation_number,
       active        = excluded.active;
