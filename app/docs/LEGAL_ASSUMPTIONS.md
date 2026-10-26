# Legal-assumption register — shop desk

**Edition:** 1.0 · **date:** 2026-10-26 · **status of every row below: `unverified`.**

This register is implemented in the product (`legal_rules` collection, seeded by
`seedLegalRules()` and editable from **Settings → Legal assumption register**). Each row
carries a state, an interpretation, a reviewer, evidence, an effective window, a next-review
date and an append-only `history` array. `GET /api/v1/settings` returns the live register;
every change is audited.

States: `unverified` · `reviewed_applicable` · `reviewed_not_applicable` ·
`future_not_effective` · `unsupported`.

> **Rule:** an `unverified` row never becomes a silent assumption. The behaviour it gates is
> either blocked or treated conservatively. A row can be moved to a reviewed state only with a
> reviewer and evidence recorded — the API rejects the change otherwise.

## 1. Cross-cutting position

The software implements the mechanics it can verify (exact arithmetic, balanced journals,
numbering, immutable snapshots, fail-closed gates). It does **not** assert legal compliance.
Applicability of each statute to a given clinic depends on facts the clinic owns
(turnover, registration type, state, licence class, product mix). The governing documents
themselves mark several citations as requiring re-verification at release; they were not
fetched from the internet during this build and must be checked against the primary source
before go-live.

## 2. Register

| Key | Position | Seeded state | How the product behaves while unverified |
| --- | --- | --- | --- |
| `LEG-01-document-profile` | Supplier status determines the correct document type (tax invoice vs bill of supply vs composition document). | unverified | Document kind is derived from the registration profile and the tax actually computed; a tax invoice is refused for a non-`regular` profile. |
| `LEG-02-invoice-particulars` | Rule 46 particulars, 16-character serial limit, series uniqueness per registration/FY. | unverified | Serial length is validated before a series can be saved; numbers are server-generated, never reused, never renumbered. |
| `LEG-03-hsn-classification` | HSN/SAC classification and the effective rate for each product. | unverified | A product cannot reach a live invoice until a human records a classification review with evidence. |
| `LEG-04-veterinary-exemption` | Veterinary *services* exemptions do not automatically extend to medicines, food or accessories. | unverified | Services and goods carry independent tax treatments; nothing is exempt by default. |
| `LEG-05-place-of-supply` | Place of supply decides CGST/SGST vs IGST. | unverified | Intra/inter-state is computed from registration state vs place of supply; components are never re-labelled after the fact. |
| `LEG-07-credit-notes` | Credit-note conditions and the s.34 GST-adjustment cut-off (30 November following the FY, or the annual return date if earlier). | unverified | GST reduction is allowed only while inside the recorded cut-off; afterwards the note is recorded as a `commercial_only` customer credit with no output-GST reduction. |
| `LEG-08-e-invoice` | E-invoicing applicability and authentic IRN/QR. | unverified | Marked `applicable` → **issuance blocked** (`LEGAL_GATE_BLOCKED`). There is no IRP integration, so no IRN/QR is ever printed. |
| `LEG-10-e-way-bill` | E-way bill obligations for consignments above the notified value. | unverified | No e-way bill is generated; the register records the position and points to the external process. |
| `LEG-11-input-tax-credit` | Input-tax eligibility requires a per-invoice review (s.16/17 conditions, blocked credits). | unverified | Purchase tax posts to `1300 Input GST — pending review`; reclassification to `1310`/`1320` needs `purchases.review_tax` plus evidence. |
| `LEG-13-gst-retention` | GST records retained for 72 months from the annual-return due date. | unverified | No TTL/purge exists for financial records; deletion is not available in the product. |
| `LEG-14-income-tax-books` | Electronic books accessible in India with daily backups. | unverified | Runbook prescribes India-region Atlas + daily backup verification; not executed in this environment. |
| `LEG-15-company-audit-trail` | Non-disableable edit history for company tenants. | unverified | Audit is append-only with a hash chain and no update/delete API. |
| `LEG-16-cash-receipts` | Cash receipt restriction (Income-tax Act 2025 s.186) — ₹2,00,000 per person per day, including events. | unverified | Single cash receipts and same-day aggregates for a payer are blocked at the threshold; an override needs a reason + evidence and is audited. Splitting is therefore blocked inside this system, but cash taken outside it cannot be seen. |
| `LEG-18-medicine-sale` | Drug sale/dispensing licences, registers and restricted medicines (H, H1, X, NDPS). | unverified | Schedule H1/X/NDPS products are created blocked. Dispensing needs a verified, unexpired licence **and** an external prescription reference; otherwise the bill cannot be issued. No prescription is authored by this software and no statutory register is produced. |
| `LEG-19-mrp-price-control` | Tax-inclusive MRP and DPCO/NPPA ceilings. | unverified | MRP is stored and printed when present; the ceiling check is not automated, so a price override remains a human responsibility. |
| `LEG-21-dpdp` | DPDP Act 2023 / DPDP Rules 2025 phased commencement, consent and data-principal rights. | unverified | Only billing identifiers are stored (customer contact, pet name/species). No clinical notes, no marketing consent, no cross-border transfer. Rights automation is **not implemented**. |
| `LEG-22-cert-in` | CERT-In directions: 6-hour incident reporting, 180-day log retention, India log residency. | unverified | Audit and application logs are written where the deployment runs; the runbook specifies the reporting clock. Not evidenced here (no production deployment). |

## 3. Positions the product takes regardless of review state

These are conservative defaults. They are not claims of legal correctness; they are the
safe behaviour when applicability is unknown.

1. **Fail closed.** Unknown profile, missing series, missing identity verification, missing
   licence, missing e-invoice decision on an `applicable` registration → the document cannot
   be issued. The draft is left untouched so nothing half-posts.
2. **Never falsify.** Legacy or supplier tax components are copied as given. Unequal
   CGST/SGST on a supplier bill is *not* silently "corrected"; the bill is rejected for a
   human to fix.
3. **Never invent statutory artefacts.** No IRN, QR, signature, licence number or register
   entry is generated. The print template states what is not printed and why.
4. **Separate commercial from tax.** A customer credit and an output-GST reduction are
   distinct amounts on the same credit note; a refund is a third, permissioned event.
5. **No silent repair.** Reconciliation reports differences; it does not post balancing
   adjustments to make them disappear.

## 4. Questions for the clinic's CA / lawyer before go-live

1. Which document does each registration profile issue, and which series formats are in use?
2. Is the clinic under e-invoicing? If so, this build must stay blocked until an IRP
   integration exists.
3. Which of the sold items are exempt/nil-rated/out of scope, and under which notification?
4. Does the s.186 cash-receipt restriction apply as implemented, and what exemptions are
   documented for this business?
5. Which medicines may be dispensed, under which licence class, and what register must be
   maintained outside this software?
6. What retention schedule applies (GST 72 months, companies 8 years, medicine registers)?
7. What are the incident-reporting contacts and the DPDP consent position at the counter?

Record the answers as reviewed rows in the register, with reviewer and evidence. Do not
change the code to assume an answer.
