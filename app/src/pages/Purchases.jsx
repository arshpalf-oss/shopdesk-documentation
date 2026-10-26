import React, { useEffect, useMemo, useState } from 'react';
import { api, inr, inputToPaise, inputToScaled, newIdempotencyKey, scaledToInput } from '../api.js';
import { useSession } from '../session.jsx';
import { Banner, Button, Card, Chip, ErrorNotice, Field, Input, Loading, Modal, Select, Table, useAsync, useToast } from '../components.jsx';

export default function Purchases() {
  const { can, session } = useSession();
  const { push } = useToast();
  const purchases = useAsync(() => api('/purchases'), []);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reviewFor, setReviewFor] = useState(null);
  const [reviewForm, setReviewForm] = useState({ status: 'eligible', evidence: '' });
  const [returnFor, setReturnFor] = useState(null);
  const [returnForm, setReturnForm] = useState({ reason: '', lines: [] });
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    supplierId: '',
    supplierInvoiceNo: '',
    supplierInvoiceDate: today,
    lines: [],
  });

  useEffect(() => {
    api('/suppliers').then((d) => setSuppliers(d.suppliers || [])).catch(() => {});
    api('/products').then((d) => setProducts(d.products || [])).catch(() => {});
  }, []);

  const goods = useMemo(() => products.filter((p) => p.kind === 'goods'), [products]);

  function addLine() {
    setForm((prev) => ({
      ...prev,
      lines: [
        ...prev.lines,
        { key: Math.random().toString(36).slice(2), productId: '', quantity: '', taxable: '', rate: '12', cgst: '', sgst: '', igst: '', batchNo: '', expiry: '', coldChain: true },
      ],
    }));
  }

  function updateLine(key, patch) {
    setForm((prev) => ({ ...prev, lines: prev.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));
  }

  function computeTax(line) {
    const taxable = Number(line.taxable || 0);
    const rate = Number(line.rate || 0) / 100;
    if (!taxable || !rate) return { cgst: '0', sgst: '0' };
    const paise = Math.round(taxable * 100 * rate);
    // Supplied as an exact integer paise string; the server still requires the
    // numbers to match the paper bill, so the operator is expected to correct them.
    const half = Math.round(paise / 2);
    return { cgst: String(half), sgst: String(paise - half) };
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        branchId: session?.branch?.id,
        supplierId: form.supplierId,
        supplierInvoiceNo: form.supplierInvoiceNo,
        supplierInvoiceDate: form.supplierInvoiceDate,
        lines: form.lines.map((line) => {
          const product = goods.find((p) => p.id === line.productId);
          const tax = computeTax(line);
          const item = {
            productId: line.productId,
            quantityScaled: inputToScaled(line.quantity, product?.quantityScale ?? 0),
            taxableValuePaise: inputToPaise(line.taxable || '0'),
            cgstPaise: line.cgst ? inputToPaise(line.cgst) : tax.cgst,
            sgstPaise: line.sgst ? inputToPaise(line.sgst) : tax.sgst,
            igstPaise: line.igst ? inputToPaise(line.igst) : '0',
            batchNo: line.batchNo || null,
            coldChainVerified: line.coldChain !== false,
          };
          if (line.expiry) item.expiry = { precision: 'date', date: line.expiry };
          return item;
        }),
      };
      await api('/purchases', { method: 'POST', idempotencyKey: newIdempotencyKey('purchase'), body });
      push('Supplier bill posted; batches received');
      setOpen(false);
      setForm({ supplierId: '', supplierInvoiceNo: '', supplierInvoiceDate: today, lines: [] });
      purchases.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitReview(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/purchases/${reviewFor._id}/itc-review`, { method: 'POST', body: reviewForm });
      push('Input-tax review recorded');
      setReviewFor(null);
      purchases.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitSupplierReturn(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/supplier-returns', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('supplier-return'),
        body: {
          purchaseId: returnFor._id,
          reason: returnForm.reason,
          lines: returnForm.lines
            .filter((l) => l.quantity && Number(l.quantity) > 0)
            .map((l) => ({ lineId: l.lineId, quantityScaled: l.quantityScaled })),
        },
      });
      push('Supplier return recorded');
      setReturnFor(null);
      purchases.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card
        title="Supplier bills"
        subtitle="Stock is received against the genuine supplier bill. Input tax stays pending until reviewed."
        actions={
          <div className="row gap-s">
            <Button size="sm" variant="ghost" onClick={purchases.reload}>
              Refresh
            </Button>
            {can('purchases.manage') && <Button size="sm" onClick={() => { setError(null); setOpen(true); }}>Record supplier bill</Button>}
          </div>
        }
      >
        {purchases.loading ? (
          <Loading />
        ) : (
          <>
            <ErrorNotice error={purchases.error} />
            <Table
              columns={[
                { key: 'number', label: 'Our ref', render: (p) => <span className="mono">{p.number}</span> },
                { key: 'supplierSnapshot', label: 'Supplier', render: (p) => p.supplierSnapshot?.name },
                { key: 'supplierInvoiceNo', label: 'Supplier bill', render: (p) => <span className="mono">{p.supplierInvoiceNo}</span> },
                { key: 'supplierInvoiceDate', label: 'Bill date' },
                { key: 'total', label: 'Total', align: 'right', render: (p) => <span className="mono">{inr(p.totals?.totalPaise)}</span> },
                { key: 'itcStatus', label: 'Input tax', render: (p) => <Chip tone={p.itcStatus === 'pending_review' ? 'warn' : 'neutral'}>{p.itcStatus || 'pending_review'}</Chip> },
                {
                  key: 'actions',
                  label: '',
                  render: (p) => (
                    <div className="row gap-s">
                      <Button size="sm" variant="ghost" onClick={() => { setError(null); setDetail(p); }}>
                        View
                      </Button>
                      {can('purchases.review_tax') && (
                        <Button size="sm" variant="ghost" onClick={() => { setError(null); setReviewForm({ status: 'eligible', evidence: '' }); setReviewFor(p); }}>
                          ITC review
                        </Button>
                      )}
                      {can('purchases.manage') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setError(null);
                            setReturnForm({
                              reason: '',
                              lines: p.lines.map((l) => ({ lineId: l.lineId, name: l.productSnapshot?.name, quantity: '', quantityScale: l.quantityScale ?? 0 })),
                            });
                            setReturnFor(p);
                          }}
                        >
                          Return
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
              rows={purchases.data?.purchases || []}
              rowKey={(p) => p._id}
              empty="No supplier bills yet."
            />
            {purchases.data?.quantityOnly && <p className="muted small">Cost values are withheld for your role.</p>}
          </>
        )}
      </Card>

      {open && (
        <Modal title="Record supplier bill" onClose={() => setOpen(false)} wide>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <Banner tone="info" title="Copy the actual bill">
            Tax components must match the supplier's bill. The helper below only computes a starting point; correct it before posting.
            A duplicate supplier bill for the same FY is refused.
          </Banner>
          <form onSubmit={submit} className="col gap">
            <div className="grid grid-form">
              <Field label="Supplier" required>
                <Select value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} required>
                  <option value="">Select supplier</option>
                  {suppliers.map((s) => (
                    <option key={s._id} value={s._id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Supplier bill number" required>
                <Input value={form.supplierInvoiceNo} onChange={(e) => setForm({ ...form, supplierInvoiceNo: e.target.value })} required />
              </Field>
              <Field label="Bill date" required>
                <Input type="date" value={form.supplierInvoiceDate} onChange={(e) => setForm({ ...form, supplierInvoiceDate: e.target.value })} required />
              </Field>
            </div>

            {form.lines.map((line) => (
              <div key={line.key} className="card" style={{ marginBottom: 0 }}>
                <div className="grid grid-form">
                  <Field label="Product" required>
                    <Select value={line.productId} onChange={(e) => updateLine(line.key, { productId: e.target.value })} required>
                      <option value="">Select</option>
                      {goods.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Quantity" required>
                    <Input value={line.quantity} onChange={(e) => updateLine(line.key, { quantity: e.target.value })} inputMode="decimal" required />
                  </Field>
                  <Field label="Taxable value ₹" required>
                    <Input value={line.taxable} onChange={(e) => updateLine(line.key, { taxable: e.target.value })} inputMode="decimal" required />
                  </Field>
                  <Field label="GST rate %">
                    <Select value={line.rate} onChange={(e) => updateLine(line.key, { rate: e.target.value })}>
                      {['0', '0.25', '3', '5', '12', '18', '28'].map((r) => (
                        <option key={r} value={r}>
                          {r}%
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="CGST ₹" hint="From the bill">
                    <Input value={line.cgst} onChange={(e) => updateLine(line.key, { cgst: e.target.value })} inputMode="decimal" placeholder="auto" />
                  </Field>
                  <Field label="SGST ₹" hint="Must equal CGST for intra-state">
                    <Input value={line.sgst} onChange={(e) => updateLine(line.key, { sgst: e.target.value })} inputMode="decimal" placeholder="auto" />
                  </Field>
                  <Field label="IGST ₹">
                    <Input value={line.igst} onChange={(e) => updateLine(line.key, { igst: e.target.value })} inputMode="decimal" placeholder="0.00" />
                  </Field>
                  <Field label="Batch number" required>
                    <Input value={line.batchNo} onChange={(e) => updateLine(line.key, { batchNo: e.target.value })} required />
                  </Field>
                  <Field label="Expiry" required hint="Date precision keeps FEFO honest.">
                    <Input type="date" value={line.expiry} onChange={(e) => updateLine(line.key, { expiry: e.target.value })} required />
                  </Field>
                  <Field label="Cold chain verified">
                    <Select value={line.coldChain ? 'yes' : 'no'} onChange={(e) => updateLine(line.key, { coldChain: e.target.value === 'yes' })}>
                      <option value="yes">Verified</option>
                      <option value="no">Not verified</option>
                    </Select>
                  </Field>
                </div>
              </div>
            ))}

            <div className="row gap-s">
              <Button type="button" variant="secondary" size="sm" onClick={addLine}>
                Add line
              </Button>
              <Button type="submit" busy={busy} disabled={form.lines.length === 0}>
                Post bill and receive stock
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {reviewFor && (
        <Modal title={`Input-tax review — ${reviewFor.supplierInvoiceNo}`} onClose={() => setReviewFor(null)}>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <p className="muted small">
            Components: CGST {inr(reviewFor.totals?.cgstPaise)} · SGST {inr(reviewFor.totals?.sgstPaise)} · IGST {inr(reviewFor.totals?.igstPaise)}
          </p>
          <form onSubmit={submitReview} className="col gap">
            <Field label="Decision">
              <Select value={reviewForm.status} onChange={(e) => setReviewForm({ ...reviewForm, status: e.target.value })}>
                <option value="eligible">Eligible input tax credit</option>
                <option value="ineligible">Ineligible</option>
                <option value="pending_review">Keep pending</option>
              </Select>
            </Field>
            <Field label="Evidence / reason" required>
              <Input value={reviewForm.evidence} onChange={(e) => setReviewForm({ ...reviewForm, evidence: e.target.value })} minLength={8} required />
            </Field>
            <Button type="submit" busy={busy}>
              Record review
            </Button>
          </form>
        </Modal>
      )}

      {returnFor && (
        <Modal title={`Supplier return — ${returnFor.number}`} onClose={() => setReturnFor(null)}>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <form onSubmit={submitSupplierReturn} className="col gap">
            {returnFor.lines.map((line, index) => (
              <div key={line.lineId} className="row gap">
                <span className="grow small">
                  {line.productSnapshot?.name} · received{' '}
                  {scaledToInput(line.quantityScaled, line.quantityScale ?? 0)}
                </span>
                <Input
                  style={{ width: 100 }}
                  value={returnForm.lines[index]?.quantity || ''}
                  onChange={(e) => {
                    const next = returnForm.lines.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l));
                    const quantityScaled = (() => {
                      try {
                        return inputToScaled(e.target.value || '0', line.quantityScale ?? 0);
                      } catch {
                        return '0';
                      }
                    })();
                    next[index].quantityScaled = quantityScaled;
                    setReturnForm({ ...returnForm, lines: next });
                  }}
                  placeholder="Qty"
                  inputMode="decimal"
                  aria-label={`Return quantity for ${line.productSnapshot?.name}`}
                />
              </div>
            ))}
            <Field label="Reason" required>
              <Input value={returnForm.reason} onChange={(e) => setReturnForm({ ...returnForm, reason: e.target.value })} minLength={5} required />
            </Field>
            <Button type="submit" variant="secondary" busy={busy}>
              Send back to supplier
            </Button>
          </form>
        </Modal>
      )}

      {detail && (
        <Modal title={`Supplier bill ${detail.number}`} onClose={() => setDetail(null)} wide>
          <dl className="kv">
            <dt>Supplier</dt>
            <dd>{detail.supplierSnapshot?.name}</dd>
            <dt>Supplier bill</dt>
            <dd className="mono">{detail.supplierInvoiceNo}</dd>
            <dt>Bill date</dt>
            <dd>{detail.supplierInvoiceDate}</dd>
            <dt>Total</dt>
            <dd className="mono">{inr(detail.totals?.totalPaise)}</dd>
          </dl>
          <Table
            dense
            columns={[
              { key: 'name', label: 'Item', render: (l) => l.productSnapshot?.name },
              { key: 'batchNo', label: 'Batch' },
              { key: 'qty', label: 'Qty', align: 'right', render: (l) => scaledToInput(l.quantityScaled, l.quantityScale ?? 0) },
              { key: 'taxableValuePaise', label: 'Taxable', align: 'right', render: (l) => <span className="mono">{inr(l.taxableValuePaise)}</span> },
              { key: 'tax', label: 'GST', align: 'right', render: (l) => <span className="mono">{inr(l.cgstPaise)} + {inr(l.sgstPaise)}</span> },
            ]}
            rows={detail.lines}
            rowKey={(l) => l.lineId}
          />
        </Modal>
      )}
    </>
  );
}
