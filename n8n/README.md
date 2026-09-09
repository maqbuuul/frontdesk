# n8n workflows

Five workflows. Everything asynchronous.

**Nothing here sits on the call path.** Voice has roughly an 800ms round-trip
budget; the caller talks to Vercel functions that talk straight to the GHL API.
n8n owns what happens before a conversation starts and after it ends, where
retries and visibility are worth the latency they cost.

If you find yourself putting an n8n webhook between the caller and the calendar,
that's the signal you've drawn the line in the wrong place.

## Import

Each workflow below ships as an importable export in this folder
(`01-missed-call-rescue.json` … `05-nightly-reconciliation.json`), built
against a stock n8n with the same conventions as the pay-per-show workflows:
no custom credentials beyond one Postgres credential named **Postgres account**,
and everything external (calendar, Slack, SMS, agent) addressed through
instance environment variables, never hard-coded.

Import order does not matter — none of them depend on another workflow's data.
Webhook paths (`missed-call`, `post-call`, `escalation`, `booking-failure`)
are relative; the production URL is `<your-n8n>/webhook/<path>`.

**Two envelopes are documented but not yet fired from the app code.** The
escalation router's webhook is live (the `escalate` tool POSTs to
`N8N_ESCALATION_WEBHOOK_URL`). The booking-failure and post-call webhooks
become live when the transports land and the tool layer is wired to them —
see `DEPLOYMENT.md` in the repo root.

---

## `01-missed-call-rescue`

**Trigger:** GHL webhook — call status `Missed`

The one that starts everything. A missed call becomes a text conversation within
seconds, and the appointment gets recovered instead of lost to whoever the
caller rings next.

1. Quiet-hours check against the location's business hours and timezone
2. **Dedupe** — is this contact already in an open conversation? Two bots
   texting one person is worse than not texting them at all
3. Rate limit per contact per day
4. Opt-out check
5. Open the WhatsApp/SMS thread through the agent

Steps 2–4 are most of the workflow. Sending the message is the easy part; not
sending it at the wrong moment is the work.

## `02-post-call-processing`

**Trigger:** transport webhook — call ended

Six systems, in order, with retries. The reason n8n is here at all.

1. Fetch the transcript and recording
2. Claude extracts intent, outcome, sentiment, whether follow-up is needed —
   **from the transcript only**, never inventing detail the call didn't contain
3. Write `call_intent`, `call_outcome`, `transcript_url` to GHL custom fields
4. Move the opportunity if the call changed its state
5. Append the event to the store
6. Slack the escalation channel if the call was handed off

Idempotent on `call_id`. Transports resend webhooks.

## `03-escalation-router`

**Trigger:** internal webhook from `escalate_to_human`

Routes by category and hour — see
[`docs/02-escalation-policy.md`](../docs/02-escalation-policy.md).

| Urgency | Business hours | After hours |
|---|---|---|
| `now` | Warm transfer, fall back to message | Message + SMS the on-call number |
| `today` | Message, flagged before close | Queue for morning |
| `next_business_day` | Message | Message |

**Never fails silently.** If the transfer doesn't complete, it degrades to a
message and records that it did. A dropped escalation is the worst outcome in
the system, and it's the one that's easiest not to notice.

## `04-booking-failure-queue`

**Trigger:** internal webhook — `book_appointment` failed

The calendar rejected it, or GHL timed out after the agent already offered the
slot. Queue it, alert a human with the caller's number, retry the transient
cases.

A booking the caller believes they have and the clinic has never heard of is the
most damaging failure this system can produce. It gets its own workflow rather
than a catch block.

## `05-nightly-reconciliation`

**Trigger:** 2am schedule

1. Pull yesterday's agent-booked appointments and their current GHL status
2. Sync appointment status from GHL into `appointments`
3. Compute agent-booked vs human-booked show rate
4. Post the morning summary: calls, containment, bookings, cost per booking,
   and the show-rate split

**Publish the show-rate split even when it's unflattering.** If agent-booked
appointments attend at a lower rate, that's the most useful thing this system
can tell you, and burying it makes every other number less trustworthy.

---

## Environment

Instance-wide environment variables (Settings → Environment variables):

```
DATABASE_URL
GHL_API_TOKEN
GHL_LOCATION_ID
ANTHROPIC_API_KEY
SLACK_WEBHOOK_URL
ONCALL_PHONE
QUIET_HOURS_START              default 20:00
QUIET_HOURS_END                default 08:00
MAX_RESCUE_PER_CONTACT_PER_DAY default 1
```

Environment variables specific to the exports:

```
# 01 — where a rescue opens the agent thread (transport endpoint).
#      Until the WhatsApp/SMS transport lands this is unset and the run
#      simply ends at "Open the agent thread".
RESCUE_AGENT_URL

# 02 — the model that extracts intent/outcome from the transcript.
#      Defaults to claude-sonnet-4-5 when unset.
POSTCALL_MODEL

# 03 — generic SMS gateway for the after-hours on-call alert.
ONCALL_SMS_URL

# 04 — retry endpoint for transient booking failures.
BOOKING_RETRY_URL

# 05 — the calendar that owns appointments (CALENDAR_PROVIDER's API),
#      same shape the pay-per-show workflows expect. Without it the nightly
#      sync errors loudly rather than pretending to have synced.
CALENDAR_API_URL
CALENDAR_API_KEY

# 02/04/05 — the location rows they upsert into when a payload omits one.
DEFAULT_LOCATION_ID
```

The quiet-hours and rate-limit values used by `01` are literals in the "Quiet
hours · dedupe · rate · opt-out" Code node, matching the defaults above;
change them there if this instance sets different values.

## Conventions

Non-negotiable:

- **Every write idempotent.** Transports retry and webhooks arrive twice
- **Audit before you act.** Anything that changes a client's account writes its
  reason first, not after
- **Empty is a signal, not a zero.** No calls yesterday is either a broken
  integration or a quiet day, and those need different responses
