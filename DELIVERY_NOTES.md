# shop desk — delivery notes

Handover notes for this branch. The application itself lives in [`app/`](app/README.md);
the governing specification is the rest of this repository.

## What is running in the sandbox

| Port | Process | Serves |
| --- | --- | --- |
| 8080 | `tools/preview-server.mjs` | **Preview gateway** — the app at `/`, downloads under `/download` |
| 3000 | `app/server/index.js` | The API + built SPA (upstream for the gateway) |

Start them with:

```bash
# app (from app/)
SHOPDESK_DATA_DIR=./data-demo PORT=3000 node server/index.js

# gateway (from repo root)
PORT=8080 node tools/preview-server.mjs
```

The gateway forwards requests verbatim (including the browser's `Host`) so the API's
same-origin check keeps working behind the preview proxy. It adds no business logic.

### Routes on 8080

| Path | Result |
| --- | --- |
| `/`, `/billing`, `/reports`, … | the app — SPA deep links return the shell, assets are served from `app/dist` |
| `/api/v1/*` | the API |
| `/download` | download page: archive button, SHA-256, file tree |
| `/shopdesk-app.zip` | the archive as an attachment |
| `/bundle.txt` | every source file concatenated as one text document |
| `/files/<path>` | one source file as `text/plain` (path traversal rejected) |

## Demo sign-in

The preview runs on the `data-demo` workspace, which is **not** the default for a new
install. New tenants start empty; see `app/docs/RUNBOOK.md`.

- Owner — `owner@demo.shopdesk.test` / `Demo-Owner-2026!`
- Cashier — `cashier@demo.shopdesk.test` / `Demo-Staff-2026!`
- Inventory operator — `inventory@demo.shopdesk.test` / `Demo-Staff-2026!`
- Accountant — `accounts@demo.shopdesk.test` / `Demo-Staff-2026!`

Tenant: **The Good Vets**, branch: **Main branch**.

## Package

`shopdesk-app.zip` — 89 entries, 259,616 bytes, excludes `node_modules`, `dist`,
`data-demo`.

```
SHA-256  a222bd9d21db5cd582b05d7bb1135118e20c52e12a75858449ab9053ecbaf67d
```

```bash
unzip shopdesk-app.zip && cd app
npm ci && npm run build
SHOPDESK_DATA_DIR=./data npm start      # then open http://localhost:3000/setup
```

## Verification performed on this branch

Executed in this workspace, on Node 22.22.3 / npm 10.9.8:

| Check | Command | Result |
| --- | --- | --- |
| Unit + integration + UI-contract tests | `npm test` (in `app/`) | 42 passed, 0 failed |
| End-to-end self-check against a live server | `node tools/self-check.js` | 19/19 passed |
| Production build | `npm run build` | success, `dist` 340 kB |
| Zip integrity | `unzip -t shopdesk-app.zip` | no errors |
| Clean-room install | extract to a scratch dir → `npm ci` → test → self-check → build | all green (153 packages) |
| Gateway: SPA shell, assets, deep links | `GET /`, `/billing`, `/reports`, `/assets/*` via :8080 | 200 |
| Gateway: all 12 report tabs | `GET /api/v1/reports/<tab>?preset=month` via :8080 | 12 × 200 |
| Gateway: sign-in as owner over the preview host | `POST /api/v1/login` with preview `Host`/`Origin` | 200, session `authenticated: true`, nav 14 |
| Gateway: archive + bundle + single file | `GET /shopdesk-app.zip`, `/bundle.txt`, `/files/server/api.js` | 200, byte counts match, zip verifies |
| Bad period input | `?preset=bogus`, `?from=xx` | `400 INVALID_PERIOD` / `400 INVALID_DATE` |

Not executed here: MongoDB Atlas, live payment gateways, real printers, GST/e-invoice
portal submission, MFA. They are listed with reasons in `app/docs/TRACEABILITY.md` §3
and `app/docs/LIMITATIONS.md`. Nothing in this repository claims those were run.

## Change in this branch's final pass

`app/server/time.js` — an unknown period preset or a malformed business date used to
raise a generic `Error`, which surfaced as `500 INTERNAL_ERROR`. It now raises a
`400` with `INVALID_PERIOD` / `INVALID_DATE` and lists the accepted presets. Covered by
the existing `time:` test and re-verified over the gateway.
