# shop desk — download and run it locally

Everything below was executed in this workspace against the packaged zip before being
written down. Total time from zero: about two minutes.

**Prerequisite: Node.js 22 or newer** (`node -v` must print `v22.x` or higher). No
database, no Docker, no build service, no internet access needed after `npm ci`. The app
ships a local file-backed store; MongoDB Atlas is optional and only needed for the
hosted/multi-writer deployment.

---

## Step 1 — Get the files

**The download page is on port 8080, at `/download`.** From the preview, open:

```
https://<your-preview-host>:8080/download
```

That page has a **⬇ shopdesk-app.zip** button, the archive's SHA-256, and a browsable
list of every file.

If the browser blocks the zip, use one of the fallbacks on the same page — all three are
the same source, byte for byte:

| Fallback | What to do |
| --- | --- |
| **All files as one text** (`/bundle.txt`) | Opens one text document containing every file, separated by `==== FILE: app/<path> ====` headers. Save it as `shopdesk-bundle.txt` and split it, or copy out the files you need. |
| **Single files** (`/files/<path>`) | Click any file in the tree (e.g. `server/api.js`) and copy its contents into a file of the same relative path under `app/`. |
| **Terminal download** | `curl -OJ https://<your-preview-host>:8080/shopdesk-app.zip` |

Verify what you got:

```bash
sha256sum shopdesk-app.zip        # macOS: shasum -a 256 shopdesk-app.zip
# 8b1327cf5d279c2a42261c668f1ccc705154a9262710f37fa3b4306010326341
```

> The archive holds **source only** — 89 entries, ~254 kB. It deliberately excludes
> `node_modules`, `dist` and any generated database, so you always build from source.

---

## Step 2 — Unzip and install

```bash
unzip shopdesk-app.zip
cd app
npm ci
npm run build
```

- `npm ci` installs exactly the locked dependency set (153 packages, ~2 s on a warm cache).
- `npm run build` writes the browser bundle to `dist/`. **Skipping this step gives you a
  page saying "The web bundle has not been built"** — the API still runs, but there is no
  interface.

---

## Step 3 — Start the server

```bash
SHOPDESK_DATA_DIR=./data npm start
```

Windows **PowerShell**:

```powershell
$env:SHOPDESK_DATA_DIR="./data"; npm start
```

Windows **cmd.exe**:

```bat
set SHOPDESK_DATA_DIR=./data && npm start
```

You should see:

```
[shop desk] listening on http://0.0.0.0:3000
[shop desk] store driver: file (data/shopdesk.json)
[shop desk] environment: development
[shop desk] first-run setup token (also stored in data/setup-token.txt):
             <a 32-character token>
[shop desk] tenants: 0 — open the app in a browser and complete the setup form on the sign-in screen
```

Notes:

- `.env.example` is **documentation, not auto-loaded** — this app reads real environment
  variables only, and has no secret in the browser bundle. Use `export`, or a tool like
  `dotenv-cli`, if you prefer a file.
- Pick a different port with `PORT=4000 npm start` (put `PORT` before the command).
- The setup token is printed once and also written to `<data dir>/setup-token.txt` with
  mode `0600`. Keep it; it is the only way to create the first workspace.

---

## Step 4 — Create your workspace (first run only)

Open **http://localhost:3000**.

Because this installation has no tenant yet, the sign-in screen *becomes* the setup form
(there is no separate `/setup` URL). Fill in:

| Field | Notes |
| --- | --- |
| Setup token | Paste the token printed by the server |
| Legal name / trade name | The registered entity and the brand customers see |
| Branch name, address | Your first branch |
| State code | Two digits, e.g. `09` for Uttar Pradesh — decides CGST+SGST vs IGST |
| GST profile | `regular`, `composition` or `unregistered` |
| GSTIN | Required for a regular profile |
| Identity evidence | A short note on what document you verified (minimum 8 characters) |
| Owner name, email, password | Password minimum 10 characters |

What you get: one tenant, one branch, your GST registration, the chart of accounts and
the legal-rule register — and **no business data at all**. Products, parties, pets,
stock, invoices and payments all start empty by design. Vendor master data, drug
catalogue items and treatment records are yours to enter.

---

## Step 5 — Optional: load the demo instead

If you would rather explore a populated workspace:

```bash
SHOPDESK_DATA_DIR=./data-demo npm run demo:seed   # refuses a non-empty directory
SHOPDESK_DATA_DIR=./data-demo npm start
```

Sign in with:

| Role | Email | Password |
| --- | --- | --- |
| Owner | `owner@demo.shopdesk.test` | `Demo-Owner-2026!` |
| Cashier | `cashier@demo.shopdesk.test` | `Demo-Staff-2026!` |
| Inventory operator | `inventory@demo.shopdesk.test` | `Demo-Staff-2026!` |
| Accountant | `accounts@demo.shopdesk.test` | `Demo-Staff-2026!` |

The demo tenant is flagged `sample: true` and every screen is labelled as demonstration
data. Use `npm run demo:seed -- --force` to reset it.

---

## Step 6 — Check it is healthy

```bash
npm test          # 42 tests: money, billing, API, durability, UI contract
npm run check     # 19 end-to-end self-checks against a live server
curl http://localhost:3000/api/v1/health
```

Expected locally: `pass 42`, `fail 0`; `19/19 self-checks passed`; and
`{"status":"ok","driver":"file",...}`.

---

## Common problems

| Symptom | Cause and fix |
| --- | --- |
| Page says "The web bundle has not been built" | Run `npm run build`, then restart the server |
| `ERR_MODULE_NOT_FOUND: express` | `node_modules` is missing — run `npm ci` in `app/` |
| `EADDRINUSE` | Port 3000 is taken — `PORT=4000 npm start` |
| Setup form says the token is invalid | You are using a stale token; read `<data dir>/setup-token.txt` for the current one |
| "Setup has already been completed" (409) | That data directory already has a tenant. Use a fresh `SHOPDESK_DATA_DIR`, or sign in |
| Server restarted and data vanished | You changed `SHOPDESK_DATA_DIR` between runs. The file store keeps one JSON file per directory |
| Print preview is blank or unstyled | Template HTML opens in a new tab; allow pop-ups for `localhost` |
| `npm test` fails with rate-limit errors | You edited tests without calling `resetRateLimits()`; see `tests/test-support.js` |

---

## Where things are

```
app/
  server/          API, records, domain rules (billing, inventory, returns, payments,
                   accounting, reports, outbox)
  src/             React interface (15 pages, role-gated navigation)
  tests/           42 tests
  tools/           self-check.js, demo-seed.js
  docs/            DATA_MODEL_AND_API.md, TRACEABILITY.md, LEGAL_ASSUMPTIONS.md,
                   RUNBOOK.md, LIMITATIONS.md
  dist/            built interface (generated by npm run build)
  .env.example     every setting, placeholders only
```

## Hosted / production deployment

The approved target is Vercel + MongoDB Atlas (a replica set — transactions are
required). See `app/docs/RUNBOOK.md` for the runbook and `app/vercel.json` +
`app/api/[...path].js` for the serverless adapter. It refuses to boot without
`MONGODB_URI`, so it cannot silently fall back to a local file.

## What is not covered

Read `app/docs/LIMITATIONS.md` and `app/docs/TRACEABILITY.md` §3 before relying on this
for live billing. Not exercised here: MongoDB Atlas, live payment gateways, real
printers, GST/e-invoice portal submission and MFA. Nothing in this package claims those
were tested. The legal rules ship as unverified references that you must review against
current law before the first real invoice — the app enforces fail-closed gates rather
than hiding them behind a disclaimer.
