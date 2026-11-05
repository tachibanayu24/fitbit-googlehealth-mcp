# fitbit-googlehealth-mcp

> A **Model Context Protocol (MCP) server** for your Google Health data (Fitbit's successor). Reads your health metrics and writes food, weight, activity and sleep logs. TypeScript, deployed to Cloudflare Workers, connected to Claude Desktop / mobile / claude.ai as a custom connector.

Built for single-user personal use: fork it and run it on your own Google Cloud project and Cloudflare account.

---

## Status — read this first

The legacy **Fitbit Web API (`api.fitbit.com`) is being decommissioned in September 2026**, and Google is no longer issuing new Fitbit developer accounts. This server therefore targets the **Google Health API** (`health.googleapis.com/v4`) by default.

| | |
|---|---|
| **Default backend** | Google Health API v4 (`HEALTH_PROVIDER=google`) |
| **Legacy backend** | Fitbit Web API, still present behind `HEALTH_PROVIDER=fitbit`, on borrowed time |
| **Written against** | v4 discovery document, revision **20260909** |

Verified against live Google Health data on 2026-09-10: all 17 read methods return real
values from a Fitbit Air. `pnpm run verify:provider` re-runs that check against your own
account, and `pnpm run probe:google` dumps the raw API shapes if you need to debug a
specific data type.

---

## What it does

- **Read** (16 tools) — activity and steps, heart rate (daily + intraday), sleep with stages, weight and body fat, food and water logs, SpO2, respiratory rate, skin temperature, HRV, VO2 max, paired devices.
Write, delete and meal-preset tools are **off by default** (see [Read-only by default](#read-only-by-default)).

- **Write** (7 tools) — food, water, weight, body fat, activity and sleep logs.
- **Delete** (6 tools) — remove individual entries.
- **Meal presets** (4 tools) — reusable nutrition profiles stored in Workers KV.
- **⭐ `log_meal_photo`** — attach a meal photo in Claude, Claude estimates the nutrition visually, and the items are written to your food log in one call.

---

## Prerequisites

- A **Google account** holding your health data (a Fitbit account merged into Google).
- A **Google Cloud project** with the Google Health API enabled — free.
- A **Cloudflare account** — the free plan is enough.
- A **Claude account** — custom connectors must be added from claude.ai on the web, then sync to mobile.
- **Node.js 20+** and **pnpm 11+** locally (`pnpm-workspace.yaml` uses `allowBuilds`).
- **macOS or Linux** for `setup:google` (it calls `pnpm` without a shell, which does not work on Windows).

You do **not** need a Fitbit developer account. If you already made one, it is only useful for the legacy `HEALTH_PROVIDER=fitbit` path, which stops working this month.

---

## Setup

### 1. Clone and install

```bash
git clone <your-fork-url>
cd fitbit-googlehealth-mcp
pnpm install
```

### 2. Create the Google Cloud project

1. **Create or pick a project** — https://console.cloud.google.com/projectcreate
2. **Enable the Google Health API** — https://console.cloud.google.com/apis/api/health.googleapis.com
3. **Configure the OAuth consent screen** — https://console.cloud.google.com/auth/audience
   - User type: **External**
   - Add your own Google account under **Test users**
   - **Publish the app so its status is "In production".** This matters: while the app sits in *Testing*, Google expires refresh tokens after **7 days**, and the Worker will break every week. Publishing does *not* require Google's security review — that is only needed above 100 users.
4. **Add the scopes** — https://console.cloud.google.com/auth/scopes — search "Google Health API" and add the **read** scopes for activity & fitness, health metrics & measurements, sleep, nutrition, profile and settings. Add the write scopes too only if you plan to use write tools (see [Read-only by default](#read-only-by-default)).
5. **Create an OAuth client ID** — https://console.cloud.google.com/apis/credentials
   - Application type: **Desktop app**
   - Copy the **Client ID** and **Client secret**

### 3. Prepare Cloudflare

```bash
pnpm wrangler login

cp wrangler.toml.example wrangler.toml
# then check TIMEZONE in wrangler.toml — it decides what "today" means for
# every tool with an optional date. Ships as "Europe/London".

pnpm wrangler kv namespace create TOKENS
pnpm wrangler kv namespace create CACHE
# paste the returned ids into wrangler.toml

pnpm wrangler secret put GOOGLE_CLIENT_ID
pnpm wrangler secret put GOOGLE_CLIENT_SECRET
```

Now create the shared secret. It is part of the connector URL, so it works like a password: save it in your password manager, then paste it at the prompt.

```bash
openssl rand -hex 32
pnpm wrangler secret put MCP_SHARED_SECRET
```

### 4. Authorize

Copy the template and paste your two values into it:

```bash
cp .env.example .env      # macOS / Linux / Git Bash
copy .env.example .env    # Windows cmd / PowerShell
```

```ini
# .env
GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret-here
```

No quotes, no trailing spaces. `.env` is gitignored. Then:

```bash
pnpm run setup:google
```

Your browser opens Google's consent screen. Approve it, and the script writes the tokens straight into the `TOKENS` KV namespace. It never prints them, so they do not end up in your shell history. Add `-- --write` to also request write scopes, or `-- --location` to allow TCX export (GPS routes).

<details>
<summary>Prefer environment variables to a file?</summary>

The script reads real environment variables first, so these work too — the syntax just differs per shell:

```powershell
# PowerShell
$env:GOOGLE_CLIENT_ID = "..."
$env:GOOGLE_CLIENT_SECRET = "..."
```
```bash
# bash / zsh / Git Bash
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
```
```bat
:: Windows cmd
set GOOGLE_CLIENT_ID=...
set GOOGLE_CLIENT_SECRET=...
```
</details>

Consent is collected here, in a real browser, on purpose: Google blocks OAuth inside embedded WebViews (`disallowed_useragent`), which is what Claude mobile would use.

### 5. Deploy

```bash
pnpm deploy
# → https://fitbit-googlehealth-mcp.<your-subdomain>.workers.dev
```

### 6. Add to an MCP client

1. On [claude.ai](https://claude.ai): Settings → Connectors → **Add custom connector** (or the equivalent in your MCP client)
2. URL: `https://fitbit-googlehealth-mcp.<your-subdomain>.workers.dev/mcp`
3. Authentication: a request header — `Authorization: Bearer <MCP_SHARED_SECRET>` (an `X-API-Key` header with the same secret also works)
4. Save; it syncs to Claude Desktop and mobile automatically

New connectors cannot be added from Claude mobile — use the web.

### Read-only by default

The server exposes only read tools, and `setup:google` asks Google only for read scopes. With no write scopes, Google itself rejects every write and delete, even if the connector URL leaks. To enable writes:

1. Run `pnpm run setup:google -- --write` and approve the extra scopes.
2. Set `ENABLE_WRITE_TOOLS = "true"` in `wrangler.toml`.
3. `pnpm deploy`.

### Keep the URL secret

The Anthropic CIDR allowlist lets through every Claude user, not only you. So the secret in the URL is the only thing that keeps others out. Do not paste the URL into chats or screenshots. `wrangler tail` and Cloudflare request logs also show the full path. If the URL leaks, rotate the secret with `wrangler secret put MCP_SHARED_SECRET` and update the connector.

---

## Where secrets live

Three separate places, for three separate purposes. This trips people up, so:

| Purpose | Where | How it gets there |
|---|---|---|
| Running the local helper scripts (`setup:google`, `probe:google`) | `.env` in the repo root | You create it from `.env.example`. Gitignored. |
| The **deployed** Worker on Cloudflare | Cloudflare Workers Secrets | `pnpm wrangler secret put GOOGLE_CLIENT_ID` — encrypted at rest, never in the repo |
| Running the Worker locally with `pnpm dev` | `.dev.vars` in the repo root | You create it. Gitignored. |

The deployed Worker **never reads `.env`** — Cloudflare doesn't upload it. If you skip
`wrangler secret put`, the Worker deploys fine and then fails at runtime with a
`GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set` error.

Your Google **refresh token** is not in any of these. It lives in the Workers KV `TOKENS`
namespace, put there by `setup:google` in step 4.

## Verifying

```bash
# against the token the deployed Worker is using (the token is not echoed)
GOOGLE_ACCESS_TOKEN=$(pnpm -s wrangler kv key get --remote --binding=TOKENS google_access_token) \
  pnpm run probe:google
```

The probe is read-only. For each endpoint it prints `✓` with the value fields that came back, `·` if reachable but empty, or `✗` with the API's error. A `403` means that scope was not granted — add it on the Data Access page and re-run `setup:google`.

To check the provider itself rather than the raw API — that every read method returns
sensible values, not `undefined` from a wrong field path:

```bash
GOOGLE_ACCESS_TOKEN=$(pnpm -s wrangler kv key get --remote --binding=TOKENS google_access_token) \
  pnpm run verify:provider
```

It calls all 17 read methods against your live account and prints a preview of each
result. Read-only; it never writes or deletes. The stored access token lasts about an
hour; if it returns 401, call any tool through Claude once so the Worker refreshes it.

---

## Tools

### Read (19)

| Tool | Arguments | Notes |
|---|---|---|
| `get_profile` | — | Identity, units, timezone |
| `list_devices` | — | Paired devices, battery, last sync |
| `get_daily_summary` | `date?` | Steps, calories, distance, active minutes, resting HR |
| `get_activity_timeseries` | `resource, start, end` | steps / distance / calories / floors / active-minute levels |
| `get_exercise_list` | `from?, to?, beforeDate?, limit?, min_duration_seconds?` | Workout sessions with UTC and local times, active duration, GPS and lap flags. Records shorter than `min_duration_seconds` (default 60) are hidden; with `0`, records under 60 s come back with `suspected_accidental: true` |
| `get_heart_rate_range` | `start, end` | Daily resting heart rate and heart-rate zones with bounds |
| `get_heart_rate_intraday` | `date, detailLevel, start_time?, end_time?, fields?` | One local day, 00:00–24:00 in the profile timezone, or a part of it (`HH:MM`). `1sec` returns every raw sample (about one every 2–5 s); a full day is about 3 MB, so narrow it or use `fields: compact` |
| `get_heart_rate_range_intraday` | `start, end, resolution?, fields?` | Any window up to 24 h. `start`/`end` need an offset (`+05:00` or `Z`); `end` is inclusive to the second. Resolution `raw` (default), `5s`, `15s`, `1min`; buckets carry avg, min and max |
| `get_exercise_heart_rate` | `exerciseId? \| logId + date?, resolution?, padding_minutes?, max_hr?, custom_zones?, plan?, work_label?, include_points?, fields?` | Heart rate of one workout: series (default `5s`), summary with the longest gap, time in zones, events, laps, and heart rate per plan segment with HRR60 |
| `export_exercise_tcx` | `exerciseId? \| logId + date?, partial_data?, max_chars?` | Garmin TCX file of a workout. Needs the optional location scope, see below |
| `get_sleep` | `date?` | Sessions with stage breakdown |
| `get_sleep_range` | `start, end` | |
| `get_body_log` | `start, end` | Weight and body fat |
| `get_food_log` | `date?` | Food and water with macros |
| `get_spo2` | `start, end` | |
| `get_respiratory_rate` | `start, end` | |
| `get_skin_temperature` | `start, end` | Deviation from baseline |
| `get_hrv` | `start, end` | |
| `get_cardio_fitness` | `date?` | VO2 max |

### Notes on heart-rate tools

- **Every time comes as a pair:** `time_utc` (`…Z`) and `time_local` (wall clock with its offset). The timezone comes from the Google profile settings.
- **Zone bounds are computed.** The API reports zone minutes but no bpm bounds. The server uses the Fitbit Karvonen method: Fat Burn from 40 %, Cardio from 60 %, Peak from 85 % of heart-rate reserve (max − resting). Max is `max_hr` if you pass it, else 220 − age from the profile; resting is the latest resting heart rate up to that day (7-day lookback; in `get_heart_rate_range`, that day's own value). If max − resting is below 20 bpm, the server gives no bounds. Such zones carry `source: "computed"`. The top zone (Peak, Bevel Zone 5) ends at max heart rate.
- **Out of Range minutes are computed.** Google gives zone minutes only for Fat Burn, Cardio and Peak (`minutesSource: "google"`). The server counts the minutes with heart-rate data from a 1-minute rollup; Out of Range = those minutes minus the other three zones (`minutesSource: "computed"`). `minutesWithoutHeartRate` is the rest of the day, so all zone minutes plus it equal the day length (for today, the minutes so far). If Google zone minutes are more than the minutes with data, Out of Range is 0 and the sum is a little longer. On live data these bounds match the zone times Google stores with a workout to within about a minute.
- **Zones in `get_exercise_heart_rate`.** `timeInZones` uses the bounds above. `zones.google` holds the zone times that Google stores with the workout (whole minutes). `zones.bevel` uses the Bevel default: percent of max heart rate (restorative < 50 %, zones 1–5 from 50/60/70/80/90 %, rounded up like the Bevel app). `custom_zones` takes your own lower bounds (for example from your app) and gives `zones.custom`: each zone ends 1 bpm below the next one, the last one at max heart rate, and time below the first bound goes to an extra zone "Below <first name>". Time in zone is weighted by the gap to the next sample; a gap counts at most 30 s.
- **Plan segments in `get_exercise_heart_rate`.** `plan` is a workout plan such as `5w 3r [3r 3w]x4 8w 5w`: a number is minutes (`1.5r` or `1:30r` = 90 s), letters are a label, and `[ ... ]xN` repeats a group. Segments follow each other from the workout start in active time, so pauses are skipped, and samples recorded during a pause are left out; a segment that the workout cuts short has `cutShort: true`, and `unplannedTailSec` is the workout time after the plan. Each segment has `peak`, `avg`, `min` and `end` (its last sample). `plan.recovery.hrr60` is the drop from the last sample of the last `work_label` segment (default `r`, case does not matter) to the sample nearest to 60 s later. With `include_points: false`, the answer has no series and stays small.
- **`fields: compact`** sends points as `[time_local, bpm]` without the offset and gives the offset once as `utcOffset`. It is about 4 times smaller.
- **Cache.** Past days are cached for 1 hour, today and later for 5 minutes.
- **TCX needs one more scope.** Run `pnpm run setup:google -- --location` to add `googlehealth.location.readonly`, and add that scope on the Data Access page of your OAuth consent screen. Without it, `export_exercise_tcx` returns HTTP 403 with a hint.

### Write (7)

`log_food` · `log_meal_photo` · `log_water` · `log_weight` · `log_body_fat` · `log_activity` · `log_sleep`

### Delete (6)

`delete_food_log` · `delete_water_log` · `delete_weight_log` · `delete_body_fat_log` · `delete_activity_log` · `delete_sleep_log`

### Meal presets (4)

`save_meal_preset` · `list_meal_presets` · `log_preset` · `delete_meal_preset`

33 tools total; 16 by default, because write, delete and preset tools need `ENABLE_WRITE_TOOLS = "true"`. Every optional `date` falls back to today.

---

## Insights and dashboard

For the Google provider, the server also registers four Whoop-style insight tools
(`get_whoop_scores`, `get_day_snapshot`, `get_trends`, `get_body_age`) built from the read
data, plus a password-protected mobile dashboard at `/app` (`DASHBOARD_PASSWORD` secret).
Two optional settings shape them, both settable in `wrangler.toml`:

| Variable | Default | Effect |
|---|---|---|
| `TIMEZONE` | UTC | What "today" means for the report and every optional `date` |
| `BIRTH_DATE` | unset | `YYYY-MM-DD`. When set, the report shows real and body age, the age HRV norm and the age VO2 estimate. When unset, all age-based output is skipped |
| `SLEEP_WAKE_TIME` | `07:00` | `HH:MM` default wake-up alarm used by the sleep plan and bedtime planner |

---

## Architecture

```
Claude mobile / Desktop / Web
      │ (public URL, Streamable HTTP)
      ▼
Anthropic Cloud  (outbound CIDR 160.79.104.0/21)
      │
      ▼
Cloudflare Workers  /mcp
  ├─ guard middleware  (bearer secret + CIDR allowlist)
  ├─ @hono/mcp  Streamable HTTP transport
  └─ McpServer
       ├─ HealthProvider interface
       │   ├─ GoogleHealthProvider   ← default
       │   │   ├─ Google OAuth refresh (Workers KV: TOKENS)
       │   │   └─ GoogleHealthClient (pagination, 401/429 retry)
       │   └─ FitbitProvider          ← legacy, sunsetting
       └─ tools/read/*, tools/write/*
            └─ getCached → Workers KV: CACHE  (TTL 1h)
```

Images never reach the server: Claude analyses the photo and passes structured `items[]`.

---

## Notes on the Google Health API

Things that differ from Fitbit and cost time if you hit them cold:

- **Every `int64` field is serialised as a string.** `{"count": "1250"}`, not `1250`.
- **Filter literals differ by time field.** Civil (wall-clock) times take **no** `Z`; physical instants **require** one; daily types take a bare `YYYY-MM-DD`.
- **Ranges are closed-open.** The API supports only `>=` and `<`, so an inclusive end date has to be advanced by a day.
- **`sleep` filters on end time only** (`sleep.interval.civil_end_time`).
- **Rollups return `rollupDataPoints`**, not `dataPoints`, and paginate by re-POSTing the body with a `pageToken`.
- **`windowSizeDays` is documented as optional but is required** — omitting it returns HTTP 400.
- **Rollup ranges are capped**: 14 days for heart rate, total calories, active minutes and calories-in-HR-zone; 90 days for everything else.
- **List pages cap at 25 rows** for sleep and exercise, 10000 elsewhere.
- **No intraday detail levels.** Google exposes raw samples (about one every 2–5 s); the heart-rate tools bucket them client-side.
- **Skin temperature is absolute °C** plus a baseline; Fitbit reported only the deviation, so this server derives it.
- **Nutrient enum is `SUGAR`, singular.** Fat and carbohydrate are top-level `totalFat` / `totalCarbohydrate` fields, not `nutrients[]` entries.
- **Delete takes a resource name, not an id.** The numeric `logId` in these tools is a stable hash of that name, resolved by scanning the last 35 days.
- **A DataPoint nests its values under a camelCase key** named for the data type, so a
  `daily-resting-heart-rate` row arrives as `{dailyRestingHeartRate: {...}}`. Reading the
  top level typechecks fine and yields `undefined` for every field.
- **Rollup buckets are dated by `civilStartTime`,** not `date`.
- **`activity-level` supports neither rollup verb** — the periods must be listed and
  summed client-side.
- **`active-zone-minutes` rollups carry flat `sumIn<Zone>HeartZone` keys,** not an array
  of zone objects, and no zone bounds.
- **Instant-valued types are filtered in true UTC,** so selecting a local day means
  converting local midnight to UTC first — not using UTC midnight.

---

## Security

Single-user design, two layers:

1. `MCP_SHARED_SECRET` must be presented on every request — as an `Authorization: Bearer` header or an `X-API-Key` header — or 401.
2. `CF-Connecting-IP` must fall inside `ALLOWED_CIDRS`, or 403. Anthropic's published outbound range is `160.79.104.0/21`.

`MCP_SHARED_SECRET` lives in Workers Secrets, never in code. Rotating it is `wrangler secret put` plus updating the connector; your Google tokens are unaffected.

**Threat model:** if the secret leaks *and* the attacker can reach you from inside Anthropic's CIDR, they can read your health data (and write false entries, if you enabled write scopes). Note that every Claude user comes from that CIDR. They cannot take over the Google account — the refresh token stays in the Worker.

---

## Local development

```bash
echo 'MCP_SHARED_SECRET=dev-secret' > .dev.vars
pnpm dev

pnpm lint
pnpm typecheck
pnpm test
```

---

## Development notes

- [`docs/research.md`](docs/research.md) — original design research (Japanese), including the Fitbit-era API findings
- [`docs/journal.md`](docs/journal.md) — development log (Japanese)
- [`scripts/probe-google-health.ts`](scripts/probe-google-health.ts) — ground-truth probe against the live API
- [`scripts/diagnose-food-log.ts`](scripts/diagnose-food-log.ts) — legacy Fitbit food-log reproducer

## Hosted pages

GitHub Pages serves the three URLs Google's OAuth consent screen requires:

| Field on the consent screen | URL |
|---|---|
| Application home page | `https://<your-username>.github.io/google-health-mcp/` |
| Privacy policy link | `https://<your-username>.github.io/google-health-mcp/privacy.html` |
| Terms of service link | `https://<your-username>.github.io/google-health-mcp/terms.html` |

If you fork this repo, enable GitHub Pages (branch `main`, folder `/docs`) and
use your own `<user>.github.io` URLs. Add `<user>.github.io` under
**Authorized domains** on the same screen. Sources are in
[`docs/`](docs/).

## Credits

Derived from [tachibanayu24/fitbit-googlehealth-mcp](https://github.com/tachibanayu24/fitbit-googlehealth-mcp)
(MIT), which implemented the original Fitbit Web API server. The Google Health API provider,
the timezone handling and the OAuth bootstrap for Google are additions.

## License

[MIT](LICENSE)
