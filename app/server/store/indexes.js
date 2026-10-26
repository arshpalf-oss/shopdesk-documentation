/**
 * Declared unique indexes and secondary indexes.
 *
 * Both stores enforce these: the file store checks uniqueness before writing;
 * the Mongo store creates real indexes. Tenant-prefixed keys are mandatory so
 * that one tenant's identifiers can never collide with another's.
 */

const present = (keys) => (doc) => keys.every((k) => doc[k] !== undefined && doc[k] !== null && doc[k] !== '');

export const INDEXES = [
  { collection: 'tenants', name: 'uq_tenant_slug', keys: { slug: 1 }, unique: true },
  { collection: 'users', name: 'uq_user_email', keys: { emailLower: 1 }, unique: true },
  { collection: 'memberships', name: 'uq_membership', keys: { tenantId: 1, userId: 1 }, unique: true },
  { collection: 'memberships', name: 'ix_membership_user', keys: { userId: 1, status: 1 } },
  { collection: 'sessions', name: 'uq_session_token', keys: { tokenHash: 1 }, unique: true },
  { collection: 'sessions', name: 'ix_session_user', keys: { userId: 1, expiresAt: 1 } },
  { collection: 'invitations', name: 'uq_invitation_token', keys: { tokenHash: 1 }, unique: true },
  { collection: 'branches', name: 'uq_branch_code', keys: { tenantId: 1, code: 1 }, unique: true },
  { collection: 'tax_registrations', name: 'uq_registration_code', keys: { tenantId: 1, code: 1 }, unique: true },
  {
    collection: 'tax_registrations',
    name: 'uq_registration_gstin',
    keys: { tenantId: 1, gstin: 1 },
    unique: true,
    partial: (d) => typeof d.gstin === 'string' && d.gstin.length > 0,
  },
  {
    collection: 'products',
    name: 'uq_product_sku',
    keys: { tenantId: 1, skuNormalised: 1 },
    unique: true,
    partial: (d) => typeof d.skuNormalised === 'string' && d.skuNormalised.length > 0,
  },
  {
    collection: 'products',
    name: 'uq_product_barcode',
    keys: { tenantId: 1, barcodeNormalised: 1 },
    unique: true,
    partial: (d) => typeof d.barcodeNormalised === 'string' && d.barcodeNormalised.length > 0,
  },
  { collection: 'products', name: 'ix_product_search', keys: { tenantId: 1, status: 1, kind: 1 } },
  { collection: 'customers', name: 'ix_customer_search', keys: { tenantId: 1, nameLower: 1 } },
  { collection: 'suppliers', name: 'ix_supplier_search', keys: { tenantId: 1, nameLower: 1 } },
  { collection: 'pets', name: 'ix_pet_owner', keys: { tenantId: 1, customerId: 1 } },

  {
    collection: 'batch_lots',
    name: 'uq_batch_no',
    keys: { tenantId: 1, branchId: 1, productId: 1, batchNoNormalised: 1 },
    unique: true,
    partial: (d) => typeof d.batchNoNormalised === 'string' && d.batchNoNormalised.length > 0,
  },
  { collection: 'batch_lots', name: 'ix_batch_expiry', keys: { tenantId: 1, branchId: 1, status: 1, expirySortKey: 1 } },
  { collection: 'stock_balances', name: 'uq_stock_batch', keys: { tenantId: 1, batchId: 1 }, unique: true },
  { collection: 'stock_balances', name: 'ix_stock_branch', keys: { tenantId: 1, branchId: 1, productId: 1 } },
  { collection: 'inventory_movements', name: 'ix_movement_batch', keys: { tenantId: 1, batchId: 1, at: 1 } },
  { collection: 'inventory_movements', name: 'ix_movement_source', keys: { tenantId: 1, sourceType: 1, sourceId: 1 } },

  { collection: 'sales_drafts', name: 'uq_draft_identity', keys: { tenantId: 1, _id: 1 }, unique: true },
  { collection: 'sales_drafts', name: 'ix_draft_cashier', keys: { tenantId: 1, cashierId: 1, status: 1 } },

  {
    collection: 'financial_documents',
    name: 'uq_document_number',
    keys: { tenantId: 1, registrationId: 1, fy: 1, number: 1 },
    unique: true,
  },
  {
    collection: 'financial_documents',
    name: 'uq_document_source_draft',
    keys: { tenantId: 1, sourceDraftId: 1 },
    unique: true,
    partial: (d) => typeof d.sourceDraftId === 'string',
  },
  {
    collection: 'financial_documents',
    name: 'ix_document_party',
    keys: { tenantId: 1, kind: 1, partyId: 1, issuedAt: 1 },
  },
  {
    collection: 'financial_documents',
    name: 'ix_document_date',
    keys: { tenantId: 1, branchId: 1, kind: 1, issuedAt: 1 },
  },
  { collection: 'document_events', name: 'ix_document_event', keys: { tenantId: 1, documentId: 1, at: 1 } },
  { collection: 'invoice_allocations', name: 'ix_allocation_document', keys: { tenantId: 1, documentId: 1 } },

  { collection: 'returns', name: 'uq_return_number', keys: { tenantId: 1, registrationId: 1, fy: 1, number: 1 }, unique: true },
  {
    collection: 'return_allocations',
    name: 'uq_return_allocation',
    keys: { tenantId: 1, returnId: 1, originalAllocationId: 1 },
    unique: true,
  },
  { collection: 'return_allocations', name: 'ix_return_allocation_source', keys: { tenantId: 1, originalDocumentId: 1 } },
  { collection: 'return_dispositions', name: 'ix_disposition_source', keys: { tenantId: 1, returnId: 1 } },

  { collection: 'purchases', name: 'uq_purchase_supplier_bill', keys: { tenantId: 1, supplierId: 1, fy: 1, supplierInvoiceNo: 1 }, unique: true },
  { collection: 'purchase_tax_reviews', name: 'uq_tax_review_purchase', keys: { tenantId: 1, purchaseId: 1 }, unique: true },
  { collection: 'supplier_returns', name: 'uq_supplier_return_number', keys: { tenantId: 1, number: 1 }, unique: true },

  { collection: 'payment_intents', name: 'uq_intent_identity', keys: { tenantId: 1, idempotencyKey: 1 }, unique: true },
  { collection: 'payments', name: 'uq_payment_identity', keys: { tenantId: 1, idempotencyKey: 1 }, unique: true },
  { collection: 'payments', name: 'ix_payment_party', keys: { tenantId: 1, partyId: 1, at: 1 } },
  { collection: 'payments', name: 'ix_payment_date', keys: { tenantId: 1, branchId: 1, kind: 1, at: 1 } },
  { collection: 'payment_allocations', name: 'ix_payment_allocation', keys: { tenantId: 1, documentId: 1 } },
  { collection: 'cash_closes', name: 'uq_cash_close', keys: { tenantId: 1, branchId: 1, businessDate: 1, sessionKey: 1 }, unique: true },

  { collection: 'ledger_accounts', name: 'uq_account_code', keys: { tenantId: 1, code: 1 }, unique: true },
  { collection: 'journal_entries', name: 'uq_journal_source', keys: { tenantId: 1, sourceEventId: 1, postingKind: 1 }, unique: true },
  { collection: 'journal_entries', name: 'ix_journal_date', keys: { tenantId: 1, businessDate: 1, status: 1 } },
  { collection: 'journal_lines', name: 'ix_journal_line_account', keys: { tenantId: 1, accountId: 1, businessDate: 1 } },
  { collection: 'period_locks', name: 'uq_period_lock', keys: { tenantId: 1, year: 1, month: 1 }, unique: true },
  { collection: 'opening_entries', name: 'uq_opening_batch', keys: { tenantId: 1, batchId: 1 }, unique: true, partial: (d) => !!d.batchId },

  { collection: 'sequences', name: 'uq_sequence_scope', keys: { tenantId: 1, registrationId: 1, fy: 1, series: 1 }, unique: true },
  {
    collection: 'idempotency_operations',
    name: 'uq_operation_identity',
    keys: { tenantId: 1, actorId: 1, action: 1, key: 1 },
    unique: true,
  },
  { collection: 'audit_events', name: 'uq_audit_sequence', keys: { tenantId: 1, sequence: 1 }, unique: true },
  { collection: 'audit_events', name: 'ix_audit_time', keys: { tenantId: 1, at: 1 } },
  { collection: 'outbox_jobs', name: 'uq_job_event', keys: { tenantId: 1, eventKey: 1 }, unique: true },
  { collection: 'outbox_jobs', name: 'ix_job_due', keys: { state: 1, nextAttemptAt: 1 } },
  { collection: 'file_objects', name: 'ix_file_owner', keys: { tenantId: 1, ownerId: 1, createdAt: 1 } },
  { collection: 'legal_rules', name: 'uq_rule_key', keys: { tenantId: 1, key: 1 }, unique: true },
  { collection: 'schema_migrations', name: 'uq_migration', keys: { name: 1 }, unique: true },
];

export function indexesFor(collection) {
  return INDEXES.filter((ix) => ix.collection === collection);
}

export function isPresentIndex(index, doc) {
  if (index.partial && !index.partial(doc)) return false;
  return present(Object.keys(index.keys))(doc);
}
