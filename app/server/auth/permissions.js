/**
 * Roles and permissions.
 *
 * Permissions are checked in the API, never only in the UI. Monetary fields
 * (cost, valuation, margin) are gated separately from quantity fields so that a
 * quantity-only operator never receives restricted values in JSON/CSV/PDF.
 */

export const ROLES = {
  owner: {
    label: 'Owner',
    permissions: ['*'],
  },
  manager: {
    label: 'Manager',
    // A manager is explicitly delegated; nothing here implies owner powers.
    permissions: [
      'billing.use', 'billing.discount', 'billing.price_override',
      'documents.read', 'documents.print', 'documents.read.cost',
      'inventory.read', 'inventory.manage', 'inventory.adjust', 'inventory.cost',
      'products.manage', 'purchases.manage', 'suppliers.manage',
      'customers.manage', 'pets.manage',
      'returns.create', 'returns.restock', 'returns.gst.override',
      'payments.record', 'payments.refund', 'payments.pending.confirm', 'cash.close',
      'reports.read', 'reports.export', 'reports.cost',
      'accounts.read',
    ],
  },
  cashier: {
    label: 'Cashier',
    permissions: [
      'billing.use', 'documents.read', 'documents.print',
      'inventory.read', 'products.read',
      'customers.manage', 'pets.manage',
      'payments.record', 'payments.pending.confirm', 'cash.close',
      'returns.reprint', 'overview.self',
    ],
  },
  inventory: {
    label: 'Inventory operator',
    permissions: [
      'inventory.read', 'inventory.manage', 'inventory.adjust',
      'products.read', 'products.manage', 'purchases.manage', 'suppliers.manage',
      'documents.read', 'reports.read',
    ],
  },
  accountant: {
    label: 'Accountant / reviewer',
    permissions: [
      'documents.read', 'documents.read.cost', 'documents.print',
      'inventory.read', 'inventory.cost', 'products.read',
      'reports.read', 'reports.export', 'reports.cost',
      'accounts.read', 'accounts.post', 'accounts.review', 'accounts.period',
      'purchases.review_tax', 'returns.gst.review',
      'payments.read', 'overview.all',
    ],
  },
  platform_operator: {
    label: 'Platform operator (no clinic data by default)',
    permissions: ['platform.tenants'],
  },
};

export const ROLE_KEYS = Object.keys(ROLES);

export const PERMISSION_LABELS = {
  '*': 'All tenant permissions (owner)',
  'billing.use': 'Create drafts, quote and issue bills',
  'billing.discount': 'Apply permitted discounts',
  'billing.price_override': 'Override catalogue price above ceiling',
  'documents.read': 'Read issued documents',
  'documents.print': 'Print / reprint documents',
  'documents.read.cost': 'See purchase cost and margin values',
  'returns.reprint': 'Reprint approved notes against own bills',
  'returns.create': 'Create returns / credit notes',
  'returns.restock': 'Restock eligible returned goods',
  'returns.gst.override': 'Override GST-adjustment eligibility (audited)',
  'returns.gst.review': 'Review GST adjustment eligibility',
  'inventory.read': 'Read stock quantities',
  'inventory.manage': 'Manage products, batches and receipts',
  'inventory.adjust': 'Post approved stock adjustments',
  'inventory.cost': 'See inventory valuation and cost',
  'products.read': 'Read product catalogue',
  'products.manage': 'Create/update products and classifications',
  'purchases.manage': 'Post supplier bills and supplier returns',
  'purchases.review_tax': 'Review input-tax eligibility',
  'suppliers.manage': 'Manage suppliers',
  'customers.manage': 'Manage customers',
  'pets.manage': 'Manage basic pet billing identifiers',
  'payments.record': 'Record confirmed receipts / refunds',
  'payments.read': 'Read payment history',
  'payments.refund': 'Record a confirmed refund (separate from issuing a credit note)',
  'payments.pending.confirm': 'Confirm pending payment attempts',
  'cash.close': 'Prepare and approve cash closes',
  'reports.read': 'Read reports',
  'reports.export': 'Export report CSV',
  'reports.cost': 'Read cost / margin / valuation reports',
  'accounts.read': 'Read ledgers and statements',
  'accounts.post': 'Post journals, expenses and openings',
  'accounts.review': 'Reverse and review postings',
  'accounts.period': 'Close / reopen accounting periods',
  'overview.self': 'Overview of own work only',
  'overview.all': 'Whole-clinic overview',
  'staff.manage': 'Invite and manage staff',
  'settings.manage': 'Manage tenant, legal and numbering settings',
  'audit.read': 'Read the audit trail',
  'exports.read': 'Download private exports',
  'platform.tenants': 'Platform tenant lifecycle (no clinic data)',
};

const OWNER_ONLY = new Set(['staff.manage', 'settings.manage', 'audit.read', 'exports.read', 'accounts.post', 'accounts.review', 'accounts.period']);

/** Expand '*' to the effective set (owner). */
export function effectivePermissions(grants = []) {
  const set = new Set(grants);
  if (set.has('*')) return { all: true, set: new Set(Object.keys(PERMISSION_LABELS)) };
  // Sensitive accounting/staff powers are never implied by '*' in a delegated role.
  for (const p of OWNER_ONLY) set.delete(p);
  return { all: false, set };
}

export function hasPermission(grants, permission) {
  if (!permission) return true;
  const eff = effectivePermissions(grants);
  return eff.all || eff.set.has(permission);
}

export function requirePermission(ctx, permission) {
  if (!hasPermission(ctx.permissions, permission)) {
    const err = new Error(`permission "${permission}" is required`);
    err.code = 'FORBIDDEN';
    err.status = 403;
    err.permission = permission;
    throw err;
  }
  return true;
}

/** Navigation entries the API will advertise for a membership. */
export const NAV_ITEMS = [
  { key: 'overview', label: 'Overview', permission: null },
  { key: 'billing', label: 'Billing & POS', permission: 'billing.use' },
  { key: 'documents', label: 'Documents & printing', permission: 'documents.read' },
  { key: 'returns', label: 'Returns & credit/debit notes', permission: 'documents.read' },
  { key: 'inventory', label: 'Inventory', permission: 'inventory.read' },
  { key: 'purchases', label: 'Purchases & supplier returns', permission: 'inventory.read' },
  { key: 'customers', label: 'Customers & pets', permission: 'customers.manage' },
  { key: 'suppliers', label: 'Suppliers', permission: 'suppliers.manage' },
  { key: 'payments', label: 'Payments & cash close', permission: 'payments.read' },
  { key: 'accounts', label: 'Accounts & ledgers', permission: 'accounts.read' },
  { key: 'reports', label: 'Reports', permission: 'reports.read' },
  { key: 'staff', label: 'Staff & permissions', permission: 'staff.manage' },
  { key: 'settings', label: 'Settings & compliance', permission: 'settings.manage' },
  { key: 'audit', label: 'Audit & exports', permission: 'audit.read' },
];
