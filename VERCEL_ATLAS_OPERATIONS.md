# Online deployment, migration and operations runbook

**Target: Vercel React/Vite frontend + Vercel Node API/Cron + MongoDB Atlas**

These steps apply to the **future multi-tenant build after implementation/testing**. They are not instructions to deploy the old single-clinic archive and call it SaaS. No account was provisioned or inspected for this pack; no cost was authorized or incurred.

## 1. What you need before buying or deploying

- The reviewed new source repository, lockfile, migrations, tests and honest release checklist.
- Owner-controlled Vercel and Atlas accounts with MFA and limited collaborator permissions.
- A commercial-use-appropriate Vercel plan, sufficient Atlas compute/storage/connections/transactions and a verified backup/PITR solution. Vercel's Hobby plan is for personal/non-commercial use, not an assumed free commercial SaaS plan. [1](https://vercel.com/docs/limits/fair-use-guidelines)
- A domain, an approved email/auth route if used, private file/backup storage and an India-located log/archive arrangement where required.
- Written approval of ongoing infrastructure/provider charges. Verify actual plan features and prices; do not promise unlimited free hosting.
- The actual tenant legal/tax/licensing profile and supported transaction types. If applicable obligations cannot be met with the selected services, stop activation or obtain approval for a suitable managed component; do not hide the gap.

A cost worksheet should separately estimate Vercel seats/runtime/egress/Cron, Atlas compute/storage/backups, stable egress/private networking if required, domain, private storage/versioning, log retention, email/SMS and professional review. Static egress is a separate paid/plan-dependent decision, not something silently enabled by a tutorial.

## 2. Set up environments and ownership

Create **development**, **staging/preview** and **production** environments with different databases, credentials, storage prefixes/buckets, secrets, auth origins and integration accounts. Production data must not be copied into a public preview. Synthetic fixtures belong only in a clearly isolated test/staging database; production tenants remain empty until genuine records/openings are supplied.

Document who can deploy, manage secrets, run migrations, approve rule changes, respond to incidents and restore backups. Platform operators are not automatically clinic data administrators. Disable public self-service administrative bootstrap. Use authenticated invitations/private operator setup and verified owner activation.

## 3. Prepare the repository locally

Start from a **working copy** of the chosen reference, not the protected original archive. Ask the agent to complete phase 0 inspection before code changes.

Typical initial commands, when the existing package supports them:

```bash
node --version
npm ci
npm run build
npm test
```

Use the project's supported Node version, initially the existing Node 22 baseline. Validate Vercel/runtime/driver compatibility and the maintenance horizon before launch. Do not blindly upgrade every dependency or claim a security audit passed without executing it.

The new build must add and document reviewed scripts such as:

```text
npm run lint
npm run test:unit
npm run test:integration
npm run test:browser
npm run db:migrate -- --plan
npm run db:migrate -- --apply
npm run db:verify
npm run reconcile -- --read-only
```

**These script names are required deliverables, not a claim they already exist in either old ZIP.** Read each tool's database/environment confirmation before executing. Destructive reset tools must refuse production and require explicit approval even in staging. Migrations are controlled one-off operations, never an unrestricted API route or automatic per-request action.

## 4. Create the Atlas project and database

1. Sign in to Atlas using the verified owner account; turn on MFA and invite collaborators with least privilege.
2. Create a project specifically for the environment. Choose a deployment supporting transactions, production capacity and the required backup/recovery features. A low-cost/test tier is not automatically an approved production finance tier.
3. Select an available India region appropriate to latency and legal requirements, for example a supported Mumbai deployment, and verify actual primary/backup location settings. Do not infer all services' storage location from this choice.
4. Configure alerts for connection/resource usage, storage, replication/availability and backup failures. Review the actual backup/PITR features in the selected account/tier. Features change; do not make a blanket assumption that every small tier has no backup or that every paid tier automatically has every recovery feature.
5. Create a **runtime database user** with only the needed database/collection actions. Prefer insert/read privileges for immutable financial/audit collections and controlled update privileges only for mutable drafts/balances/projections. No cluster-admin/validator/index-management powers in the API.
6. Create separate short-lived/restricted migration/restore credentials. Keep them out of normal Vercel runtime environments and frontend build variables.
7. Obtain the official driver connection string. Keep credentials private and URI-encode password characters correctly. Store the database name separately if the application expects it. Never paste secrets into support screenshots or this document.
8. Configure Network Access for the **actual backend egress**, not merely your laptop IP or the public application/domain IP.

## 5. Atlas network access and TLS

Atlas IP access lists control which clients may connect. A public website's ingress address is not its backend's outbound address. Vercel serverless egress can vary unless the selected service provides approved stable egress/private connectivity. Choose an actual supported solution and verify the egress IPs for the functions' selected region/environment before narrowing the Atlas list.

Adding `0.0.0.0/0` allows connections from anywhere and increases exposure; it is not the default security recommendation. [1](https://www.mongodb.com/docs/atlas/security/ip-access-list/) Any temporary diagnostic exposure needs explicit approval, strong least-privilege credentials, monitoring, expiry and a rollback plan. Do not leave a wildcard allowlist as a silent production shortcut.

On an initial connection failure, diagnose separately: DNS/SRV, network access list/egress, paused cluster/service health, TLS trust/handshake, driver/runtime compatibility, authentication and missing environment variables. A message such as `MONGODB_TLS_FAILED` classifies a failure, not its proven cause.

**Never “fix” TLS by setting `NODE_TLS_REJECT_UNAUTHORIZED=0`, `tlsAllowInvalidCertificates`, invalid-hostname acceptance or a plaintext connection.** Capture sanitized error category/request ID for operators. Keep raw Mongo URI/credentials/host topology out of public errors.

Use a module-level cached Mongo client/pool compatible with Vercel's lifecycle. Set conservative max pool size, idle limits and selection/operation timeouts based on measured concurrency. Estimate total connections as warm instances × per-instance pool plus jobs/operations; one pool of 10 per instance can still exhaust a small cluster when the app scales. Clear a rejected cached connection promise so one failed startup does not poison the instance indefinitely. Reuse the pool; do not connect/close per request or establish a separate pool for each tenant by accident.

## 6. Configure Vercel

1. Create/import the reviewed new project from the owner's repository. Do not make a repository public if it contains private code/configuration.
2. Select the correct root directory and Vite/static build configuration, normally install `npm ci`, build `npm run build`, output `dist`. Confirm the actual project scripts instead of guessing.
3. Use the supported **Node.js runtime** for the Mongo API. Do not deploy it as Edge runtime. Set the function region deliberately, normally `bom1` if available and approved, rather than assume the default is India.
4. Preserve/test API rewrites and the SPA fallback. `/api/v1/...` must reach the Node API, not return `index.html`; frontend routes must load after refresh. Authentication/setup/status errors must remain meaningful and sanitized.
5. Give functions conservative tested durations and workload limits. Do not rely on a plan's maximum duration as a job queue. Limits/features change and some are beta. [1](https://vercel.com/docs/functions/limitations)
6. Configure a protected production-only cron schedule consistent with the selected plan. Cron execution can overlap or retry; its handler must use durable leases. Authenticate using a strong `CRON_SECRET`/supported authorization mechanism, reject unauthorized requests and do not accept an arbitrary browser tenant ID as the job scope. [1](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
7. Protect preview deployments and route preview secrets only to staging. Confirm that Cron, log drains and external providers use the correct environment.
8. Add security headers/caching rules. Financial/auth/API responses are private/no-store; static fingerprinted frontend assets can be cached. Avoid putting PII/auth tokens in URLs or public assets.

### Environment variable checklist

Final names are a versioned application contract. Typical server-only variables:

| Variable | Purpose / rule |
| --- | --- |
| `MONGODB_URI` | Secret native-driver connection URI; server-only. |
| `MONGODB_DB` | Explicit environment-specific database. |
| `APP_ORIGIN` | Exact approved HTTPS origin for auth/CSRF/link generation. |
| Session/token hashing secret(s) | High-entropy independent secrets according to the auth design; never static examples. |
| MFA encryption/key reference | Protect MFA secrets; do not log or expose them. |
| `CRON_SECRET` | Authenticate scheduled job invocations; not a tenant API key. |
| Private storage endpoint/region/bucket/credentials | Minimum required permissions; prove location/retention where legally relevant. |
| Safe log sink/credentials | Approved retention/location; redact secrets and personal data. |
| Optional approved provider credentials | Environment-specific IRP/signing/email/payment integrations only after approval. |

Never prefix secrets with `VITE_`: Vite exposes such variables to the browser bundle. Do not include actual `.env` files in Git/ZIPs. Vercel environment changes usually require the appropriate redeployment; verify the active deployment uses the intended environment, not a stale preview. Use secret-management rotation and incident procedures, not credentials in screenshots.

## 7. Database preflight and migrations

Before the first live deployment:

1. Confirm the target environment/database fingerprint, available transactions, runtime role, network route, backup and current source schema version.
2. Run a dry-run migration plan against staging with a verified backup.
3. Apply reviewed migrations using separate operator credentials. Create validators, tenant-prefixed indexes, immutable-role privileges and schema/version records. Do not silently rebuild/drop live indexes on every function invocation.
4. Initialize reference metadata/approved chart of accounts only. No products, invoices, customers, pets, suppliers, stock or cash movements are fabricated.
5. Verify indexes, permissions, empty-tenant counts and the read/write capability matrix. A `readWrite` user on the entire database does not prove append-only protection.
6. Rehearse the upgrade/downgrade compatibility plan. Refuse startup/mutations against unsupported schema versions with safe operator diagnostics.
7. Repeat the approved production procedure during a controlled release window, preserving existing data and evidence.

## 8. Staging verification and go-live

Run the full acceptance matrix with two independently seeded test tenants. Verify backend isolation even when a request deliberately sends foreign IDs; test every API, report, CSV/PDF, file, job and support path. Execute concurrency, idempotency, injected failure, unknown commit, repeated returns, over-refund, historical tax and GL/stock/payment reconciliation tests.

Use the official Vercel build/runtime path as well as local tests. Check login/session/CSRF behavior on the real HTTPS host, direct SPA navigation and API routes, Cron authentication, function budgets, pool reuse, payload limits and protected previews. Verify A4/58/80 mm output with the real printers. Do not create fake production invoices to test printing.

Obtain the CA/GST/licensing/privacy/contract reviews specified by the legal matrix; unresolved mandatory controls block the affected tenant/capability. Test actual India-required backup/log/archive locations, not just UI checkboxes.

Then: final approved migration → owner activation → genuine opening data → production write enablement → close monitoring. Give owners the user guide and contacts. Display support/exclusion limits honestly. Plan expiry/subscription enforcement separately from the clinic's financial ledger, with contractually appropriate secure record access/export/retention after termination.

## 9. Routine operations

**Monitor:** API error/latency, failed authentication/rate limits, tenant-scope violations, unknown outcomes, duplicate conflicts, stock/GL reconciliation, queue backlog/oldest job, dead letters, lease recovery, storage/cost growth, backup age, restore evidence and expiring licences/rule reviews.

**Daily:** confirm provider backups and India daily copies where required; inspect failed jobs/pending provider outcomes; reconcile cash/digital receipts; review critical expiry/recalls and access alerts.

**Weekly:** check staff/support grants, dependency/security advisories and working backup retention. Run read-only reconciliation of stock balances to movements, journals to sources and customer/supplier balances to allocation records.

**Periodic:** test full restore and tenant recovery, rotate credentials under policy, rehearse incidents, review vendor/subprocessor arrangements and upcoming legal/rate changes. Roll out future rule versions by effective date without recalculating old invoices.

## 10. Backup and recovery design

Proposed targets such as **RPO 15 minutes / RTO 4 hours** are engineering objectives, not a promise until the actual paid tier, backup configuration and restore drills demonstrate them. Document provider outage and missing-backup scenarios honestly.

Use verified provider database backups/PITR plus independent protected evidence/archives as required. Cover immutable documents, allocations, movements, payments, GL, audit, rules, numbering history, file metadata and file objects, and the separately protected keys needed for recovery. A CSV export is not a complete database backup. A backup without tested decryption/restore is not proven recoverability.

For mandatory daily India backups/log retention, retain provider location evidence and last-success alerts. Do not attempt an unlimited full-database `mongodump` inside a normal Vercel request. Use the approved Atlas/native managed backup capabilities; bounded artifact jobs are not automatically substitutes. Large one-off import/restore tools may run on an explicitly approved operator machine/CI runner with temporary controlled access, not a hidden always-on product backend. Obtain approval before adding another managed compute service.

### Recovery procedure

1. Declare incident, record time/scope, preserve evidence and stop affected financial writes. Prefer read-only mode over destructive guesses.
2. Restore the selected backup/PITR into an isolated restricted environment, never directly over the shared production database without approval.
3. Verify manifests/decryption/schema, stock by batch, original amounts/tax, payment/refund balances, trial balance, source links, rules and number history.
4. Reconcile transactions after the restore point against independent numbering/audit evidence, customer-issued documents, bank/provider records and IRP where applicable. **Do not reuse any number merely because the restored counter is lower.** Restore a safe issuance fence/high-water mark before enabling new bills.
5. Reconcile outbox/provider status. Do not blindly resend payments, refunds, e-invoice submissions or notification jobs restored from an earlier state. Use the original operation/provider identities.
6. Revoke/rotate sessions or compromised credentials according to the incident, including stale sessions that might reappear from backup. Do not import source-tenant credentials into another tenant.
7. For one-tenant recovery, restore/extract through reviewed tenant-scoped tools; do not overwrite unrelated clinics' collections. Preserve approvals and recovery audit evidence.
8. Verify the recovered tenant in read-only mode, obtain business/technical approval, enable writes gradually and monitor. Record actual RPO/RTO and gaps.

A code rollback is not automatically a database rollback. New production invoices/payments after deployment must not disappear because a previous application version is redeployed.

## 11. Incident response and safe diagnostics

Maintain an actual on-call/contact matrix, reporting applicability and legal clocks. Triage CERT-In-listed incidents and privacy breaches separately; do not wait for the wrong regime's deadline. Preserve security evidence in the approved location, minimize exposure, rotate compromised secrets and record required notifications/decisions with legal review.

A public health endpoint should reveal only minimal generic service readiness. Deep diagnostics require an authorized operator and must never dump customer records, keys, full environment values, database URIs or raw stack traces. Treat symptoms as symptoms; no unverified cause is declared fixed without an actual successful environment test.

## 12. Stop / no-go conditions

Stop production activation if tenant isolation, exact money, numbering, stock/payment/GL consistency, required legal document/medicine controls, authentication/audit, recoverability or mandatory India arrangements fail. Do not compensate by disabling TLS, relaxing permissions, deleting audit rows, fabricating statutory IDs or rewriting old bills. Publish remaining limitations and obtain the right approvals instead.
