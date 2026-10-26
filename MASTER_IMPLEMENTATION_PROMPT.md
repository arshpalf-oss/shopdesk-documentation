# COPY-READY MASTER IMPLEMENTATION PROMPT

## 0. Approved product, scope and precedence

Act as a senior full-stack JavaScript engineer, MongoDB/transaction architect, security engineer and QA lead experienced in Indian billing/inventory systems. Build a maintainable commercial product, not only UI screens.

The software name is **shop desk**. **The Good Vets** is a client/tenant brand, not an assumed legal supplier name. Statutory documents must use the actual verified supplier identity.

Approved target:

- Independent-clinic **multi-tenant SaaS**, with branches and legal/GST-registration scopes inside a tenant.
- **JavaScript/ES modules, React/Vite frontend, Node.js API on Vercel, MongoDB Atlas using the native Node driver**. Prefer the existing project structure and compatible libraries. Do not introduce an unapproved framework/language/database rewrite.
- **All application frontend and API hosting on Vercel.** No hidden always-on Node backend/worker, persistent local SQLite database or local durable filesystem. Use Mongo durable state, bounded authenticated Vercel Cron consumers and explicitly approved private storage/providers.
- Veterinary **billing/inventory only**, with customers, basic pet identifiers and suppliers. No diagnosis/treatment/clinical chart or prescription authoring.
- **Full double-entry accounting is INCLUDED by explicit user approval**, overriding only the general-ledger exclusion in section 14 of the attached Legal Notes. Include party/cash/bank/inventory/sales/purchases/GST/expense/opening/journal accounts, reversals, trial balance and basic reviewed management statements. Other exclusions remain.
- Preserve minimal dark/readable UI, a genuinely scrollable left navigation, named cashiers, complete billing/inventory/HSN/batch/expiry workflows, A4/corporate/settings templates, 58/80 mm thermal output, all 12 existing core report tabs/date controls/CSV, cumulative original-invoice/line/batch returns, default no-restock and separate refunds.
- New production tenants start **empty**. Do not create demo/sample products, parties, pets, stock, sales, payments or balances. Approved system references and an account chart are not demo business transactions.

The complete user attachment is `Legal Notes.txt` (461 lines; SHA-256 `ade7d2b1abfb979d28b448f36509eaa3bb253a2ff14ff234c8b96ce9c9e27a14`). Incorporate every non-conflicting requirement, including its section 8.3 quantity-only reporting/permission requirement and its final workflow/preproduction checklist. If a requirement conflicts with the approved scope, explain it and seek approval rather than silently changing it. This prompt consolidates the target; use the attached overview/architecture/legal/acceptance/runbook documents for deeper detail if provided.

Do not claim universal Indian-law compliance, government/GST/PCI certification, professional licensure or an audit opinion. Source verification and professional review must be explicit. Scope exclusions do not excuse defects, unsafe security or non-waivable obligations.

## 1. First action: inspect and plan, do not rewrite blindly

Before extensive changes:

1. Inspect repository, package/lockfile, runtime, frontend routes/components, backend APIs/auth, database models/validators/indexes, finance/tax/returns, PDF/report generation, tests and deployment configuration.
2. Identify what is genuinely implemented, incomplete, unsafe or contradicted by this specification. Preserve working domain/UI behavior; prefer incremental refactoring with evidence over a needless rewrite.
3. Produce an architecture/data-flow diagram, feature-gap matrix, permission matrix, legal-assumption register, migration/risk plan and phased test-driven implementation plan.
4. Identify existing business data and protected files. Never reset/delete/overwrite production or change historic financial money without an expressly approved controlled process.
5. Explain any missing dependencies/credentials/legal facts; do not invent them. Ask targeted questions only for genuinely unresolved decisions. The scope choices in section 0 are already settled.
6. Wait for plan approval before substantial financial schema/logic changes or external provisioning. Never purchase a plan, enable paid networking or deploy to a live tenant without explicit authorization.

If the provided references are SQLite 1.2.0 and native MongoDB 1.3.0, treat them as **single-clinic reference editions**. The inspected Mongo server has no implemented `tenantId` scoping and its listed models lack a dedicated audit-event collection. Do not rename it SaaS and deploy it unchanged. Old test results do not prove new isolation, audit or idempotency.

## 2. Non-negotiable integrity invariants

- Financial truth is immutable: preserve original numbers/dates, supplier/recipient/line snapshots, HSN/SAC, UOM, price/discount/tax, totals, batch/cost allocations, actor and rule/template versions. Correct through linked events/documents, never silent overwrite/delete.
- Atomicity: document, stock, allocations, journal, actual confirmed receipt, audit event and durable outbox/idempotency result commit together where they form one business action. Failures leave no partial committed action.
- No overselling/negative stock, expired/ineligible stock sale, duplicate invoice/payment/refund/return/journal, over-credit, over-return or over-refund.
- One authoritative backend exact-arithmetic tax/calculation service; frontend quotes, PDFs and reports cannot independently invent totals. Current catalogue changes never recalculate issued history.
- BigInt calculations, BSON Long paise/quantity units, exact rational/scaled rates and JSON strings. Initial currency is INR; no unreviewed foreign-exchange/multi-currency flow. No binary floating-point money or unsafe `Number`/`parseFloat` coercion. Guard database aggregation/Long overflow and any automatic double promotion; use validated exact Decimal128 intermediates or bounded BigInt reduction for reports, and checked string results.
- Same financial operation retried with the same identity/hash returns the original result; a changed payload under that identity is rejected. Button disabling alone is not duplicate prevention.
- Unknown commit/provider/response outcome is **unknown**, not automatically failed/rolled back. Resolve the original operation before retrying; never replay under a fresh key just because the UI timed out.
- Every posted journal balances; inventory, payments, party balances and reports reconcile to source events. Never insert invented balancing revenue/expenses or silently repair historical truth.
- No demo business data, hardcoded owner/password, fabricated statutory identifiers, fake gateway acknowledgments, placeholder functional buttons or unverified “tests passed” claims.

## 3. Application boundaries, data model and tenancy

Keep business logic in tested domain services, not React components or request handlers. Controllers authenticate/validate/authorize; repositories enforce trusted tenant scope; services run transactions; pure helpers calculate exact amounts; documents/reports consume immutable sources.

### 3.1 Trusted context and authorization

- Derive `{userId, tenantId, membershipId, allowedBranchIds, permissions, requestId}` from authenticated server-validated membership. Never trust a body/header/subdomain tenant ID as authorization.
- Pass context explicitly. Never keep a mutable global “current tenant” or reuse tenant-specific state across concurrent Vercel requests. A shared Mongo client/pool is fine; a shared mutable request context is not.
- All collection queries, updates, aggregations, lookup joins, child/reference checks, imports, exports, jobs, signed file links, caches and support tools must enforce tenant and branch/registration scope.
- Mongo has no native FK/RLS for this design. Use strict validators, tenant-prefixed unique indexes, same-tenant references checked within transactions, controlled repositories and archive-not-delete behavior. Do not claim SQL FKs exist.
- Reject unknown fields/operators; do not spread request JSON into queries/updates. No client-supplied arbitrary aggregation, raw query, `$where`, file path or remote fetch URL.
- Authorize monetary fields before DTO serialization. Quantity-only inventory views/export/PDF must not contain unauthorized cost/valuation/margin. Navigation/CSS hiding is not security.
- Enforce current staff status and permission version; revoke captured sessions after disabling staff. Secure tenant switching only for actual memberships. Protect last-owner transfer/recovery.
- Platform operators have no default clinic-data access. Exceptional support grants require verified purpose, owner/authorized approval, expiry, narrow permissions and audit; no invisible universal impersonation.

### 3.2 Logical collections

Design and document these concerns; embed bounded related structures only where appropriate:

- Tenant/branch/registration identity and entitlements; legal profiles and effective-dated rule approvals.
- Global users plus tenant memberships, secure sessions, invitations/reset/MFA metadata.
- Products/tax versions/UOM and price policies; minimal customers/basic pets/suppliers.
- Batch/receipt cost layers, stock balances/reservations and append-only inventory movements.
- Mutable versioned sales/purchase drafts; durable external document intents and number reservations where required.
- Immutable final financial documents, original line/batch/cost allocations; append-only document events and separately rebuildable status/settlement projections.
- Original-linked returns/allocations/disposition; commercial credit versus eligible GST-adjustment amounts/status.
- Pending/unverified payment attempts separate from immutable confirmed receipts/refunds and exact allocation records.
- Ledger accounts, immutable posted journal entries/lines, period locks and input-tax-review evidence.
- Sequences, durable financial idempotency identities/results, append-only audit, retention holds, leased outbox jobs, private file metadata, migrations and reconciliation evidence.

Use ObjectId references internally, UTC event instants, explicit business dates/timezone and preserved expiry label/precision. Snapshots include actor IDs and original display values without leaking costs in ordinary sale APIs. Avoid unbounded arrays and oversized transactions/documents.

### 3.3 Indexes and least privilege

Create reviewed migrations with required-field validators and tested indexes: legally correct document-number uniqueness by tenant/registration/FY/approved number scope; sequence scope; finalization/source-draft uniqueness; normalized SKU/barcode partial uniqueness; supplier invoice/FY duplicate checks; stock layer/branch uniqueness; source-event journal uniqueness; idempotency identity; FEFO/search/report/ledger/audit/date access and due-job leasing. Use explicit permitted number scopes, not a client-editable kind that permits two tax invoices with the same number.

Coordinate registration identity and numbering across branches and external billing channels. A duplicate GSTIN/registration claim across unrelated tenants needs controlled verification without leaking another tenant. A single legal receiving entity's cash-limit aggregation cannot be narrowed merely by creating branches or workspaces.

Runtime credentials have minimal read/insert privileges for immutable financial/audit collections and controlled updates for mutable state where supported. No routine delete/update privileges over source finance; no validator/index/admin access. Use separate restricted migration/restore credentials outside normal APIs. TTL cleanup is for expiring auth/ephemeral records, never a shortcut to deleting books/idempotency evidence prematurely.

## 4. Screens, roles and everyday usability

Build a minimal readable React interface: dark high-contrast text, simple system fonts, labeled inputs, clear totals/errors, keyboard/focus support, compact responsive layouts and independent sidebar scrolling. All features must remain reachable on a short screen and mobile. Show tenant/branch context persistently; do not rely on color alone for state. Never display optimistic financial success.

Required modules and management behavior:

1. **Overview:** permitted gross billed/credits/net/confirmed receipts/due/refund entitlement, low-stock/expiry/exceptions with period definitions/drill-down. Cashier sees authorized own work, not owner totals.
2. **Billing/POS:** product/SKU/barcode search, backend availability/quote, customer/pet reference where needed, eligible batch/expiry/HSN/tax, permitted discounts, clear draft/blocked/issuing/issued/unknown states.
3. **Documents/printing:** correct legal title/fields, Corporate/Classic/Compact A4 and 58/80 mm thermal templates, immutable originals and no stock/finance effects on reprint. Settings version templates; no arbitrary unsafe scriptable template editor.
4. **Inventory:** reviewed products/classifications/UOM, manufacturer batches/expiry/locations/stock status, FEFO, movements, approved counts/adjustments, quarantine/recall/disposal; quantity-only permissions end-to-end.
5. **Purchases:** original supplier bill/date/FY, actual supplier tax components, received lots/expiry/quantity/cost, payable/payment and separate ITC review. Duplicate posting cannot add stock twice.
6. **Supplier returns:** original receipt/batch eligibility, dispatch/reason, supplier acknowledgment/actual credit note and approved legal/accounting treatment. Do not label a buyer memo as an automatically valid seller statutory debit note.
7. **Customers/pets/suppliers:** minimum necessary directory/contact/GST/address fields and source-linked statements; basic pet billing identifiers only, no clinical chart/prescription authoring. Archive referenced masters.
8. **Customer returns/notes:** original invoice/line/batch remaining entitlement, condition/reason, cumulative components, default no-restock, permissioned suitable restock and separate GST eligibility.
9. **Payments/refunds/cash close:** actual confirmed receipts and partial allocations, pending/unverified attempts, separate refund recording, method/reference/date/actor, cashier drawer reconciliation and variance approvals.
10. **Accounts:** party/cash/bank/clearing/inventory/revenue/purchases/tax/expenses/capital/openings, balanced journals/reversals, trial balance, reviewed basic P&L/balance-sheet working outputs, period locks and reconciliation.
11. **Reports:** preserve exactly these 12 core tabs: Summary, Day book, Products, Categories, Cashiers, Payments, GST, GSTR-1, GSTR-3B, Stock, Receivables, Stock log. Add returns, expiry, payables and audit views as needed without dropping the originals.
12. **Settings/staff/compliance/audit/exports:** verified identity/GST profile/series, rule versions, readiness blockers, invoice preferences, individual invitations/permissions/MFA, non-disableable audit and private exports/retention/recovery status.

Roles: owner, explicitly delegated manager, named cashier, inventory operator, accountant/reviewer and separate platform operator. Default cashier restrictions exclude returns/refunds, stock adjustments, classifications, costs/margins, journals and unrestricted exports; allow reprinting approved notes against their authorized own bills. Any broader delegation needs a named permission, not an accidental owner-style payload.

First-use onboarding must be authenticated, owner-verified, empty and gated by necessary configuration. No unauthenticated global “first caller becomes owner” setup. Provide practical first-day, daily close, weekly expiry/access and month/FY-end instructions. SaaS subscription entitlement/admin is separate from clinic customer money; no automatic gateway subscription collection is implied.

## 5. Financial workflows and transaction implementation

### 5.1 Quote and finalize

Drafts are versioned, not issued invoices. A quote is computed on the backend from same-tenant references and applicable rule versions. Revalidate all facts at finalization: stock/expiry/status, price/discount authority, supply/recipient/PoS, mandatory fields, licensing/e-invoice prerequisites and draft/quote version. Do not silently accept a changed total; return a reviewable conflict.

For a supported ordinary sale, one Mongo transaction must:

1. Resolve the operation identity and matching canonical payload hash.
2. Validate same-tenant references and legal readiness; recalculate exact approved totals.
3. Allocate eligible FEFO stock and perform conditional available-quantity/version updates. No count-then-write race, negative stock or expired-batch override.
4. Atomically obtain the legal registration/FY series number; no frontend or count-plus-one generation.
5. Insert immutable complete financial/line snapshots and original batch/cost allocations.
6. Insert movements, balanced source-unique GL entries, any actual confirmed receipt, audit and unique outbox events.
7. Record the durable idempotency result; commit majority-durable and only then respond issued.

Every repository operation uses the same session. Do not use `Promise.all` or network/PDF/email/storage side effects inside a retriable callback. Do not send an HTTP response inside it. Bound transaction/driver retries to the function budget. Handle the specifically expected idempotency conflict, not every duplicate-key error, as a possible replay. Driver guidance: [1](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/)

Keep finalization/source-draft uniqueness so a new key cannot finalize an already issued draft twice. Operation status lookup remains authorized. If a response is lost, preserve the original key and resolve it; no new financial queue/retry on reconnect.

### 5.2 Numbering and state

Reserve/generate server-side; enforce full printed-number format/length, approved scopes and FY behavior. Track committed/exposed issued/cancelled/reserved/abandoned numbers and never silently reuse them. Coordinate with other systems using the same legal registration. An unexposed candidate rolled back with its whole transaction is not an issued or durably reserved number. Separate immutable document truth from mutable state projections; business lifecycle, statutory acceptance/cancellation, settlement and physical fulfillment are distinct dimensions.

### 5.3 Purchases, inventory and adjustments

Posting a genuine receipt creates stock/cost layers, movements/payable/tax-review/accounting once. Direct product quantity editing is not an opening/receipt/adjustment workflow. Document actual supplier tax; never split a single total into invented input components or auto-claim ITC. Partial/bonus receipts and supplier returns require exact quantity/cost policy and source links. If a partial receipt/accrual flow is not implemented, block it instead of inventing a full receipt.

Month/year expiry retains its precision and reviewed sell-by cutoff; recalled/quarantined/cold-chain-unverified/damaged stock is ineligible even if a calendar expiry is future. Required unknown expiry blocks sale. Backdating a new counter sale must not bypass current custody, expiry or period controls. Disposal records actual approved handling, not merely a UI balance subtraction. Support authorized internal consumption, wastage and damage/expiry write-offs as explicit movement/voucher types with approved expense/COGS/tax-review treatment, not hidden quantity edits.

### 5.4 Returns and credit entitlement

Use the original finalized invoice, line and sold batch allocations. All previous partial, full, commercial and no-restock credits consume the correct entitlement. For the ordinary unadjusted sale, cumulative monetary allocation must reconcile exactly:

`new component = rounded(original component × cumulative returned quantity / original quantity) − previously allocated component`

Use an approved deterministic implementation with proper caps/residuals. Current product prices/rates cannot affect old return amounts. The last valid return must reconcile original quantities, discounts, taxable value, components and gross—not create an extra credit from rounding.

Authorized later debit/price-correction notes are separate immutable source-component entitlement buckets linked to the original line. Explicitly design/test their return allocation and the effect of earlier non-quantity commercial credits; the simple unadjusted formula is not universally sufficient. Never edit originals, over-return physical quantity or credit a source component twice. Provide a reviewed undercharge/debit-note workflow with correct numbering/tax/GL and no stock movement for a price-only change.

Restock defaults false. Only explicitly approved suitable goods in an eligible original batch/location can increase saleable stock and reverse the appropriate original allocated cost/COGS. A non-restocked return creates no false inventory/COGS reversal; record physical returned/quarantine/disposal custody separately and avoid a second cost write-off. Refuse ordinary product-return credits for an already delivered service unless the separate authorized correction workflow permits it.

Commercial customer credit and eligible GST adjustment are separate. Keep original tax reference versus actual GST adjustment/status/evidence; late or ineligible commercial credits can change customer balance without lowering output GST. Remaining/full credit considers earlier returns and cannot reverse an invoice twice. Concurrent returns conditionally consume remaining entitlement in the same transaction.

### 5.5 Payments, refunds and cancellation

Confirmed manual receipts mean staff actually verified money received; pending/unverified UPI/card is not paid. Record method/reference/date/amount/actor and exact allocations. No card PAN/CVV/PIN/bank password. Duplicate reference checks follow the actual provider/account semantics; split allocations do not become duplicate receipts.

A credit does not send money. A refund is a separate permissioned, idempotent confirmed outflow after actual external payment, capped transactionally by real entitlement. Pending/failed refunds do not reduce cash. Support receipt reversals/corrections with history; block unexplained overpayments/advances until an approved receipt-voucher/time-of-supply flow exists.

Base supported-case settlement: net billed = original gross + valid debit adjustments − customer credits; net received = confirmed receipts − confirmed refunds − confirmed receipt reversals; due/refund entitlement are positive differences in the appropriate direction. Explicit credit transfers/advances require separate allocation/accounting design, never double subtraction.

Draft discard is not issued cancellation. Issued correction/cancellation needs permission/reason, preserved number/core, lawful eligibility, genuine external acknowledgment if required, linked financial/stock events and separate refund. Cancellation cannot magically return goods to custody or erase bank movements.

## 6. India tax, medicine and legal-policy requirements

Verify current official instruments at implementation/release and obtain tenant-specific review. Maintain a versioned legal-assumption register with source URL, publication/commencement, applicability, interpretation/reviewer/evidence, effective range, supported/blocked cases and review date. Store rule/template versions on originals. Clearly differentiate `unverified`, `applicable`, `not applicable after review`, `future not effective` and `unsupported`.

### 6.1 Tax/document engine

- Distinguish regular GST, composition and unregistered profiles. Do not collect GST without entitlement or assume every document is a tax invoice. Implement legally relevant tax invoice, bill of supply, reviewed ordinary commercial record, notes and receipts/vouchers.
- Validate supplier/recipient/description/HSN-SAC/UOM/discount/value/component/PoS/declaration fields by actual transaction; not every field is universally mandatory. Rule 46 numbers are no more than 16 characters with the specified permitted characters and uniqueness. [2](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html)
- Do not invent HSN/SAC/rates or treat classification regex/reference suggestions as professional approval. Verify turnover/recipient-dependent HSN detail and current notifications/portal rules. Keep exemption, nil rate, zero rating and out-of-scope categories distinct.
- Entry 46 of Notification 12/2017–Central Tax (Rate) concerns veterinary-clinic animal/bird healthcare, not all medicines/retail/grooming/boarding/software. Verify exact current classification and composite/mixed supplies. [1](https://cbic-gst.gov.in/hindi/pdf/central-tax-rate/Notification12-CGST.pdf)
- Determine goods/services place of supply from actual applicable rules and facts, not merely customer home state. Review bill-to/ship-to, unregistered delivery-address and service cases separately. Apply CGST/SGST, CGST/UTGST or IGST lawfully. Unsupported special cases block.
- For supported **new** applicable equal-rate intra-state cases, CGST and SGST/UTGST paise amounts must be equal under an approved rounding policy. Never silently assign an odd paise to only one half. If fixed inclusive price/component equality cannot reconcile lawfully, use a reviewed explicit policy or reject before issue. Preserve legacy amounts and original correction bases, including unequal saved components.
- Validate discounts/time of supply and rounding. Do not recalculate originals after rule updates. The CBIC section 15/34 pages accessed for this specification show 2026 amendments marked awaiting notification; recheck actual commencement rather than activate displayed future text automatically. [1](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter4/section15_v1.00.html)

### 6.2 Notes, integrations and special transactions

- Apply current section 34 conditions and reporting cut-off: 30 November after the relevant FY or relevant annual-return filing, whichever earlier, and applicable tax-incidence/recipient ITC-reversal conditions. Distinguish issuing a commercial credit from entitlement to reduce output GST; preserve evidence/status and operative effective dates. [1](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter7/section34_v1.00.html)
- Verify e-invoice supplier/document/recipient applicability, parent notifications, look-back and exemptions. Notification 10/2023 uses the relevant **exceeding ₹5 crore** context; do not confuse it with the separate **AATO ₹10 crore and above / 30-day IRP reporting** restriction from 1 April 2025. [1](https://www.gstcouncil.gov.in/node/4365) [5](https://www.gst.gov.in/newsandupdates/read/543)
- Never invent an IRN, signed QR, cancellation acknowledgment or e-way bill. Ordinary PDF/UPI QR ≠ authentic e-invoice. Covered final document delivery remains blocked until its necessary statutory prerequisites are valid.
- External calls belong outside retriable DB callbacks: durable frozen intent/number/hash → outbox → provider idempotency/status lookup → controlled completion. Unknown provider success must not free reservations/reuse numbers or produce a second invoice. If external success precedes a DB outage, reconcile the same identity; compensate only through the actual lawful process.
- E-way movement rules, dynamic B2C QR, RCM/advances, cess, exports/SEZ and inter-registration transfers require their own current applicability/design. Do not generalize one ₹50,000 rule or ordinary-retail tax flow to all cases. Keep unsupported affected operations disabled.
- October 2026 recipient-generated RCM self-invoice sandbox features (`RCMDOM`/`RCMIMP`) are a change-watch item pending the relevant production/legal commencement; recommendations/sandbox availability are not automatically operative law. [2](https://www.gst.gov.in/newsandupdates/read/678)
- Input-tax eligibility is separately reviewed; actual supplier tax components, evidence, exempt/taxable common inputs, blocked credit/reversals and GSTR-2B review matter. Purchase tax is not automatically claimable ITC.

### 6.3 Medicine sale, MRP and external records

- Verify tenant/location/product-specific drug sale/dispensing licences, personnel, prescription/order and register requirements under current central/state law. Do not assume an own-patient clinic exemption authorizes open retail.
- Record necessary external references and genuine sale/dispensing particulars even though clinical/prescription authoring is excluded. Review legally acceptable physical/digital register/signature formats. The retrieved CDSCO rule 65 compilation includes animal-owner particulars, H1 separate records/three-year preservation and X prescription/retained-copy conditions; it is an older compilation, not a complete 2026 amendment check. [1](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules,%201945%20(1).pdf)
- H/H1/X/NDPS or other restricted medicines remain blocked unless their actual licence/external prescription/register/controlled-stock process is implemented and reviewed. No fake licence/clinical approval checkbox.
- Enforce applicable tax-inclusive MRP and verified current NPPA/DPCO price controls/pack conversions. Do not add GST above an inclusive applicable MRP or guess a current ceiling. Review the 2026 DPCO amendment and actual revised-price/batch evidence, not only an old base compilation or originally printed MRP; do not impose manufacturer-only duties on every retailer. Verify lawful split-pack dispensing.
- Prevent expired/recalled/damaged/ineligible resale, quarantine unsafe returns and record approved supplier-return/disposal evidence. A write-off is not lawful physical disposal; never generate fake certificates.
- Where income-tax/professional rules require a case register or other records outside this product, document an approved external process or block unsupported onboarding. Do not claim billing screens replace clinical/professional records.

### 6.4 Cash, retention, signatures and privacy commencement

- Apply reviewed Income-tax Act 2025 section 186 restrictions: the official text addresses receipt of ₹2,00,000 or more in the specified non-permitted modes using alternative person/day, single-transaction and event tests, subject to stated exemptions. Aggregate by actual receiving legal entity across relevant branches and payments, not just per invoice/customer-row. Detect split/relabel attempts; require verified payer/exception evidence as needed and reconcile outside-system receipts. Review other current PAN/cash/reporting provisions. [1](https://www.incometaxindia.gov.in/w/section-186-41)
- GST records generally use section 36's 72 months from relevant annual-return due date, with proceedings/investigation extensions/holds. Do not substitute invoice-date six years. Rule 56/57 stock/accounts/edit-log/authentication/backup requirements need actual controls. A hash/scanned signature is not a legally recognized digital signature; review rule 56 electronic-record authentication separately from rule 46 invoice exceptions.
- Notified Income-tax Rules 2026 rule 46 includes specified electronic-books accessibility in India, daily India-server backups, seven-tax-year retention and reopened-assessment provisions; additional medical-profession records (including Form 25) need professional applicability review. Do not rely only on superseded rule numbers/forms. [1](https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-03/En-Notified-IT-Rules-2026-20-03-2026.pdf)
- Company tenants need current company-books/audit-trail/India backup/access/retention review, including non-disableable accounting edit history and applicable eight-FY records. An application owner or runtime credential must not routinely alter immutable history. Independent evidence/privileged-change controls are necessary; hash chains are not an audit certification.
- As of the specification research date (26 October 2026), DPDP Act/Rules 2025 have phased commencement. Rules 1/2/17–21, rule 4 after one year and rules 3/5–16/22–23 after eighteen months follow the official publication/commencement instruments and corrigenda. Confirm exact dates and later changes; do not say all substantive duties already apply or ignore current IT Act/SPDI duties. [2](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf) [1](https://www.meity.gov.in/static/uploads/2025/12/3c7ebbae0e5456f493f486e6845df86b.pdf)
- Design notices/purposes/appropriate consent or other permitted grounds, rights/grievance/access/correction/erasure with lawful retention, children/guardian handling, processor/vendor contracts, transfer assessment and incident evidence. Do not collect Aadhaar/biometrics/human medical history/card credentials by default. Do not claim to be a statutory Consent Manager from a consent UI.
- Assess CERT-In applicability: listed reportable incidents within six hours and covered ICT log retention for 180 days within Indian jurisdiction, plus required contact/time-sync duties. Future-applicable DPDP security/processing retention and breach duties are separate, including their one-year provisions and prompt/detailed-report distinctions. Do not wait 72 hours for every incident. [1](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf)
- Keep maximum applicable record-class retention and legal holds; no automatic whole-tenant purge on subscription expiry. An India function region alone does not establish India storage of every backup/log/vendor flow.
- Preserve electronic evidence/artifact hashes/custody/source and actual signatures as applicable. Hash ≠ court admissibility certificate, official IRP evidence or professional legal opinion.

## 7. Complete double-entry accounting extension

Implement a genuine transaction-linked ledger, not financial-looking cards or a disconnected manual spreadsheet. Maintain customer/supplier subledgers and cash/bank/clearing/inventory/sales/services/returns/discounts/COGS/GST/expense/capital/opening accounts with reviewed mappings.

- Purchase/receipt: inventory and appropriate eligible/pending/non-recoverable tax treatment versus payable/actual payment; never automatic input-credit eligibility.
- Sale: receivable versus revenue/output tax; allocated COGS versus inventory.
- Receipt/supplier payment: actual money account versus the party balance.
- Eligible customer credit: approved contra-revenue and only eligible tax adjustment versus party credit; commercial-only credit must not automatically debit output GST.
- Explicit eligible restock: restore original approved cost/inventory versus COGS; no such reversal merely for no-restock returns.
- Refund/loss/expense/opening/transfer/journal events: balanced source-linked mappings and actual evidence; no duplicate cost loss after a no-restock return.
- Every posted journal uses same-tenant valid accounts, exact balanced lines and unique source-event/posting identity. Immutable after posting; reverse/correct with links. No fake balancing entry.
- Openings require genuine reviewed inputs and coordinated party/stock balances; no double-counting inventory. Period locks and controlled reopen preserve both actual business date and recorded time.
- Reconcile trial balance, stock carrying value, party allocations, cash/bank and tax working balances. Basic management P&L/balance sheet need reviewed account mappings and must not be labeled audited statutory statements.

Payroll, depreciation policy, consolidation, income-tax filing and statutory audit are not silently included just because the GL is included. Document them as future scope unless separately approved.

## 8. Reports, audit, privacy and security

Every report supports Today, 7 days, This month, Last month, Financial year, All time and custom From/To, applicable branch/registration/cashier filters, metric definitions, drill-down and permission-controlled CSV. Preserve event-date/as-of semantics: issue date, receipt date, return date and refund date differ. Date queries use reviewed business-timezone half-open UTC bounds.

Provide invoice/customer/user sales detail and cancelled/return/discount/payment-method drill-downs. Separate gross billing, discounts, commercial credits, eligible GST adjustments, net billed, confirmed receipts, refunds, due, refundable amount and actual cost/margin. Non-restock returns do not falsely restore profit. Clearly label GSTR-1/3B outputs working registers/papers, not filed returns/ready portal JSON. Historical stock and balances reconstruct from events or verified snapshots with freshness/source watermarks; later events do not leak into an earlier as-of report.

Provide non-disableable append-only audit for finance/stock/corrections, rule/permission changes, sensitive access/exports, support grants, migration and restore. Record actor/time/source/request/reason and safe before/after values; never passwords/tokens/card credentials/raw sensitive bodies. Record failed privileged attempts in a safe operational/security trail without fabricating a committed financial posting. Protect independent evidence against privileged tampering and document residual administrator risk honestly.

Use maintained authentication patterns, strong password hashing, secure HttpOnly/Secure cookies, appropriate SameSite/CSRF/origin checks, owner/platform MFA, controlled invitations/reset/recovery, secure headers/CSP, output escaping, distributed rate limits and restricted operational endpoints. Validate request sizes, file type/size/scan and SSRF-safe uploads; no arbitrary URLs. Do not make costs/private customer data available in bootstrap payloads, error messages or downloadable hidden fields.

Files/exports are private, server-keyed and tenant/role/purpose-bound. Authorize before minting short-lived downloads; record access, enforce retention and scan untrusted attachments. Preserve original document/template/artifact versions; reconstruction is not falsely presented as an identical original file. Privacy rights and legal retention operate together. Publish reviewed service/privacy/DPA/support/termination terms and acceptance versions; no disclaimer replaces security or professional/legal responsibilities.

## 9. Vercel, Atlas, durable jobs and operations

- Browser calls same-origin relative APIs; database/keys never enter `VITE_` variables or the frontend bundle. In preview/deployment, never point browser code at localhost for its backend.
- Use Node.js functions, correct API/SPA routing and an explicitly selected approved region; test direct frontend reload and API paths in the actual Vercel runtime.
- Reuse a bounded Mongo pool across warm invocations; avoid per-request connect/close or a pool per tenant, clear failed cached connections, and size total connections for real function concurrency. Pin supported runtime/driver/dependency versions and verify lockfile/build/audit.
- Verify actual Atlas backend egress/allowlist/private-network options. Never disable TLS verification. A generic TLS failure is not proof of a single cause. Broad `0.0.0.0/0` access is not a silent default; stable egress/private networking has plan/cost implications requiring approval.
- Vercel functions are bounded/stateless. No durable local disk, in-memory-only queues, startup timers, unawaited financial effects or hidden persistent worker. Verify current function/body/response/plan/Cron limits. Commercial SaaS is not assumed eligible for a free personal-use plan.
- Insert outbox jobs transactionally with the source event. Authenticated Cron atomically claims small due batches using lease tokens/expiry; checkpoint bounded work, reject stale lease commits and tolerate overlap/crash/retry. Backoff/dead-letter/redrive require controlled review. Downstream handlers/provider calls use source identities/status reconciliation; no unqualified external “exactly once” promise.
- Large exports/private PDF artifacts use bounded jobs and approved private storage; no huge synchronous buffered response or full-database backup in a normal function. Temporary file use is not durable storage.
- Use separate dev/staging/prod secrets/databases/storage/provider accounts; previews cannot use live tenant data. Record cost/location/subprocessor features and approval before enabling services.
- Monitor latency/errors, scope violations, unknown outcomes, pool pressure, reconciliation differences, queue age/dead letters, backup age/restore evidence and expiring legal rules/licences.
- Verify real backups/PITR, India-required daily copies and security-log retention. Exports are not complete backups. Document measured RPO/RTO; proposed targets are not guaranteed without drills/tier evidence.
- Restore into isolation, reconcile money/stock/GL/rules/files and transactions after the restore point, restore a safe document-number fence before new issue, reconcile external jobs/providers and revoke stale sessions as needed. Do not overwrite other tenants, reissue old numbers or resend financial actions blindly.
- Migrations/backfills/imports/restores require dry-run/backup/target confirmation, counts/hashes/balance reports, rollback/cutover approval and separate restricted credentials; never mutate all production data on startup. Preserve source archives and historical snapshots. Reinvite staff rather than import live sessions/secrets.
- Operational diagnostics are sanitized and authorized; deep status never dumps environment secrets, connection strings, customer records or raw stacks. Provide actual incident contacts/reporting clocks/evidence retention.

## 10. Initial exclusions and honest capability gates

Keep excluded unless separately approved: clinical records/prescription authoring, online pharmacy marketplace/delivery, controlled-drug workflows without validated prerequisites, payment aggregation/custody/automatic gateway refunds, automatic GST filing, payroll/consolidation and unimplemented statutory integrations/special supplies. An approved external workflow must be concrete and lawful; a generic checkbox or disclaimer is insufficient.

If an excluded capability is legally mandatory for a tenant/transaction, disable that transaction or restrict onboarding until a verified solution exists. Do not tell the user that an excluded integration removes legal obligations. Do not broaden scope, charge for services or claim an external account was configured without authorization.

## 11. Required executed tests and release evidence

Use the existing test framework where practical, plus real replica-set Mongo integration, direct API/security, browser/accessibility, official Vercel runtime and operational/manual tests. Mocks alone cannot prove transactions/indexes. Maintain a requirement-to-test matrix and record command/environment/time/result/artifact. Do not mark unrun tests passed.

At minimum execute:

1. Empty tenants/no demo; authenticated onboarding; safe owner recovery.
2. Two-tenant adversarial access across every read/mutation/child/lookup/report/PDF/CSV/file/job/cache/support path; current permissions/branch revocation; restricted money absent from payloads.
3. Money/quantity/rate bounds, overflow, odd paise, inclusive/exclusive, discounts, equal applicable halves, immutable old rates/amounts and full residual return allocation.
4. Document/GST profile/HSN/PoS/required-field boundaries; unsupported statutory/medicine workflows blocked; genuine integration failure/duplicate/unknown outcome where implemented.
5. Parallel invoice numbering/FY/series, last-unit stock FEFO/expiry/quarantine races, duplicate receipt/finalization, same/different idempotency payload, injected transaction failures and lost commit responses.
6. Purchases, supplier returns, cumulative partial/no-restock/eligible-restock/remaining credits, concurrent return caps, separate GST eligibility, partial/pending receipts, refund caps/concurrency and lawful cancellation/compensation.
7. Exact balanced unique-source GL, stock/party/cash/tax reconciliation, genuine openings/expenses/journals/reversals/period locks and no false no-restock COGS reversal.
8. All 12 report tabs, date presets/custom/as-of/event dates, roles/CSV, working-paper labels, A4/58/80 mm fields/reprints and independent sidebar scrolling/accessibility.
9. Auth/CSRF/MFA/rate limiting/operator injection/XSS/SSRF/upload, redacted errors/logs, append-only/non-disableable audit, legal holds/privacy rights and secret scanning/dependency checks.
10. Outbox overlap/lease expiry/stale-token/crash/backoff/dead-letter/provider reconciliation; private exports/download expiry and large-work budgets.
11. Atlas/TLS/pool limits, actual Vercel routes/HTTPS/env/runtime, protected previews, actual India-required logs/backups and isolated restore with number/provider/session reconciliation.
12. Migration preservation/cutover/rollback and professional policy/licensing/privacy/contract evidence. Correct known research limitations at actual release rather than hide them.

No release if mandatory isolation, money, stock, numbering, payment/return, GL, audit, legal eligibility or recoverability tests fail. A limited release is valid only for independently safe supported profiles with blocked unsupported functions.

## 12. Delivery, implementation order and your immediate response

Build incrementally: inspection/approved plan → CI/safe environments → tenancy/auth/field permissions → validators/indexes/exact money/legal policies → masters/purchases/stock with GL → atomic sales/printing → returns/refunds/corrections → complete accounting/reporting → durable audit/jobs/privacy/backup → approved integrations or tested exclusions → staging/migration/runtime/security/professional review → authorized production.

Deliver:

- Working JavaScript source and lockfile, versioned models/validators/indexes/migrations and APIs/data dictionary.
- Feature/permission/gap/requirement traceability, tests with actual raw results and a list of failures/limitations.
- Exact-money/rounding/accounting/legal-policy documentation and source/effective-date/reviewer register.
- `.env.example` placeholders only, Vercel/Atlas deployment steps, secure setup and operating guide.
- Migration/reconciliation/backup/restore/incident/runbook tools and evidence; no production secrets/DB/demo business data in archives.
- Owner/cashier/inventory/accountant instructions, complete reports/template documentation and a go/no-go record signed by the appropriate business/technical/professional-policy reviewers.

**Your immediate first response must be the repository findings, approved-scope confirmation, gap analysis, unresolved factual/legal questions and phased implementation/testing plan. Do not claim the product is already built, deployed, tested or universally compliant. Do not start destructive changes or paid provisioning before approval.**
