# Deploying frontdesk

Two live pieces, split exactly where the code is split:

1. **The tool layer** — the Next.js app, deployed to Vercel as serverless
   functions. This is the realtime path: the agent, the five tools, and the
   escalation webhook live here.
2. **The async layer** — five n8n workflows in `n8n/`. Everything that happens
   before a conversation starts or after it ends, where retries and visibility
   are worth the latency they cost.

Voice and WhatsApp transports are **not wired yet** — this document covers the
tool layer and the workflows. The transports sit on top of the same tool
endpoints when they land (see *Integration gaps*).

---

## 1. Database (Neon or any Postgres)

One-time, against the `DATABASE_URL` the app and workflows will share:

```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/metrics.sql
```

Seed one location row so the workflows' foreign keys land (update to the real
practice):

```sql
INSERT INTO locations (location_id, business_name, timezone, calendar_id)
VALUES ('demo-location', 'Bright Smile Dental', 'America/New_York', '')
ON CONFLICT (location_id) DO NOTHING;
```

The dashboard-style views (`v_call_outcomes`, `v_escalation_queue`,
`v_show_rate_by_booker`, `v_cost_per_attended`) come from `metrics.sql`.

---

## 2. The tool layer on Vercel

The repo deploys as one Vercel project with no root-directory setting.

```bash
npx vercel                       # first deploy / link
npx vercel env add DATABASE_URL
npx vercel env add ANTHROPIC_API_KEY
npx vercel env add SLOT_SIGNING_SECRET
npx vercel env add CALENDAR_PROVIDER        # calcom (default) | gohighlevel
# ... the provider's keys and the rest of .env.example
npx vercel --prod
```

### Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Shared with the n8n workflows |
| `ANTHROPIC_API_KEY` | yes | The agent |
| `SLOT_SIGNING_SECRET` | yes | Long random string. Rotating it invalidates outstanding slot offers — correct behaviour |
| `CALENDAR_PROVIDER` | no | `calcom` default. `gohighlevel` adapter is written, not yet run |
| `CALCOM_API_KEY`, `CALCOM_EVENT_TYPE_ID` | provider | The calendar today |
| `GHL_API_TOKEN`, `GHL_CALENDAR_ID`, `GHL_LOCATION_ID` | provider | Only when `CALENDAR_PROVIDER=gohighlevel` |
| `DEFAULT_LOCATION_ID` | yes | The location rows point here |
| `LOCATION_TIMEZONE` | no | `America/New_York` default |
| `N8N_ESCALATION_WEBHOOK_URL` | yes* | Public `<n8n>/webhook/escalation` — fires on every escalation |
| `N8N_BOOKED_WEBHOOK_URL` | later | Env exists; hook not yet fired from code (see gaps) |
| `ONCALL_PHONE`, `PRACTICE_NAME`, `AGENT_MODEL`, `AGENT_FAST_MODE` | no | Behaviour knobs from `.env.example` |

*Set the escalation webhook for the router to be live; the app runs fine
without it (escalations still land in the DB and console queue).

### Smoke test

```bash
# availability — requires the calendar keys
curl -s "https://<project>.vercel.app/api/tools/get-availability" \
  -H 'content-type: application/json' \
  -d '{"serviceType":"new-patient","dateFrom":"2026-09-08","dateTo":"2026-09-12"}'

# lookup, hold, book, escalate, take-message follow the same shapes as in
# docs/01-tool-contract.md. The agent turn (single POST, any transport) is
# /api/agent.
```

---

## 3. The workflows in n8n

Import `n8n/01-missed-call-rescue.json` … `n8n/05-nightly-reconciliation.json`.
Add one Postgres credential named **Postgres account**. Instance environment
variables are listed in `n8n/README.md`.

Verification, cheapest first:

1. Run **05** manually — it is scheduled but can be executed by hand. It should
   sync nothing (empty calendar) and post the morning summary line.
2. POST a fake envelope to `<n8n>/webhook/escalation` and confirm the row lands
   and (with `SLACK_WEBHOOK_URL` set) Slack fires.
3. POST a fake missed-call payload and read the "Stand down (logged above)"
   path in the execution log — proving the quiet-hours / dedupe logic ran.

---

## Integration gaps to close when the transports land

Nothing below blocks the tool layer or the workflows importing; each is a stub
deliberately left until voice/WhatsApp is wired:

1. **`04-booking-failure-queue` trigger** — `book-appointment`'s failure paths
   don't POST to n8n yet. Add a fire-and-forget fetch (same pattern as
   `escalate`) to a new `N8N_BOOKING_FAILURE_WEBHOOK_URL`, body:
   `{ callId, phone, locationId, code, retryable, agentShouldSay, offeredSlotId }`.
2. **`02-post-call-processing` trigger** — the transport's call-ended webhook.
   The workflow's `Normalise the payload` node reads defensively; point the
   transport at `<n8n>/webhook/post-call`.
3. **`N8N_BOOKED_WEBHOOK_URL`** — declared in `.env.example` but never fired.
   Decide which workflow owns the booked-event (SMS confirmation/receipt) and
   fire it from `book-appointment`'s success path.
4. **01's `RESCUE_AGENT_URL`** — the endpoint that opens the WhatsApp/SMS
   thread. Set it when the messaging transport exists.

---

Verified against: `tsc --noEmit` and `next build` clean (7 API routes); the
five workflow JSONs import-shape-checked (valid nodes, valid connections).
