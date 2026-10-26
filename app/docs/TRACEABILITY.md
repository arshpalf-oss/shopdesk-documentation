# Requirement traceability — shop desk

**Edition:** 1.0 · **date:** 2026-10-26 · **source of truth:** the documentation pack in the
repository root (`MASTER_IMPLEMENTATION_PROMPT.md`, `ARCHITECTURE_AND_BUILD_GUIDE.md`,
`TEST_ACCEPTANCE_AND_TRACEABILITY.md`, `INDIA_LEGAL_AND_RELEASE_MATRIX.md`,
`PRODUCT_OVERVIEW_AND_USER_GUIDE.md`, `VERCEL_ATLAS_OPERATIONS.md`,
`reference/Legal-Notes-user-supplied.txt`).

Result vocabulary used below — no row is allowed to overstate its evidence:

- **PASS (unit/API)** — executed in this repository with the command shown, actual output recorded.
- **PASS (manual)** — executed by hand against the running build, output pasted here.
- **NOT EXECUTED** — the environment cannot run it (no Atlas replica set, no Vercel runtime,
  no bank/UPI/e-invoice provider, no printer hardware).
- **BLOCKED BY DESIGN** — the capability is deliberately unavailable until a real prerequisite exists.

Commands referenced:

```text
npm test                 # node --test tests/*.test.js  → 42 assertions groups pass (see §2)
npm run check            # node tools/self-check.js     → 19/19 PASS
npm run build            # vite build                   → dist/ built
```

## 1. Acceptance matrix (T01–T40)

| ID | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| T01 | Empty onboarding | **PASS (API)** | `tests/api.test.js` → “setup requires the server token, creates an empty tenant and starts a session” asserts `products === 0` and `financial_documents === 0` after setup, and that the setup token is not exposed in production mode. `npm run demo:seed` refuses to run on a non-empty directory. |
| T02 | Cross-tenant isolation | **PASS (API)** | `tests/api.test.js` → “two-tenant isolation through the HTTP API” (404 for foreign document, print and product patch; empty lists/reports). `tests/billing.test.js` → “draft cannot reference another tenant product”. `tests/durability.test.js` → repository refuses an unscoped context. Self-check step “tenant isolation”. |
| T03 | Membership/branch lifecycle | **PASS (API)** | `tests/api.test.js` → “login is rate limited and disabled staff lose access immediately” (membership disable invalidates the live session on the next request). Branch limits enforced by `assertBranch`; last-owner demotion refused in `PATCH /staff/:membershipId`. |
| T04 | Monetary field permissions | **PASS (API)** | `tests/api.test.js` → cashier and inventory-operator tests assert `costPaise`, `costPoolPaise`, `unitCostPaise`, `quantityOnHandScaled` are absent, `quantityOnly: true`, and CSV export 403. |
| T05 | Authentication/security | **PARTIAL PASS (API); NOT EXECUTED for MFA/provider rate limits** | CSRF, origin, rate-limit and session-revocation assertions in `tests/api.test.js`. scrypt password hashing (`auth/passwords.js`). No MFA, no distributed rate-limit store, no SSO — listed in `LIMITATIONS.md`. |
| T06 | Exact arithmetic | **PASS (unit)** | `tests/money.test.js` (4 tests) covers rejection of floats/overflow, half-up rounding, `mulDivRound`, largest-remainder allocation and scaled quantities. |
| T07 | Tax/discount fixtures | **PASS (unit)** | `tests/money.test.js` (7 tax tests): inclusive/exclusive, intra-state equal halves, odd-paisa round-off, IGST-only inter-state, unregistered profile, discount allocation, rejected treatments. |
| T08 | Historical immutability | **PASS (API/unit)** | Documents store line/product/party/pet snapshots and a template version; catalogue edits after issue do not alter them (snapshot asserts in `tests/billing.test.js` and `tests/ui-contract.test.js`). No update/delete route exists for issued documents. |
| T09 | Document eligibility/fields | **PASS (unit/API)** | `computeQuote` chooses `tax_invoice` vs `bill_of_supply`; `assertCanIssue` blocks profile/series mismatches; unregistered profile test collects no GST. |
| T10 | Legal integrations/exclusions | **BLOCKED BY DESIGN** | e-invoice `applicable` and unsupported profiles throw `LEGAL_GATE_BLOCKED`; restricted medicines require a verified, unexpired licence plus an external prescription reference (`lineGates`). No IRN/QR is ever fabricated (`tests/api.test.js` print test). |
| T11 | Invoice sequence concurrency | **PASS (single-process)** | `tests/billing.test.js` → “parallel invoices get unique sequential numbers in the legal scope”. Numbers are allocated inside the transaction from `sequences` with a unique index. Multi-process/Mongo concurrency: **NOT EXECUTED**. |
| T12 | Stock/FEFO/expiry races | **PASS (single-process)** | `tests/billing.test.js` → FEFO skips expired batch; oversell blocked with no document/movement/journal; parallel last-unit checkouts cannot oversell. Mongo-level race: **NOT EXECUTED**. |
| T13 | Atomic sale failure injection | **PASS (partial, file driver)** | Failed transactions roll back every write (`tests/durability.test.js`); blocked licence leaves the draft at `status=draft` with unchanged version (self-check). Real replica-set failpoints: **NOT EXECUTED**. |
| T14 | Idempotency/replay | **PASS (API)** | `tests/billing.test.js` and `tests/ui-contract.test.js` assert replay returns the original document and a changed payload is rejected. |
| T15 | Unknown commit/response loss | **PARTIAL** | `GET /api/v1/operations/:key` resolves the original key and returns a note that any retry must reuse the same key. A UI “resolving…” state exists in the API contract but was not exercised under real network loss: **NOT EXECUTED**. |
| T16 | Purchases/duplicate receipts | **PASS (unit)** | Duplicate supplier bill per supplier/FY is refused (`DUPLICATE_SUPPLIER_BILL`); batches, payable and pending input tax post in one transaction (self-check bill ₹25,088). |
| T17 | Supplier return | **PASS (unit, core)** | Batch caps enforced; supplier credit note recorded separately. Dispatch/acknowledgement workflow is **not implemented** (see limitations). |
| T18 | Partial/repeated returns | **PASS (unit)** | `tests/billing.test.js` → cumulative credit formula; self-check asserts two credit notes sum exactly to the original line (₹25,101). |
| T19 | Restock vs no-restock | **PASS (unit)** | Default is no restock; restock requires `returns.restock`, a `resaleable` condition and an eligible original batch; restored cost is incremental (`cumCost − priorCost`) and reconciles (self-check: `return_restock` 1,120; inventory GL == valuation). |
| T20 | Return concurrency | **PASS (single-process)** for entitlement; **NOT EXECUTED** for simultaneous writers. |
| T21 | Commercial vs GST credit | **PASS (unit)** | `tests/billing.test.js` → commercial-only credit keeps output GST; post-cut-off credit becomes `commercial_only`; GST override needs evidence and permission. |
| T22 | Payments/partial settlement | **PASS (API)** | Overpayment blocked; receipts allocate per invoice; pending intents do not move cash (`tests/api.test.js` + `tests/billing.test.js`). |
| T23 | Refunds/over-refunds | **PASS (unit/API)** | Refund needs `payments.refund`, is capped by `refundablePaise`, and is independent of the credit note (`tests/billing.test.js`). |
| T24 | Cash limit aggregation | **PASS (unit)** | `assertCashLimit` aggregates confirmed cash receipts per party/day; ≥ ₹2,00,000 blocked with `LEGAL_GATE_BLOCKED` and override requires reason + evidence. Boundary fixtures in `tests/billing.test.js`; applicability of s.186 to a given clinic remains a professional question (see legal register LEG-11). |
| T25 | Cancellation/compensation | **PARTIAL** | Draft discard ≠ issued correction; debit notes have their own number/source/GL and move no stock. Issued-document cancellation with linked compensation is **not implemented**. |
| T26 | Double-entry postings | **PASS (unit)** | Journal mapping asserted by the self-check (trial balance ₹97,499 both sides) and `tests/billing.test.js` → “sales, returns, refunds keep the GL balanced and reconciled”. |
| T27 | Openings/journals/period close | **PASS (API)** | Manual journals must balance; posted entries are immutable; reversal creates a linked entry; period locks block postings in locked months. |
| T28 | Full reconciliation | **PASS (unit)** | `reconcile()` compares trial balance, inventory GL vs batch valuation, receivable control vs sub-ledger; self-check reports 0 warnings. |
| T29 | All 12 core report tabs | **PASS (API)** | Every tab returned 200 in `tests/ui-contract.test.js`; presets, branch scope and definitions are returned with each report. |
| T30 | GSTR working papers | **PASS (API), labelled** | `gstr1`/`gstr3b` carry `warning` text stating they are working papers, not filed returns. No portal JSON is produced. |
| T31 | A4/58/80 mm printing | **PASS (manual)** | Rendered all five templates: `@page { size: A4 }` for corporate/classic/compact and `size: 58mm auto` / `80mm auto` for thermal. Text escaping and “no script / no fabricated IRN” asserted in `tests/api.test.js`. Physical printer/paper check: **NOT EXECUTED**. |
| T32 | UI/accessibility | **PASS (manual, browser)** | Dark theme, independently scrollable sidebar, persistent tenant/branch/role header, keyboard-focusable controls, mobile breakpoint, empty states, no optimistic financial success. Formal WCAG audit with assistive tech: **NOT EXECUTED**. |
| T33 | Audit immutability/privacy | **PASS (unit)** | `tests/billing.test.js` → tampering breaks the chain; audit has no update/delete path; secrets redacted (`redact()`). |
| T34 | Outbox/Cron/leases | **PARTIAL** | Durable outbox with lease tokens and retry counters; `/cron/jobs` requires a secret. Crash/overlap/dead-letter drilling: **NOT EXECUTED**. |
| T35 | Private files/exports | **PARTIAL** | CSV exports are permission-gated and audited; there is no user file upload feature yet. Signed links/scanning: **NOT EXECUTED**. |
| T36 | Retention/privacy rights | **NOT EXECUTED** | No retention job or erasure workflow; see limitations. Records are not TTL-purged, which is the safe default. |
| T37 | Backup/restore | **NOT EXECUTED** | Runbook written (`RUNBOOK.md`); no Atlas backup was performed in this environment. |
| T38 | Migration/cutover | **NOT EXECUTED** | No legacy data exists to migrate; importer not built. |
| T39 | Vercel production runtime | **NOT EXECUTED** | `api/[...path].js`, `vercel.json` and the deployment steps exist; nothing was deployed. |
| T40 | Release and change gates | **PARTIAL** | Legal-assumption register implemented (`docs/LEGAL_ASSUMPTIONS.md` + `legal_rules` collection, 17 seeded positions); professional sign-off and contracts are outside this build. |

## 2. Executed test inventory (raw)

```text
$ npm test
ℹ tests 42
ℹ pass 42
ℹ fail 0

tests/money.test.js      13 pass   money, rounding, allocation, scaled quantities, tax, FY/expiry bounds
tests/billing.test.js    15 pass   FEFO, oversell, concurrency, numbering, idempotency, stale quote,
                                   tenant references, returns (restock/commercial/cut-off), refunds,
                                   cash limit, cash close, GL reconciliation, audit tampering
tests/api.test.js         8 pass   setup/empty tenant, CSRF+origin, tenant isolation, role DTOs,
                                   quantity-only operator, print safety, cron auth, session revocation
tests/durability.test.js  4 pass   date round-trip across restart, unique index, transaction rollback,
                                   unscoped repository refusal
tests/ui-contract.test.js 2 pass   full SPA flow + cashier cost-field denial
```

```text
$ npm run check
19/19 self-checks passed
  - creates a tenant, branch, chart of accounts and legal register
  - restricted medicine blocked until a verified licence exists (draft untouched)
  - records a reviewed drug licence
  - posts a supplier bill with pending input tax
  - issues an invoice through draft → quote → finalize (₹75,100, ₹15,100 due)
  - rejects an oversell and leaves no document/movement/journal
  - replays a finalize with the same key and rejects a changed payload
  - issues two credit notes whose credits sum exactly to the original line
  - restores cost at the correct incremental amount
  - records a refund inside entitlement
  - records a receipt and a cash close
  - trial balance balances (₹97,499 both sides)
  - stock/GL reconciliation has no findings
  - audit chain intact (6 events)
  - second tenant sees zero documents
```

## 3. Gaps that are honestly open

1. **MongoDB replica-set behaviour** — transactions, failpoints, index conflicts and
   multi-process concurrency were exercised against the in-repo file driver only.
2. **Vercel runtime** — adapter and configuration are written, never deployed.
3. **MFA, email delivery, password reset, SSO** — not implemented.
4. **e-invoice (IRP), e-way bill, UPI/card gateway, bank reconciliation, WhatsApp/email
   documents** — deliberately blocked rather than simulated.
5. **Supplier return acknowledgement workflow, issued-document cancellation** — partial.
6. **Retention/erasure automation and DPDP rights handling** — not implemented.
7. **Accessibility and printer validation on real hardware** — manual review only.

Every gap above is either blocked at runtime (so nothing unsafe can be issued) or
documented in `LIMITATIONS.md`.
