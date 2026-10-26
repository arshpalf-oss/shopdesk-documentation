# Limitations and known gaps — shop desk

Honest list, current as of 2026-10-26. Nothing here is hidden behind a disclaimer in the UI:
where the product cannot do something safely, it refuses the operation.

## 1. Not implemented (blocked at runtime)

| Area | Behaviour today | Consequence |
| --- | --- | --- |
| E-invoicing (IRP) / IRN / signed QR | A registration marked `applicable` blocks issuance. No IRP client exists. | A clinic under e-invoicing cannot issue from this build until an integration is added. |
| E-way bill | No generation, no portal call. The register records the obligation. | Movement of goods must be documented outside the product. |
| Payment gateway / UPI reconciliation | `payment_intents` record an attempt; a human confirms it. No provider webhook. | Nothing is auto-settled; unconfirmed attempts never move cash. |
| Bank statement import / bank reconciliation | Not implemented. Receipts are recorded manually with a reference. | Reconciliation with the bank is manual. |
| Statutory medicine registers (Schedule H1/X) | No register output, no prescription authoring. Dispensing needs a verified licence + external prescription reference. | The legal register must be maintained outside the software. |
| Clinical records | Out of scope by design: no diagnosis, treatment or prescription authoring. Pets are billing identifiers only. | The clinic needs a separate clinical system. |
| Payroll, consolidation, income-tax filing, statutory audit output | Out of scope (approved). | Use an accountant's tooling. |
| Email / SMS / WhatsApp delivery of documents | Not implemented; staff invitations show a one-time token to share manually. | Manual delivery. |
| Password reset, MFA, SSO | Not implemented. Passwords are scrypt-hashed; sessions are cookie + CSRF. | Owner resets a staff password by disabling/reinviting; no second factor. |
| Rate limiting across processes | In-memory counters, per process. | A multi-instance deployment needs a shared limiter. |
| Retention jobs, erasure, DPDP rights workflow | No purge exists (the safe default for financial records). | Data-subject requests are handled manually. |
| User file uploads (logos, scans) | No upload feature. | Print templates use text only; no image assets are stored. |
| Supplier-return acknowledgement workflow | Supplier return and supplier credit note are recorded; dispatch/acknowledgement steps are not. | Track the physical return outside the product. |
| Issued-document cancellation with compensation | Not implemented. Credit note + refund is the supported correction path. | No cancellation voucher. |
| Opening balances | A single, evidence-gated opening posting exists; no per-party opening import wizard. | Large migrations need a prepared journal. |
| Migration importer | Not written. | No legacy data can be imported yet. |
| Dedicated index/validator migration tool | Indexes are declared in code and applied by the driver; there is no versioned migration runner. | Schema change management is manual. |

## 2. Environment limits of this delivery

- **MongoDB Atlas was not available.** All financial behaviour was exercised against the
  in-repo file driver, which shares the store contract (transactions, unique indexes,
  sorted `findOne`, atomic file writes). Real replica-set transactions, failpoints, and
  cross-process races are **unproven**.
- **Vercel was not available.** `api/[...path].js` and `vercel.json` are written but never
  deployed; runtime routing, duration limits and Cron auth are **unproven**.
- **No printer hardware.** Templates were verified by inspecting the generated CSS
  (`@page size: A4`, `58mm auto`, `80mm auto`) and content, not on paper.
- **No assistive-technology audit.** Keyboard focus, contrast and labels were reviewed by hand.
- **No penetration test.** CSRF, origin, session revocation and DTO stripping are covered by
  automated tests; broader security review is open.

## 3. Deliberate deviations from the reference documents

1. **File store instead of SQLite** for local/self-hosted use. The reference editions used
   SQLite; this build ships a single-writer JSON store with the same repository contract so
   no SQLite driver dependency is needed. Production target remains MongoDB Atlas.
2. **`_id` values are 24-hex strings, not BSON `ObjectId`.** This keeps the two drivers
   identical and makes test fixtures portable. They are opaque; nothing parses them.
3. **No `frame-ancestors 'none'` on the HTML response** so the sandboxed preview iframe can
   render. Production should add it (`server/app.js` documents this).
4. **Supplier bills copy the supplier's tax components.** Unequal CGST/SGST is rejected
   rather than "corrected", because correcting another party's tax would falsify the record.
5. **Restock defaults to off** for every return, even when the goods look saleable.

## 4. Product decisions an operator must know

- A **credit note is not a refund**. Money leaves only through a permissioned refund.
- A **reprint has no financial effect** but is audited.
- **Cash ≥ ₹2,00,000** for one payer/day is blocked; an override needs reason + evidence and
  is audited. Cash taken outside the system is invisible to this check.
- **GST adjustment on a return** stops at the recorded s.34 cut-off; after that the credit is
  commercial only.
- **Cost and margin are separate permissions.** A cashier or inventory operator never receives
  those fields in JSON, CSV or print.
- **Deleting a financial document is impossible.** Corrections are linked events.

## 5. What would make this production-ready

1. Real Atlas replica set with migration/failpoint tests (T11–T13, T16, T20, T27).
2. Vercel deployment rehearsal including Cron and cold-start behaviour (T34, T39).
3. Security review and a shared rate-limit store (T05).
4. Backup/restore drill with a measured RPO/RTO and the number fence (T37).
5. Reviewed legal register entries for the actual clinic (T40), signed by the CA/lawyer.
6. Accessibility and printer validation on the clinic's own hardware (T31, T32).
