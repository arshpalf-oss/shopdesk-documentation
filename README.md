# shop desk — product, architecture and engineering pack

**Client/tenant brand: The Good Vets · Prepared 26 October 2026 · Specification edition 1.0**

This is a product and engineering specification, operating guide and copy-ready AI build prompt. It is **not a newly built application, a deployment, a GST certification or a legal opinion**. No hosting account, database, subscription or paid resource was created for this pack.

## Your approved decisions

- Build an online **multi-tenant SaaS** for independent veterinary clinics and related shops.
- Use **JavaScript/ES modules, React/Vite, a Node.js API on Vercel, and MongoDB Atlas**. Do not introduce a separate always-running backend without approval.
- Clinical scope is **billing and inventory only**: customers, pets and suppliers are included, but diagnosis, treatment records and prescription authoring are not.
- **Retain full double-entry accounting** as your expressly approved extension to section 14 of the attached legal notes. Other exclusions remain in effect.
- Keep the software name **shop desk**. “The Good Vets” is the client/tenant brand, not an assumed registered legal entity. Statutory documents must use the actual verified supplier identity.
- Preserve returns, immutable historical money, named cashiers, reports, equal applicable new intra-state tax components, scrolling navigation, readable UI, invoice templates and thermal printing.
- New production tenants start empty. Only approved system references and a chart of accounts may be initialized; never create demo business records.

## Files and reading order

| File | Purpose |
| --- | --- |
| `PRODUCT_OVERVIEW_AND_USER_GUIDE.md` | What every module does, where it appears, who can use it, and daily operating procedures. |
| `ARCHITECTURE_AND_BUILD_GUIDE.md` | MongoDB model, tenant isolation, JavaScript service boundaries, APIs, exact money, transactions, job design and phased construction. |
| `INDIA_LEGAL_AND_RELEASE_MATRIX.md` | Official-source legal research, applicability caveats, engineering controls, unverified items and professional release gates. |
| `TEST_ACCEPTANCE_AND_TRACEABILITY.md` | Acceptance scenarios and mapping of all 20 sections of your legal attachment. |
| `VERCEL_ATLAS_OPERATIONS.md` | Online setup, private configuration, Atlas connectivity/TLS, migrations, monitoring, backups and incident recovery. |
| `MASTER_IMPLEMENTATION_PROMPT.md` | Standalone, copy-ready engineering prompt for an AI coding agent. |
| `MASTER_IMPLEMENTATION_PROMPT.txt` | Identical prompt as plain text. |
| `SHOP-DESK-ENGINEERING-BLUEPRINT.docx` | Combined reading edition of the guides and master prompt. |
| `SHOP-DESK-ENGINEERING-BLUEPRINT.html` | Self-contained, searchable reading edition; no external assets or network calls. |
| `diagrams/architecture.svg` | Proposed deployment and trust boundaries. |
| `reference/Legal-Notes-user-supplied.txt` | Your complete attachment, preserved unchanged. |
| `REFERENCE_SOURCES.md` | Official/technical reading index, with research and applicability qualifications. |
| `DOCUMENT_VALIDATION.md` | Checks of the documents themselves, not executed SaaS or legal-certification tests. |
| `PACK-MANIFEST.json` | File hashes for the packaged deliverables; not a software compliance certificate. |

## How to use the master prompt

1. Give the coding agent the **actual existing repository**, not just screenshots. Supply the user legal notes and this pack.
2. Paste `MASTER_IMPLEMENTATION_PROMPT.md` as its engineering instruction.
3. Ask it to complete **repository inspection, a gap analysis, legal-assumption register and phased plan first**. Review those before authorizing substantial code or financial-data changes.
4. Approve work phase by phase. Require executed tests and evidence at every gate. A design requirement or a green-looking screen is not an implementation.
5. Ask a qualified Indian CA/GST practitioner to validate the tenant-specific tax/document rules and accounting mappings. Obtain licensing/privacy/legal review for the applicable business and contracts.
6. Use separate development/staging databases and approved fixtures. Never test invoices or refunds in production books.
7. Do not declare the system ready for a tenant or transaction type whose necessary legal controls are unsupported. An excluded integration does not remove the tenant's legal obligation.

## Existing software versus this target

The reference SQLite release is **1.2.0**. A separate native-MongoDB reference is **1.3.0**. Both are single-clinic references, not verified multi-tenant SaaS products. The inspected MongoDB server code has no `tenantId` implementation and its model list does not include a dedicated audit-event collection. Reusing that code without a tenant/security refactor would be unsafe.

Existing feature behavior is a preservation reference, **not proof that the proposed SaaS has been implemented or tested**. The task completed by this pack is documentation and prompt preparation. New SaaS runtime tests, hosting verification, tenant onboarding and professional approvals remain future work.

## Legal and research boundaries

The attachment is now complete; the quantity-only inventory requirement in section 8.3 is included. The pack adds conditional requirements concerning medicine sale/dispensing, MRP/price controls, electronic records, cash receipts, data protection, cyber incident handling and retention. It does not reconstruct invented missing text or claim to enumerate every Indian or state law.

The legal matrix differentiates an observed official rule, an applicability question, a phased/future requirement and a project-specific safeguard. Enactment, commencement, a Council recommendation and sandbox availability are not interchangeable. All legal rules must be rechecked at the real release date.

Your attached file's SHA-256 is `ade7d2b1abfb979d28b448f36509eaa3bb253a2ff14ff234c8b96ce9c9e27a14`.
