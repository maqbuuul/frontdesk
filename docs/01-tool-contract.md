# Tool contract

The agent's entire capability surface. Voice, WhatsApp and SMS are transports
over this — get it right once and adding a transport is configuration.

Five tools. Anything the agent cannot do with one of these, it cannot do.

---

## The rule that governs all of them

> **The model selects from tool output. It never constructs a fact.**

It may not invent a time slot, a price, a policy, or a clinical opinion. If the
information didn't come back from a tool call, the agent doesn't have it, and
the correct behaviour is to say so and offer to have someone call back.

This is enforced in the prompt *and* at the boundary: `book_appointment`
rejects any `slot_id` that wasn't issued by a `get_availability` call in the
same conversation. Prompts drift. Validation doesn't.

---

## `get_availability`

```
in   service_type   string    enum from the location's configured services
     date_from      ISO date
     date_to        ISO date  max 14 days after date_from
     provider_id    string?   optional, omit for any

out  slots[]        { slot_id, starts_at, ends_at, provider_id, provider_name }
     timezone       IANA name
     next_available ISO datetime, when slots[] is empty
```

**`slot_id` is opaque and single-use.** It encodes calendar, provider, start
time and an issue timestamp, signed. The agent quotes times to the caller and
passes `slot_id` back — it never assembles a booking from a raw datetime the
caller said.

**Served from cache.** Free/busy is refreshed on a short interval per calendar,
because a live GHL call costs 200–500ms and the latency budget for the whole
turn is around 800ms. The cache can be slightly stale; that's what the hold and
the booking-time re-check are for.

**Empty is not an error.** No availability in range returns `slots: []` and a
`next_available`, so the agent can say "nothing this week, earliest is Tuesday
the 14th" instead of failing.

---

## `hold_slot`

```
in   slot_id        string
     contact_ref    string?   if known
out  hold_id        string
     expires_at     ISO datetime   default: 3 minutes
```

Called the moment the agent *offers* a specific time, before the caller has
agreed.

**Why this exists.** Between offering a slot and booking it, thirty to ninety
seconds pass while the caller finds their diary. Two callers can be offered the
same slot in that window. Without a hold, the second booking either fails after
the agent already promised it, or silently double-books.

Holds expire on their own. A caller who hangs up mid-sentence must not lock a
slot until someone notices.

---

## `book_appointment`

```
in   hold_id        string
     contact        { first_name, last_name?, phone, email? }
     reason         string    free text, what the caller said they need
     source         enum      voice | whatsapp | sms
out  appointment_id string
     starts_at      ISO datetime
     confirmation   { sms_queued: bool }
```

**Rejects** any `hold_id` that is expired, already consumed, or not issued in
this conversation.

**Idempotent** on `hold_id`. The transport will retry on timeout; a retry must
not produce a second appointment.

**Re-checks against GHL at write time.** The cache can be stale. If the slot
went in the interim, it returns a conflict with fresh alternatives rather than
an error, so the agent can recover in-conversation: *"that just went — I can do
3:40 instead."*

Writes on success: the GHL appointment, the contact (upsert on phone), the
opportunity stage, the custom fields, and one event to the store.

---

## `lookup_contact`

```
in   phone          E.164
out  found          bool
     contact        { id, first_name, last_name?, tags[], last_appointment_at? }?
     upcoming[]     { appointment_id, starts_at, provider_name }
```

Called at the start of every conversation, before the greeting.

Changes the opening line: a returning patient gets *"Hi Sarah — calling about
Thursday?"* rather than *"Can I take your name?"* It also catches the most
common real reason for the call, which is someone asking about an appointment
they already have.

**Never reads clinical history**, even where GHL holds it in a custom field.
The agent has no reason for it, and the smallest surface is the right one when
health information is involved.

---

## `escalate_to_human`

```
in   category       enum    see 02-escalation-policy.md
     summary        string  what the caller wants, in one sentence
     urgency        enum    now | today | next_business_day
out  action         enum    transferred | message_taken | callback_scheduled
     told_caller    string  exactly what the agent should now say
```

The most important tool in the file. An agent that can't stop is a liability.

**`told_caller` comes back from the tool**, not from the model. What the caller
is promised — "someone will call you within the hour" — is a commitment the
business is making, and it depends on staffing and time of day. That belongs in
code, not in a prompt where it can drift into a promise nobody can keep.

**Never fails silently.** If the transfer can't complete, it degrades to taking
a message and says so. A dropped escalation is the worst outcome in the system.

---

## `take_message`

```
in   contact        { first_name?, phone }
     summary        string
     callback_window enum   asap | morning | afternoon | anytime
out  message_id     string
```

After hours, or when the caller declines to book. Writes to the queue the
console surfaces and n8n routes in the morning.

---

## Errors

Every tool returns the same shape on failure:

```
{ ok: false, code: string, retryable: bool, agent_should_say: string }
```

`agent_should_say` exists for the same reason as `told_caller`. When the
calendar is unreachable, the caller hears one sentence written by a person,
not an improvisation from a model that has just lost its tools.

---

## What deliberately isn't here

- **Cancelling or rescheduling.** Higher stakes than booking and a worse failure
  mode. Escalates for now.
- **Anything about price, insurance or coverage.** Varies per clinic, changes
  often, and being wrong about it costs trust. Escalates.
- **Reading clinical notes.** No reason to.

Each of these is a deliberate no, not a missing feature. The list of things an
agent refuses to do is part of its design, and it's the part worth being able to
defend.
