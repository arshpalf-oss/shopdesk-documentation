import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, inputToPaise, inputToScaled, inr, newIdempotencyKey, scaledToInput } from '../api.js';
import { useSession } from '../session.jsx';
import { Banner, Button, Card, Chip, ErrorNotice, Field, Input, Select, Textarea, useToast } from '../components.jsx';

const METHODS = [
  ['upi', 'UPI'],
  ['cash', 'Cash'],
  ['card', 'Card'],
  ['bank', 'Bank transfer'],
  ['cheque', 'Cheque'],
  ['other', 'Other'],
];

export default function Billing() {
  const { session, can } = useSession();
  const { push } = useToast();
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [pets, setPets] = useState([]);
  const [customerId, setCustomerId] = useState('');
  const [petId, setPetId] = useState('');
  const [lines, setLines] = useState([]);
  const [notes, setNotes] = useState('');
  const [draft, setDraft] = useState(null);
  const [quote, setQuote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [issued, setIssued] = useState(null);
  const [payment, setPayment] = useState({ method: 'upi', take: false, amount: '' });
  const [templates, setTemplates] = useState([]);
  const [template, setTemplate] = useState('corporate');
  const keyRef = useRef(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      api(`/products?search=${encodeURIComponent(search)}`)
        .then((data) => setProducts(data.products || []))
        .catch(() => {});
    }, 200);
    return () => clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    api('/customers').then((data) => setCustomers(data.customers || [])).catch(() => {});
    api('/documents?limit=1')
      .then((data) => setTemplates(data.templates || []))
      .catch(() => {});
    api('/templates').then((data) => setTemplates(data.templates || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!customerId) {
      setPets([]);
      setPetId('');
      return;
    }
    api(`/pets?customerId=${customerId}`)
      .then((data) => setPets(data.pets || []))
      .catch(() => setPets([]));
  }, [customerId]);

  function addProduct(product) {
    setIssued(null);
    setLines((prev) => {
      const existing = prev.findIndex((l) => l.productId === product.id);
      if (existing >= 0 && product.quantityScale === 0) {
        const copy = [...prev];
        const line = copy[existing];
        copy[existing] = { ...line, quantity: String(Number(line.quantity || '0') + 1) };
        return copy;
      }
      return [
        ...prev,
        {
          key: `${product.id}-${Math.random().toString(36).slice(2, 7)}`,
          productId: product.id,
          name: product.name,
          hsn: product.hsn,
          uom: product.uom,
          quantityScale: product.quantityScale ?? 0,
          quantity: '1',
          priceMode: product.priceMode,
          salePricePaise: product.salePricePaise,
          taxRateBps: product.taxRateBps,
          taxTreatment: product.taxTreatment,
          availableScaled: product.availableScaled,
          discount: '',
        },
      ];
    });
  }

  function updateLine(key, patch) {
    setIssued(null);
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key) {
    setIssued(null);
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  const payloadLines = useMemo(
    () =>
      lines.map((line) => {
        const out = {
          productId: line.productId,
          quantityScaled: inputToScaledSafely(line.quantity, line.quantityScale),
        };
        if (line.discount && line.discount.trim()) out.discountPaise = inputToPaiseSafely(line.discount);
        if (line.priceOverride && line.priceOverride.trim()) out.unitPricePaise = inputToPaiseSafely(line.priceOverride);
        return out;
      }),
    [lines]
  );

  async function quoteNow() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        branchId: session.branch?.id,
        customerId: customerId || null,
        petId: petId || null,
        notes: notes || null,
        lines: payloadLines,
      };
      let data;
      if (draft?.id) {
        data = await api(`/sales-drafts/${draft.id}`, { method: 'PUT', body: { ...body, version: draft.version } });
      } else {
        data = await api('/sales-drafts', { method: 'POST', body });
      }
      setDraft({ id: data.draft.id, version: data.draft.version });
      setQuote(data);
      return data;
    } catch (err) {
      setError(err);
      setQuote(null);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function issue() {
    if (!quote) return;
    setBusy(true);
    setError(null);
    if (!keyRef.current) keyRef.current = newIdempotencyKey('billing');
    try {
      const paymentBody = payment.take
        ? {
            method: payment.method,
            amountPaise: payment.amount.trim() ? inputToPaiseSafely(payment.amount) : quote.quote.totals.totalPaise,
          }
        : null;
      const result = await api(`/sales-drafts/${quote.draft.id}/finalize`, {
        method: 'POST',
        idempotencyKey: keyRef.current,
        body: { version: quote.draft.version, quoteHash: quote.quoteHash, payment: paymentBody },
      });
      setIssued({ ...result, quoteSnapshot: quote });
      setDraft(null);
      setQuote(null);
      keyRef.current = null;
      push(`Issued ${result.number}`, 'info');
    } catch (err) {
      setError(err);
      // Reflect a changed quote instead of pretending the old total was charged.
      if (err.code === 'QUOTE_CHANGED' || err.code === 'DRAFT_VERSION_CONFLICT') {
        await quoteNow();
      }
    } finally {
      setBusy(false);
    }
  }

  function resetSale() {
    setLines([]);
    setQuote(null);
    setDraft(null);
    setNotes('');
    setIssued(null);
    setPayment({ method: 'upi', take: false, amount: '' });
    setSearch('');
    keyRef.current = null;
  }

  const blockers = (quote?.blockers || []).filter((b) => b.severity !== 'info');
  const infoNotes = (quote?.blockers || []).filter((b) => b.severity === 'info');
  const selectedCustomer = customers.find((c) => c._id === customerId);

  return (
    <div className="pos">
      <div>
        {issued ? (
          <Card title={`Bill ${issued.number} issued`} subtitle={`${issued.docKind === 'tax_invoice' ? 'Tax invoice' : 'Bill of supply'} · ${inr(issued.totals?.totalPaise)}`}>
            <p className="muted small">
              The document is final. Its numbering, snapshot and journal are immutable; corrections are separate linked events.
              Reprinting does not change any balance.
            </p>
            <div className="grid grid-2" style={{ marginTop: '0.7rem' }}>
              <Field label="Print template">
                <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
                  {(templates.length ? templates : [{ key: 'corporate', label: 'Corporate A4' }]).map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label} {t.version ? `(${t.version})` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="row gap-s" style={{ alignItems: 'flex-end' }}>
                <Button variant="secondary" onClick={() => window.open(`/api/v1/documents/${issued.documentId}/print?template=${template}`, '_blank', 'noopener')}>
                  Open print view
                </Button>
                <Link to={`/documents/${issued.documentId}`}>
                  <Button variant="ghost">Document details</Button>
                </Link>
              </div>
            </div>
            <div className="row gap-s" style={{ marginTop: '0.8rem' }}>
              <Button onClick={resetSale}>New bill</Button>
              {can('documents.read') && <Link to="/returns"><Button variant="ghost">Return / credit note</Button></Link>}
            </div>
          </Card>
        ) : (
          <>
            <Card title="Add products and services" subtitle="Stock is not reserved by a quote; availability is checked again at issue.">
              <Field label="Search catalogue" hint="Name, SKU, barcode, category or HSN">
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Start typing…" autoFocus />
              </Field>
              <div className="product-list">
                {products.map((product) => (
                  <button type="button" key={product.id} className="product-hit" onClick={() => addProduct(product)}>
                    <span>
                      <strong>{product.name}</strong>
                      <span className="muted small"> · {product.category || 'General'} · {product.hsn || 'no HSN'}</span>
                    </span>
                    <span className="row gap-s">
                      <span className="muted small">
                        {product.kind === 'goods' ? `${scaledToInput(product.availableScaled, product.quantityScale)} ${product.uom} in stock` : 'service'}
                      </span>
                      <span className="mono">{inr(product.salePricePaise)}</span>
                    </span>
                  </button>
                ))}
                {products.length === 0 && <p className="empty">No matching products.</p>}
              </div>
            </Card>

            <Card title="Bill lines" subtitle="Discounts apply before tax. Prices are exact in paise.">
              {lines.length === 0 ? (
                <p className="empty">Add at least one line to quote the bill.</p>
              ) : (
                <>
                  {lines.map((line) => (
                    <div className="line-row" key={line.key}>
                      <div>
                        <strong className="small">{line.name}</strong>
                        <div className="muted tiny">
                          {line.taxTreatment === 'taxable' ? `${Number(line.taxRateBps) / 100}% GST` : line.taxTreatment.replace('_', ' ')} ·{' '}
                          {line.priceMode === 'inclusive' ? 'price incl. tax' : 'price excl. tax'}
                        </div>
                        <Input
                          aria-label={`Price override for ${line.name}`}
                          placeholder={`${inr(line.salePricePaise)} override`}
                          value={line.priceOverride || ''}
                          onChange={(e) => updateLine(line.key, { priceOverride: e.target.value })}
                        />
                      </div>
                      <Field label={`Qty (${line.uom})`}>
                        <Input
                          value={line.quantity}
                          onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                          inputMode="decimal"
                        />
                      </Field>
                      <Field label="Discount ₹">
                        <Input value={line.discount} onChange={(e) => updateLine(line.key, { discount: e.target.value })} inputMode="decimal" placeholder="0.00" />
                      </Field>
                      <Button variant="ghost" size="sm" onClick={() => removeLine(line.key)} aria-label={`Remove ${line.name}`}>
                        Remove
                      </Button>
                    </div>
                  ))}
                  <div className="grid grid-form" style={{ marginTop: '0.5rem' }}>
                    <Field label="Customer" hint="Leave empty for an unregistered counter sale.">
                      <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                        <option value="">Walk-in / no customer</option>
                        {customers.map((c) => (
                          <option key={c._id} value={c._id}>
                            {c.name}
                            {c.phone ? ` · ${c.phone}` : ''}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Pet" hint="Billing identifier only; no clinical record is stored.">
                      <Select value={petId} onChange={(e) => setPetId(e.target.value)} disabled={!pets.length}>
                        <option value="">Not specified</option>
                        {pets.map((p) => (
                          <option key={p._id} value={p._id}>
                            {p.name} {p.species ? `(${p.species})` : ''}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label="Notes on the bill">
                    <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
                  </Field>
                  <div className="row gap-s">
                    <Button onClick={quoteNow} busy={busy} disabled={!lines.length}>
                      {quote ? 'Recalculate quote' : 'Get quote'}
                    </Button>
                    {quote && <Button variant="ghost" onClick={resetSale}>Clear</Button>}
                  </div>
                </>
              )}
            </Card>
          </>
        )}

        <ErrorNotice error={error} onDismiss={() => setError(null)} />
      </div>

      <div className="pos-cart">
        <Card title="Quote" subtitle={selectedCustomer ? selectedCustomer.name : 'Walk-in counter sale'}>
          {!quote ? (
            <p className="empty">Build the lines and press “Get quote”. Totals, GST split and stock checks are computed on the server.</p>
          ) : (
            <>
              {blockers.length > 0 && (
                <Banner tone="legal" title="This bill cannot be issued yet">
                  <ul className="blocker-list">
                    {blockers.map((b, i) => (
                      <li key={i}>
                        <code>{b.code}</code> {b.message}
                      </li>
                    ))}
                  </ul>
                </Banner>
              )}
              {infoNotes.length > 0 && (
                <Banner tone="info" title="Notes">
                  {infoNotes.map((b) => (
                    <p key={b.code} className="small">
                      {b.message}
                    </p>
                  ))}
                </Banner>
              )}

              <div className="totals">
                <div className="t-row">
                  <span className="muted">Document type</span>
                  <Chip tone={quote.quote.docKind === 'tax_invoice' ? 'info' : 'neutral'}>
                    {quote.quote.docKind === 'tax_invoice' ? 'Tax invoice' : 'Bill of supply'}
                  </Chip>
                </div>
                <div className="t-row">
                  <span className="muted">Taxable value</span>
                  <span className="mono">{inr(quote.quote.totals.taxableValuePaise)}</span>
                </div>
                <div className="t-row">
                  <span className="muted">CGST</span>
                  <span className="mono">{inr(quote.quote.totals.cgstPaise)}</span>
                </div>
                <div className="t-row">
                  <span className="muted">SGST</span>
                  <span className="mono">{inr(quote.quote.totals.sgstPaise)}</span>
                </div>
                {BigInt(quote.quote.totals.igstPaise) > 0n && (
                  <div className="t-row">
                    <span className="muted">IGST</span>
                    <span className="mono">{inr(quote.quote.totals.igstPaise)}</span>
                  </div>
                )}
                {BigInt(quote.quote.totals.roundOffPaise) !== 0n && (
                  <div className="t-row">
                    <span className="muted">Component round-off</span>
                    <span className="mono">{inr(quote.quote.totals.roundOffPaise, { sign: true })}</span>
                  </div>
                )}
                <div className="t-row total">
                  <span>Total payable</span>
                  <span className="mono">{inr(quote.quote.totals.totalPaise)}</span>
                </div>
              </div>

              <div style={{ marginTop: '0.8rem' }}>
                <label className="row gap-s small">
                  <input type="checkbox" checked={payment.take} onChange={(e) => setPayment({ ...payment, take: e.target.checked })} />
                  Record money received now
                </label>
                {payment.take && (
                  <div className="grid grid-form" style={{ marginTop: '0.45rem' }}>
                    <Field label="Method">
                      <Select value={payment.method} onChange={(e) => setPayment({ ...payment, method: e.target.value })}>
                        {METHODS.map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Amount ₹" hint="Leave blank to record the full total.">
                      <Input value={payment.amount} onChange={(e) => setPayment({ ...payment, amount: e.target.value })} inputMode="decimal" placeholder={inr(quote.quote.totals.totalPaise)} />
                    </Field>
                  </div>
                )}
                <p className="tiny muted">
                  Cash receipts of ₹2,00,000 or more (or aggregating to it for one payer in a day) are blocked as a legal gate.
                </p>
              </div>

              <Button block style={{ marginTop: '0.6rem' }} onClick={issue} busy={busy} disabled={blockers.length > 0}>
                Issue {quote.quote.docKind === 'tax_invoice' ? 'tax invoice' : 'bill of supply'}
              </Button>
              <p className="tiny muted" style={{ marginTop: '0.4rem' }}>
                The number is assigned server-side at commit. This screen never shows a number before the server confirms it.
              </p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function inputToScaledSafely(value, scale) {
  try {
    return inputToScaled(value, scale);
  } catch {
    return '0';
  }
}

function inputToPaiseSafely(value) {
  try {
    return inputToPaise(value);
  } catch {
    return '0';
  }
}
