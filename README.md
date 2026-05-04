# Civara

CRM built for UK employability charities, repair cafés, and community organisations. Track participants, generate funder reports (MoJ, GLA, CBF), find live funding opportunities, and prove impact.

## Stack

- **Frontend:** Plain HTML / CSS / vanilla JavaScript. No build step.
- **Hosting:** Vercel (static)
- **Database & Auth:** Supabase (PostgreSQL with RLS)
- **AI:** Anthropic Claude API, called via `/api/claude` proxy

## Project Structure

```
/
├── *.html                 ← top-level pages (index, login, app, partner, etc.)
├── css/
│   └── app.css            ← styles for the main CRM (app.html)
├── js/
│   ├── config.js          ← Supabase keys, constants  (load order matters →)
│   ├── utils.js           ← shared helpers
│   ├── db.js              ← Supabase wrappers + DB cache
│   ├── auth.js            ← session, RBAC, org switching
│   ├── agents.js          ← Claude API + AI agents
│   ├── render.js          ← page render functions
│   ├── modals.js          ← modal open/save/delete handlers
│   ├── branding.js        ← logo + colour customisation
│   ├── demo.js            ← demo data toggle
│   ├── router.js          ← page navigation
│   ├── boot.js            ← entry point — runs last
│   └── extensions/        ← features added after core (independent modules)
│       ├── demographics.js
│       ├── csv-import.js
│       ├── reporting-periods.js
│       └── opportunities.js
└── logo.png
```

## Running locally

This is a static site. You can:

- Open `index.html` directly in a browser, OR
- Use any static file server: `npx serve` or `python3 -m http.server`

There's no build step. Edit a file, refresh the browser.

## Deploying

Push to GitHub. Vercel auto-deploys on every push to `main`.

## Pages

- `index.html` — marketing landing page
- `login.html` — sign in / sign up
- `app.html` — main CRM (most code lives here)
- `partner.html` — partner referral portal
- `team.html` — team management within an org
- `invite.html` — invitation acceptance
- `settings.html` — org-level settings
- `admin.html` — single-org admin
- `super-admin.html` — Civara staff admin (across all orgs)

## Database tables

Key tables in Supabase:

- `organisations` — every org
- `memberships` — user ↔ org with role (manager / advisor / admin)
- `super_admins` — Civara staff
- `participants`, `events`, `feedback`, `volunteers`, `contracts`, `funders`, `employers`, `partner_referrals`, `circular_items`, `evidence`, `referrals`, `contacts`, `invitations`, `partner_profiles`

Every table has an `org_id` column and is filtered through Row Level Security.

## AI agents

The `js/agents.js` file calls Claude via a server-side `/api/claude` route (you'll need to set this up if you fork this — it's not in this repo). It accepts:

```json
{
  "model": "claude-haiku-4-5-20251001",
  "max_tokens": 600,
  "system": "...",
  "messages": [{ "role": "user", "content": "..." }],
  "web_search": false
}
```

…and forwards to the Anthropic API with your `ANTHROPIC_API_KEY`.

## Adding a new page or feature

1. Add the HTML to `app.html` inside `<div id="page-yourname" class="page">`
2. Add a render function in `js/render.js` called `renderYourname()`
3. Add a route in `js/router.js` inside the `renders` object in `go()`
4. Add a sidebar nav button in `app.html`

## Common tasks

**Add a new field to participants:**
1. Add column to `participants` table in Supabase
2. Update `syncAll()` in `js/db.js` to read it
3. Add the input to `modal-p` in `app.html`
4. Read/write it in `openAddP`, `openEditP`, `saveP` in `js/modals.js`

**Add a new AI agent:**
1. Write a new `runXxxAgent()` function in `js/agents.js`
2. Use the `runAgent({ container, headerLabel, headerSub, steps, sys, prompt })` helper
3. Wire it to a button somewhere

# Sentinel — back-office ops layer

## What it is
A super-admin-only AI dashboard at /super-admin.html → 🎯 Sentinel.
Generates a daily morning briefing across all your customers and queues
churn-risk decisions for your approval.

## Setup
1. Run `supabase-sentinel-schema.sql` once in Supabase SQL Editor.
2. Confirm these env vars exist in Vercel (Production scope):
   - SUPABASE_URL
   - SUPABASE_SERVICE_ROLE_KEY
   - ANTHROPIC_API_KEY
3. Optional: set CRON_SECRET in Vercel and use `Authorization: Bearer <secret>` 
   if you want to protect the endpoint from random hits.
4. Deploy.

## First run
Sign in to /super-admin.html, click 🎯 Sentinel, then "⚡ Run agents now".
Wait ~15 seconds. You should see the briefing card and any churn decisions.

## Daily schedule
With vercel.json updated, /api/sentinel-cron runs at 06:00 UTC daily.

## Cost
~£0.005-0.01 per run on Claude Haiku 4.5. About 30p/month if you only have 
the cron firing once a day.

## Adding agents
Sentinel currently runs two agents:
- Chief of Staff briefing — generates the daily narrative
- Churn detector — flags inactive paying customers

To add more, edit /api/sentinel-cron.js and add a new async function 
following the same pattern as runChurnDetector. Call it in the handler. 
Decisions go to sentinel_decisions, briefings to sentinel_briefings.

## If something breaks
- Briefing missing → check Vercel function logs for /api/sentinel-cron
- "Not authorized" → check super_admins table contains your user_id
- Empty briefing narrative → Claude API key issue, check ANTHROPIC_API_KEY
- "Run failed" alert → check browser console for the underlying error
## License

Proprietary. © Civara.
