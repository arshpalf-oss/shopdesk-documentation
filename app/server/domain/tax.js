/**
 * Tax and value engine — the single authoritative calculator.
 *
 * React, PDF templates and reports never re-derive totals: they consume this
 * module's output or the saved snapshot.
 *
 * Rounding policy (explicit, reviewed in docs/ROUNDING-AND-TAX-POLICY.md):
 *  - line tax = round_half_up(taxable × rate / 10 000) in exact BigInt paise;
 *  - for a supported intra-state supply with equal component rates, CGST and
 *    SGST are ALWAYS equal (half of the invoice tax, rounded half-up). If the
 *    total tax has an odd paisa, the residual 1 paisa is an explicit invoice
 *    round-off line — it is never silently assigned to only one half;
 *  - inter-state supplies use IGST only;
 *  - inclusive prices are decomposed with round_half_up(gross × 10 000 / (10 000 + rate));
 *  - discounts are applied before tax; an invoice-level discount is allocated
 *    across lines by gross value using largest remainder, so it reconciles exactly.
 */

import {
  MoneyError,
  allocateProportional,
  divRoundHalfUp,
  formatPaise,
  formatScaled,
  parseScaled,
  sumPaise,
  toPaise,
} from '../money.js';
import { unprocessable } from '../errors.js';

export const TREATMENTS = ['taxable', 'exempt', 'nil_rated', 'zero_rated', 'out_of_scope'];
export const TAXABLE_TREATMENTS = new Set(['taxable']);
export const DEFAULT_EQUAL_HALVES_POLICY = 'equal_halves_with_roundoff';

export function roundTax(taxable, rateBps) {
  const base = toPaise(taxable, 'taxable value');
  const rate = BigInt(rateBps);
  if (rate < 0n || rate > 10000n) {
    throw new MoneyError('tax rate must be between 0 and 10000 basis points (0–100%)', 'TAX_RATE_INVALID');
  }
  return divRoundHalfUp(base * rate, 10000n);
}

export function decomposeInclusive(gross, rateBps) {
  const total = toPaise(gross, 'inclusive gross');
  const rate = BigInt(rateBps);
  if (total < 0n) throw new MoneyError('inclusive gross must not be negative');
  if (rate < 0n || rate > 10000n) throw new MoneyError('tax rate must be 0–10000 bps');
  const taxable = divRoundHalfUp(total * 10000n, 10000n + rate);
  return { taxable, tax: total - taxable };
}

function normaliseTreatment(treatment, rateBps) {
  if (treatment === undefined || treatment === null || treatment === '') {
    return BigInt(rateBps) === 0n ? 'nil_rated' : 'taxable';
  }
  if (TREATMENTS.includes(treatment)) return treatment;
  throw unprocessable(`unknown tax treatment "${treatment}"`);
}

/**
 * Resolve intra/inter-state from the registration's state and the actual
 * place-of-supply facts. The customer's home state alone is not sufficient in
 * every case, so deliveryStateCode is preferred when recorded.
 */
export function resolveSupplyMode({ registration, customer, deliveryStateCode }) {
  if (!registration) throw unprocessable('a GST registration must be selected');
  if (registration.profile !== 'regular') return 'none';
  const supplierState = registration.stateCode;
  if (!supplierState) throw unprocessable('registration state code is required');
  const recipientState = deliveryStateCode || customer?.stateCode || customer?.billingStateCode || null;
  if (!recipientState) return 'intra';
  return recipientState === supplierState ? 'intra' : 'inter';
}

export function resolveDocKind({ registration, totals }) {
  if (!registration) throw unprocessable('registration required');
  if (registration.profile === 'composition') return 'bill_of_supply';
  if (registration.profile === 'unregistered') return 'commercial_sale';
  return totals.taxPaise === '0' ? 'bill_of_supply' : 'tax_invoice';
}

export const DOC_KIND_LABELS = {
  tax_invoice: 'TAX INVOICE',
  bill_of_supply: 'BILL OF SUPPLY',
  commercial_sale: 'SALE RECORD',
  credit_note: 'CREDIT NOTE',
  debit_note: 'DEBIT NOTE',
};

/**
 * Compute a full quote.
 *
 * @param {object} input
 * @param {Array} input.lines  catalogue lines (product snapshot + quantity)
 * @param {object} input.registration
 * @param {object} [input.customer]
 * @param {string} [input.deliveryStateCode]
 * @param {string} [input.invoiceDiscountPaise]
 * @param {object} [input.policy] { equalHalvesPolicy }
 */
export function computeQuote({
  lines,
  registration,
  customer = null,
  deliveryStateCode = null,
  invoiceDiscountPaise = '0',
  policy = {},
}) {
  if (!Array.isArray(lines) || lines.length === 0) throw unprocessable('at least one line is required');
  const supplyMode = resolveSupplyMode({ registration, customer, deliveryStateCode });
  const gstEnabled = supplyMode !== 'none';

  const prepared = lines.map((line, index) => {
    if (!line.productId) throw unprocessable(`line ${index + 1}: product is required`);
    const scale = Number(line.quantityScale ?? 3);
    if (!Number.isInteger(scale) || scale < 0 || scale > 6) {
      throw unprocessable(`line ${index + 1}: invalid quantity scale`);
    }
    const quantity = parseScaled(String(line.quantityScaled), scale, `line ${index + 1} quantity`);
    if (quantity <= 0n) throw unprocessable(`line ${index + 1}: quantity must be greater than zero`);
    const rateBps = BigInt(line.taxRateBps ?? '0');
    const treatment = normaliseTreatment(line.taxTreatment || (rateBps === 0n ? 'nil_rated' : 'taxable'), rateBps);
    const priceMode = line.priceMode === 'inclusive' ? 'inclusive' : 'exclusive';
    const unitPrice = toPaise(line.unitPricePaise, `line ${index + 1} price`);
    if (unitPrice < 0n) throw unprocessable(`line ${index + 1}: price must not be negative`);
    const gross = divRoundHalfUp(unitPrice * quantity, 10n ** BigInt(scale));
    const lineDiscount = toPaise(line.discountPaise ?? '0', `line ${index + 1} discount`);
    if (lineDiscount < 0n) throw unprocessable(`line ${index + 1}: discount must not be negative`);
    if (lineDiscount > gross) throw unprocessable(`line ${index + 1}: discount exceeds line value`);
    const taxableRate = TAXABLE_TREATMENTS.has(treatment) && gstEnabled && rateBps > 0n;
    return {
      index,
      productId: line.productId,
      name: line.name,
      sku: line.sku || null,
      hsn: line.hsn || null,
      uom: line.uom || 'unit',
      quantityScale: scale,
      quantityScaled: quantity.toString(),
      quantity: formatScaled(quantity, scale),
      unitPricePaise: unitPrice.toString(),
      priceMode,
      grossPaise: gross,
      lineDiscountPaise: lineDiscount,
      taxTreatment: treatment,
      taxRateBps: rateBps.toString(),
      taxableAtRate: taxableRate,
      batchRequired: Boolean(line.batchRequired),
      expiryRequired: Boolean(line.expiryRequired),
      kind: line.kind || 'goods',
      category: line.category || null,
      externalPrescriptionRef: line.externalPrescriptionRef || null,
      schedule: line.schedule || null,
    };
  });

  const invoiceDiscount = toPaise(invoiceDiscountPaise, 'invoice discount');
  if (invoiceDiscount < 0n) throw unprocessable('invoice discount must not be negative');
  const grossTotal = prepared.reduce((a, l) => a + l.grossPaise - l.lineDiscountPaise, 0n);
  if (invoiceDiscount > grossTotal) throw unprocessable('invoice discount exceeds invoice value');
  const discountShares = allocateProportional(
    invoiceDiscount,
    prepared.map((l) => l.grossPaise - l.lineDiscountPaise)
  );

  const computed = prepared.map((line, i) => {
    const discount = line.lineDiscountPaise + discountShares[i];
    const netGross = line.grossPaise - discount;
    let taxable;
    let tax;
    if (line.priceMode === 'inclusive') {
      const split = line.taxableAtRate
        ? decomposeInclusive(netGross, line.taxRateBps)
        : { taxable: netGross, tax: 0n };
      taxable = split.taxable;
      tax = split.tax;
    } else {
      taxable = netGross;
      tax = line.taxableAtRate ? roundTax(netGross, line.taxRateBps) : 0n;
    }
    return { ...line, discountPaise: discount, netGrossPaise: netGross, taxableValuePaise: taxable, taxPaise: tax };
  });

  const taxableTotal = computed.reduce((a, l) => a + l.taxableValuePaise, 0n);
  const taxTotal = computed.reduce((a, l) => a + l.taxPaise, 0n);
  const discountTotal = computed.reduce((a, l) => a + l.discountPaise, 0n);

  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;
  let roundOff = 0n;
  if (gstEnabled && taxTotal > 0n) {
    if (supplyMode === 'intra') {
      const half = divRoundHalfUp(taxTotal, 2n);
      cgst = half;
      sgst = half;
      // Explicit rounding line when the total tax has an odd paisa.
      roundOff = taxTotal - (cgst + sgst);
      if (roundOff !== 0n && (policy.equalHalvesPolicy || DEFAULT_EQUAL_HALVES_POLICY) === 'reject_odd') {
        throw unprocessable(
          'This basket produces an odd-paisa tax total. The configured policy requires an even split; ' +
            'adjust a line value or enable the reviewed equal-halves round-off policy.',
          'ODD_PAISE_COMPONENT'
        );
      }
    } else {
      igst = taxTotal;
    }
  }

  const lineTaxWeights = computed.map((l) => l.taxPaise);
  const lineCgst = supplyMode === 'intra' ? allocateProportional(cgst, lineTaxWeights) : computed.map(() => 0n);
  const lineSgst = supplyMode === 'intra' ? allocateProportional(sgst, lineTaxWeights) : computed.map(() => 0n);
  const lineIgst = supplyMode === 'inter' ? allocateProportional(igst, lineTaxWeights) : computed.map(() => 0n);

  const outLines = computed.map((l, i) => ({
    index: l.index,
    productId: l.productId,
    name: l.name,
    sku: l.sku,
    hsn: l.hsn,
    uom: l.uom,
    kind: l.kind,
    category: l.category,
    quantityScale: l.quantityScale,
    quantityScaled: l.quantityScaled,
    quantity: l.quantity,
    unitPricePaise: l.unitPricePaise,
    priceMode: l.priceMode,
    priceIncludesTax: l.priceMode === 'inclusive',
    grossPaise: l.grossPaise.toString(),
    discountPaise: l.discountPaise.toString(),
    taxableValuePaise: l.taxableValuePaise.toString(),
    taxTreatment: l.taxTreatment,
    taxRateBps: l.taxRateBps,
    taxPaise: l.taxPaise.toString(),
    cgstPaise: lineCgst[i].toString(),
    sgstPaise: lineSgst[i].toString(),
    igstPaise: lineIgst[i].toString(),
    lineTotalPaise: (l.taxableValuePaise + lineCgst[i] + lineSgst[i] + lineIgst[i]).toString(),
    batchRequired: l.batchRequired,
    expiryRequired: l.expiryRequired,
    externalPrescriptionRef: l.externalPrescriptionRef,
    schedule: l.schedule,
  }));

  const totalPaise = taxableTotal + cgst + sgst + igst + roundOff;
  const totals = {
    grossPaise: computed.reduce((a, l) => a + l.grossPaise, 0n).toString(),
    discountPaise: discountTotal.toString(),
    taxableValuePaise: taxableTotal.toString(),
    cgstPaise: cgst.toString(),
    sgstPaise: sgst.toString(),
    igstPaise: igst.toString(),
    taxPaise: (cgst + sgst + igst).toString(),
    computedTaxPaise: taxTotal.toString(),
    roundOffPaise: roundOff.toString(),
    totalPaise: totalPaise.toString(),
    supplyMode,
    gstEnabled,
    equalHalves: supplyMode === 'intra' ? cgst === sgst : true,
  };

  // Rate-group breakdown for GST working papers (never portal JSON).
  const groups = new Map();
  for (const line of outLines) {
    const key = `${line.taxTreatment}|${line.taxRateBps}`;
    const g = groups.get(key) || {
      taxTreatment: line.taxTreatment,
      taxRateBps: line.taxRateBps,
      taxableValuePaise: 0n,
      cgstPaise: 0n,
      sgstPaise: 0n,
      igstPaise: 0n,
    };
    g.taxableValuePaise += BigInt(line.taxableValuePaise);
    g.cgstPaise += BigInt(line.cgstPaise);
    g.sgstPaise += BigInt(line.sgstPaise);
    g.igstPaise += BigInt(line.igstPaise);
    groups.set(key, g);
  }
  const rateGroups = [...groups.values()]
    .sort((a, b) => Number(BigInt(a.taxRateBps) - BigInt(b.taxRateBps)))
    .map((g) => ({
      taxTreatment: g.taxTreatment,
      taxRateBps: g.taxRateBps,
      taxableValuePaise: g.taxableValuePaise.toString(),
      cgstPaise: g.cgstPaise.toString(),
      sgstPaise: g.sgstPaise.toString(),
      igstPaise: g.igstPaise.toString(),
      taxPaise: (g.cgstPaise + g.sgstPaise + g.igstPaise).toString(),
    }));

  const docKind = resolveDocKind({ registration, totals });
  const blocks = [];
  if (supplyMode === 'intra' && cgst !== sgst) {
    blocks.push({ code: 'UNEQUAL_COMPONENTS', message: 'CGST and SGST must be equal for this supply.' });
  }
  if (cgst + sgst + igst + roundOff !== taxTotal) {
    blocks.push({ code: 'TOTAL_RECONCILIATION', message: 'Component taxes plus round-off do not reconcile to the computed tax.' });
  }
  if (totalPaise !== taxableTotal + taxTotal) {
    blocks.push({ code: 'TOTAL_RECONCILIATION', message: 'Invoice total does not reconcile to taxable value plus tax.' });
  }

  return {
    lines: outLines,
    rateGroups,
    totals,
    supplyMode,
    docKind,
    policy: {
      equalHalves: policy.equalHalvesPolicy || DEFAULT_EQUAL_HALVES_POLICY,
      taxRateUnit: 'basis points of taxable value',
      rounding: 'half-up (away from zero) at paise precision',
    },
    blocks,
  };
}

/** Human-readable money for templates/CSV. */
export function displayPaise(value) {
  return formatPaise(value);
}

export { sumPaise };
