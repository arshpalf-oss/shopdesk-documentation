# Runbook — shop desk

Operational instructions for running, backing up, restoring and recovering the application.
Nothing in this file was executed against production; steps that require infrastructure are
marked **[requires infrastructure]** and must be rehearsed before go-live.

## 1. Local run

```bash
npm install                 # installs express, mongodb, react, vite, zod
npm run build               # builds dist/ (SPA served by the Node process)
SHOPDESK_DATA_DIR=./data npm start          # http://localhost:3000
```

First run prints a setup token and writes `$SHOPDESK_DATA_DIR/setup-token.txt` (mode 0600).
Use it once on the **First-run setup** screen. A tenant, its branch, chart of accounts and
legal register are created; **no** products, parties, pets, stock or invoices are created.

Development with two processes (Vite proxies `/api` to the API — keep it same-origin):

```bash
npm run dev:api     # API on :3000
npm run dev:web     # Vite on :5173, proxies /api
```

Demo data is opt-in and isolated from real data:

```bash
SHOPDESK_DATA_DIR=./data-demo npm run demo:seed          # refuses a non-empty directory
SHOPDESK_DATA_DIR=./data-demo npm run demo:seed -- --force
```
Demo logins: `owner@demo.shopdesk.test / Demo-Owner-2026!`, plus cashier, inventory and
accountant accounts with `Demo-Staff-2026!`. The workspace is flagged `sample: true` and the
UI labels it.

## 2. Configuration

Copy `.env.example` and fill in real values. Never commit `.env`.

| Variable | Meaning |
| --- | --- |
| `MONGODB_URI` | Atlas connection string (replica set required for transactions). Empty ⇒ file driver. |
| `MONGODB_DB` | Database name (default `shopdesk`) |
| `SHOPDESK_DATA_DIR` | File-driver data directory and setup-token location |
| `SHOPDESK_SETUP_TOKEN` | Pin the first-run token instead of generating one |
| `SHOPDESK_SESSION_HOURS` | Session lifetime (default 12) |
| `SHOPDESK_SECURE_COOKIES` | Force `Secure` cookies (automatic when `NODE_ENV=production`) |
| `SHOPDESK_TRUST_PROXY` | Trust `X-Forwarded-*` (only behind a known proxy) |
| `SHOPDESK_CRON_SECRET` | Required for `POST /api/v1/cron/jobs` |
| `SHOPDESK_DEV_EXPOSE_SETUP_TOKEN` | Development only; must stay `0` in production |

## 3. Deploy to Vercel + Atlas **[requires infrastructure]**

1. Create an Atlas cluster **in an India region** with a replica set (transactions).
2. Database user with `readWrite` on the app database only; IP access list restricted to
   Vercel egress (or private endpoint). TLS is mandatory.
3. Create the database and apply index/validator migrations:
   ```bash
   MONGODB_URI=... node tools/self-check.js   # idempotent; also proves connectivity
   ```
   (A dedicated `tools/migrate.js` is not yet written — see `LIMITATIONS.md`.)
4. Import the project into Vercel. Build `npm run build`, output `dist`,
   function `api/[...path].js` (already in `vercel.json`).
5. Environment variables from §2. Keep `SHOPDESK_DEV_EXPOSE_SETUP_TOKEN=0`.
6. Run first-run setup once via the printed token. Confirm `tenants: 1` and an empty catalogue.
7. Configure the Vercel Cron entry (`*/5 * * * *` → `/api/v1/cron/jobs`) with
   `Authorization: Bearer $SHOPDESK_CRON_SECRET`.
8. Smoke test: sign in with each role, issue a ₹0-value bill against a test product, reprint it
   in all five templates, confirm the audit trail shows the print and no journal moved.
9. Record the go/no-go entry using the template in `TRACEABILITY.md` §4.

Serverless has no local disk: **the file driver is not usable on Vercel**. `api/[...path].js`
refuses to start without `MONGODB_URI`.

## 4. Backup and restore **[requires infrastructure]**

- Atlas continuous backup with point-in-time recovery; daily snapshot retention ≥ 35 days
  (align with GST 72-month retention for exported archives, not for snapshots).
- Export a portable copy monthly:
  ```bash
  mongodump --uri "$MONGODB_URI" --archive=shopdesk-$(date +%F).archive --gzip
  ```
- Restore rehearsal (quarterly, in an isolated project):
  1. `mongorestore --uri "$STAGING_URI" --archive=... --gzip --nsFrom='shopdesk.*' --nsTo='staging.*'`
  2. Run `node tools/self-check.js` against staging and compare trial balance, stock valuation
     and the highest issued number per series with the source system.
  3. Revoke all sessions in the restored copy (`sessions.revokedAt = now`) before anyone logs in.
  4. Re-enable issuing only after the number fence (§5) is confirmed.
- File-driver deployments: copy `shopdesk.json` while the process is stopped; the file is
  written atomically (temp file + `fsync` + `rename`), so a running copy is usually consistent
  but is not a substitute for a stopped copy.

## 5. Number fence after any restore or failover

Legal numbers must never be reissued. After restoring into a new environment:

1. Read `sequences` for every `(registrationId, fy, series)`.
2. Also read the highest `number` actually present in `financial_documents`, `returns` and
   `purchases`.
3. If any sequence counter is **lower** than the highest number in a document collection,
   raise the counter before allowing new issues:
   ```js
   // run in a maintenance shell, inside a transaction
   db.sequences.updateOne({ _id: '<seq-id>' }, { $set: { counter: <highestIssued> } })
   ```
4. Confirm the next issued number is higher than every number in that series before reopening
   the counter.

## 6. Cash close and daily routine

End of day, per branch:

1. **Payments & cash close** → counted cash vs expected. Expected = opening + confirmed cash
   receipts − cash refunds − receipt reversals. A variance requires a written reason; it is
   stored on the close and in the audit trail.
2. Confirm no `payment_intents` are left `pending` without a matching settlement.
3. Check **Overview** alerts (out of stock, expiring within 60 days).
4. Check **Settings → Compliance readiness** for new blockers.
5. Export the day book CSV if the accountant wants a paper trail (export is audited).

## 7. Month close

1. Reconcile: **Accounts → Reconciliation** must show no `critical` findings. A
   `INVENTORY_VS_GL` or `RECEIVABLE_SUBLEDGER` difference must be explained, not silenced.
2. Review input tax: every supplier bill should leave `pending_review`.
3. Lock the month: **Accounts → Period locks**. Later postings dated inside a locked month are
   refused until the lock is reopened with a reason (audited).
4. Generate GSTR-1 and GSTR-3B working papers. They are labelled working papers; they are not
   filed returns and contain no portal JSON.

## 8. Incident response

| Situation | First action |
| --- | --- |
| Suspected data tampering | `GET /api/v1/audit/verify`; if invalid, freeze issuing, snapshot the database, start the privacy/security process. |
| Wrong bill issued | Do **not** edit it. Issue a credit note (ineligible GST → commercial only) and a separate refund if money moved. |
| Duplicate submission / timeout | Look up the key with `GET /api/v1/operations/:key`; retry **only** with the same key, or start a new draft after confirming nothing posted. |
| Oversell reported | Check `inventory_movements` for the batch; stock is CAS-guarded, so the report is more likely a stale screen than a real oversell. |
| Staff devices lost | Disable the membership in **Staff & permissions** — the live session stops working on the next request. |
| Cron/outbox stuck | Check `outbox_jobs` for `status`/`lastError`; expired leases are reclaimable. Re-run `POST /api/v1/cron/jobs` with the secret. |
| Password/credential leak | Rotate `SHOPDESK_CRON_SECRET`, `SHOPDESK_SETUP_TOKEN`, Atlas credentials; revoke sessions (all `sessions.revokedAt`). No application-level encryption keys exist to rotate. |
| CERT-In reportable incident | 6-hour reporting clock from awareness; preserve logs (180-day retention target). **[requires infrastructure]** |

## 9. Upgrades

1. Read the diff of `server/store/indexes.js` and any domain invariant changes.
2. Take a snapshot.
3. Deploy to staging, run `npm test` and `npm run check` there.
4. Reconcile staging (trial balance, valuation, numbering).
5. Deploy to production, then re-run the §5 number fence check and a single test issue in a
   sandbox tenant — never in the live tenant.
