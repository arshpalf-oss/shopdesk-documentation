/**
 * Server-rendered, print-ready documents.
 *
 * Rendering uses ONLY the saved immutable snapshot: changing a product, price,
 * tax rate or template later cannot alter an issued document. No script is
 * emitted, all user text is escaped, and no statutory QR/IRN/signature is ever
 * drawn — those require an authentic integration and are shown as "not applicable
 * or not integrated" instead.
 */

import { formatINR, formatScaled } from '../money.js';
import { businessDate } from '../time.js';

const TEMPLATES = {
  corporate: { a4: true, label: 'Corporate A4', version: 'A4-2026.10' },
  classic: { a4: true, label: 'Classic A4', version: 'A4-2026.10' },
  compact: { a4: true, label: 'Compact A4', version: 'A4-2026.10' },
  thermal58: { a4: false, width: '58mm', label: 'Thermal 58 mm', version: 'THERMAL-2026.10' },
  thermal80: { a4: false, width: '80mm', label: 'Thermal 80 mm', version: 'THERMAL-2026.10' },
};

export function templateChoices() {
  return Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, version: t.version, a4: t.a4 }));
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function docTitle(document) {
  switch (document.docKind) {
    case 'tax_invoice':
      return 'TAX INVOICE';
    case 'bill_of_supply':
      return 'BILL OF SUPPLY';
    case 'commercial_sale':
      return 'SALE RECORD';
    case 'credit_note':
      return 'CREDIT NOTE';
    case 'debit_note':
      return 'DEBIT NOTE';
    default:
      return 'DOCUMENT';
  }
}

function qtyLabel(line) {
  return `${formatScaled(BigInt(line.quantityScaled), line.quantityScale)} ${esc(line.uom || '')}`.trim();
}

function money(value) {
  return formatINR(value);
}

function a4Table(document) {
  const rows = document.lines
    .map((line, i) => {
      const taxLabel = [
        BigInt(line.cgstPaise) > 0n ? `CGST ${money(line.cgstPaise)}` : null,
        BigInt(line.sgstPaise) > 0n ? `SGST ${money(line.sgstPaise)}` : null,
        BigInt(line.igstPaise) > 0n ? `IGST ${money(line.igstPaise)}` : null,
      ]
        .filter(Boolean)
        .join('<br>') || '—';
      const batch = (line.batchAllocations || []).map((b) => esc(b.batchNo)).join(', ');
      return `<tr>
        <td class="num">${i + 1}</td>
        <td>
          <strong>${esc(line.product?.name)}</strong>
          ${line.product?.sku ? `<div class="muted">SKU ${esc(line.product.sku)}</div>` : ''}
          ${batch ? `<div class="muted">Batch ${batch}</div>` : ''}
          ${line.externalPrescriptionRef ? `<div class="muted">External Rx ref: ${esc(line.externalPrescriptionRef)}</div>` : ''}
        </td>
        <td class="num">${esc(line.product?.hsn || '—')}</td>
        <td class="num">${qtyLabel(line)}</td>
        <td class="num">${money(line.unitPricePaise)}${line.priceIncludesTax ? '<div class="muted">incl.</div>' : ''}</td>
        <td class="num">${BigInt(line.discountPaise) > 0n ? money(line.discountPaise) : '—'}</td>
        <td class="num">${money(line.taxableValuePaise)}</td>
        <td class="num">${taxLabel}<div class="muted">${formatRate(line.taxRateBps)}</div></td>
        <td class="num">${money(line.lineTotalPaise)}</td>
      </tr>`;
    })
    .join('');

  return `<table class="items">
    <thead>
      <tr>
        <th class="num">#</th><th>Description</th><th class="num">HSN/SAC</th><th class="num">Qty</th>
        <th class="num">Rate</th><th class="num">Discount</th><th class="num">Taxable</th>
        <th class="num">GST</th><th class="num">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function formatRate(bps) {
  const n = BigInt(bps || '0');
  if (n === 0n) return '0%';
  const whole = n / 100n;
  const fraction = n % 100n;
  return fraction === 0n ? `${whole}%` : `${whole}.${fraction.toString().padStart(2, '0')}%`;
}

function a4Totals(document) {
  const t = document.totals;
  return `<table class="totals">
    <tr><td>Taxable value</td><td class="num">${money(t.taxableValuePaise)}</td></tr>
    ${BigInt(t.cgstPaise) !== 0n ? `<tr><td>CGST</td><td class="num">${money(t.cgstPaise)}</td></tr>` : ''}
    ${BigInt(t.sgstPaise) !== 0n ? `<tr><td>SGST / UTGST</td><td class="num">${money(t.sgstPaise)}</td></tr>` : ''}
    ${BigInt(t.igstPaise) !== 0n ? `<tr><td>IGST</td><td class="num">${money(t.igstPaise)}</td></tr>` : ''}
    ${BigInt(t.roundOffPaise || '0') !== 0n ? `<tr><td>Round-off (equal-half policy)</td><td class="num">${money(t.roundOffPaise)}</td></tr>` : ''}
    <tr class="grand"><td>Total</td><td class="num">${money(t.totalPaise)}</td></tr>
  </table>`;
}

function thermalBody(document, widthLabel) {
  const lines = document.lines
    .map(
      (line) => `<div class="t-line">
        <div class="t-name">${esc(line.product?.name)}</div>
        <div class="t-row">
          <span>${qtyLabel(line)} × ${money(line.unitPricePaise)}</span>
          <span>${money(line.lineTotalPaise)}</span>
        </div>
        <div class="t-meta">HSN ${esc(line.product?.hsn || '—')} · GST ${formatRate(line.taxRateBps)}
          ${BigInt(line.cgstPaise) > 0n ? ` · CGST ${money(line.cgstPaise)}` : ''}
          ${BigInt(line.sgstPaise) > 0n ? ` · SGST ${money(line.sgstPaise)}` : ''}
          ${BigInt(line.igstPaise) > 0n ? ` · IGST ${money(line.igstPaise)}` : ''}</div>
        ${(line.batchAllocations || []).length ? `<div class="t-meta">Batch ${line.batchAllocations.map((b) => esc(b.batchNo)).join(', ')}</div>` : ''}
      </div>`
    )
    .join('');
  const t = document.totals;
  return `<div class="thermal">
    <div class="t-center"><strong>${esc(document.supplierSnapshot?.tradeName || document.supplierSnapshot?.legalName)}</strong></div>
    <div class="t-center t-meta">${esc(document.supplierSnapshot?.address || '')}</div>
    ${document.supplierSnapshot?.gstin ? `<div class="t-center t-meta">GSTIN ${esc(document.supplierSnapshot.gstin)}</div>` : ''}
    <div class="t-center"><strong>${docTitle(document)}</strong></div>
    <div class="t-row"><span>${esc(document.number)}</span><span>${esc(document.businessDate)}</span></div>
    <div class="t-meta">Customer: ${esc(document.partySnapshot?.name || 'Walk-in customer')}</div>
    <hr>
    ${lines}
    <hr>
    <div class="t-row"><span>Taxable</span><span>${money(t.taxableValuePaise)}</span></div>
    ${BigInt(t.cgstPaise) !== 0n ? `<div class="t-row"><span>CGST</span><span>${money(t.cgstPaise)}</span></div>` : ''}
    ${BigInt(t.sgstPaise) !== 0n ? `<div class="t-row"><span>SGST/UTGST</span><span>${money(t.sgstPaise)}</span></div>` : ''}
    ${BigInt(t.igstPaise) !== 0n ? `<div class="t-row"><span>IGST</span><span>${money(t.igstPaise)}</span></div>` : ''}
    ${BigInt(t.roundOffPaise || '0') !== 0n ? `<div class="t-row"><span>Round-off</span><span>${money(t.roundOffPaise)}</span></div>` : ''}
    <div class="t-row t-total"><span>TOTAL</span><span>${money(t.totalPaise)}</span></div>
    <div class="t-meta">${esc(widthLabel)} · ${esc(document.templateVersion)}</div>
    <div class="t-meta">Generated from the saved document snapshot. No statutory QR/IRN is printed.</div>
  </div>`;
}

function creditNoteBody(ret) {
  const rows = ret.credit.lines
    .map(
      (l, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td>${esc(l.lineId)}</td>
      <td class="num">${esc(l.quantityScaled)}</td>
      <td class="num">${money(l.credit.taxableValuePaise)}</td>
      <td class="num">${money(l.credit.cgstPaise)}</td>
      <td class="num">${money(l.credit.sgstPaise)}</td>
      <td class="num">${money(l.credit.igstPaise)}</td>
      <td class="num">${money(l.credit.commercialCreditPaise)}</td>
    </tr>`
    )
    .join('');
  return `<table class="items">
    <thead><tr><th class="num">#</th><th>Original line</th><th class="num">Qty</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th><th class="num">Credit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <table class="totals">
    <tr><td>Commercial credit</td><td class="num">${money(ret.credit.commercialCreditPaise)}</td></tr>
    <tr><td>GST adjustment (${esc(ret.credit.gstAdjustmentStatus)})</td><td class="num">${money(ret.credit.gstAdjustmentPaise)}</td></tr>
    <tr class="grand"><td>Customer credit</td><td class="num">${money(ret.credit.commercialCreditPaise)}</td></tr>
  </table>`;
}

export function renderDocumentHtml({ document, template = 'corporate', tenant, asOf }) {
  const chosen = TEMPLATES[template] ? template : 'corporate';
  const config = TEMPLATES[chosen];
  const isCredit = document.kind === 'credit_note' || document.docKind === 'credit_note';
  const totalCredit = isCredit ? document.credit?.commercialCreditPaise : document.totals?.totalPaise;
  const pageRule = config.a4
    ? '@page { size: A4; margin: 12mm; }'
    : `@page { size: ${config.width} auto; margin: 3mm; }`;
  const theme =
    chosen === 'compact'
      ? '--pad:6px;--font:10.5px;--title:15px'
      : chosen === 'classic'
        ? '--pad:9px;--font:11.5px;--title:17px'
        : '--pad:10px;--font:12px;--title:19px';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(docTitle(document))} ${esc(document.number)}</title>
<style>
  :root { ${theme} }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, "Segoe UI", Arial, sans-serif; color: #101418; background: #fff; font-size: var(--font); }
  .sheet { padding: 8px; max-width: ${config.a4 ? '190mm' : config.width}; margin: 0 auto; }
  .head { display: flex; justify-content: space-between; gap: 16px; border-bottom: 2px solid #101418; padding-bottom: 8px; }
  .brand { font-size: var(--title); font-weight: 700; letter-spacing: .2px; }
  .muted { color: #4a5560; font-size: .86em; }
  .title { text-align: right; font-weight: 700; font-size: var(--title); letter-spacing: 1px; }
  .meta { display: flex; justify-content: space-between; gap: 16px; padding: 8px 0; }
  .meta > div { flex: 1; }
  table { width: 100%; border-collapse: collapse; }
  .items th, .items td { border-bottom: 1px solid #c9d1d9; padding: var(--pad); vertical-align: top; }
  .items th { background: #eef2f6; text-align: left; font-size: .92em; }
  .num { text-align: right; white-space: nowrap; }
  .totals { margin-left: auto; width: ${config.a4 ? '70mm' : '100%'}; margin-top: 8px; }
  .totals td { padding: 4px 0; }
  .totals .grand td { border-top: 2px solid #101418; font-weight: 700; font-size: 1.1em; padding-top: 6px; }
  .notes { margin-top: 12px; font-size: .86em; color: #333c46; }
  .sign { display: flex; justify-content: space-between; margin-top: 26px; font-size: .9em; }
  .sign div { border-top: 1px solid #101418; padding-top: 4px; min-width: 55mm; }
  .thermal { font-family: ui-monospace, "Courier New", monospace; font-size: 11px; line-height: 1.35; }
  .t-center { text-align: center; }
  .t-row { display: flex; justify-content: space-between; gap: 8px; }
  .t-meta { font-size: 9.5px; color: #333; }
  .t-line { margin: 4px 0; }
  .t-name { font-weight: 600; }
  .t-total { font-weight: 700; font-size: 13px; }
  hr { border: 0; border-top: 1px dashed #555; margin: 6px 0; }
  .tag { display: inline-block; border: 1px solid #101418; padding: 1px 6px; border-radius: 10px; font-size: .8em; }
  @media print { .sheet { padding: 0; } }
  ${pageRule}
</style>
</head>
<body>
<div class="sheet">
  ${
    config.a4 && !isCredit
      ? `<div class="head">
          <div>
            <div class="brand">${esc(document.supplierSnapshot?.tradeName || document.supplierSnapshot?.legalName)}</div>
            <div class="muted">${esc(document.supplierSnapshot?.legalName)}</div>
            <div class="muted">${esc(document.supplierSnapshot?.address || '')}</div>
            ${document.supplierSnapshot?.gstin ? `<div class="muted">GSTIN: ${esc(document.supplierSnapshot.gstin)}</div>` : '<div class="muted">GSTIN: not applicable / not configured</div>'}
          </div>
          <div class="title">${docTitle(document)}<div class="muted">${esc(document.number)}</div></div>
        </div>
        <div class="meta">
          <div>
            <strong>Billed to</strong>
            <div>${esc(document.partySnapshot?.name || 'Walk-in customer')}</div>
            ${document.partySnapshot?.address ? `<div class="muted">${esc(document.partySnapshot.address)}</div>` : ''}
            ${document.partySnapshot?.gstin ? `<div class="muted">GSTIN: ${esc(document.partySnapshot.gstin)}</div>` : '<div class="muted">Recipient GSTIN: not recorded</div>'}
            ${document.petSnapshot ? `<div class="muted">Pet: ${esc(document.petSnapshot.name)}${document.petSnapshot.species ? ` (${esc(document.petSnapshot.species)})` : ''}</div>` : ''}
          </div>
          <div>
            <div><strong>Invoice date:</strong> ${esc(document.businessDate)}</div>
            <div><strong>Place of supply:</strong> ${esc(document.placeOfSupplyStateCode || '—')} · ${esc(document.placeOfSupplyLabel || '')}</div>
            <div><strong>Cashier:</strong> ${esc(document.cashierName || '')}</div>
            <div><strong>Template:</strong> ${esc(document.templateVersion)}</div>
          </div>
        </div>
        ${a4Table(document)}
        ${a4Totals(document)}`
      : config.a4 && isCredit
        ? `<div class="head">
            <div>
              <div class="brand">${esc(document.partySnapshot?.name || 'Credit note')}</div>
              <div class="muted">Original invoice: ${esc(document.sourceNumber)}</div>
            </div>
            <div class="title">CREDIT NOTE<div class="muted">${esc(document.number)}</div></div>
          </div>
          <div class="meta">
            <div><strong>Date:</strong> ${esc(document.businessDate)}<br><strong>Reason:</strong> ${esc(document.reason)}</div>
            <div><strong>Commercial credit:</strong> ${money(totalCredit)}<br><strong>Restocked:</strong> ${document.restock ? 'Yes (approved)' : 'No (default)'}</div>
          </div>
          ${creditNoteBody(document)}`
        : thermalBody(document, config.label)
  }
  ${
    config.a4
      ? `<div class="notes">
          ${document.declaration ? `<div>${esc(document.declaration)}</div>` : ''}
          ${document.terms ? `<div>${esc(document.terms)}</div>` : ''}
          <div class="muted" style="margin-top:6px">
            This is a computer-generated document reproduced from the saved immutable snapshot (template ${esc(document.templateVersion)}).
            ${document.docKind === 'tax_invoice' ? 'No signature is printed unless the applicable rule permits it; authentic e-invoice/IRP particulars are not printed because no IRP integration is enabled.' : ''}
            ${document.docKind === 'credit_note' ? 'A credit note is not a refund; money movements are recorded separately.' : ''}
          </div>
        </div>
        <div class="sign"><div>Customer signature</div><div>For ${esc(document.supplierSnapshot?.tradeName || tenant?.tradeName || '')}</div></div>`
      : ''
  }
  <div class="muted" style="margin-top:10px">As-of settlement note: this document total is the original issued amount. Current dues are shown in the application, not on the original document. Printed ${esc(asOf || new Date().toISOString())} · Business date ${esc(businessDate(new Date()))}</div>
</div>
</body>
</html>`;
}

export { TEMPLATES };
