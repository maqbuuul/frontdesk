# Escalation policy

The calls the agent must not handle.

This is the shortest document here and the one worth arguing about. An AI
receptionist for a healthcare business is a liability the first time it answers
a question it shouldn't have.

The test for every category: **if the agent gets this wrong, who gets hurt and
how badly?** Where the answer is worse than "the caller is mildly annoyed," a
human takes it.

---

## Hard stops — transfer or take a message, always

| Category | Trigger | Urgency |
|---|---|---|
| `clinical` | Any question about symptoms, pain, medication, whether something is serious | `now` |
| `emergency` | Bleeding, swelling, trauma, "I'm in a lot of pain", anything time-critical | `now` |
| `billing` | Cost, insurance, coverage, payment plans, an invoice dispute | `today` |
| `complaint` | Dissatisfaction with treatment or staff | `today` |
| `records` | Requests for notes, referrals, or anything about their file | `next_business_day` |
| `legal` | Solicitors, insurers, subpoenas, anything with a letterhead | `next_business_day` |

### On `clinical` and `emergency`

These are not the same and shouldn't be handled the same way.

**Clinical** is any request for judgement: *"is this normal?"*, *"should I be
worried?"*, *"can I take ibuprofen with that?"* The agent does not answer, does
not reassure, and does not speculate. Reassurance is itself a clinical act —
"that sounds fine" from a receptionist bot is advice, and it's advice from
something with no basis for giving it.

**Emergency** is a superset that also bypasses the queue. If a caller describes
something urgent, the agent stops the booking flow immediately, says so plainly,
and transfers. It does not first collect their email address.

Both categories should be **over-triggered on purpose**. A false positive costs
one transferred call. A false negative costs considerably more.

---

## Soft escalations — try once, then hand over

| Category | Trigger |
|---|---|
| `confused` | Two consecutive turns where intent can't be resolved |
| `frustrated` | Explicit request for a human, or clear irritation |
| `out_of_scope` | A service the clinic doesn't offer, or another location entirely |
| `no_availability` | Nothing in range and the caller won't take the alternative |

**"Let me get someone" must always work.** If a caller asks for a human at any
point, that request is honoured immediately and without a retention attempt.
Making somebody argue with software to reach a person is the single fastest way
to lose them, and it's the thing people hate most about phone systems.

---

## What happens on escalation

Behaviour depends on the hour, and it is decided in code rather than by the
model — see `escalate_to_human` in [the tool contract](01-tool-contract.md).

| | Business hours | After hours |
|---|---|---|
| `now` | Warm transfer. If nobody answers, take a message and say so | Message + immediate SMS alert to the on-call number |
| `today` | Message, flagged for callback before close | Message, queued for the morning |
| `next_business_day` | Message | Message |

**Never promise what staffing can't deliver.** The line the caller hears comes
back from the tool, not from the model, because it depends on who is actually
working — and a promise of "within the hour" made at 9pm is a broken promise
before it's finished being spoken.

---

## Recording, consent and PHI

- **Consent.** Two-party consent states require both sides to agree to
  recording. The disclosure runs at the top of the call, before anything is
  captured, and it is not skippable.
- **PHI.** Clinic calls carry health information whether or not the agent asks
  for it. Transcripts are treated as sensitive by default: encrypted, retained
  on a fixed schedule, never sent anywhere they don't need to go.
- **Minimum surface.** The agent never requests clinical detail. The reason a
  caller gives for the appointment is stored verbatim as they said it, and
  nothing is inferred from it.
- **The recording is the audit trail.** When a booking is disputed, the call is
  the evidence. That's also why the console lets a human listen to any call
  rather than only reading its summary.

---

## Reviewing what it refused

Every escalation writes a row: category, the caller's phrasing, what the agent
said, what the human did next.

**Read the queue weekly.** It's the only honest signal about where the agent's
judgement is wrong in both directions — categories it's missing, and categories
where it's escalating calls it could safely have handled.

Tune toward over-escalation. The cost of the two mistakes is not symmetric.
