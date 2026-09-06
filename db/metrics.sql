-- Metric definitions. One place, so "what is our show rate" has exactly one
-- answer regardless of who asks or which screen they open.

-- ---------------------------------------------------------------------------
-- The comparison this whole system exists to make honest.
--
-- Only appointments whose time has passed are counted. Including future
-- bookings drags every rate down and flatters whichever side booked more
-- recently -- which, for a newly launched agent, is always the agent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_show_rate_by_booker AS
SELECT location_id,
       booked_by,
       count(*)                                            AS appointments,
       count(*) FILTER (WHERE status = 'attended')         AS attended,
       count(*) FILTER (WHERE status = 'no_show')          AS no_shows,
       count(*) FILTER (WHERE status = 'cancelled')        AS cancelled,
       count(*) FILTER (WHERE status = 'confirmed')        AS confirmed_first,
       round(100.0 * count(*) FILTER (WHERE status = 'attended')
             / nullif(count(*) FILTER (WHERE status <> 'cancelled'), 0), 1)
                                                           AS show_rate_pct
FROM appointments
WHERE starts_at < now()
GROUP BY 1, 2;

-- Cost per attended appointment, per booker.
--
-- Cost per booking flatters the agent: it books cheaply. Cost per *attended*
-- appointment is the number a clinic actually pays for, and it is the only
-- fair basis for comparing an agent against a receptionist.
CREATE OR REPLACE VIEW v_cost_per_attended AS
WITH agent_cost AS (
    SELECT location_id, sum(cost_cents) / 100.0 AS spend_usd
    FROM calls
    WHERE started_at > now() - interval '30 days'
    GROUP BY 1
)
SELECT s.location_id,
       s.booked_by,
       s.appointments,
       s.attended,
       s.show_rate_pct,
       CASE WHEN s.booked_by = 'agent'
            THEN round((c.spend_usd / nullif(s.attended, 0))::numeric, 2)
       END AS cost_per_attended_usd
FROM v_show_rate_by_booker s
LEFT JOIN agent_cost c USING (location_id);

-- Does confirming actually move the number?
--
-- The showrate-os design bets that asking for an explicit confirmation reply
-- raises attendance. This view is what settles that bet with data rather than
-- with an opinion.
CREATE OR REPLACE VIEW v_confirmation_effect AS
SELECT location_id,
       booked_by,
       status = 'confirmed' OR status_at IS NOT NULL AS was_confirmed,
       count(*)                                       AS appointments,
       round(100.0 * count(*) FILTER (WHERE status = 'attended')
             / nullif(count(*), 0), 1)                AS show_rate_pct
FROM appointments
WHERE starts_at < now() AND status <> 'cancelled'
GROUP BY 1, 2, 3;
