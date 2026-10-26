# MongoDB + JavaScript architecture and step-by-step build guide

**shop desk · Proposed independent-clinic SaaS · Vercel frontend/API + MongoDB Atlas**

This is an engineering blueprint. Example interfaces, indexes and command names below are requirements to implement, not a representation that the existing releases already contain them. Preserve the existing archives and real data.

## 1. Architecture decision record

| Decision | Selected design | Why / boundary |
| --- | --- | --- |
| Frontend | Existing React/Vite, JavaScript/JSX, ES modules | Preserve working UI/flows; do not switch to Next.js/TypeScript merely for preference. |
| API | Existing Node/Express service patterns behind Vercel Node.js functions | Same-origin `/api/v1`; no browser connection to Atlas, no Edge-runtime MongoDB assumptions. |
| Database | MongoDB Atlas replica-set deployment using native Node driver | Real transactions, indexes and validation; no SQLite file in a stateless production function. |
| Tenancy | Shared collections with mandatory server-derived tenant scope; branches/registrations within tenant | Efficient initial SaaS; requires comprehensive application-enforced isolation because MongoDB has no built-in row-level tenant security here. |
| Money | Integer paise with BigInt calculations and BSON Long storage; exact scaled quantities/rational rates | Prevent binary floating-point drift and unsafe JSON conversions. |
| Financial truth | Immutable documents, allocations, movements, payments and posted journals; mutable derived projections separately | Corrections are linked new records, not overwrites. |
| Durable work | Transactional Mongo outbox + leased, bounded Vercel Cron invocations | No always-running worker, in-memory-only queue or fire-and-forget finance. |
| Files/backup | Approved private object storage and provider backups, with actual India-located copies where required | Vercel function disk is not durable. Provider storage/location features must be verified. |
| Accounting | Full double-entry subledgers/general ledger and trial balance | Explicitly approved extension to legal attachment section 14. |
| Unsupported legal flows | Fail-closed eligibility gates or a reviewed lawful external workflow | An excluded integration does not remove legal duties. |

A database-per-tenant model can be evaluated later for contractual/regulatory needs. It is not a drop-in change: connection budgets, credentials, migrations, restores and costs differ. Do not claim database-enforced tenant isolation for shared collections.

## 2. Deployment and trust boundaries

```text
Owner / cashier / inventory / accountant browsers
      | HTTPS, same origin, secure session + CSRF
      v
Vercel: React/Vite static app + Node.js API
      | request context: user, membership, tenant, branches, permissions
      | Zod validation -> domain services -> tenant repositories
      | Mongo TLS + least-privilege credentials
      v
MongoDB Atlas
  masters | drafts | immutable finance | stock balances | GL
  audit events | idempotency | outbox jobs | legal rule versions
      ^
      | authenticated Cron claims durable leases, small bounded batches
Vercel Cron -> Node job handler -> private artifacts / safe logs / notifications

Separate restricted control plane:
  migrations, access approvals, backups/restores, evidence and incident handling

Optional approved integrations:
  authentic IRP/e-way/signing/payment/email providers
  disabled until actual applicability + implementation + testing are approved
```

The browser never receives database URIs, administrative API credentials, signing private keys, backup credentials or unrestricted customer exports. Platform operations do not automatically gain tenant-data access.

## 3. Repository reuse and gap analysis

Inspect `/shop-desk` (SQLite 1.2.0) and `/shop-desk-mongodb` (native MongoDB 1.3.0) if supplied. The Mongo reference has native persistence and Vercel routing patterns, but the inspected server has **zero `tenantId` occurrences** and no dedicated audit-event collection in its model list. It is not a safe multi-tenant starting deployment without refactoring.

Preserve behavior from `src/SidebarMenu.jsx`, billing/inventory/customer/purchase screens, `shared.js`, `returns.js`, `accounts.js`, `reporting.js`, backend domain/accounting/returns/security code, PDF generation and tests. Do not treat numeric SQL-conversion output or old tests as proof of new tenant isolation. Replace all-state bootstrap payloads with permission-scoped resources; never send owner-only costs to cashiers and hide them with CSS.

Suggested incremental layout, not a demand for a needless repository rewrite:

```text
src/                         React screens, controls, scoped API client
shared/                      pure DTO helpers, money/quantity functions, formatting
server/
  app.js                     Express routing / Vercel adapter boundary
  auth/                      users, sessions, invitations, CSRF, MFA integration
  tenancy/                   trusted request context, membership and branch guards
  repositories/              only location with normal raw Mongo collection access
  domain/                    billing, stock, purchases, payments, returns, accounting
  tax/                       reviewed policies, quote calculator, validation
  documents/                 snapshots, template rendering, signing adapters
  jobs/                      bounded durable outbox consumers
  audit/                     append-only events, redaction, evidence exports
  platform/                  restricted operations, not an owner backdoor
api/handler.js               API entrypoint
api/cron/jobs.js              separately authenticated cron entrypoint
migrations/                  reviewed versioned migrations, NOT public endpoints
tools/                       import, preflight, reconciliation and recovery tools
tests/                       unit, replica-set integration, browser and security
vercel.json                  explicit Node routing, region, durations and cron
.env.example                 placeholders only; never real credentials
```

Keep JavaScript/ES modules. Use JSDoc where useful; do not require an unrequested language migration. Pin compatible supported dependencies and maintain a lockfile. Verify supported Node/Vercel/driver versions and runtime end-of-life at launch, starting from the existing Node 22 baseline rather than blindly installing `latest`.

## 4. Tenant isolation and authentication

1. Authenticate an opaque, high-entropy session cookie. Store only a hash of the session token, with user/membership context and expiry. Use Secure, HttpOnly and an appropriate SameSite policy; enforce CSRF/origin checks for cookie-authenticated mutations.
2. Resolve the active tenant from a server-validated membership/session selection. A tenant slug, route parameter, body field or subdomain is not authorization.
3. Load current membership status/permission version and branch/registration scope. Deactivated staff or changed permissions must lose access without waiting for a stale UI cache.
4. Build a trusted context `{ userId, tenantId, membershipId, allowedBranchIds, permissions, requestId }`. Pass it explicitly through controllers, domain services, repositories, jobs and file access.
5. Every query/update/delete/aggregation/import/export lookup uses the tenant predicate; every related entity must match tenant and appropriate branch/registration. Lookup pipelines must scope both sides.
6. Never spread request JSON directly into Mongo filters or updates. Validate known scalar fields and build permitted predicates server-side. Block operator injection and arbitrary aggregations.
7. Return a non-leaking not-found response for foreign-tenant IDs. Check authorization for the parent and every child allocation, product, pet, batch, payment, journal account and file.
8. Authorize monetary fields at the query/DTO level. Costs, valuation, margins, bank references and full exports have distinct permissions; do not rely on navigation visibility.
9. Keep support access disabled by default. A verified, time-limited, purpose-bound support grant requires approval, narrowly scoped permissions, prominent visibility and audit evidence. No unrestricted impersonation endpoint.
10. Require MFA for owners/platform operators; provide controlled recovery, distributed rate limits, safe password hashing, hashed invitation/reset tokens, session revocation and least privilege.

TTL indexes clean up expired sessions/tokens opportunistically; the API must check their actual expiry. Never add TTL deletion to financial/audit records just to reduce storage.

## 5. MongoDB logical data model

The following are logical collections. Combine small embedded structures where safe, but do not merge immutable truth into mutable UI state. All tenant-owned documents carry `tenantId`; global control-plane records require separate restricted repositories.

| Group / collection | Essential content |
| --- | --- |
| `tenants`, `branches`, `tax_registrations` | Actual business identity, branch addresses/state, registration status, owner-approved series, supported legal profiles. Prevent duplicate active GST-registration onboarding across unrelated tenants without controlled review. |
| `legal_profiles`, `rule_versions` | Applicability, effective dates, references, reviewer/evidence, next review; products reference approved versions. |
| `users`, `memberships`, `sessions`, `invitations` | Identity separated from tenant membership/role; one person may belong to multiple tenants but permissions do not cross. |
| `products`, `product_tax_versions` | SKU/barcode/UOM/quantity scale/type, manufacturer/restrictions, price versions, approved HSN/SAC/treatments, active status. |
| `customers`, `pets`, `suppliers` | Minimal contact/GST/billing reference data; archive history, no clinical chart/prescription authoring. |
| `batch_lots`, `stock_balances` | Product, branch/location, manufacturer lot, expiry label/precision, received source, conditions, version and exact quantities; cost layers reference genuine receipts. |
| `sales_drafts`, `purchase_drafts` | Mutable versioned work-in-progress, not statutory invoices or posted stock/GL. |
| `document_intents`, `number_reservations` | Durable external-integration state and number history when needed; not invented IRNs or finalized invoices. |
| `financial_documents` | Immutable final invoices/bills/credit/debit notes/purchase records and complete legal/tax/party/line snapshots; `kind` determines legal role. |
| `document_events`, `document_states` | Append-only cancellation/correction/integration events; mutable rebuildable current status projection, not changes to core financial amounts. |
| `invoice_allocations` | Immutable original invoice-line/batch quantities and exact cost/tax allocations for returns and COGS. |
| `returns`, `return_allocations`, `return_dispositions` | Original document/line/allocation links, cumulative amount/quantity controls, commercial and GST-adjustment distinction, explicit restock and physical handling. |
| `payment_intents`, `payments`, `payment_allocations` | Pending/unverified attempts separate from immutable confirmed receipt/refund records and exact allocations; no gateway custody assumed. |
| `inventory_movements` | Append-only received/sold/returned/transferred/adjusted/written-off quantities, source/actor/time/cost treatment. |
| `ledger_accounts`, `journal_entries`, `journal_lines`, `period_locks` | Account identity/classification, immutable balanced posted vouchers, source references, exact debits/credits, reviewed openings and period controls. |
| `purchase_tax_reviews` | Actual input components and authorized eligibility/reclassification evidence; pending is not claimable. |
| `sequences`, `idempotency_operations` | Atomic numbering scope and durable financial operation identity/result/hash; no premature cleanup allowing replay. |
| `audit_events`, `retention_holds` | Safe append-only action/correction/access/export/permission history; legal preservation. |
| `outbox_jobs`, `file_objects` | Durable leased work, private artifact metadata, tenant/actor/purpose/access/expiry, provider idempotency and result references. |
| `schema_migrations`, `reconciliation_runs` | Controlled version/readiness and checksums/differences; no silent rewrite of source finance. |

### 5.1 Common fields and validators

Use ObjectId IDs internally, UTC instants for events and explicit business dates/timezone (`Asia/Kolkata` initially). Preserve original labelled dates where relevant. Store created/actor/source/schema version, immutable original snapshots, and a version token on mutable projections/drafts. Do not infer the operator from whoever opens the bill later.

MongoDB has no relational foreign-key constraint for these collections. Substitute explicit same-tenant reference checks within transactions, schema validation, unique indexes, controlled writes and archival instead of deletion. These are application-enforced integrity controls, not a claim that native FKs exist.

Set strict `$jsonSchema` validators for required IDs, enumerations and BSON Long amounts; validate nested line shapes and bounded lengths in the application. Prevent raw imports from bypassing validation. Runtime credentials cannot manage validators/indexes or perform unrestricted administrative operations.

Include authorized internal consumption, wastage, damage/expiry write-off and physical count corrections as explicit source-linked movement/voucher types, not hidden balance edits; apply the approved expense/COGS and tax-review treatment. A price-only debit note changes no stock quantity.

### 5.2 Index requirements

Verify exact query plans and collation before creating indexes. Examples:

```javascript
// Migration examples; collection access and validation omitted for clarity.
await documents.createIndex(
  { tenantId: 1, registrationId: 1, financialYear: 1, numberingScope: 1, number: 1 },
  { unique: true, name: 'uq_document_number' }
);
await sequences.createIndex(
  { tenantId: 1, registrationId: 1, financialYear: 1, series: 1 },
  { unique: true }
);
await operations.createIndex(
  { tenantId: 1, actorId: 1, action: 1, key: 1 },
  { unique: true, name: 'uq_operation_identity' }
);
await journalEntries.createIndex(
  { tenantId: 1, sourceEventId: 1, postingKind: 1 },
  { unique: true }
);
await stockBalances.createIndex(
  { tenantId: 1, branchId: 1, stockLayerId: 1 },
  { unique: true }
);
await returnAllocations.createIndex(
  { tenantId: 1, returnId: 1, originalAllocationId: 1 },
  { unique: true }
);
await jobs.createIndex({ state: 1, nextAttemptAt: 1, leaseUntil: 1 });
```

Also index tenant/date/document type, customer/due, supplier invoice/FY, movement product/batch/date, ledger account/date, audit tenant/time, stock FEFO eligibility and file ownership. SKU/barcode uniqueness needs normalized fields and partial filters so missing values do not collide. Customer phone is not generally unique. Maintain full-number uniqueness in the legally required registration/FY/document-number scope across its series and coordinate external systems; series alone cannot excuse two invoices with the same printed number.

Registration IDs must map to verified unique supplier registrations. Where a shared legal registration could otherwise be duplicated, enforce a controlled platform-level GSTIN identity/claim process without leaking another tenant's details. If invoices, notes and supplier records share one collection, use fixed server-controlled legal number scopes. Supplier invoice numbers have a separate supplier/FY scope. Do not allow two outward invoices with the same number by adding a freely editable `kind` or scope to an overly permissive index. Preserve genuinely distinct legacy document classes without renumbering their originals.

## 6. Exact money, quantities and tax

- Keep report aggregation exact too: guard MongoDB Long-overflow promotion to double, use validated Decimal128 intermediate aggregation or bounded BigInt reductions, and return paise strings without unsafe coercion.
- Parse decimal strings; use `BigInt` for calculations. Store paise and scaled quantity units using BSON `Long`, with explicit bounds. JSON transports them as strings. Do not call `Number()`/`parseFloat()` on money or enable driver options that silently promote large values to unsafe JS numbers.
- Define each UOM's scale and legal unit/pack conversion. Prefer explicit integer ratios. A fractional strip/tablet conversion is not authorized dispensing merely because arithmetic supports it.
- Represent rates as exact rational/scaled values with defined precision; do not assume only a small hardcoded list of integer-percentage slabs.
- Quote and finalize through one backend calculator. The browser uses returned amounts; PDF/report generators use saved snapshots, not today's tax functions.
- Define an approved rounding policy for components, lines, invoice discount allocation and final invoice adjustment. Deterministic largest-remainder/cumulative allocation must reconcile to original totals.
- For new applicable intra-state transactions with matching component rates, calculate one half-component under the approved policy and use the equal amount for CGST and SGST/UTGST. Never split an odd combined paise by putting one extra paise into only one component.
- Tax-inclusive fixed prices and equal paise components can produce mathematically incompatible rounding cases. Use only a reviewed explicit taxable/rounding/price policy; otherwise reject the quote and require correction before issue. Never disguise an unexplained difference or alter history to force equality.
- Preserve legacy snapshots, including historical unequal components. Returns/corrections of those documents retain their actual original basis; do not fabricate different historical taxes.

Example boundary helper (real implementation needs validation and tests):

```javascript
import { Long } from 'mongodb';

export function toStoredPaise(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new Error('Integer paise string required');
  }
  const n = BigInt(value);
  if (n < -(2n ** 63n) || n > 2n ** 63n - 1n) {
    throw new Error('Money outside storage bounds');
  }
  return Long.fromBigInt(n);
}
```

The UI may use small ordinary numbers for page sizes and dates; the prohibition is against unsafe monetary/quantity arithmetic, not all JavaScript numbers.

## 7. Atomic billing and idempotency

Every financial mutation requires a random operation key scoped to tenant, actor and action, plus a canonical validated payload hash. Retrying the same operation returns its original result; the same identity with a different payload is rejected. Keep a durable minimal deduplication record for the replay-risk/legal retention period even if optional cached response data expires.

For ordinary supported sales without an external statutory prerequisite:

1. Authenticate/authorize and validate the request size, identifiers and draft version.
2. In a real Mongo transaction, check the idempotency identity and matching payload.
3. Resolve same-tenant products/parties/branches/registration, approved effective rules and legal prerequisites. Revalidate price/discount authority, expiry and stock.
4. Recalculate using the backend calculator and compare the approved quote/draft revision. Do not silently charge a changed amount.
5. Select FEFO eligible stock layers. Use conditional version/available-quantity updates in the transaction. A failed condition causes a clean conflict, not negative stock.
6. Reserve the final number with an atomic counter in its legal scope; no count-plus-one or frontend numbering.
7. Insert immutable invoice/line snapshots, original stock/cost allocations, inventory movements, balanced GL postings, any genuine confirmed receipt, audit event and outbox jobs.
8. Write the durable idempotency result in that transaction. Commit with appropriate majority durability; only then return “issued”.

Pseudocode (not copy-and-run production code):

```javascript
async function finalizeSale(ctx, command, operationIdentity) {
  const payloadHash = canonicalValidatedHash(command);
  const session = mongoClient.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      // Callback may be retried. No email, PDF upload, portal call or HTTP response here.
      const old = await operations.find(ctx, operationIdentity, session);
      if (old) {
        assertMatchingHash(old, payloadHash);
        result = old.result;
        return;
      }
      const sale = await validateAndQuoteFresh(ctx, command, session);
      const allocations = await decrementEligibleStock(ctx, sale, session);
      const number = await nextLegalNumber(ctx, sale, session);
      const document = buildImmutableSnapshot(sale, allocations, number);
      await finance.insert(ctx, document, session);
      await movements.insertSale(ctx, document, allocations, session);
      await accounting.postBalancedSale(ctx, document, session);
      await audit.append(ctx, saleIssuedEvent(document), session);
      await outbox.enqueueUnique(ctx, documentArtifactJob(document), session);
      result = committedSaleResult(document);
      await operations.insert(ctx, operationIdentity, payloadHash, result, session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary'
    });
    return result;
  } finally {
    await session.endSession();
  }
}
```

All relevant repository calls must actually use the same session. Do not run `Promise.all` inside the transaction. Driver transaction helpers can retry; an unknown commit is not proof of rollback. Bound database/retry budgets to the function's execution budget, handle **only the expected idempotency-index conflict** as a replay, and resolve ambiguous results through a majority-consistent operation lookup. Do not catch every duplicate-key error and pretend success. Never send an Express response from inside a retriable callback. Official driver guidance: [1](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)

### 7.1 External statutory integrations

Do not put a network call to IRP, signing, gateway, email or object storage inside a retriable Mongo transaction. Use a durable intent with a frozen payload/hash and reserved number, plus an outbox task and provider-specific idempotency/status reconciliation.

When a valid IRN is a prerequisite, the customer's final valid tax document must remain gated until authentic acceptance is recorded. A number/reservation and any stock hold must remain recoverable through unknown provider outcomes; do not release stock or reuse the number while IRP success is still possible. If the external provider succeeded and the next DB commit failed, reconcile the same intent/IRN rather than submit a new invoice. Cancellation/compensation requires the correct actual legal/provider process.

Initial versions can keep these integrations excluded, but then eligibility gates must exclude affected tenants/transactions. A fake “integration successful” adapter is not an acceptable implementation.

## 8. Returns, credits, refunds and cancellations

Original line/batch allocations must contain the exact sold quantity, discount, taxable value, tax components, gross and cost basis. For an ordinary unadjusted original sale, allocate partial returns cumulatively:

`new amount = rounded original amount × cumulative returned quantity / original quantity − amount already credited`

Use a deterministic approved algorithm for every component, with the last eligible return absorbing only legitimate residuals so full cumulative returns exactly equal the original. Do not recalculate from a current price/rate. Later authorized debit/price-correction notes must remain separate immutable source-component entitlement buckets with explicit original-line references. Design and test their allocation, and the effect of earlier non-quantity commercial credits, under the approved policy; the simple unadjusted formula is not a universal algorithm for those cases. Preserve physical quantity caps and avoid crediting any source component twice. A transaction must conditionally consume the remaining return entitlement and, if selected, restore eligible original stock. Concurrent returns cannot both spend the same entitlement.

- Default restock is **false**. Require explicit permission, condition/suitability confirmation and eligible original batch/location before restoring stock.
- No-restock returns do not add saleable quantity or automatically restore inventory/COGS. Record actual physical custody/disposition separately, with zero restored book cost unless an approved explicit valuation/reclassification process applies. Do not later write off that same original cost a second time.
- Commercial credits and output-GST adjustments have separate eligibility/amounts. Preserve original tax reference fields even where permitted GST adjustment is zero.
- A credit note changes the customer's obligation, not the bank account. A refund is a distinct confirmed money record with method/reference/date/actor, permission and idempotency.
- Remaining/full credits consider all previous partial credits and delivered-service constraints. Never reverse an entire invoice twice.
- Cancellation appends legally appropriate events/compensating documents. Draft deletion, issued cancellation, tax credit, goods return and refund are not interchangeable. Keep the original number/snapshot.

Base-case settlement definition, before optional advances/external-credit transfers:

```text
net billed = original issued gross + valid debit adjustments − customer credits
net money received = confirmed receipts − confirmed refunds − confirmed receipt reversals
due = max(net billed − net money received, 0)
refund entitlement = max(net money received − net billed, 0)
```

For broader allocation features, model explicit credit applications and their double-entry effects; do not simply subtract a credit twice. Pending payments/refunds have no completed cash effect. Block unexplained overpayments; advances need an approved voucher/time-of-supply flow before activation.

## 9. Double-entry accounting model

Retain a chart of accounts covering customers/suppliers, cash/bank/clearing, inventory, goods/services sales, sales returns/discounts, COGS, GST input/output, expenses, capital and reviewed opening equity. Derive party subledgers from the same events, not a disconnected manually edited balance.

Examples, subject to approved tax/COA mappings:

| Event | Debit | Credit |
| --- | --- | --- |
| Goods receipt/invoice | Inventory and eligible/pending/non-recoverable tax according to policy | Supplier payable / genuine immediate payment account |
| Issued sale | Customer receivable | Revenue and legally applicable output tax |
| Sold stock | COGS | Inventory at allocated cost |
| Confirmed customer receipt | Cash/bank/clearing | Customer receivable |
| Eligible sales return/credit | Sales return and permitted output-tax reversal | Customer receivable/customer-credit account |
| Commercial-only credit without GST reduction | Approved contra-revenue/expense for the commercial amount | Customer receivable/customer-credit account; **no automatic output-GST debit** |
| Explicit eligible restock | Inventory at approved original allocated cost | COGS; no such entry merely for a non-restock return |
| Confirmed refund | Customer receivable/refund liability as mapped | Actual cash/bank account |
| Supplier payment | Supplier payable | Cash/bank |
| Approved stock loss | Loss/expense and relevant reviewed tax adjustments | Inventory; physical disposal tracked separately |
| Expense/payment | Approved expense/asset/tax accounts | Cash/bank/payable |

Every posted journal balances exactly and has a unique source-event/posting identity. Lines reference same-tenant active accounts; corrections are linked reversal plus replacement where appropriate. Posted entries cannot be edited/deleted. Period locks, controlled reopen approvals, actual date and recorded timestamp remain visible. No fake “balancing” income/expense is inserted to make a trial balance pass.

Manage opening stock and ledger openings as one coordinated controlled migration so inventory is not counted twice. Opening receivable/payable allocations must reconcile to party balances. Basic P&L and balance-sheet working outputs need reviewed mappings and opening/period logic; do not label them audited statutory statements.

## 10. API contract and frontend state

Representative routes, all requiring backend tenant/permission checks except specifically public authentication endpoints:

| API area | Required operations |
| --- | --- |
| `/api/v1/session`, `/tenant-switch` | Login/logout/revoke, current scoped membership and allowed navigation; switch only to verified membership. |
| `/products`, `/customers`, `/pets`, `/suppliers` | Paged/searchable read, validated create/update/archive with field-level permissions. |
| `/stock`, `/batches`, `/inventory-adjustments` | Eligible availability, batch trace, approved stock events; no raw balance overwrite endpoint. |
| `/purchases`, `/supplier-returns` | Draft/review/post/return; genuine supplier notes and tax-review links. |
| `/sales-drafts`, `/sales-drafts/:id/quote` | Versioned drafts and side-effect-free backend quotes. |
| `/sales-drafts/:id/finalize` | Idempotent atomic issue; no client-specified final tax, number or actor accepted. |
| `/documents/:id`, `/documents/:id/print` | Immutable saved artifact/snapshot and separate as-of settlement; tenant-owned object authorization. |
| `/documents/:id/return-preview`, `/returns` | Original remaining entitlement, credit/disposition review and atomic posting. |
| `/payments`, `/refunds`, `/credit-applications` | Separate pending/confirmed, exact authorized allocations, caps and source references. |
| `/accounts`, `/journals`, `/period-locks` | Allowed reads, balanced posting/reversal, openings and close/reopen approvals. |
| `/reports/:tab`, `/exports` | Date/branch/registration filters, definitions, restricted DTOs and private durable jobs. |
| `/operations/:key` | Authorized durable result/status lookup after uncertain request outcomes. |
| `/audit`, `/settings/legal-profile`, `/staff` | Restricted audit, reviewed rules, invitations/permissions and readiness. |

Illustrative finalization:

```http
POST /api/v1/sales-drafts/{draftId}/finalize
Idempotency-Key: a-cryptographically-random-operation-key
If-Match: the-reviewed-draft-version
Content-Type: application/json

{"quoteHash":"approved-backend-quote-hash"}
```

Return committed document ID/number, operation reference and source status. A pending external operation can return 202 only after its durable intent exists. Use 401/403, non-leaking 404, 409 for state/stock/quote/idempotency conflicts, 422 for validation and a safe dependency-unavailable/unknown-outcome code as appropriate. Public errors include a request ID, never a Mongo URI/credentials/stack/tenant data.

Use cursor pagination and bounded queries, not an all-record bootstrap. Disable automatic retries of financial mutations under a new key. Preserve a minimal nonsensitive operation key across an uncertain UI outcome; poll/resolve the original authorized operation. Service workers must not queue sales/payments offline. No optimistic finance/stock success. Safe reads/quotes can retry under explicit policy.

## 11. Reports and printing architecture

Preserve Summary, Day book, Products, Categories, Cashiers, Payments, GST, GSTR-1, GSTR-3B, Stock, Receivables and Stock log. GSTR outputs are clearly labeled working registers/papers until an actually verified filing capability is separately authorized.

Reports use immutable source events plus controlled derived projections with a freshness watermark. Define event dates, inclusive UI date ranges converted to half-open UTC intervals in the business timezone, financial-year boundaries, cancellations, commercial versus tax credits, pending money, cost/restock effects and branch/registration grouping. For an as-of report, later events must not leak backward into earlier balances.

Use the same saved snapshot for A4 and 58/80 mm output. Store template version and authentic integration payloads where required. Render immutable original artifacts; if displaying current settlement, label its as-of timestamp and do not overwrite the original invoice total. Every narrow format retains legally required particulars, even if it spans pages. PDF/email jobs are idempotent artifacts of a committed document, not a second posting path.

## 12. Durable jobs, files and serverless constraints

Outbox insertion occurs in the same DB transaction as its source action. Jobs have tenant/source/purpose, unique event key, payload version/reference, state, attempts, next attempt time, lease token/expiry and result. Cron claims due work atomically, processes small bounded chunks, and checkpoints progress. Only the current lease token may commit results; a crashed worker's expired lease can be reclaimed safely.

Handlers must be idempotent; assume at-least-once invocation, overlap and partial failure. Use bounded backoff, dead-letter/manual-redrive review and provider-specific status reconciliation. “Exactly once” is achieved for a financial database event using transactions/unique identities, not promised for every external email. No in-memory job list, local persistent backup, startup timer or unawaited process controls core correctness.

Large exports use consistent defined snapshots/watermarks, pagination and private object storage. Do not put large exports or backup archives through a normal buffered API response. Vercel imposes function/body/execution limits that vary by runtime/plan; verify current limits and keep normal bodies conservatively below them. [1](https://vercel.com/docs/functions/limitations)

Private file metadata includes tenant, object key, uploader, purpose, allowed readers, content type/hash, size, retention and scan state. Server generates object keys and scoped upload permissions. Never trust a client-provided tenant prefix or public URL. Validate type/size and scan external documents before use; prevent SSRF. Short-lived download capabilities must be minted only after authorization; avoid PII/secrets in paths and logs. Verify object storage region/versioning/immutability features rather than assume all Vercel products store in India.

## 13. Security, audit, privacy and retention

Use schema/input validation, safe filtering, output encoding, secure response headers/CSP, strong password hashing, secure session/CSRF controls, MFA, distributed rate limiting and least-privilege infrastructure. Protect login, setup, reset, invitations, exports, support access, refunds and expensive reports. Ordinary setup must not be an unauthenticated global “first caller becomes owner” endpoint.

Financial/audit collections should be read/insert-only for runtime database roles where feasible; mutable drafts/balances/projections use separately scoped privileges. Migrations use separate credentials outside normal API handlers. Retain an independently protected audit/evidence copy and privilege-change monitoring. A hash chain alone cannot prevent an administrator rewriting the database.

Audit actors, events, source IDs, safe before/after fields, approvals, role/config changes, exports, restores and request correlation. Do not log passwords/tokens, raw sensitive request bodies or full payment credentials. Make the accounting audit trail non-disableable. Read/export of sensitive customer/financial information needs authorized access logging with minimized metadata.

Apply the maximum applicable record-class retention/hold, not a global TTL or arbitrary tenant-delete timer. Separate a privacy deletion request from statutory financial retention; restrict/pseudonymize non-required personal fields when lawful. Provide controlled access/correction/export/grievance processes, a data/processor inventory, notices, versioned acceptance and future DPDP readiness. India-required books/backups/logs need actual provider configuration/evidence; `bom1` alone is insufficient.

## 14. Migration from existing editions

Treat migration as a separately approved operation, never an automatic production startup side effect.

1. Inventory source versions, row counts, monetary storage conventions, invoice series, party balances, batches, originals/credits/returns/payments, users and attachments.
2. Take verified encrypted backups and hash manifests; obtain a rollback/freeze plan and named approval. Do not reset/delete the originals.
3. Create a new target tenant/branch/registration with a migration mapping. Do not attach untrusted source records directly to an existing unrelated tenant.
4. Import to staging with exact historical amounts/rates/date/template/source IDs and actor provenance. Map schema relationships and original batch allocations; preserve cancelled numbers and credit links.
5. Quantize legacy decimal values under an approved conversion/reporting policy. Preserve original stored value representation and an explicit migration reconciliation record; flag anomalies rather than silently “repairing” tax history.
6. Reconcile record counts, full source hashes where applicable, every invoice total/tax, opening/closing stock by batch, customer/supplier balances, receipts/refunds, GL trial balance and inventory valuation. Verify as-of reports before/after.
7. Do not import active sessions, reset tokens, production credentials or another tenant's users blindly. Reinvite/revalidate staff under the new permission model.
8. Reconstruct number high-water marks from issued/cancelled/reserved and external series. Test new numbering without posting a fake real invoice.
9. Rehearse cutoff/delta handling and reversal. If rollback follows new production activity, reconcile those new transactions before any reversal of deployment/data.
10. Run a final controlled migration under freeze, obtain signed reconciliation/approval and only then enable production writes. Keep legacy evidence read-only for retention.

## 15. Step-by-step implementation sequence

### Phase 0 — Inspect, agree scope and preserve evidence

Deliver repository audit, feature-gap table, data-flow diagram, legal-assumption register, risk register and phased plan. Record the full-accounting override. Do not change financial logic/data before the plan is reviewed.

### Phase 1 — Foundation and development safety

Set up supported Node, lockfile-based installation, separate development/staging environments, format/lint/unit tests, replica-set integration test support, dependency/license checks, secret scanning and CI. Add empty-tenant/reference initialization only. Define versioned contracts and error types.

### Phase 2 — Tenancy, auth and authorization first

Implement trusted context/repositories, memberships, sessions/MFA, invitations, branch/registration scopes, field-level money permissions and platform separation. Build two-tenant adversarial tests before business endpoints are exposed. Refactor old all-state endpoints.

### Phase 3 — Schema, exact arithmetic and legal policies

Versioned migrations/indexes/validators; immutable/mutable split; money/quantity/rate helpers; reviewed document/PoS/tax/rounding profiles; quote DTOs; legal readiness gates. Test paise/rounding/overflow/FY/expiry boundaries.

### Phase 4 — Masters and inventory/purchases

Products/parties/basic pets, batch receipts and expiry/FEFO, source-linked stock movements, opening/adjustment controls, supplier-return workflow and input-tax review. Add corresponding GL postings and reconciliation, not a later unrelated ledger retrofit.

### Phase 5 — Sales and printing

Versioned drafts, backend quotes, atomic/idempotent finalization, registration-wide numbering, original batch/cost snapshots, source-linked accounting, genuine receipt handling and A4/thermal templates. Test concurrency, retries, failure injection and reprint behavior.

### Phase 6 — Returns, credits, refunds and correction

Original cumulative entitlement, default no-restock, disposition controls, separate commercial/GST adjustments, cashiers' own-note reprints, remaining credits, separate refund confirmations and lawful cancellations. Test concurrent return/refund caps and no false COGS reversal.

### Phase 7 — Accounting, close and reports

Complete chart/openings/expenses/journals/reversals, bank/cash reconciliation, party subledgers, period locks, trial balance/basic management statements and all 12 reports with as-of/event-date semantics. Validate stock/GL/tax/payment reconciliations.

### Phase 8 — Durable operations, audit and privacy

Complete append-only audit/privilege evidence, outbox/leases/backoff/dead-letter, private files, exports, retention/holds, privacy/incident workflows, backup verification and restore drills. These controls begin earlier; this phase finishes end-to-end operational coverage.

### Phase 9 — Approved integrations or verified exclusions

Implement authentic required integrations only if approved. Test their unknown outcomes/compensation; otherwise prove affected transactions/tenants cannot be activated. Do not hide unimplemented functionality behind enabled buttons.

### Phase 10 — Staging, migration rehearsal and production release

Run the acceptance matrix, official Vercel runtime/build/routing tests, two-tenant security review, real printer checks, professional configuration review, India storage/log evidence, backup/restore and migration rehearsal. Publish an honest result/failure list. Deploy only after written technical/business/legal-policy approval; monitor early production and preserve a safe rollback plan.

## 16. Required developer deliverables

Working JavaScript source, lockfile, migrations/indexes/validators, `.env.example`, tests and raw results, architecture/API/data dictionary, legal applicability register, onboarding/user guide, migration/reconciliation and backup/restore tools, Vercel/Atlas instructions, CI, threat/permission matrix, template fixtures and limitations/release checklist. No secrets, production databases or demo business records in the deliverable.

The complete acceptance and attachment traceability are in `TEST_ACCEPTANCE_AND_TRACEABILITY.md`; online steps and recovery procedures are in `VERCEL_ATLAS_OPERATIONS.md`.
