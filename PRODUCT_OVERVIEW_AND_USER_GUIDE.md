# Product overview and operating guide

**shop desk · The Good Vets · Proposed multi-tenant online edition**

This guide describes the target product, not a claim that a new SaaS is already running. Configuration, legal applicability and permissions determine which controls can be activated. All examples below are training arithmetic, never production seed data.

## 1. What the software is

shop desk is a browser-based veterinary counter-management system connecting products, batches, purchases, sales, payments, returns, inventory and double-entry books. Different clinics use the same platform but must never share business records, credentials or financial reports accidentally.

A **tenant** is an independent business workspace. A **branch** is a location within that tenant. A **GST registration** identifies the supplier registration used for a transaction; it is not simply the tenant's display name. One tenant may have several branches and registrations, but a new installation can start with one of each. Transfers between registrations are disabled until their tax and document workflow is approved.

The product is not a veterinary diagnosis tool, prescription-authoring system, payment custodian, tax adviser or automatic GST-filing service. A veterinarian/clinic may still have professional recordkeeping obligations in another approved system.

## 2. Who sees what

| Role | Typical access | Restrictions |
| --- | --- | --- |
| Tenant owner | Business setup, staff, approvals, returns/refunds, accounts, reports, exports and recovery requests | Cannot silently rewrite issued invoices, disable the audit trail, bypass law or inspect another tenant. |
| Manager | Only the explicitly delegated sales/inventory/approval permissions | No automatic owner powers; refund and tax-setting permissions are separate. |
| Cashier | Own drafts/bills, permitted receipts, shared minimal customer/pet directory, own approved return-note reprints | No stock corrections, tax-classification changes, cost/margin reports, journals, unrestricted exports or refunds by default. |
| Inventory operator | Products/batches/receipts and quantity-only inventory views if granted | Purchase cost, valuation, selling prices and billing totals require their respective permissions; hiding a column alone is insufficient. |
| Accountant/read-only reviewer | Authorized ledgers, working papers, period reviews and exports | Posting, reversals and tax eligibility approvals require additional permissions. No staff/password administration by default. |
| Platform operator | Tenant lifecycle, plan entitlements, deployment health and incident coordination | No default access to clinic invoices or customer data. Exceptional support access must be approved, time-limited and audited. |

Names must identify the actual person. Do not share the owner login among cashiers. An owner's membership in one tenant never grants access to another. Staff deactivation must revoke sessions, including already captured sessions used in later requests.

## 3. Navigation and visual presentation

The tenant and active branch must remain visible at the top of the application. Use a dark, readable system font, clear labels and borders, restrained colors, keyboard focus and accessible errors. The desktop sidebar itself must scroll independently so Accounts, Reports and Settings remain reachable on short screens. Mobile navigation must have the same permitted features.

Suggested navigation:

```text
Overview
Billing & POS
Returns & credit/debit notes
Inventory
Purchases & supplier returns
Customers & pets
Suppliers
Payments & cash close
Accounts & ledgers
Reports
Staff & permissions
Settings & compliance readiness
Audit & exports
```

Show only permitted entries, but enforce every restriction again in the API. Consequential actions need an explanation, confirmation and final backend status. Do not show an “issued”, “paid”, “refunded” or “compliant” badge optimistically before the relevant commit/confirmation.

## 4. Screen-by-screen feature specification

### 4.1 Overview

**Show:** selected period, gross billed, customer credits/returns, net billed, confirmed receipts, outstanding balances, refundable amounts, low-stock/expiry alerts and unresolved operational exceptions. Owners may see cost and valuation cards; other users must not receive those values through the API.

**Use:** choose Today, 7 days, This month, Last month, Financial year, All time or custom From/To. Drill into the contributing source documents. A cashier dashboard is limited to that cashier's authorized work, not the entire clinic's sales.

**Manage:** every metric needs a definition and a drill-down. Invoice date, receipt date and return date are different measures; do not compare them as if they were the same event.

### 4.2 Settings and compliance readiness

**Show:** legal/trade name, address, state/UT, GST status, registration(s), financial-year series, business timezone, receipt methods, invoice templates, permissions, retention rules and readiness issues.

**Use:** owner enters the actual supplier identity, confirms GST status (regular/composition/unregistered as applicable), obtains classification/document review and selects supported transaction profiles. Configure each series before billing. Store approval evidence and effective dates.

**Manage:** tax changes create new versions, not changes to old invoice snapshots. Expired licences, unsupported e-invoice obligations, unreviewed tax rules or missing mandatory recipient fields must block the affected sale, not merely display a dismissible warning. “Not required” must be a reviewed applicability conclusion, not a synonym for “not configured”.

### 4.3 Products and services

**Show:** name, SKU, barcode, goods/service type, category, UOM, pack conversion, permitted quantity precision, sale price, inclusive/exclusive mode, HSN/SAC, tax treatment/rule, batch requirements, expiry requirements, manufacturer, applicable restrictions and active status. Owner-only fields include purchase cost and margins.

**Use:** create a product, select verified classifications, set price and UOM, and save. Search by name/SKU/barcode at the counter. A reference lookup can suggest a classification for review; it must not invent a legally approved HSN/rate or silently activate it.

**Manage:** archive products instead of deleting referenced products. Maintain effective-dated tax/price history. A service has no stock deduction. A product bundle must not receive a guessed “healthcare exempt” or highest-rate mixed-supply treatment; unsupported composite/mixed supplies are blocked pending review.

### 4.4 Inventory, batches and expiry

**Show:** physical location, product, manufacturer batch, labelled expiry and precision, available/reserved/non-saleable quantities, supplier/receipt links, status and movement history. Quantity-only views must contain no unauthorized value, cost or margin fields in HTML, JSON, CSV or PDF.

**Use:** receive stock through Purchases or an approved opening/adjustment workflow. View batches; FEFO chooses eligible first-expiring stock. Near-expiry filters help review 30/60/90-day horizons. A month/year label must retain that original precision and use a reviewed sell-by interpretation.

**Manage:** block expired, recalled, quarantined or otherwise ineligible batches. Unknown required expiry blocks sale. Physical counting produces an adjustment document with reason and approval; never type over a historical balance. Every movement is append-only, including internal consumption, wastage and damage/expiry write-off with approved accounting/tax-review treatment. Quarantine/disposal is not the same as a sale, customer credit or supplier refund.

### 4.5 Purchases and goods receipt

**Show:** supplier, supplier invoice/date/FY, receipt lines, batch/expiry, quantities and bonus units, costs and discounts where permitted, actual supplier GST components, receipt status, payable and payments.

**Use:** select supplier, enter the genuine supplier bill, record eligible batches and quantities, review costs/tax, then post receipt. The posting adds stock and the accounting liability once. A repeated submission must return the same result, not add stock again.

**Manage:** duplicate bill checks use the proper supplier/FY scope. Never split a single supplier GST amount into guessed CGST/SGST or mark it automatically claimable ITC. ITC remains pending/ineligible/eligible according to a separately authorized review. A supplier payment reduces the payable, not purchase quantity.

### 4.6 Supplier returns

**Show:** original purchase/receipt, original batches, available quantity eligible to send back, reason, dispatch reference, supplier acknowledgment and supplier credit-note status.

**Use:** select the original receipt, return permitted quantities, approve the inventory movement and record the supplier's actual response. Expired goods returned to a supplier are a documented return/disposal pathway, never a customer sale.

**Manage:** a buyer's commercial return/debit memo is not automatically the original supplier's statutory GST debit note. Track the genuine supplier credit note or other approved legal treatment separately. Do not reduce GST/ITC just because goods left the shelf. No placeholder supplier-return button may be presented as functional before this flow is implemented and tested.

### 4.7 Customers, pets and suppliers

**Show:** only necessary contact/address/GST details, billing and settlement history, and basic pet identifiers. Customer and supplier balances link to the same party ledgers used by accounting.

**Use:** create/select the party before billing where required. A walk-in anonymous sale is allowed only if that document/transaction legally permits it. Collect mandatory recipient information based on value, GST status, goods restrictions and other reviewed rules.

**Manage:** do not use phone number as an unquestionable unique identity; several people/pets may share one. Pet records are billing references, not consultations or prescriptions. Avoid free-text human health information and unnecessary identity documents. Corrections to a directory do not rewrite past invoice snapshots.

### 4.8 Billing and POS

**Show:** searchable products, eligible quantity/batch/expiry, sale price, tax treatment, discounts, customer, document type, place-of-supply decision, backend-calculated totals and receipt entry. Clearly distinguish a draft, blocked validation, issuing/unknown outcome and an issued document.

**Use:** create draft → add products → choose customer/context → obtain a backend quote → resolve warnings → finalize once → print the committed document. Default FEFO can be overridden only to another eligible batch by an authorized person. Discount ceilings and price overrides require permission and audit.

**Manage:** the backend revalidates stock, rules, price permissions and draft version at finalization. A stale quote requires review. Disabling the button helps usability but database idempotency and unique constraints prevent duplicates. Reprinting never posts another sale or stock deduction.

### 4.9 Invoices, receipts and printing

**Show:** appropriate document title, verified supplier identity, number/date, required recipient and delivery data, HSN/SAC, quantities/UQC, discounts, taxable values, legally applicable tax components, place of supply, declarations, final total and authentic statutory integration fields where applicable.

**Use:** select Corporate, Compact or Classic A4; choose 58 mm or 80 mm thermal/POS output; preview/download/reprint. Configure the real printer, paper width, 100% scaling and browser headers/footers. Test in staging or with a non-posting print preview, not a fake production sale.

**Manage:** narrow receipts must still contain their required particulars, with continuation pages if needed. A payment QR is not an IRP-signed GST QR. “Computer-generated” is not a blanket replacement for all legally required authentication. Preserve original snapshots, template version and original artifact; show current settlement separately and label its as-of time.

### 4.10 Payments and cash close

**Show:** invoice, confirmed receipt allocations, pending/unverified payment attempts, amount, method, actual date/time, external reference, recorder, outstanding and refund entitlement.

**Use:** record only money actually received as a confirmed manual receipt. If a UPI/card payment is not confirmed, keep it pending and do not mark the bill paid. Record partial payments individually. A receipt may allocate to several invoices only through an explicitly implemented allocation flow whose sum equals the receipt.

**Manage:** changes use reversal/correction events, not silent edits. Deduplicate requests. Apply reviewed cash-receipt limits and aggregation across the correct legal entity, payer/day, transaction and event. The system cannot see receipts kept in another system, so outside receipts need reconciliation. No card PAN, CVV, PIN or banking passwords are stored.

For cash close, expected cash equals opening cash plus confirmed cash receipts and transfers in, less cash refunds, payouts and transfers out. Count actual cash, record a variance with reason/approval, and post the appropriate accounting voucher. Sales totals are not cash totals.

### 4.11 Customer returns and credit notes

**Show:** original issued invoice/line, original batch allocations, quantity already returned, remaining entitlement, saved original money/taxes, goods condition, reason and a default **Do not restock** choice.

**Use:** owner opens the original bill → Return products → chooses quantities and original batches → records condition/reason → decides disposition → reviews the credit → confirms. A good, eligible return may be explicitly restocked into its original batch only after suitability/resale checks. Cashiers cannot create returns/refunds by default but can reprint approved notes against their own bills.

**Manage:** partial and repeated returns cumulatively allocate the original amounts exactly; all earlier returns count toward caps, including non-restocked goods. Do not reprice using today's catalogue. A non-restocked return does not inflate sellable stock or automatically reverse inventory/COGS. Keep a separate physical disposition record for goods awaiting quarantine/return/disposal.

A commercial customer credit and an eligible GST liability reduction are separate values/statuses. Preserve original tax amounts as references, but apply a GST adjustment only when its legal conditions and reporting eligibility have been validated. A late/non-qualifying commercial credit can reduce what the customer owes without reducing output GST.

### 4.12 Refunds, remaining credits and cancellations

**Use refunds:** approve the refund entitlement → actually return the money outside the software → record date/method/reference/amount → commit once. A refund record does not transfer funds. Pending/failed refunds are not completed cash outflows. Prevent concurrent over-refunds.

**Use remaining-invoice credit:** after earlier partial returns, credit only the still-uncredited quantities/amounts, including any separately approved service correction. Do not combine an old whole-invoice credit with new partial returns and reverse the same money twice.

**Debit notes / undercharge correction:** an authorized owner/accountant selects the original issued sale, records the genuine reason, reviews the additional value/tax and issues a separately numbered linked note under the approved legal workflow. A price-only correction changes no stock quantity. Preserve separate source allocations for later credits/returns, including earlier commercial credits; never edit the original amounts or double-credit the adjustment. Additional goods require their own approved fulfillment/document process.

**Use cancellation:** discard unissued drafts under policy. For an issued invoice, use the authorized legally permitted cancellation/correction process, with reason, timestamps, linked compensating records and any genuine portal acknowledgment. Never delete the issued snapshot or reuse its number. Do not restock goods merely because an invoice status changes; actual custody and suitability matter.

### 4.13 Accounts and ledgers — explicitly included

**Show:** customer/supplier, cash/bank/clearing, inventory, sales/services, sales returns/discounts, GST, expense, capital and opening-balance accounts; journals, reversals, trial balance and basic management statements with clearly stated mappings.

**Use:** post genuine balanced opening vouchers with the accountant; record expenses with supporting references; create balanced journals; review statements and reverse incorrect posted vouchers with linked opposite entries. Period locks control late postings. Automatic sales/purchase/payment/return entries occur in the same transaction as their source action.

**Manage:** sum of debits equals sum of credits for every posted journal. No invented opening balances or automatic “balancing” revenue. Non-restock returns do not create a false inventory/COGS reversal. Tax-credit eligibility and non-recoverable tax treatment use approved mappings. Basic P&L/balance-sheet outputs are management statements, not audited statutory financial statements. Payroll, depreciation policy, consolidation, income-tax filing and statutory audit remain outside the initial scope unless separately contracted.

### 4.14 Reports and exports

Preserve these 12 core tabs: **Summary, Day book, Products, Categories, Cashiers, Payments, GST, GSTR-1 working register, GSTR-3B working papers, Stock, Receivables and Stock log**. Add returns, expiry, purchases/payables and audit/reconciliation views where needed; account statements/trial balance remain under Accounts.

The sales register/drill-down also provides invoice/customer/user detail, cancelled sales, discounts, returns and payment-method totals.

Every report supports approved date presets and custom From/To, branch/registration filters, definitions, drill-down and permission-controlled CSV. GSTR labels must visibly say working papers/registers—not official filed returns or ready-to-file portal JSON. Distinguish gross billed, discounts, commercial credits, eligible GST adjustments, confirmed receipts, refunds, net billed, due and margin.

Historical reports use source event dates and saved snapshots. A receipt today against an older invoice belongs in today's receipts but not today's newly billed sales. Large exports run as durable jobs, remain private and expire according to policy. Quantity-only permissions also apply to downloads and hidden fields.

### 4.15 Staff, audit, backups and tenant administration

**Staff:** invite individual users, assign branch/role permissions, require owner/platform MFA, review discount/export/refund rights and disable departed users immediately.

**Audit:** review actor/time/action, source IDs, safe before/after changes, approvals, exports, permission changes and correction links. The audit trail cannot be turned off by an owner or ordinary application administrator.

**Backups:** inspect actual last-success time, scope, encryption, India storage evidence where required and restore-test results. An export is not a complete disaster-recovery backup. Tenant recovery must not overwrite other clinics or accidentally import someone else's credentials.

**Platform administration:** manage tenant activation/entitlements without gaining automatic access to clinic records. Record legal terms/privacy/DPA acceptance versions. Subscription collection is initially manual/externally administered unless a separately approved gateway is built; never pretend the clinic payment ledger is the SaaS provider's subscription ledger.

## 5. First-time setup checklist

1. Verify the owner identity and create a tenant through an authenticated onboarding/invitation flow.
2. Enter the actual business/branch/registration details; review tax status, required records and product/licensing scope.
3. Complete the compliance-readiness gates and accountant-approved document/tax/ledger configuration.
4. Configure unique FY series and coordinate them with any other billing system using the same registration.
5. Create staff accounts and least-privilege permissions; set printing preferences.
6. Create genuine suppliers/products and reviewed classifications. Import only verified opening stock and balances through controlled tools.
7. Test the whole workflow using **separate staging data**, including failed/unknown outcomes, returns and printer widths.
8. Verify backups, restore, India-required storage/log arrangements and incident contacts before first real bill.
9. Activate production. Do not enter sample sales or silently reset a tenant to make it look empty.

## 6. Daily, weekly and month-end management

**Opening:** confirm the correct tenant/branch, connection/readiness status, receipt printer, active staff and any urgent recalls/expiry alerts. Record genuine drawer opening cash if used.

**During the day:** receive stock through documents; bill only eligible batches; verify manual digital receipts; resolve unknown outcomes through the operation-status screen rather than posting again under a new key.

**Closing:** reconcile cash and UPI/card/bank references, review pending receipts/refunds, compare net billed versus cash collected, investigate failed jobs and confirm backup success.

**Weekly:** perform selective physical stock checks, review near-expiry/quarantine/disposal, outstanding parties, staff access and reconciliation exceptions.

**Month/FY end:** accountant reviews tax working papers, ITC eligibility, credit/debit-note eligibility, trial balance, inventory valuation and locked periods; approve rule/series changes for future transactions. Legal retention survives tenant closure.

## 7. Worked counter example

Illustrative only: taxable value ₹1,000 at 12% produces ₹60 CGST + ₹60 SGST in an applicable intra-state case, total ₹1,120. A confirmed ₹700 receipt leaves ₹420 due. A valid 30% customer credit of ₹336 reduces net billed to ₹784 and due to ₹84. A later credit of the remaining ₹784 leaves net billed zero and ₹700 refundable; a confirmed ₹700 refund then clears that entitlement.

The inventory decision is independent: restock only the explicitly eligible original quantities/batches. GST reduction is independently subject to legal eligibility. The invoice remains preserved throughout.

## 8. Limits users must understand

- Internet access is required for authoritative billing. No offline sale/payment queue or automatic background financial replay.
- “Record receipt/refund” is a human-entered record, not bank verification or a transfer.
- A tax classification lookup is not professional classification approval.
- An ordinary PDF, hash or payment QR is not an IRN, statutory signature or compliance certificate.
- A feature excluded from this product may still be a legal obligation of the clinic; use an approved external process or block the affected transaction.
- Recovery from an old backup is not permission to reuse document numbers or ignore transactions after the recovery point.
