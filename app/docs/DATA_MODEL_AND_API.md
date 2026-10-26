# shop desk — data model, indexes and API surface

Generated from the running code (`server/store/indexes.js`, `server/api.js`). This is the
data dictionary required by the delivery checklist; it is not a marketing description.

## 1. Storage model

- One MongoDB database (`MONGODB_DB`, default `shopdesk`) for all tenants.
- Every business document carries `tenantId`. The tenant id is **never** accepted from a
  request body; it comes from the server-side session context (`server/auth/sessions.js`)
  and is injected by `server/tenancy/repo.js`.
- Global collections (no tenant scope): `tenants`, `users`. Everything else is scoped.
- `_id` is an app-generated 24-hex string in both drivers, so the local file store and
  MongoDB behave identically.
- Money is an **integer paise string** (`"12345"` = ₹123.45). Quantities are **scaled
  integer strings** with the product's declared `quantityScale`. Dates are BSON `Date`
  (the file driver tags and revives them; see `server/store/file-store.js`).
- Financial mutations happen only inside `store.transaction(...)`. The local file driver
  is a single-writer store with the same contract and rejects writes outside a
  transaction (`#assertWritable`).

### Collections

| Collection | Purpose |
| --- | --- |
| `tenants` | Workspace identity, legal profile, invoice settings, sample flag |
| `users` | Login identity (scrypt hash, no plaintext, no shared default password) |
| `memberships` | Role + permission grants + branch limits per tenant |
| `sessions` | Hashed session tokens, CSRF secret, revocation |
| `invitations` | One-time staff invitation tokens (hashed, expiry, single use) |
| `branches` | Physical locations under a tenant |
| `tax_registrations` | GSTIN/profile/series/e-invoice/drug-licence per registration |
| `legal_rules` | Legal-assumption register with state, reviewer, evidence, history |
| `customers`, `pets`, `suppliers` | Billing parties; pets are identifiers only (no clinical record) |
| `products`, `product_tax_versions` | Catalogue + reviewed classification history |
| `batch_lots`, `stock_balances`, `inventory_movements` | Batch, per-batch balance, movement log |
| `purchases`, `purchase_tax_reviews`, `supplier_returns` | Supplier bills, input-tax decisions, returns |
| `sales_drafts` | Open quotes (not financial until finalize) |
| `financial_documents`, `invoice_allocations` | Issued invoices + FEFO batch allocations used for return entitlement |
| `returns`, `return_allocations`, `return_dispositions`, `debit_notes` | Credit notes, per-source allocation, custody, debit notes |
| `payments`, `payment_allocations`, `payment_intents` | Confirmed money, per-invoice allocation, pending attempts |
| `cash_closes` | Cash reconciliation with variance reason |
| `ledger_accounts`, `journal_entries`, `journal_lines` | Double-entry ledger (source-unique postings) |
| `opening_entries`, `expenses` | Openings and expenses |
| `period_locks` | Locked accounting months |
| `audit_events` | Append-only, per-tenant sequence + hash chain |
| `idempotency_operations` | Idempotency key → payload hash → stored result |
| `outbox_jobs`, `sequences` | Durable jobs and legal number sequences |

### Indexes

Declared once in `server/store/indexes.js` and applied by both drivers
(`indexesFor(collection)`); unique violations surface as `err.code === 'E11000'`.

| Collection | Index | Keys | Unique |
| --- | --- | --- | --- |
| `tenants` | `uq_tenant_slug` | slug | unique |
| `users` | `uq_user_email` | emailLower | unique |
| `memberships` | `uq_membership` | tenantId, userId | unique |
| `memberships` | `ix_membership_user` | userId, status |  |
| `sessions` | `uq_session_token` | tokenHash | unique |
| `sessions` | `ix_session_user` | userId, expiresAt |  |
| `invitations` | `uq_invitation_token` | tokenHash | unique |
| `branches` | `uq_branch_code` | tenantId, code | unique |
| `tax_registrations` | `uq_registration_code` | tenantId, code | unique |
| `tax_registrations` | `uq_registration_gstin` | tenantId, gstin | unique |
| `products` | `uq_product_sku` | tenantId, skuNormalised | unique |
| `products` | `uq_product_barcode` | tenantId, barcodeNormalised | unique |
| `products` | `ix_product_search` | tenantId, status, kind |  |
| `customers` | `ix_customer_search` | tenantId, nameLower |  |
| `suppliers` | `ix_supplier_search` | tenantId, nameLower |  |
| `pets` | `ix_pet_owner` | tenantId, customerId |  |
| `batch_lots` | `uq_batch_no` | tenantId, branchId, productId, batchNoNormalised | unique |
| `batch_lots` | `ix_batch_expiry` | tenantId, branchId, status, expirySortKey |  |
| `stock_balances` | `uq_stock_batch` | tenantId, batchId | unique |
| `stock_balances` | `ix_stock_branch` | tenantId, branchId, productId |  |
| `inventory_movements` | `ix_movement_batch` | tenantId, batchId, at |  |
| `inventory_movements` | `ix_movement_source` | tenantId, sourceType, sourceId |  |
| `sales_drafts` | `uq_draft_identity` | tenantId, _id | unique |
| `sales_drafts` | `ix_draft_cashier` | tenantId, cashierId, status |  |
| `financial_documents` | `uq_document_number` | tenantId, registrationId, fy, number | unique |
| `financial_documents` | `uq_document_source_draft` | tenantId, sourceDraftId | unique |
| `financial_documents` | `ix_document_party` | tenantId, kind, partyId, issuedAt |  |
| `financial_documents` | `ix_document_date` | tenantId, branchId, kind, issuedAt |  |
| `document_events` | `ix_document_event` | tenantId, documentId, at |  |
| `invoice_allocations` | `ix_allocation_document` | tenantId, documentId |  |
| `returns` | `uq_return_number` | tenantId, registrationId, fy, number | unique |
| `return_allocations` | `uq_return_allocation` | tenantId, returnId, originalAllocationId | unique |
| `return_allocations` | `ix_return_allocation_source` | tenantId, originalDocumentId |  |
| `return_dispositions` | `ix_disposition_source` | tenantId, returnId |  |
| `purchases` | `uq_purchase_supplier_bill` | tenantId, supplierId, fy, supplierInvoiceNo | unique |
| `purchase_tax_reviews` | `uq_tax_review_purchase` | tenantId, purchaseId | unique |
| `supplier_returns` | `uq_supplier_return_number` | tenantId, number | unique |
| `payment_intents` | `uq_intent_identity` | tenantId, idempotencyKey | unique |
| `payments` | `uq_payment_identity` | tenantId, idempotencyKey | unique |
| `payments` | `ix_payment_party` | tenantId, partyId, at |  |
| `payments` | `ix_payment_date` | tenantId, branchId, kind, at |  |
| `payment_allocations` | `ix_payment_allocation` | tenantId, documentId |  |
| `cash_closes` | `uq_cash_close` | tenantId, branchId, businessDate, sessionKey | unique |
| `ledger_accounts` | `uq_account_code` | tenantId, code | unique |
| `journal_entries` | `uq_journal_source` | tenantId, sourceEventId, postingKind | unique |
| `journal_entries` | `ix_journal_date` | tenantId, businessDate, status |  |
| `journal_lines` | `ix_journal_line_account` | tenantId, accountId, businessDate |  |
| `period_locks` | `uq_period_lock` | tenantId, year, month | unique |
| `opening_entries` | `uq_opening_batch` | tenantId, batchId | unique |
| `sequences` | `uq_sequence_scope` | tenantId, registrationId, fy, series | unique |
| `idempotency_operations` | `uq_operation_identity` | tenantId, actorId, action, key | unique |
| `audit_events` | `uq_audit_sequence` | tenantId, sequence | unique |
| `audit_events` | `ix_audit_time` | tenantId, at |  |
| `outbox_jobs` | `uq_job_event` | tenantId, eventKey | unique |
| `outbox_jobs` | `ix_job_due` | state, nextAttemptAt |  |
| `file_objects` | `ix_file_owner` | tenantId, ownerId, createdAt |  |
| `legal_rules` | `uq_rule_key` | tenantId, key | unique |
| `schema_migrations` | `uq_migration` | name | unique |

## 2. API surface (`/api/v1`)

Transport rules that apply to everything below:

- Cookie session (`HttpOnly`, `SameSite=Lax`, `Secure` in production) plus a
  session-bound `X-CSRF-Token` header on every non-GET request.
- Mutations are rejected unless the `Origin` host matches `Host`.
- Financial POSTs require `Idempotency-Key` (8–128 chars of `[A-Za-z0-9._:-]`).
- All `/api` responses are `Cache-Control: no-store`; 5xx bodies are generic and carry a
  request id. Full errors are logged server-side without bodies or credentials.

### Session and setup

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | Liveness + driver |
| GET | `/setup/status` | `needsSetup`; the setup token is printed by the server, never bundled |
| POST | `/setup` | Requires the server setup token; creates an **empty** tenant; 409 once used |
| POST | `/login` | Rate limited (10 attempts/identity/IP) |
| POST | `/logout` | Revokes the session |
| GET | `/session` | Identity, tenant, branch, role, permissions, navigation, CSRF token |
| POST | `/tenant-switch` | Membership-checked workspace switch |
| GET | `/permissions` | Role/permission catalogue |

### Workspace, catalogue and parties

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/overview` | session (self-scoped without `overview.all`) |
| GET/POST/PATCH | `/products`, `/products/:id` | `products.read` / `products.manage` |
| POST | `/products/:id/classification-review`, `/products/:id/archive` | `products.manage` |
| GET/POST/PATCH | `/customers`, `/customers/:id` | `customers.manage` |
| GET | `/customers/:id/statement` | `payments.read` |
| GET/POST | `/pets` | `pets.manage` |
| GET/POST | `/suppliers` | `suppliers.manage` |

### Inventory and purchasing

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/stock`, `/stock/batches`, `/stock/movements` | `inventory.read` (cost stripped without `inventory.cost`) |
| POST | `/stock/adjustments` | `inventory.adjust` |
| POST | `/batches/:id/status` | `inventory.manage` |
| GET | `/purchases`, `/purchases/:id` | `inventory.read` (quantity-only without cost) |
| POST | `/purchases` | `purchases.manage` (idempotent) |
| POST | `/purchases/:id/itc-review` | `purchases.review_tax` |
| POST | `/supplier-returns`, `/supplier-returns/:id/credit-note` | `purchases.manage` |

### Sales, printing, returns

| Method | Path | Permission |
| --- | --- | --- |
| GET/POST | `/sales-drafts`, `/sales-drafts/:id` | `billing.use` |
| PUT | `/sales-drafts/:id` | `billing.use` (version-checked) |
| POST | `/sales-drafts/:id/quote` | `billing.use` |
| POST | `/sales-drafts/:id/finalize` | `billing.use` (idempotent, atomic) |
| POST | `/sales-drafts/:id/discard` | `billing.use` |
| GET | `/documents`, `/documents/:id` | `documents.read` |
| GET | `/documents/:id/print` | `documents.print` (template `corporate|classic|compact|thermal58|thermal80`) |
| GET | `/documents/:id/settlement`, `/documents/:id/return-preview` | `documents.read` |
| POST | `/documents/:id/returns` | `returns.create` (+ `returns.restock` to restock) |
| POST | `/documents/:id/debit-notes` | `accounts.post` |
| GET | `/returns`, `/returns/:id`, `/returns/:id/print` | `documents.read` / `documents.print` |
| GET | `/templates` | `documents.print` |

### Money

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/payments` | `payments.read` |
| POST | `/payments` | `payments.record` (idempotent; cash-limit gate) |
| POST | `/payments/:id/reverse` | `payments.record` |
| POST | `/refunds` | `payments.refund` (separate from a credit note) |
| POST | `/payment-intents`, `/payment-intents/:id/confirm` | `payments.record` / `payments.pending.confirm` |
| GET | `/payment-intents` | `payments.read` |
| POST/GET | `/cash-close` | `cash.close` / `payments.read` |

### Accounts, reports, governance

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/accounts`, `/accounts/trial-balance`, `/accounts/pnl`, `/accounts/balance-sheet` | `accounts.read` |
| GET | `/accounts/reconciliation`, `/accounts/parties`, `/accounts/journals` | `accounts.read` |
| POST | `/accounts/journals`, `/accounts/journals/:id/reverse` | `accounts.post` / `accounts.review` |
| POST | `/expenses`, `/openings` | `accounts.post` |
| GET/POST/DELETE | `/period-locks` | `accounts.read` / `accounts.period` |
| GET | `/reports`, `/reports/:tab`, `/reports/:tab.csv` | `reports.read` / `reports.export` |
| GET/PATCH | `/settings`, `/settings/tenant`, `/settings/registrations/:id`, `/settings/rules/:key` | `settings.manage` |
| GET | `/readiness` | `reports.read` |
| POST | `/branches` | `settings.manage` |
| GET | `/staff`, POST `/staff/invite`, PATCH `/staff/:membershipId` | `staff.manage` |
| POST | `/invitations/accept` | unauthenticated (token + expiry checked) |
| GET | `/audit`, `/audit/verify`, `/exports/audit.csv` | `audit.read` |
| GET | `/operations/:key` | session (idempotency outcome lookup) |
| POST | `/cron/jobs` | `X-Cron-Secret` header or `Authorization: Bearer` — never a browser session |

## 3. Money, tax and rounding helpers

`server/money.js` and `server/domain/tax.js` own all arithmetic. Public summary:

- `toPaise(value)` accepts an integer string only; floats, exponents, NaN and values over
  the paise bound are rejected. No `Number` arithmetic on money anywhere.
- `mulDivRound(a, b, d)` is exact integer math with half-up rounding at the final step.
- `allocateProportional(total, weights)` uses largest-remainder so allocated parts always
  sum back to the total.
- Tax decomposition: exclusive lines compute tax on the taxable value; inclusive lines use
  `round_half_up(gross × 10000 / (10000 + rate))`. Intra-state tax is split into equal
  CGST/SGST halves with any odd paisa carried as an explicit document round-off
  (`equal_halves_with_roundoff`), never silently added to one half. `reject_odd` is
  available for profiles that require exact halves.
- Discounts are applied before tax and allocated across lines by largest remainder.
