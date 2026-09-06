# The GoHighLevel foundation

What has to exist in the account before the agent has anything to book into.

About four hours. The provisioning script in
[`ghl-provisioner`](../../ghl-provisioner) already creates most of it — this doc covers what the *agent* additionally needs.

---

## The account

GoHighLevel runs a 14-day trial. One sub-account, a fictional clinic. Then,
before anything else:

- **Timezone on the sub-account**, not just on the calendar. This is the single
  most common cause of an appointment landing at the wrong hour
- **Business hours** matching what a front desk would actually work — the agent
  branches on them
- **A dedicated number**, not the trial number

**A2P 10DLC will not be approved inside a trial**, so outbound SMS won't
deliver. Build as if it will, log what would have been sent, and say so on
camera. Knowing *why* it wouldn't send in production is the more interesting
answer than pretending it does.

Collect: **location ID** (Settings → Business Profile) and an API token
(Settings → Private Integrations).

## The calendar — the part that matters most

The agent's entire value depends on `get_availability` returning times a human
would actually honour.

- Slot duration matches the real appointment length
- **Buffer time set.** Back-to-back booking is how double-bookings happen
- Minimum scheduling notice ≥ 2 hours, or the agent books slots nobody can staff
- Maximum booking window, usually 30 days
- Availability excludes lunch and admin blocks
- If you configure multiple providers, decide the routing rule now —
  round-robin, or service-specific

Then check free/busy through the API and confirm it matches what the calendar UI
shows. **Do this before writing any agent code.** If availability is wrong at
the source, everything above it is confidently wrong.

## Custom fields the agent writes

Beyond the 26 the provisioning script creates:

| Field | Type | Written by |
|---|---|---|
| `call_source` | text | `book_appointment` — voice, whatsapp, sms |
| `call_intent` | text | n8n post-call, extracted from transcript |
| `call_outcome` | text | booked / escalated / message / abandoned |
| `escalation_category` | text | `escalate_to_human` |
| `transcript_url` | text | n8n post-call |
| `agent_booked` | checkbox | the flag the show-rate comparison splits on |

`agent_booked` is small and load-bearing. Without it there's no way to compare
agent-booked against human-booked appointments, which is the number worth
having.

## Pipeline

The existing 8-stage **New Patient** pipeline works unchanged:

```
New Lead → Contacted → Booked → Confirmed → Attended → No Show → Recycle → Closed Lost
```

The agent moves opportunities to `Booked`. Everything downstream — confirmation,
reminders, attendance — is already specified in
[`ghl-provisioner`](../../ghl-provisioner/docs/workflow-specs.md).

**`Attended` must be spelled exactly that.** Reporting joins on the stage name.

## The trigger

One GHL workflow, and it's the one that starts everything:

**Trigger:** Call Status is `Missed` (or no answer past N rings)
**Action:** Webhook → the n8n missed-call rescue workflow

Payload: contact id, phone, call time, location id, and any click ID fields
already on the contact.

**Done when:** you miss a call on the clinic number on purpose and see the
webhook arrive.

## Verify before moving on

- [ ] Provisioning script's verification step passes — all fields present
- [ ] Free/busy through the API matches the calendar UI
- [ ] A test appointment created via API appears in the UI at the right time
- [ ] Contact upsert on an existing phone number updates rather than duplicates
- [ ] Missed call fires the webhook and it arrives
- [ ] Timezone correct on the sub-account, the calendar, and in API responses

That last one deserves its own check. Timezone bugs in a booking system don't
throw errors — they just book people at the wrong hour, and nobody finds out
until somebody doesn't turn up.
