/**
 * Chart of accounts initialised for every new tenant.
 *
 * These are approved system references, not demo business transactions. The
 * pack permits initialising a chart of accounts for a new tenant; it forbids
 * seeding products, parties, stock, invoices or balances.
 */

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];

export const CHART = [
  { code: '1000', name: 'Cash in hand', type: 'asset', normal: 'debit', system: true },
  { code: '1010', name: 'Bank account', type: 'asset', normal: 'debit', system: true },
  { code: '1020', name: 'Card / UPI clearing', type: 'asset', normal: 'debit', system: true },
  { code: '1100', name: 'Accounts receivable (customers)', type: 'asset', normal: 'debit', system: true, party: 'customer' },
  { code: '1200', name: 'Inventory', type: 'asset', normal: 'debit', system: true },
  { code: '1300', name: 'Input GST — pending review', type: 'asset', normal: 'debit', system: true },
  { code: '1310', name: 'Input GST — eligible', type: 'asset', normal: 'debit', system: true },
  { code: '1320', name: 'Input GST — ineligible / non-recoverable', type: 'asset', normal: 'debit', system: true },
  { code: '2000', name: 'Accounts payable (suppliers)', type: 'liability', normal: 'credit', system: true, party: 'supplier' },
  { code: '2100', name: 'Output GST — CGST', type: 'liability', normal: 'credit', system: true },
  { code: '2110', name: 'Output GST — SGST / UTGST', type: 'liability', normal: 'credit', system: true },
  { code: '2120', name: 'Output GST — IGST', type: 'liability', normal: 'credit', system: true },
  { code: '2200', name: 'Customer credit / refund liability', type: 'liability', normal: 'credit', system: true },
  { code: '3000', name: 'Capital / owner equity', type: 'equity', normal: 'credit', system: true },
  { code: '3100', name: 'Opening balance equity', type: 'equity', normal: 'credit', system: true },
  { code: '4000', name: 'Sales — goods', type: 'revenue', normal: 'credit', system: true },
  { code: '4010', name: 'Sales — services', type: 'revenue', normal: 'credit', system: true },
  { code: '4100', name: 'Sales returns, credits & discounts', type: 'revenue', normal: 'debit', system: true },
  { code: '4110', name: 'Invoice round-off', type: 'revenue', normal: 'credit', system: true },
  { code: '5000', name: 'Cost of goods sold', type: 'expense', normal: 'debit', system: true },
  { code: '5100', name: 'Inventory write-off, wastage & losses', type: 'expense', normal: 'debit', system: true },
  { code: '5200', name: 'Rent', type: 'expense', normal: 'debit', system: false },
  { code: '5210', name: 'Salaries & staff welfare', type: 'expense', normal: 'debit', system: false },
  { code: '5220', name: 'Utilities', type: 'expense', normal: 'debit', system: false },
  { code: '5290', name: 'Other operating expenses', type: 'expense', normal: 'debit', system: false },
  { code: '5900', name: 'Discounts & commercial credits allowed', type: 'expense', normal: 'debit', system: true },
];

/** Account codes used by automatic postings. */
export const ACC = {
  CASH: '1000',
  BANK: '1010',
  CLEARING: '1020',
  RECEIVABLE: '1100',
  INVENTORY: '1200',
  INPUT_TAX_PENDING: '1300',
  SUPPLIER_PAYABLE: '2000',
  OUTPUT_CGST: '2100',
  OUTPUT_SGST: '2110',
  OUTPUT_IGST: '2120',
  CUSTOMER_CREDIT: '2200',
  CAPITAL: '3000',
  OPENING_EQUITY: '3100',
  SALES_GOODS: '4000',
  SALES_SERVICES: '4010',
  SALES_RETURNS: '4100',
  ROUND_OFF: '4110',
  COGS: '5000',
  WRITE_OFF: '5100',
  COMMERCIAL_CREDIT: '5900',
};

/** Map a confirmed receipt/refund method to its money account. */
export function moneyAccountForMethod(method) {
  switch (method) {
    case 'cash':
      return ACC.CASH;
    case 'bank_transfer':
    case 'cheque':
      return ACC.BANK;
    case 'card':
    case 'upi':
      return ACC.CLEARING;
    default:
      return ACC.CASH;
  }
}

export const PAYMENT_METHODS = ['cash', 'card', 'upi', 'bank_transfer', 'cheque'];
