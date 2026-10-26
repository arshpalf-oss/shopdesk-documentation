# shop desk

Multi-tenant veterinary **billing, inventory and double-entry accounting** for clinics.
“The Good Vets” is the demo tenant's brand; the software is **shop desk**.

Built to the specification pack in the parent directory
(`MASTER_IMPLEMENTATION_PROMPT.md`, `ARCHITECTURE_AND_BUILD_GUIDE.md`,
`TEST_ACCEPTANCE_AND_TRACEABILITY.md`, `INDIA_LEGAL_AND_RELEASE_MATRIX.md`,
`PRODUCT_OVERVIEW_AND_USER_GUIDE.md`, `VERCEL_ATLAS_OPERATIONS.md`,
`reference/Legal-Notes-user-supplied.txt`). Scope is billing and inventory plus full
accounting. Clinical authoring, payroll, consolidation, income-tax filing and statutory audit
are out of scope.

## Quick start

```bash
npm install
npm run build                 # build the SPA into dist/
SHOPDESK_DATA_DIR=./data npm start        # http://localhost:3000
```

The first run prints a setup token (also in `$SHOPDESK_DATA_DIR/setup-token.txt`). Complete
**First-run setup** with it. The new workspace contains one branch, a chart of accounts and the
legal-assumption register — and **no** products, parties, pets, stock or bills.

Want to look around with sample data? Use a separate directory:

```bash
SHOPDESK_DATA_DIR=./data-demo npm run demo:seed
SHOPDESK_DATA_DIR=./data-demo npm start    # owner@demo.shopdesk.test / Demo-Owner-2026!
```

Demo accounts: `owner@`, `cashier@`, `inventory@`, `accounts@demo.shopdesk.test`
(staff password `Demo-Staff-2026!`). The workspace is flagged `sample`.

Development (two processes, same-origin via the Vite proxy):

```bash
npm run dev:api      # API on :3000
npm run dev:web      # UI on :5173
```

Production target is Vercel + MongoDB Atlas — see `docs/RUNBOOK.md` §3.

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | API + built SPA on one port |
| `npm run dev:api` / `dev:web` | watch-mode API / Vite dev server |
| `npm run build` | build the React app |
| `npm test` | 42 automated checks (`node:test`) |
| `npm run check` | 19-step end-to-end self-check with printed evidence |
| `npm run demo:seed` | opt-in sample workspace (refuses non-empty data dirs) |

## What it does

- **Billing**: draft → server quote → finalize. FEFO batch allocation, no negative stock,
  legal numbers assigned server-side inside the transaction, idempotent finalize with a quote
  hash so a changed price is never silently charged.
- **Printing**: A4 Corporate / Classic / Compact and 58 mm / 80 mm thermal, rendered from the
  immutable snapshot. Reprints are audited and change nothing.
- **Returns**: cumulative per-line/per-batch entitlement, no restock by default, separate
  commercial credit vs GST adjustment, separate permissioned refunds, s.34 cut-off handling.
- **Inventory**: batches with expiry precision, quarantine/recall status, approved
  adjustments, write-offs, cold-chain verification flag.
- **Purchases**: supplier bills with duplicate detection, pending input-tax review, supplier
  returns and credit notes.
- **Money**: confirmed receipts, reversals, pending attempts, cash close with variance reason,
  ₹2,00,000 cash-receipt gate.
- **Accounts**: balanced source-unique journals, trial balance, P&L, balance sheet,
  reconciliation, manual journals, expenses, openings, period locks.
- **Reports**: twelve core tabs (Summary, Day book, Products, Categories, Cashiers, Payments,
  GST, GSTR-1, GSTR-3B, Stock, Receivables, Stock log) plus reviewer extras, presets and custom
  ranges, permissioned CSV, working-paper labels.
- **Governance**: append-only hash-chained audit trail, legal-assumption register with reviewer
  and evidence, compliance readiness blockers, role matrix with quantity-only roles.

## Roles

| Role | Can |
| --- | --- |
| Owner | Everything in the tenant, including settings, staff, audit |
| Manager | Day-to-day operations; no settings/staff/audit/accounts posting |
| Cashier | Bill, print, record receipts, cash close; **no cost fields, no refunds, no returns** |
| Inventory operator | Products, purchases, batch status, adjustments; **quantity only, no cost** |
| Accountant | Read everything financial, post/reverse journals, review input tax, export reports |
| Platform operator | Tenant lifecycle only; no clinic data |

Permissions are enforced in the API. Hiding a button is never the control.

## Documentation

| Document | Contents |
| --- | --- |
| `docs/DATA_MODEL_AND_API.md` | Collections, all 58 indexes, full API surface, money/tax rules |
| `docs/TRACEABILITY.md` | T01–T40 matrix with executed evidence and open gaps |
| `docs/LEGAL_ASSUMPTIONS.md` | Legal-assumption register, fail-closed behaviour, questions for the CA |
| `docs/RUNBOOK.md` | Run, configure, deploy, backup/restore, number fence, daily/month close, incidents |
| `docs/LIMITATIONS.md` | What is not built, what was not executed, deliberate deviations |

## Honest status

Executed in this repository: `npm test` → **42/42 pass**, `npm run check` → **19/19 pass**,
`npm run build` → success, plus a manual browser pass over every screen as owner and cashier.

Not executed (no environment): MongoDB Atlas replica-set transactions and failpoints, Vercel
deployment/runtime, payment/e-invoice providers, printer hardware, formal accessibility and
security audits, backup/restore drill. Those are listed with their acceptance IDs in
`docs/TRACEABILITY.md` §3 and must be run before a go-live decision.

## Configuration

See `.env.example` (placeholders only). No secret is ever exposed to the browser bundle:
the setup token, cron secret, Mongo credentials and session secrets live only on the server.

## Licence / compliance note

shop desk is software, not advice. It is not a tax opinion, a GST filing service, an
e-invoice provider or an audited-statements generator. Statutory applicability for a given
clinic must be reviewed and recorded by that clinic's professional advisers — the product
makes that record explicit rather than pretending it is settled.
