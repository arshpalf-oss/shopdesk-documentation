# India legal, applicability and release matrix

**Research cut-off: 26 October 2026 · Engineering requirements, not a legal/tax opinion**

No prompt, code generator, disclaimer or passing test suite guarantees compliance with every Indian law. Applicability depends on supplier identity, legal form, state, GST status, turnover history, actual supply, product category, medicine licences, data roles and business conduct. A qualified Indian CA/GST practitioner and relevant legal/licensing specialists must verify the actual configuration and releases. Professional review is a project release safeguard; this document does not invent a universal statutory requirement that all software be certified by a CA.

## 1. How legal rules enter the product

Maintain an effective-dated **legal-assumption register**. Each rule records its official instrument/section, source URL and retrieval date, publication and commencement evidence, territorial/transaction applicability, interpretation owner, reviewer/evidence, valid-from/to, supported cases, required tests and next review. States are `unverified`, `reviewed_applicable`, `reviewed_not_applicable`, `future_not_effective` or `unsupported`.

Do not equate a Council recommendation, enacted amendment, portal advisory, draft rule, sandbox feature or blog explanation with an operative legal requirement. Unknown applicability is not “not required”. Block an affected transaction until its necessary controls or a reviewed lawful external workflow exist. Ordinary tenant owners cannot override statutory gates merely by accepting a warning.

The controls below are **proposed for the build**. They have not been implemented or legally approved for a new SaaS by creating this pack.

## 2. Core GST/document controls

### LEG-01 — Supplier status and correct document

Configure regular GST registration, composition status and unregistered businesses as distinct profiles. Verify the actual GSTIN/legal identity/status and date range; syntactic checksum validity alone is not official registration verification. An unregistered person must not collect GST as if registered. Composition and exempt-supply document logic must be reviewed; do not label every printout a GST tax invoice.

Support tax invoice, bill of supply, appropriate ordinary commercial sale record, credit/debit notes, receipts and cancellation/return records. Where legally applicable, invoice-cum-bill-of-supply is a distinct reviewed capability, not a generic mixed-cart shortcut. Required fields depend on document and transaction facts. Rule 49 specifies bill-of-supply particulars. [1](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule49_v1.00.html)

**Release evidence:** reviewed document eligibility/field matrix, genuine tenant identity approval, blocked invalid combinations, templates tested on A4 and thermal widths. Preserve electronic-invoice signature exceptions only where actually applicable; do not issue a blanket “no signature ever required” statement.

### LEG-02 — Invoice numbering and particulars

Rule 46 includes a consecutive serial number, no more than 16 characters, permitted letters/numbers/hyphen/slash, unique for a financial year, plus transaction-dependent supplier/recipient, description, quantity/UQC, tax, place-of-supply and other particulars. Recipient particulars at specified values and requested particulars below those values must follow the current rule. [2](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html)

**Build:** server-reserved series per legal registration/FY, full-number uniqueness, no reuse after cancellation/reservation, FY rollover tests and a number register. All prefixes/separators count toward length. Coordinate series with external billing channels. A branch ID is not a substitute for correct registration-wide uniqueness.

**Release evidence:** concurrency tests, legacy/external number migration, cancelled-number history, recipient-field boundary fixtures and required declarations reviewed by the CA.

### LEG-03 — HSN/SAC and rates

No product is legally classified merely because a suggested code matches a regex. Notification 78/2020 specifies 4/6-digit HSN requirements by preceding-year turnover, with the stated relief for qualifying supplies to unregistered recipients; portal validations and later instruments also need review. [1](https://gstcouncil.gov.in/sites/default/files/2024-05/notfctn-78-central-tax-english-2020.pdf)

**Build:** reviewed classifications and effective-dated rate/treatment versions with source/evidence. A reference catalogue is not a catalogue of approved tenant rates. Do not seed a guessed rate for every medicine or freeze an obsolete list of GST slabs. Validate current notifications for the actual product and supply date.

**Release evidence:** product-by-product approval or approved classification policy; tests for missing/invalid codes, changed rates, exemption versus nil rating and immutable historic snapshots.

### LEG-04 — Veterinary healthcare is not the entire pet business

Entry 46 of Notification 12/2017–Central Tax (Rate), under heading 9983, covers services by a veterinary clinic in relation to healthcare of animals or birds. It is not a blanket exemption for all medicines, pet food, retail supplies, grooming, boarding or software subscriptions. The base notification and current amendments/applicability must be checked for the specific supply. [1](https://cbic-gst.gov.in/hindi/pdf/central-tax-rate/Notification12-CGST.pdf)

**Build:** independent, approved goods/service treatments; no automatic healthcare exemption for the whole cart. Composite/mixed supplies, ancillary dispensing and bundled packages require professional classification before activation. The SaaS provider's own subscription supply is separate from the clinic's veterinary supplies.

### LEG-05 — Place of supply and tax components

The IGST Act's goods rules distinguish movement, bill-to/ship-to and other cases, including section 10(1)(ca) for unregistered recipients and recorded addresses. [1](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_IGST_Act/active/chapterv/section10_v1.00.html) Circular 209/03/2024 addresses the specified unregistered-recipient delivery/billing-address issue. [1](https://gstcouncil.gov.in/node/4989)

**Build:** a reviewed place-of-supply resolver accepting supplier registration, goods/service type, recipient status, delivery/movement and special-case facts. Service rules require separate review; a customer's home state alone is insufficient. Use SGST or UTGST as legally applicable. For supported new ordinary intra-state supplies with equal component rates, preserve the project's equal CGST/SGST-or-UTGST requirement using an approved rounding policy. Never rewrite historical unequal saved tax components.

**Gate:** exports, SEZ, reverse charge, unusual bundles, distinct-person stock transfers and other unsupported cases remain blocked until scoped and validated.

### LEG-06 — Value, discounts and rounding

Section 15 governs value and discount treatment. The CBIC active text accessed in this research includes Finance Act 2026 changes marked **“w.e.f. yet to be notified”**; a coding agent must not apply bracketed future text merely because it appears on the page. Verify the operative pre-amendment text and any subsequent commencement notification at implementation/release. [1](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter4/section15_v1.00.html)

**Build:** one backend exact-arithmetic tax service; explicit before-/at-/post-supply discount eligibility, invoice-discount allocation and inclusive-price residual policy. Do not hide rounding differences by altering an issued snapshot. Distinguish paise-level calculation policy from legally prescribed rounding of statutory amounts. Review the actual rounding/time-of-supply treatment; illustrative rates are not product advice.

### LEG-07 — Customer credits are not automatically GST reductions

Section 34 provides for credit/debit notes. Its current text specifies the credit-note declaration cut-off of 30 November following the supply FY or furnishing of the relevant annual return, whichever is earlier, plus conditions on reducing output tax liability. The accessed text also shows a proviso effective 1 October 2025 concerning attributable ITC reversal by a registered recipient who availed it, and other incidence-of-tax cases. A further 2026 insertion is marked awaiting commencement. [1](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter7/section34_v1.00.html)

**Build:** separate original tax reference, customer commercial-credit value, eligible GST adjustment, eligibility review and reporting status. Do not misdescribe a reporting/declaration deadline as a universal prohibition on making any later commercial credit. Record the real annual-return filing date when relevant. Refund recording never substitutes for a required note or proves GST reduction.

**Gate:** review late notes, post-sale discounts, recipient ITC evidence and supplier-return legal document roles. A buyer's purchase-return memo is not automatically a supplier-issued statutory debit note.

### LEG-08 — E-invoice applicability and authentic IRN

Notification 10/2023 reduces the relevant e-invoicing turnover figure to five crore rupees from 1 August 2023; the applicable parent notification, turnover look-back, supplier exemptions and document/recipient coverage must also be assessed. The official listing describes taxpayers **exceeding** ₹5 crore; preserve the operative wording, not a loose threshold label. [1](https://www.gstcouncil.gov.in/node/4365)

A separate GSTN advisory applies a 30-day reporting restriction to covered IRN documents for AATO ₹10 crore and above from 1 April 2025, including relevant invoices, credit notes and debit notes. This is not the general applicability threshold. [5](https://www.gst.gov.in/newsandupdates/read/543)

**Build:** record verified applicability per registration, authentic IRN/signed payload/QR and cancellation acknowledgments only through approved integration or a properly verified external workflow. A normal PDF or UPI QR is not e-invoicing. Do not deliver a legally ineffective “final invoice” where IRN is mandatory but missing. If this integration remains outside initial scope, restrict the product to eligible supported transactions/tenants rather than waive their obligation.

### LEG-09 — New/proposed portal features are not automatically operative law

GSTN's October 2026 advisory on recipient-generated RCM self-invoices describes `RCMDOM`/`RCMIMP` as available for sandbox work, with production rollout, applicability and commencement governed by further notifications/communication. [2](https://www.gst.gov.in/newsandupdates/read/678)

**Build:** track this as a change-watch item, not as an enabled production obligation based only on a recommendation/sandbox feature. More generally, recheck current notifications after Council meetings before deploying tax changes. Do not fabricate self-invoice IRNs.

### LEG-10 — E-way bills, dynamic B2C QR and special supplies

Rule 138 contains conditions for e-way-bill information and consignment-value calculation, with exceptions and state-specific implications. Do not implement a single “every bill over ₹50,000 needs an e-way bill” rule. [5](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter16/rule138_v1.00.html)

**Gate:** determine goods movement, transporter/document facts, state rules, exemptions, current validity/cancellation/portal requirements and any separately applicable dynamic B2C QR obligation. These integrations remain excluded unless approved; block affected dispatches or use a reviewed external process. RCM/advances, cess, exports/SEZ and interstate stock transfers are not silently treated as ordinary domestic retail.

### LEG-11 — ITC and inventory losses

Input tax eligibility is subject to the relevant conditions, exclusions, evidence and reversals; a purchase invoice or an equal split of a combined tax figure does not establish claimable ITC. [7](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter5/section16_v1.00.html)

**Build:** pending/eligible/ineligible review; actual supplier tax components; accountant-approved tax/expense/inventory reclassification. Review mixed exempt/taxable activity, losses/write-offs, gifts and other blocked/reversal cases under the applicable provisions. GSTR-2B matching and return filing are not invented by the application. Preserve source facts even when a professional review later changes eligibility.

## 3. Books, electronic records and cash

### LEG-12 — GST stock accounts, audit trail and authentication

Rule 56 covers stock/accounts, document registers, advances and relevant supply records; it requires electronic edit/delete logs and includes authentication of electronic records by digital signature. Its requirements are not satisfied merely by creating a pretty audit screen. [1](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter7/rule56_v1.00.html)

**Build:** append-only financial documents/movements/journals, immutable change events, role-controlled read/export, reproducible record packages and a professionally reviewed record-authentication/signing workflow where applicable. A SHA-256 hash, scanned signature or software checkbox is not a statutory digital signature. Do not confuse an invoice signature exception under rule 46 with the separate rules for electronic books.

### LEG-13 — GST retention and recoverability

Section 36 generally requires relevant GST records for 72 months from the due date of the annual return for the relevant year; specified proceedings/investigations can extend retention to one year after final disposal or that period, whichever is later. [3](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter8/section36_v1.00.html) Rule 57 requires proper electronic backup and production of readable/authenticated records on demand. [1](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter7/rule57_v1.00.html)

**Build:** record-class retention calculation, legal holds, readable exports, restore tests and preserved financial snapshots. Do not implement “delete all tenant data after 30 days” or a blanket “six years from invoice date” policy. Privacy erasure must coexist with required lawful retention.

### LEG-14 — Current income-tax books and India backups

The notified Income-tax Rules, 2026 commence on 1 April 2026. Rule 46(8) addresses the specified electronic books/documents remaining accessible in India and daily backups on servers physically in India. Rule 46(9) prescribes seven tax years from the end of the relevant tax year for the specified records, with the further reopened-assessment provision. Applicability is tied to the persons/books described in the rule, not every database merely because it is Indian. [1](https://www.incometax.gov.in/iec/foportal/sites/default/files/2026-03/En-Notified-IT-Rules-2026-20-03-2026.pdf)

The primary PDF was retrieved and rule 46 read on PDF pages 37–38. Rule 46(6) also refers to additional medical-profession records, including a daily case register in **Form No. 25** and specified stock inventories. Whether and how these apply to the client's veterinary activity requires CA review. Do not casually substitute an old form number or claim a billing-only product fulfills clinical/professional recordkeeping.

**Build:** actual India backup evidence, daily-success monitoring, the applicable retention clock and external-record workflow where a required professional register is outside scope. Assess transitional periods under the old/new income-tax legislation with the CA.

### LEG-15 — Company books and non-disableable accounting audit trail

For company tenants, section 128 includes double-entry/accrual books and at least eight preceding financial years of relevant books/vouchers, subject to applicable extensions. [2](https://www.indiacode.nic.in/handle/123456789/1362/simple-search?query=Chapter+IX+-+The+Companies+%28Accounts%29+Rules%2C+2014.+&searchradio=rules) ICAI's revised 2024 implementation guide addresses the company accounting-software audit-trail requirement effective for the relevant FYs from 1 April 2023, including operation/preservation and tampering considerations. [13](https://eirc-icai.org/uploads/background_materials/Revised%202024_Implementation%20Guide%20on%20Reporting%20of%20Audit%20Trail%20(1)_1712114860.pdf)

The MCA primary Fourth Amendment Rules, 2022 were also retrieved: they amend access to electronic books to “at all times”, replace periodic with daily backup, and add particulars of a person in India where the provider is outside India. Primary URL: https://www.mca.gov.in/bin/ebook/dms/getdocument?doc=MTcyODIyOTI0&docCategory=Notifications&type=open

**Build:** no disable switch for accounting audit trails; complete transaction/change history and India-accessible/daily backup arrangements where applicable. Application owners and runtime database credentials must not have routine alteration/deletion rights over immutable financial/audit collections. Exceptional privileged maintenance must be controlled and independently evidenced. Hash chains are tamper-evidence, not proof that a privileged database administrator cannot tamper.

**Verification limit:** the legacy MCA 2021 PDF URL returned an error page during research. The accounting audit-trail conclusion here uses the official professional-body guide; the current amended primary rule/notifications must still be reviewed before company-tenant release.

### LEG-16 — Cash receipt restrictions

The official Income-tax Department text of section 186, Income-tax Act 2025, prohibits receipt of ₹2,00,000 or more in the specified non-permitted modes under the alternative person/day, single-transaction and event/occasion tests, subject to stated exemptions. It is not just a per-invoice limit. [1](https://www.incometaxindia.gov.in/w/section-186-41)

**Build:** approved payment-mode and aggregation rules; entity-wide checks across branches, payer identity where required, split-payment detection, recorded exception evidence and conservative controls when outside receipts are unknown. Do not encourage splitting bills, changing customers or recording cash as UPI to avoid a limit. Review other applicable cash/PAN/reporting requirements and the current rules, including prescribed electronic modes, with the CA. A warning cannot make a prohibited receipt lawful.

## 4. Veterinary product, pricing and disposal controls

### LEG-17 — Drug licences, prescriptions and restricted categories

The CDSCO compilation retrieved is Drugs Rules 1945 as amended through G.S.R. 823(E) dated 17 November 2022 (with its stated effective date). It is **not proof that all amendments through October 2026 have been consolidated**. Rule 65 includes prescription/recordkeeping requirements, animal-owner particulars for veterinary supply, Schedule H1 separate records with three-year preservation, and Schedule X prescription requirements including a two-year retained copy. Different records/categories have different conditions. [1](https://cdsco.gov.in/opencms/resources/UploadCDSCOWeb/2022/drug_rules/Drugs%20Rules,%201945%20(1).pdf)

**Build:** product restriction category, tenant/location licence profile and validity/review evidence, required external prescription/order references, dispensing/record prerequisites and stock traceability. Do not equate every clinic with a licensed retail pharmacy or assume an own-patient exemption authorizes an open shop. Digital screens do not automatically replace a prescribed physical/bound register or signature. Obtain state licensing/professional advice on exact current requirements and acceptable record formats.

**Scope decision:** no prescription authoring/clinical records. If a restricted medicine cannot be lawfully sold using a verified external prescription/register process, **block that medicine sale**. Do not lower the legal requirement to fit the UI. NDPS-controlled categories require separate specialist validation and remain disabled by default; medicinal purpose alone is not an unrestricted permission. [1](https://narcoticsindia.nic.in/)

### LEG-18 — MRP and drug price control

The Legal Metrology packaged-commodity rules define retail sale price inclusive of taxes and restrict sales above the applicable retail sale price. Product/category exceptions and current amendments require review; this is not a rule that every clinic service has an MRP. [1](https://consumeraffairs.gov.in/public/upload/admin/cmsfiles/whatsnews/Book_on_Legal_Metrology_Packaged_Commodities_Rules,2011_with_all_amendments_whatsnews.pdf)

NPPA/DPCO price-control applicability and current formulation-specific notifications must be considered for affected drugs. Do not reuse an old ceiling-price table as current universal veterinary pricing. [1](https://nppa.gov.in/en/drugspricescontrolorder2013)

The official NPPA listing now includes the 30 June 2026 amendment, S.O. 3516(E), affecting matters including specified pack/price determinations, revised-price communication and manufacturer records. A 2016/2023 base compilation alone is therefore not a complete current source. Manufacturer-specific duties must not be imposed indiscriminately on a clinic retailer. [1](https://nppa.gov.in/storage/uploads/pdf/dpco-amend-2026-57e460458980dab7263beda9399d68bc.pdf)

**Build:** applicable batch/pack MRP, unit conversion and tax-inclusive cap checks, approved price-control evidence/effective dates and blocked over-cap totals. Apply the reviewed currently applicable revised cap/price evidence to affected old stock; the originally printed MRP alone may be insufficient after a relevant price revision. Do not add GST over an already tax-inclusive MRP or disguise an overcharge as a product fee. Validate lawful split-pack dispensing separately.

### LEG-19 — Expiry, recall, quarantine and disposal

Bio-Medical Waste Management Rules 2016 include veterinary institutions in their scope and address expired/discarded medicines; subsequent amendments/state procedures also need review. [3](https://cpcb.gov.in/uploads/Projects/Bio-Medical-Waste/Bio-medical_Waste_Management_Rules_2016.pdf)

**Build:** block resale of expired/recalled/ineligible stock; record condition, quarantine, authorized supplier return/disposal and supporting references. Financial write-off is not evidence of lawful physical disposal. Capture the actual approved disposal method/vendor/documentation; do not generate fake disposal certificates or instruct staff to discard medicine into ordinary waste. No-restock customer returns must not restore sellable quantity or create duplicate cost reversals.

## 5. Privacy, security, contracts and evidence

### LEG-20 — DPDP commencement and transitional privacy duties

MeitY G.S.R. 843(E) phases commencement of the DPDP Act; G.S.R. 846(E) rule 1 phases the Rules: rules 1, 2, 17–21 at publication, rule 4 one year after publication, and rules 3, 5–16, 22–23 eighteen months after publication. The notifications are dated 13 November 2025 and the Gazette identifiers show publication on 14 November. Use the actual instruments and confirm precise legal commencement dates/corrections with counsel, rather than silently choosing one blog's one-day-different calculation. As of this pack's date, do not say every substantive duty is already in force. [14](https://www.meity.gov.in/static/uploads/2025/11/c56ceae6c383460ca69577428d36828b.pdf) [2](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf)

The December 2025 corrigenda must be read with the Rules. [1](https://www.meity.gov.in/static/uploads/2025/12/3c7ebbae0e5456f493f486e6845df86b.pdf) Assess currently applicable IT Act/SPDI obligations during transition rather than treating future DPDP commencement as permission to ignore privacy/security today. [2](https://www.indiacode.nic.in/ViewFileUploaded?path=AC_CEN_45_76_00001_200021_1517807324077%2Frulesindividualfile%2F&file=GSR313E_10511%281%29_0.pdf)

**Build now:** purpose/data inventory, clear notices, appropriate grounds/consent evidence, minimal collection, access/correction/grievance/erasure workflows with lawful retention, children/guardian handling where relevant, vendor/processor agreements, transfer assessment and incident response. The clinic is normally responsible for its customer processing; the platform may be its processor and a separate fiduciary for staff/platform account/subscription purposes. Validate the actual roles rather than rely on labels.

Animal data is not automatically human health data, but the linked owner's contact and billing information is personal data. Do not collect Aadhaar/biometrics/card credentials or a human medical history by default. Do not become or claim to be a statutory Consent Manager merely by implementing a consent screen.

### LEG-21 — Logs and breach response

CERT-In directions cover specified entities/incidents, require the stated reportable cyber incidents within six hours of notice/awareness and secure ICT logs for a rolling 180 days within Indian jurisdiction, along with the other applicable direction/clock/contact duties. [1](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf)

DPDP Rules 6–8 contain additional security/data/log retention and breach-information provisions once their applicable phase begins. Rule 7 distinguishes notification without delay from its detailed Board report within 72 hours (subject to the stated extension); this is not a substitute for CERT-In's different duty. Rules 6 and 8 include one-year retention provisions requiring precise scope/retention design. [2](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf)

**Build:** named incident contacts/on-call, early reportable-incident triage, reporting clocks and evidence preservation; minimized safe security logs in an approved India-located sink with the applicable retention. Do not log raw secrets/customer documents or wait 72 hours for every incident. Vercel function region alone does not prove every provider log/backup is stored in India; verify vendor features/contracts and block launch if mandatory arrangements cannot be met.

### LEG-22 — Contracts and service responsibilities

Obtain Indian legal review of the MSA/service terms, privacy notice/DPA, client responsibilities, supported/excluded use, price/renewal, incident cooperation, backup/RPO/RTO, termination/export/retention, intellectual property, support-access and liability provisions. Evaluate relevant consumer/e-commerce/intermediary/state business obligations on the actual model; do not assume SaaS billing software is automatically a pharmacy marketplace or automatically exempt from every such law.

Preserve acceptance/version/timestamp evidence. Scope exclusions do not excuse defective covered functionality, negligent engineering, non-waivable duties or unsafe security. Do not publish “100% Indian-law compliant”, “GST certified”, “PCI certified” or “audit proof” without the applicable independent evidence. Ordinary business software is not a professional licence.

### LEG-23 — Electronic evidence and signatures

Preserve original artifacts, source IDs, actor/time history, rule/template versions, hashes and a controlled export/custody record. The Bharatiya Sakshya Adhiniyam 2023 has electronic-record provisions including section 63; legal advisers must assess the evidence/certificate requirements for an actual proceeding. [6](https://www.indiacode.nic.in/bitstream/123456789/20063/1/a2023-47.pdf)

A hash helps integrity checking but is not automatic court admissibility, a qualified digital signature, an IRP acknowledgment or proof of truth. Never fabricate an official certificate or backdate evidence.

### LEG-24 — Additional-scope review triggers

Reassess law before adding online medicine ordering, delivery, clinical/prescription authoring, controlled drugs, payment aggregation/custody, automated gateway refunds, payroll, SMS/WhatsApp marketing, cross-border transfers, exports/SEZ, multi-registration stock transfers, automatic tax filing or wider clinical data. Collect only the relevant approvals; do not ask every tenant for every possible licence or sensitive identity document irrespective of need.

## 6. Release evidence and who signs off

| Evidence | Responsible reviewer | Release effect |
| --- | --- | --- |
| Tenant legal identity, GST status, licence scope and exact supported transactions | Owner plus appropriate CA/licensing/legal reviewer | Blocks affected operation/tenant activation if unresolved. |
| Tax/document/discount/PoS/credit-note rules, effective dates and rounding fixtures | Qualified Indian CA/GST practitioner | Approves the supported policy version, not universal future compliance. |
| Accounting mappings, openings, ITC review, close/retention/record authentication | Accountant/CA; company auditor/legal adviser where applicable | Blocks accounting release for unsupported obligations. |
| Tenant isolation, permissions, exact money, retries, reversals and reconciliation | Engineering and independent QA/security review | Executed test evidence required; no assumption-based pass. |
| India backup/log arrangements, restore tests, incident contacts and RPO/RTO evidence | Operations/security plus legal applicability reviewer | Blocks public production if mandatory controls are unproven. |
| Privacy/processor/transfer assessment, contracts and termination policy | Indian legal/privacy reviewer and business owner | Final contract/privacy gate. |

## 7. Explicit research limits / open checks

- Sources were read/retrieved for specification design, not an exhaustive all-state legal opinion or certified legal due diligence.
- Current product GST classification/rates, licence conditions, professional registers and physical/digital acceptance must be reviewed per tenant/product; none is guessed here.
- The CDSCO compilation is dated; current amendments and state licensing directions are not fully consolidated in this pack.
- The consolidated Income-tax Act download returned HTTP 403, while the specific official section 186 page and the notified 2026 Rules were accessible. A separate direct eGazette PDF download failed certificate verification; verification was **not disabled**. Do not treat those failed retrievals as successful verification of the entire current Act.
- The referenced SPDI primary-file link did not parse in the current fetch; the current full text and transition remain release-review items.
- The old MCA 2021 PDF path failed. The 2022 amendment primary source and ICAI guide were accessible; current amended primary rules still need release review.
- DPDP precise calendar commencement computation and all relevant corrigenda/later notifications must be confirmed; relative Gazette wording is preserved above.
- Rule 56 electronic-record authentication, record signatures, statutory invoice exceptions, company audit trails and legally acceptable drug registers require a concrete approved solution, not only hashes.
- A production region in Mumbai is not a guarantee that all vendors' global logs, support systems, email or backups remain in India. Verify each relevant flow and contract.
- All new SaaS implementation, runtime/security tests and professional approvals remain pending. This matrix is an acceptance framework, not a completed compliance certificate.
