import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, inr, inputToPaise, newIdempotencyKey, scaledToInput } from '../api.js';
import { useSession } from '../session.jsx';
import { Banner, Button, Card, Chip, ErrorNotice, Field, Input, Loading, Modal, Select, Table, useAsync, useToast } from '../components.jsx';

const PRESETS = [
  ['all', 'All time'],
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['month', 'This month'],
  ['last_month', 'Last month'],
  ['fy', 'This financial year'],
];

export default function Documents() {
  const navigate = useNavigate();
  const [preset, setPreset] = useState('all');
  const [search, setSearch] = useState('');
  const { data, error, loading, reload } = useAsync(() => api(`/documents?preset=${preset}`), [preset]);

  const rows = useMemo(() => {
    const list = data?.documents || [];
    if (!search.trim()) return list;
    const needle = search.toLowerCase();
    return list.filter((d) =>
      [d.number, d.partySnapshot?.name, d.cashierName, d.docKind, d.businessDate].filter(Boolean).some((v) => String(v).toLowerCase().includes(needle))
    );
  }, [data, search]);

  return (
    <>
      <Card
        title="Issued documents"
        subtitle="A reprint never changes a balance. Credit notes are separate documents, not edits."
        actions={
          <Button variant="ghost" size="sm" onClick={reload}>
            Refresh
          </Button>
        }
      >
        <div className="row gap-s" style={{ marginBottom: '0.6rem', flexWrap: 'wrap' }}>
          <Select value={preset} onChange={(e) => setPreset(e.target.value)} style={{ width: 180 }} aria-label="Period">
            {PRESETS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Input placeholder="Search number, party or cashier" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 280 }} />
          <span className="muted small">{rows.length} document(s)</span>
        </div>
        <ErrorNotice error={error} />
        {loading ? (
          <Loading />
        ) : (
          <Table
            columns={[
              {
                key: 'number',
                label: 'Number',
                render: (row) => (
                  <Link to={`/documents/${row._id}`} className="mono">
                    {row.number}
                  </Link>
                ),
              },
              { key: 'businessDate', label: 'Date' },
              { key: 'docKind', label: 'Type', render: (row) => (row.docKind === 'tax_invoice' ? 'Tax invoice' : 'Bill of supply') },
              { key: 'partySnapshot', label: 'Party', render: (row) => row.partySnapshot?.name || 'Walk-in' },
              { key: 'cashierName', label: 'Cashier' },
              { key: 'total', label: 'Total', align: 'right', render: (row) => <span className="mono">{inr(row.totals?.totalPaise)}</span> },
              { key: 'status', label: 'Status', render: (row) => <Chip tone={row.status === 'issued' ? 'good' : 'neutral'}>{row.status}</Chip> },
            ]}
            rows={rows}
            rowKey={(row) => row._id}
            onRowClick={(row) => navigate(`/documents/${row._id}`)}
            empty="No documents in this period."
          />
        )}
      </Card>
    </>
  );
}

export function DocumentDetail() {
  const { id } = useParams();
  const { can, tenant } = useSession();
  const { push } = useToast();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useAsync(() => api(`/documents/${id}`), [id]);
  const [templates, setTemplates] = useState([]);
  const [template, setTemplate] = useState('corporate');
  const [payOpen, setPayOpen] = useState(false);
  const [payForm, setPayForm] = useState({ amount: '', method: 'upi', reference: '' });
  const [payError, setPayError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [settlement, setSettlement] = useState(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundForm, setRefundForm] = useState({ amount: '', method: 'cash', reason: '' });

  useEffect(() => {
    api('/templates').then((d) => setTemplates(d.templates || [])).catch(() => {});
  }, []);

  useEffect(() => {
    api(`/documents/${id}/settlement`)
      .then(setSettlement)
      .catch(() => setSettlement(null));
  }, [id, data]);

  if (loading) return <Loading />;
  if (error) return <ErrorNotice error={error} />;
  const doc = data.document;

  async function recordPayment(event) {
    event.preventDefault();
    setBusy(true);
    setPayError(null);
    try {
      const body = {
        documentId: doc._id,
        method: payForm.method,
        amountPaise: payForm.amount.trim() ? inputToPaise(payForm.amount) : settlement?.duePaise || doc.totals.totalPaise,
      };
      if (payForm.reference.trim()) body.reference = payForm.reference.trim();
      const result = await api('/payments', { method: 'POST', body, idempotencyKey: newIdempotencyKey('receipt') });
      push(`Receipt ${result.payment?.number || result.number || ''} recorded`);
      setPayOpen(false);
      setPayForm({ amount: '', method: 'upi', reference: '' });
      reload();
    } catch (err) {
      setPayError(err);
    } finally {
      setBusy(false);
    }
  }

  async function recordRefund(event) {
    event.preventDefault();
    setBusy(true);
    setPayError(null);
    try {
      const result = await api('/refunds', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('refund'),
        body: {
          documentId: doc._id,
          amountPaise: inputToPaise(refundForm.amount),
          method: refundForm.method,
          reason: refundForm.reason,
        },
      });
      push(`Refund ${result.number || result.refund?.number || ''} recorded`);
      setRefundOpen(false);
      reload();
    } catch (err) {
      setPayError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row gap-s" style={{ marginBottom: '0.7rem' }}>
        <Button variant="ghost" size="sm" onClick={() => navigate('/documents')}>
          ← All documents
        </Button>
        <span className="mono">{doc.number}</span>
        <Chip tone="info">{doc.docKind === 'tax_invoice' ? 'Tax invoice' : 'Bill of supply'}</Chip>
        <Chip tone={doc.status === 'issued' ? 'good' : 'bad'}>{doc.status}</Chip>
      </div>

      <div className="grid grid-2">
        <Card title="Document">
          <dl className="kv">
            <dt>Issued at</dt>
            <dd>{new Date(doc.issuedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</dd>
            <dt>Business date</dt>
            <dd>{doc.businessDate}</dd>
            <dt>Series / FY</dt>
            <dd className="mono">
              {doc.series} · {doc.fy}
            </dd>
            <dt>Cashier</dt>
            <dd>{doc.cashierName}</dd>
            <dt>Customer</dt>
            <dd>{doc.partySnapshot?.name || 'Walk-in customer'}</dd>
            {doc.partySnapshot?.gstin && (
              <>
                <dt>Customer GSTIN</dt>
                <dd className="mono">{doc.partySnapshot.gstin}</dd>
              </>
            )}
            {doc.petSnapshot && (
              <>
                <dt>Pet (billing id)</dt>
                <dd>
                  {doc.petSnapshot.name} {doc.petSnapshot.species ? `· ${doc.petSnapshot.species}` : ''}
                </dd>
              </>
            )}
            <dt>Place of supply</dt>
            <dd>
              {doc.placeOfSupplyLabel || doc.placeOfSupplyStateCode} ({doc.supplyMode})
            </dd>
            <dt>Template</dt>
            <dd>{doc.templateVersion}</dd>
          </dl>
        </Card>

        <Card title="Money">
          <div className="totals">
            <div className="t-row">
              <span className="muted">Taxable value</span>
              <span className="mono">{inr(doc.totals.taxableValuePaise)}</span>
            </div>
            <div className="t-row">
              <span className="muted">CGST</span>
              <span className="mono">{inr(doc.totals.cgstPaise)}</span>
            </div>
            <div className="t-row">
              <span className="muted">SGST</span>
              <span className="mono">{inr(doc.totals.sgstPaise)}</span>
            </div>
            {BigInt(doc.totals.igstPaise) > 0n && (
              <div className="t-row">
                <span className="muted">IGST</span>
                <span className="mono">{inr(doc.totals.igstPaise)}</span>
              </div>
            )}
            {BigInt(doc.totals.discountPaise) > 0n && (
              <div className="t-row">
                <span className="muted">Discounts</span>
                <span className="mono">{inr(doc.totals.discountPaise)}</span>
              </div>
            )}
            <div className="t-row total">
              <span>Invoice total</span>
              <span className="mono">{inr(doc.totals.totalPaise)}</span>
            </div>
            {settlement && (
              <>
                <div className="t-row">
                  <span className="muted">Confirmed received</span>
                  <span className="mono">{inr(settlement.netReceivedPaise)}</span>
                </div>
                <div className="t-row">
                  <span className="muted">Credited (returns)</span>
                  <span className="mono">{inr(settlement.creditPaise)}</span>
                </div>
                <div className={`t-row ${BigInt(settlement.duePaise) > 0n ? 'due' : ''}`}>
                  <span>Balance due</span>
                  <span className="mono">{inr(settlement.duePaise)}</span>
                </div>
                <div className="t-row">
                  <span className="muted">Refund entitlement</span>
                  <span className="mono">{inr(settlement.refundablePaise)}</span>
                </div>
              </>
            )}
          </div>
          <div className="row gap-s" style={{ marginTop: '0.7rem', flexWrap: 'wrap' }}>
            {can('payments.record') && settlement && BigInt(settlement.duePaise) > 0n && (
              <Button size="sm" onClick={() => setPayOpen(true)}>
                Record receipt
              </Button>
            )}
            {can('payments.refund') && settlement && BigInt(settlement.refundablePaise) > 0n && (
              <Button size="sm" variant="secondary" onClick={() => setRefundOpen(true)}>
                Refund customer
              </Button>
            )}
            {can('returns.create') && (
              <Link to={`/returns?documentId=${doc._id}`}>
                <Button size="sm" variant="ghost">
                  Return / credit note
                </Button>
              </Link>
            )}
          </div>
        </Card>
      </div>

      <Card title="Lines" subtitle="Prices, tax components and cost are immutable snapshots taken at issue.">
        <Table
          dense
          columns={[
            { key: 'name', label: 'Item', render: (l) => l.product?.name || l.productName || l.name },
            { key: 'hsn', label: 'HSN/SAC', render: (l) => l.product?.hsn || '—' },
            {
              key: 'qty',
              label: 'Qty',
              align: 'right',
              render: (l) => `${scaledToInput(l.quantityScaled, l.quantityScale ?? 0)} ${l.uom || ''}`,
            },
            { key: 'rate', label: 'Rate', align: 'right', render: (l) => <span className="mono">{inr(l.unitPricePaise)}</span> },
            { key: 'taxable', label: 'Taxable', align: 'right', render: (l) => <span className="mono">{inr(l.taxableValuePaise)}</span> },
            {
              key: 'gst',
              label: 'CGST + SGST / IGST',
              align: 'right',
              render: (l) => (
                <span className="mono">
                  {inr(l.cgstPaise)} + {inr(l.sgstPaise)}
                  {BigInt(l.igstPaise) > 0n ? ` / ${inr(l.igstPaise)}` : ''}
                </span>
              ),
            },
            { key: 'total', label: 'Line total', align: 'right', render: (l) => <span className="mono">{inr(l.lineTotalPaise)}</span> },
            ...(data.canSeeCost
              ? [{ key: 'cost', label: 'Cost', align: 'right', render: (l) => <span className="mono">{inr(l.costPaise)}</span> }]
              : []),
          ]}
          rows={doc.lines}
          rowKey={(l) => l.lineId}
        />
        {data.canSeeCost && (
          <details style={{ marginTop: '0.5rem' }}>
            <summary className="muted small">Batch allocations (FEFO)</summary>
            <Table
              dense
              columns={[
                { key: 'batchNo', label: 'Batch' },
                { key: 'expiry', label: 'Expiry', render: (b) => b.expiry?.date || b.expiry?.year || '—' },
                { key: 'quantityScaled', label: 'Qty', align: 'right' },
                { key: 'costPaise', label: 'Allocated cost', align: 'right', render: (b) => <span className="mono">{inr(b.costPaise)}</span> },
              ]}
              rows={doc.lines.flatMap((l) => (l.batchAllocations || []).map((b) => ({ ...b, item: l.product?.name })))}
              rowKey={(b, i) => `${b.batchId}-${i}`}
            />
          </details>
        )}
      </Card>

      <Card title="Print" subtitle="The template version is stamped on the document; no script, QR or IRN is fabricated.">
        <div className="row gap-s">
          <Select value={template} onChange={(e) => setTemplate(e.target.value)} style={{ maxWidth: 260 }} aria-label="Print template">
            {(templates.length ? templates : [{ key: 'corporate', label: 'Corporate A4' }]).map((t) => (
              <option key={t.key} value={t.key}>
                {t.label} {t.version ? `· ${t.version}` : ''}
              </option>
            ))}
          </Select>
          <Button variant="secondary" onClick={() => window.open(`/api/v1/documents/${doc._id}/print?template=${template}`, '_blank', 'noopener')}>
            Open print view
          </Button>
        </div>
        <Banner tone="info" title="Reprints are operational records">
          A reprint is logged in the audit trail and has no financial effect. The credit note is not a refund; refunds are recorded
          separately.
        </Banner>
      </Card>

      {payOpen && (
        <Modal title={`Record receipt against ${doc.number}`} onClose={() => setPayOpen(false)}>
          <ErrorNotice error={payError} onDismiss={() => setPayError(null)} />
          <form onSubmit={recordPayment} className="col gap">
            <Field label="Amount ₹" hint={`Outstanding: ${inr(settlement?.duePaise)}`} required>
              <Input value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} inputMode="decimal" placeholder={inr(settlement?.duePaise)} />
            </Field>
            <Field label="Method">
              <Select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
                {['upi', 'cash', 'card', 'bank', 'cheque', 'other'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference" hint="UPI reference, cheque number, etc.">
              <Input value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} />
            </Field>
            <Button type="submit" busy={busy}>
              Record confirmed receipt
            </Button>
          </form>
        </Modal>
      )}

      {refundOpen && (
        <Modal title={`Refund against ${doc.number}`} onClose={() => setRefundOpen(false)}>
          <ErrorNotice error={payError} onDismiss={() => setPayError(null)} />
          <Banner tone="warn" title="A refund is separate from a credit note">
            Only money actually received above the net billed amount can be refunded.
          </Banner>
          <form onSubmit={recordRefund} className="col gap">
            <Field label="Amount ₹" hint={`Refund entitlement: ${inr(settlement?.refundablePaise)}`} required>
              <Input value={refundForm.amount} onChange={(e) => setRefundForm({ ...refundForm, amount: e.target.value })} inputMode="decimal" />
            </Field>
            <Field label="Method">
              <Select value={refundForm.method} onChange={(e) => setRefundForm({ ...refundForm, method: e.target.value })}>
                {['cash', 'upi', 'card', 'bank', 'cheque', 'other'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason" required>
              <Input value={refundForm.reason} onChange={(e) => setRefundForm({ ...refundForm, reason: e.target.value })} minLength={5} />
            </Field>
            <Button type="submit" variant="danger" busy={busy}>
              Record confirmed refund
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
