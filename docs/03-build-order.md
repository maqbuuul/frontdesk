# Build order

Five days. Each stage is done when the loop closes, not when the code runs.

The order exists to de-risk the hard part: **build the tool layer once, then add
transports.** WhatsApp first because it has no latency pressure, voice second
because by then only the transport is new.

---

## Day 1 · The GoHighLevel foundation

The agent needs somewhere real to book into. See
[`00-ghl-foundation.md`](00-ghl-foundation.md).

**Done when:** the provisioning script's verification step passes, and a missed
call on the clinic number fires a webhook that arrives somewhere you can see it.

## Day 2 · `lib/calendar` and `app/api/tools`

The GHL client and the five tool endpoints, deployed as Vercel functions.

Build the client first and test it against the real account from a script —
free/busy, contact upsert, appointment create, custom field write. Then wrap it
in the tool endpoints.

**Done when:** you can `curl` each of the five tools against your real GHL
account and get correct results, including the failure shapes.

**Don't skip:** the `slot_id` signing, and `book_appointment` rejecting a
`slot_id` it didn't issue. Retro-fitting validation after the agent is talking
is much harder than putting it in now.

## Day 3 · `lib/agent` and the WhatsApp transport

Prompts, tool schemas, guardrails, and the escalation categories wired to the
tool.

WhatsApp because a three-second pause costs nothing there, so you can debug the
booking logic without fighting latency at the same time.

**Done when:** a WhatsApp conversation books a real appointment into the GHL
calendar, and a message describing pain gets escalated instead of booked.

**Test the refusals as hard as the bookings.** The escalation path is the one
that matters and the one nobody demos.

## Day 4 · Voice

Point a voice platform at the same tool endpoints. Vapi, Retell or LiveKit —
they bundle speech-to-text, turn-taking and text-to-speech, and the
differentiation here isn't in re-implementing barge-in.

Then buy the number.

**Done when:** you can call a real phone number, book an appointment, and watch
it appear in the GHL calendar while still on the line.

**Watch the latency budget.** Around 800ms round trip. Availability must come
from cache; if a live GHL call sits on the critical path it will feel broken
even when it's correct.

## Day 5 · the console and the measurement

The console: call list, transcripts, the escalation queue, booking outcomes.

Then sync appointment outcomes from GHL into `appointments` and answer the
question the metric views in [`db/metrics.sql`](../db/metrics.sql) exist
for:

**do agent-booked appointments get attended at the same rate as human-booked
ones?**

**Done when:** the console is deployed on Vercel showing live data, and that
comparison renders a number.

---

## Definition of done, overall

Not "it works on my machine." This:

1. Call the number
2. It answers, offers real times, books one
3. The appointment is in the GoHighLevel calendar
4. The contact exists with the custom fields populated
5. The opportunity moved stage
6. A confirmation SMS arrived
7. The event is in the store
8. The console shows the call and its transcript
9. Nobody touched anything

Every step in that chain is somewhere it can silently half-work. Test the chain,
not the parts.

---

## If time runs short

Cut in this order — worst thing to lose is last:

| Cut | Costs you |
|---|---|
| The show-rate comparison | The best line in the video |
| Console polish | Filmable material, but a single metrics page survives |
| Voice | The phone number. A real loss — this is the demo |
| Escalation logic | **Never cut this.** It's what separates a system from a toy |

Shipping the WhatsApp agent alone still demonstrates every tool on their list.
Shipping voice without escalation demonstrates that you'd put an unsupervised
model in front of patients.
