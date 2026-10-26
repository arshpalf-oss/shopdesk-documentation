# Acceptance tests, traceability and release gates

**shop desk · New multi-tenant SaaS target · 26 October 2026**

**Status:** this is the required test plan. The proposed SaaS has not been implemented or executed by preparing these documents. No row below should be marked passed until the coding team runs it and records the actual environment, command, result and evidence. Existing reference-edition tests do not prove the new tenant/security/legal requirements.

## 1. Test layers and evidence

- Pure unit/property tests: money, quantities, rates, allocation/rounding, expiry/FY/date bounds, status transitions and ledger rules.
- Native Mongo replica-set integration tests: real sessions, transactions, validators, indexes, conditional concurrency and failpoints where supported. A mock cannot prove atomic rollback or real unique-index behavior.
- API/auth/security tests: direct HTTP requests bypassing the UI, two-tenant adversarial cases, field-level DTOs, files/jobs and lifecycle permissions.
- Browser/accessibility tests: owner/cashier/inventory/accountant roles, scrollable navigation, empty state, no optimistic finance, failed/unknown outcomes and printing.
- Runtime/deployment tests: official Vercel build/runtime/routing, real HTTPS auth/origin settings, database networking/TLS/pools, Cron auth/overlap and provider limits.
- Operational/legal acceptance: verified source/configuration review, actual storage/log location, migration/reconciliation, printer checks, backup restore and incident rehearsal.

For every scenario retain: test ID, requirement IDs, fixture/version, database/runtime, execution command, timestamp, pass/fail/skip, observed values, logs/artifact location and defect/retest. Distinguish unit proof, integration proof, manual review and professional interpretation.

## 2. Mandatory acceptance matrix

| ID | Scenario | Required result / evidence |
| --- | --- | --- |
| T01 | Empty production onboarding | Zero sample products/parties/pets/stock/invoices/receipts. Only approved system/reference/COA records and verified owner setup. No hardcoded shared default password. |
| T02 | Cross-tenant identifiers | Tenant A cannot list/get/update/finalize/return/refund/export/print or join Tenant B records, including guessed ObjectIds, child allocations, files and jobs. Non-leaking denial; no stock/GL changes. |
| T03 | Membership/branch lifecycle | Captured sessions lose revoked access immediately under policy; branch limits enforced; owner/platform roles do not bypass tenant checks. Last-owner removal requires safe transfer. |
| T04 | Monetary field permissions | Quantity-only inventory JSON/CSV/PDF contains no costs/values/margins; cashier cannot obtain hidden cost fields via bootstrap/exports/error payloads. |
| T05 | Authentication/security | Secure cookies, expiry, CSRF/origin, MFA, reset/invite replay/expiry, distributed rate limits, XSS/operator injection, upload/SSRF and redacted errors/logs tested. |
| T06 | Exact arithmetic and bounds | BigInt/Long/string round trip, negative/overflow/precision rejection, decimal quantity UOM and pack ratios; no unsafe `Number` money path. |
| T07 | Tax/discount fixtures | Inclusive/exclusive, line/invoice discounts, zero/exempt/nil distinctions, mixed rates and odd-paise cases reconcile under approved policy; applicable equal halves remain equal. Unsupported rounding combinations block rather than fabricate. |
| T08 | Historical immutability | Change product/name/price/tax/party/template after issue; old invoice values, original artifact and return basis remain unchanged. Legacy unequal tax remains as stored. |
| T09 | Document eligibility/fields | Regular/composition/unregistered/exempt profiles select valid documents; missing required recipient/HSN/declarations/PoS blocks affected issue. No GST collected under an unregistered profile. |
| T10 | Legal integrations/exclusions | Covered e-invoice/e-way/restricted-medicine cases block without valid prerequisites; never fabricate IRN/QR/licence/register evidence. Reviewed-not-applicable differs from unconfigured. |
| T11 | Invoice sequence concurrency | Parallel checkouts produce unique numbers within the proper registration/FY/legal scope, ≤16 characters/permitted format; FY boundaries and committed/exposed reservations/cancellations do not reuse numbers. An unexposed rolled-back candidate is not an issued number. Coordinate external series. |
| T12 | Stock/FEFO/expiry races | Parallel sales for the last units allow only valid total quantity. FEFO skips expired/quarantined/recalled/ineligible lots; month-expiry/current-time boundary and explicit eligible override tested. No negative stock. |
| T13 | Atomic sale failure injection | Fail after number/stock/doc/movement/journal/audit writes before commit. No partial committed sale, balance, receipt or GL; no misleading UI success. Test actual transaction sessions. |
| T14 | Idempotency/replay | Same key/hash returns same result; same key/different payload fails; concurrent duplicates, double-clicks, retries, webhooks and repeat draft-finalization cannot duplicate stock/documents/payments/journals. |
| T15 | Unknown commit/response loss | Simulate commit-response loss/timeouts. UI reports resolving/unknown, queries original operation, and recovers one committed result; no new-key replay or false rollback claim. |
| T16 | Purchases/duplicate receipts | Original supplier bill/date/FY duplicate checks, batch quantities/costs and source-linked GL post once; failures roll back stock/payable/tax review together. |
| T17 | Supplier return | Original receipt/batch caps, dispatch/acknowledgment, available/non-saleable handling and received supplier note recorded; buyer memo not falsely treated as seller GST debit note. |
| T18 | Partial/repeated returns | Sum of cumulative quantities and each saved original component never exceeds original. Last return exactly consumes legitimate residuals; current catalogue does not alter the result. |
| T19 | Restock versus no-restock | Default false; unauthorized/expired/damaged/cold-chain-unverified returns cannot become saleable. Eligible original restock restores only approved quantity/cost. No-restock makes no false inventory/COGS reversal or later duplicate cost loss. |
| T20 | Return concurrency and full credit | Simultaneous returns cannot consume the same entitlement; remaining/full credit after earlier partial returns cannot credit the invoice twice, including approved service corrections. Linked debit/price adjustments and earlier commercial-only credits use tested per-source entitlement allocations, not a naive raw-original formula. |
| T21 | Commercial versus GST credit | Credit can reduce customer obligation while GST reduction remains zero/pending/ineligible; legal date/annual-return/recipient-ITC evidence is evaluated under approved policy. Reports/GL do not reduce tax blindly. |
| T22 | Payments/partial settlement | Confirmed receipt allocations reconcile exactly; pending UPI/card is not paid. Different dates/actors retained. Receipt retry/reversal cannot double-cash or double-settle an invoice. |
| T23 | Refunds/over-refunds | Credit note alone makes no cash movement. Separate confirmed refund requires permission/reference and cannot exceed entitlement under concurrent attempts. Pending/failed refunds do not reduce cash. |
| T24 | Cash limit aggregation | Approved section 186 rule boundaries, same person/day, single transaction across days and event tests across branches; split/relabel attempts blocked; exemptions require verified evidence. |
| T25 | Cancellation/compensation | Draft discard versus issued correction distinguished; number/core preserved, actual custody/provider eligibility checked, every stock/GL/payment compensation linked and not repeated. Authorized undercharge/debit notes have their own number/GL/source and price-only notes change no stock. |
| T26 | Double-entry postings | Every journal balances; source uniqueness; correct sale/purchase/receipt/refund/return/restock/loss/expense/opening/tax mappings. No artificial balancing accounts. |
| T27 | Openings/journals/period close | Verified party/stock/COA openings reconcile without duplication; invalid accounts/cross-tenant lines rejected; posted vouchers immutable; reversal and controlled reopen retain history. |
| T28 | Full reconciliation | Movement balances = controlled stock projections; inventory carrying value = mapped GL; party allocation balances = subledgers; receipt/refund totals and source postings agree; internal consumption/wastage/loss vouchers reconcile too. Differences surfaced, not silently repaired. |
| T29 | All 12 core report tabs | Correct defaults/presets/custom ranges, branch/registration/cashier scopes, event dates, gross/credits/net/receipts/refunds/due/margin; as-of results do not include later events. |
| T30 | GSTR working papers | Correctly labeled non-filed working registers; commercial credit versus eligible GST adjustment and reviewed input eligibility separated; no fabricated portal JSON or tax-payment status. |
| T31 | A4/58/80 mm printing | All mandatory particulars visible, no clipped totals/HSN/tax, authentic QR only, repeat print adds no financial effect, original template/artifact retained, escaped text/logo inputs safe. |
| T32 | UI/accessibility | Dark readable text, keyboard/focus/errors, independent scrollable sidebar on short screens, usable mobile menu, no unreachable Accounts/Reports/Settings, accurate empty states. |
| T33 | Audit immutability/privacy | Actor/time/source/before-after/approval/role/export/restore events retained and non-disableable; runtime cannot ordinarily alter immutable collections; independent evidence detects privileged tampering. Secrets never logged. |
| T34 | Outbox/Cron/leases | Crash after commit/before artifact, overlapping invocations, expired lease/stale token, retries/dead-letter/redrive and provider duplicate/status scenarios; no lost financial event or duplicate money action. |
| T35 | Private files/exports | Tenant/role ownership, scoped uploads, size/type/scan, signed-link expiry/access logging, large job pagination; no public bucket or cross-tenant path trick. |
| T36 | Retention/privacy rights | Correct GST/income-tax/company/medicine/security clocks and holds, lawful privacy restriction/erasure, no financial TTL purge; future DPDP changes tracked without pretending already in force. |
| T37 | Backup/restore | Actual successful India-required backups/log evidence; isolated restore/decryption/reconciliation, post-restore number fence, provider-job reconciliation and session revocation; observed RPO/RTO recorded. |
| T38 | Migration/cutover | Original amounts/tax/allocations/cancelled series/actors preserved; counts/balances/hash reports approved; no imported live sessions or unrelated tenant credentials; rehearsal/rollback handles new activity. |
| T39 | Vercel production runtime | Build/routing/direct refresh/auth/origin/env/pool/duration/payload tests pass on intended runtime. No local persistent data or hidden always-on worker. No TLS bypass. |
| T40 | Release and change gates | Professional applicability evidence, signed supported scope/exclusions, source/rule version watch, incident contacts, contracts/privacy acceptance and honest limitations. All blocking defects resolved or affected capability disabled. |

## 3. Property-based invariants

- Each issued financial source has exactly one authorized posting set; sum of journal debits equals credits in exact paise.
- Sold quantity cannot exceed eligible available stock; restored saleable stock/cost cannot exceed explicitly eligible original returned allocations.
- Sum of all return allocations/components cannot exceed the original source, and a complete valid return exactly equals its original amount basis.
- Confirmed refund cannot exceed the customer's actual refundable entitlement; a credit without refund does not change cash.
- Every tenant reference/lookup/result/job/file remains in the authorized tenant; every money-restricted response omits restricted values, not merely their labels.
- A failed or ambiguous response cannot justify posting the same financial operation twice.
- Changing current reference data cannot change a finalized financial snapshot or an earlier as-of report's source events.
- A legally unsupported transaction cannot become issuable because a UI checkbox, owner override or placeholder integration says “success”.

## 4. Complete attachment traceability

User attachment: `Legal Notes.txt`, 461 lines, SHA-256 `ade7d2b1abfb979d28b448f36509eaa3bb253a2ff14ff234c8b96ce9c9e27a14`. The unchanged copy is in `reference/Legal-Notes-user-supplied.txt`.

| Attachment section | Where it is incorporated | Acceptance coverage |
| --- | --- | --- |
| 1 Role and objective / inspect first | Master prompt §1; Architecture §3, §15 phase 0; README workflow | T38–T40; plan approval before extensive modification. |
| 2 Fundamental principles | Master §2, §5–§7; Architecture §6–§9; Legal LEG-12/13 | T08, T13–T15, T25–T28, T33. |
| 3 India tax/invoice requirements, all subsections | Master §6; Architecture §6/7/11; Legal LEG-01–LEG-16 | T06–T11, T21, T24, T30–T31, T40. |
| 4 Draft/product/validation/finalize/print sales workflow | User guide §4.8–4.9; Architecture §7/10/11; Master §4/5 | T09–T15, T31–T32. |
| 5 Inventory, batches, expiry, stock ledger | User guide §4.3–4.6; Architecture §5/8/9; Legal LEG-17–19 | T12, T16–T19, T28. |
| 6 Cancellation, returns, refunds, notes | User guide §4.10–4.12; Architecture §8; Master §5 | T18–T25. |
| 7 Payment recording, partial/repeated and refund separation | User guide §4.10/4.12; Architecture §8/9/10; Master §5 | T14–T15, T22–T24, T28. |
| 8 Reports, including §8.3 quantity-only visibility | User guide §4.14; Architecture §4/11; Master §4/8 | T04, T28–T30, T35. |
| 9 Database, transaction integrity and relationships | Architecture §4–§7; Master §3/5 | T02, T06, T11–T15, T26–T28. Mongo equivalents explicitly replace unavailable native relational FKs. |
| 10 Audit trail | Architecture §5/13; Legal LEG-12/15/23; Master §8 | T08, T25, T33, T36–T38. |
| 11 Security and access control | Architecture §4/13; Operations §2/5/6/11; Master §8 | T02–T05, T33–T36, T39. |
| 12 Error handling and reliability | Architecture §7/10/12; Operations §11/12; Master §5/9 | T13–T15, T34, T39. |
| 13 Data retention, backups and recovery | Legal LEG-13–16/20–23; Architecture §13/14; Operations §9–11 | T33, T36–T38. |
| 14 Scope boundaries | README approved decisions; Master §0/10; Legal LEG-08–10/17/24 | Full GL explicitly retained by user approval. Clinical/gateway/statutory integration exclusions remain unless separately approved; T10/T40. |
| 15 Testing requirements | This matrix; Master §11; Architecture §15 phase gates | T01–T40 plus property invariants; actual evidence required. |
| 16 UI/UX | User guide §3/4; Master §4; Architecture §10/11 | T04, T15, T29, T31–T32. |
| 17 Tax configuration/maintenance | Legal rule register and LEG-03/06–09/20; Architecture §6/13; Master §6 | T07–T10, T21, T30, T36, T40. |
| 18 Development workflow | README usage; Architecture §15; Master §1/12 | T38–T40; inspect/plan, safe incremental build and honest test report. |
| 19 Non-negotiable instructions | All invariant sections, Master §2–§11 | T01–T40; no silent history changes/fake compliance/UI-only completion. |
| 20 Final objective | README scope; User guide complete operation; Master §12 | Integrated end-to-end release evidence, not just rendered screens. |
| Suggested delivery workflow and pre-production checklist after §20 | Architecture §15/16; Operations §7–§12; Master §12 | Final owner/technical/professional-policy approval with source evidence, migration/backup and actual tests. |

Additional explicit user requirements retained: **shop desk** name; readable minimal UI; independent scrolling sidebar; no demo business data; A4/thermal/settings templates; applicable equal CGST/SGST with historical preservation; named cashiers; all 12 core reports/date controls/CSV; full accounting; cumulative original-batch returns/default no-restock/separate refunds; multi-tenancy; JavaScript/MongoDB; Vercel frontend+API; approved external workflows or blocks for obligations outside clinical scope.

## 5. Conflicts resolved explicitly

1. **Attachment section 14 vs full accounting:** the user expressly chose to retain double-entry accounting. This is the approved extension; do not remove it or claim the original attachment already included it by default.
2. **The Good Vets vs software name:** product is **shop desk**; The Good Vets is client/tenant branding. Statutory identity is independently verified.
3. **Relational constraints vs MongoDB:** no false claim of native FKs/RLS. Use validators, tenant-scoped references, unique indexes, controlled repositories, archival and transactions.
4. **All-Vercel vs always-on workers/files:** no local durable filesystem or hidden persistent Node service. Use Atlas state, durable outbox and bounded authenticated Cron, plus explicitly approved managed storage/providers.
5. **Billing-only vs medicine/professional records:** no clinical authoring module, but required sale/dispensing/register controls cannot be waived. Use approved external records or block the affected category/tenant.
6. **Equal new tax components vs preserved history:** apply an approved equal-half policy to the supported new applicable transaction. Do not falsify old tax, force SGST where UTGST/IGST applies or silently “fix” a historical return basis.
7. **Full legal compliance aspiration vs evidence:** requirements and gates are specified; universal certification is not asserted. Unsupported obligations remain release blockers, not accepted disclaimers.

## 6. Final go/no-go record template

```text
Release / source commit / schema version:
Environment / runtime / providers / regions:
Supported tenant and transaction profiles:
Rule/configuration versions and professional review references:
Executed tests and evidence links:
Open defects and affected capabilities (enabled/blocked):
Reconciliation/migration approval:
Backup/restore/location and measured RPO/RTO:
Security/incident/privacy/contract evidence:
Technical approver / business owner / professional-policy reviewers:
Decision and date: GO / CONDITIONAL ONLY FOR STATED SUPPORTED SCOPE / NO-GO
```

A scope-limited release is acceptable only when the unsupported operation is genuinely unavailable and the allowed operation is independently safe/legal. An unchecked checkbox is not a pass.
