# Frontdesk

**An AI receptionist that answers the phone, checks a real calendar, and books
the appointment.**

Voice and WhatsApp over one tool layer · GoHighLevel · n8n · Claude · Vercel

> 📞 **Call it: `+1 ___ ___ ____`** — it's live. Book something.

---

## The problem

A clinic that pays for lead generation misses 30–40% of the calls those leads
make. Lunch, after hours, already on the phone. Every missed call is an
appointment somebody already paid to generate and never received.

The gap isn't ad performance. It's that nobody picks up.

```
   inbound call ──▶ nobody answers ──▶ lead calls a competitor
                          │
                          ▼
   inbound call ──▶  frontdesk  ──▶ checks real availability
                          │      ──▶ books into GoHighLevel
                          │      ──▶ confirms by SMS
                          ▼
                    escalates to a human when it should
```

## What it does

- Answers on the first ring, day or night
- Reads **real** free/busy from the clinic's GoHighLevel calendar
- Books the appointment, writes the contact, moves the opportunity
- Texts a confirmation
- **Knows what it must not handle** and hands those calls to a person
- Reports whether the appointments it booked were actually attended

That last one is the part most AI receptionists skip. A booking isn't the
product. A person walking through the door is.

## The two rules everything else is built around

**1. The model may only offer slots the calendar API returned.**

It never generates a time. The moment a language model can invent availability,
it eventually books somebody into a slot that doesn't exist — and a confidently
wrong appointment is worse than a missed call, because the clinic doesn't find
out until the patient is standing at the desk.

**2. Nothing a caller waits on goes through n8n.**

Voice has roughly an 800ms round-trip budget before it stops feeling like a
conversation. The realtime path is Vercel functions straight to the GHL API.
n8n owns everything asynchronous — post-call processing, escalation routing,
reconciliation — where its retries and visibility are worth the latency it
costs.

Tools chosen by constraint, not by preference.

## Layout

```
app/api/tools/     the six tool endpoints — Vercel serverless functions
lib/calendar/      one interface, Cal.com and GoHighLevel behind it
lib/slots.ts       signed slot ids — how a model is stopped inventing a time
lib/db.ts          holds, calls, escalations
lib/agent/         prompt, tool schemas, the loop
app/api/agent/     one turn, on any transport
db/                schema and metric views
n8n/               five asynchronous workflows
test/              what must not break
docs/              the contracts worth reading before the code
```

One Next.js app rather than a workspace monorepo. The split earns nothing here
— every part deploys to the same Vercel project — and a single app deploys with
no configuration. Folders keep the separation the docs describe.

## Start here

| Read | For |
|---|---|
| [`docs/01-tool-contract.md`](docs/01-tool-contract.md) | What the agent can do, and what it must refuse |
| [`docs/02-escalation-policy.md`](docs/02-escalation-policy.md) | The calls a machine has no business handling |
| [`docs/03-build-order.md`](docs/03-build-order.md) | What to build, in what order, and when each piece is done |
| [`docs/00-ghl-foundation.md`](docs/00-ghl-foundation.md) | The GoHighLevel account this books into |

## The hard parts

Kept here rather than buried, because they're the interesting bit.

| Problem | Approach |
|---|---|
| **Latency budget** | ~800ms round trip. Availability served from a short-lived cache; only the booking call hits GHL live |
| **Two callers, one slot** | Offering a time and booking it are seconds apart. Slots are held on offer and released on timeout |
| **Hallucinated availability** | The model selects from tool output. It cannot construct a time |
| **Clinical questions** | Hard stop and transfer. A dental AI giving medical advice is a liability, not a feature |
| **Consent and PHI** | Call recording consent varies by state; clinic calls carry health information |
| **Cost per call** | Voice runs roughly $0.05–0.15/min. At pay-per-appointment margins that's a real line item |

## Measurement

Appointment outcomes are synced back from GoHighLevel nightly, so the question
that matters can actually be answered:

**Do appointments booked by the agent get attended at the same rate as ones
booked by a human?**

If the answer is no, that's more useful than if the answer is yes.

---

Built by [Abdiwahid Ali](https://github.com/maqbuuul). Nairobi.
