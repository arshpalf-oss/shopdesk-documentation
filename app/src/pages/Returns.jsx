import React, { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, inr, inputToScaled, newIdempotencyKey, scaledToInput } from '../api.js';
import { useSession } from '../session.jsx';
import { Banner, Button, Card, Chip, ErrorNotice, Field, Input, Loading, Select, Table, Textarea, useAsync, useToast } from '../components.jsx';

const CONDITIONS = [
  ['unopened', 'Unopened / unopened pack'],
  ['resaleable', 'Resaleable (required to restock)'],
  ['opened', 'Opened / used'],
  ['damaged', 'Damaged'],
  ['expired', 'Expired'],
  ['cold_chain_unverified', 'Cold chain unverified'],
  ['recalled', 'Recalled'],
];

export default function ReturnsPage() {
  const [params, setParams] = useSearchParams();
  const { can } = useSession();
  const { push } = useToast();
  const [documentId, setDocumentId] = useState(params.get('documentId') || '');
  const [preview, setPreview] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [restock, setRestock] = useState({});
  const [conditions, setConditions] = useState({});
  const [reason, setReason] = useState('');
  const [reduceGst, setReduceGst] = useState(true);
  const [disposition, setDisposition] = useState('returned_to_customer');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [documents, setDocuments] = useState([]);
  const list = useAsync(() => api('/returns'), []);

  useEffect(() => {
    api('/documents?preset=all&limit=200')
      .then((data) => setDocuments(data.documents || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!documentId) {
      setPreview(null);
      return;
    }
    setError(null);
    api(`/documents/${documentId}/return-preview`)
      .then((data) => {
        setPreview(data);
        setReduceGst(Boolean(data.gstEligibility?.eligible));
        const q = {};
        const c = {};
        const r = {};
        for (const line of data.lines || []) {
          q[line.lineId] = '';
          c[line.lineId] = line.restockable ? 'resaleable' : 'unopened';
          r[line.lineId] = false;
        }
        setQuantities(q);
        setConditions(c);
        setRestock(r);
      })
      .catch((err) => {
        setPreview(null);
        setError(err);
      });
  }, [documentId]);

  const selectedLines = useMemo(() => {
    if (!preview) return [];
    return preview.lines
      .map((line) => {
        const raw = quantities[line.lineId];
        let scaled = '0';
        try {
          scaled = raw ? inputToScaled(raw, line.quantityScale ?? 0) : '0';
        } catch {
          scaled = '0';
        }
        return { line, scaled };
      })
      .filter((row) => BigInt(row.scaled) > 0n);
  }, [preview, quantities]);

  const estimatedCredit = useMemo(() => {
    if (!preview) return 0n;
    return selectedLines.reduce((acc, { line, scaled }) => {
      const originalQty = BigInt(line.originalQuantityScaled);
      if (originalQty === 0n) return acc;
      const remainingQty = BigInt(line.remainingQuantityScaled);
      const qty = scaled > remainingQty ? remainingQty : scaled;
      const share = Number(qty) / Number(originalQty);
      const total = BigInt(line.credit.commercialCreditPaise) * BigInt(Math.round(share * 10000)) / 10000n;
      return acc + total;
    }, 0n);
  }, [preview, selectedLines]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        reason,
        gstAdjustment: reduceGst,
        disposition,
        lines: selectedLines.map(({ line, scaled }) => {
          const item = { lineId: line.lineId, quantityScaled: scaled, condition: conditions[line.lineId] || 'unopened' };
          if (restock[line.lineId]) item.restock = true;
          return item;
        }),
      };
      const data = await api(`/documents/${documentId}/returns`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('return'),
        body,
      });
      setResult(data);
      push(`Credit note ${data.number} issued`);
      setDocumentId('');
      setPreview(null);
      list.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const filteredDocuments = documents.filter((d) =>
    !search.trim() ? true : [d.number, d.partySnapshot?.name].filter(Boolean).some((v) => v.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <>
      {result && (
        <Card title={`Credit note ${result.number} issued`}>
          <div className="grid grid-stats">
            <div className="stat">
              <span className="stat-label">Commercial credit</span>
              <strong className="stat-value">{inr(result.commercialCreditPaise)}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">GST adjustment</span>
              <strong className="stat-value">{inr(result.gstAdjustmentPaise)}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">GST status</span>
              <strong className="stat-value" style={{ fontSize: '0.95rem' }}>{result.gstAdjustmentStatus}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">Restocked</span>
              <strong className="stat-value" style={{ fontSize: '0.95rem' }}>{result.restocked ? 'Yes, original batch' : 'No'}</strong>
            </div>
          </div>
          <Banner tone="info" title="A credit note is not a refund">
            The customer balance is reduced. Money leaves the business only through a separate, permissioned refund entry.
          </Banner>
          <div className="row gap-s">
            <Button variant="secondary" onClick={() => window.open(`/api/v1/returns/${result.returnId}/print?template=corporate`, '_blank', 'noopener')}>
              Print credit note
            </Button>
            <Button variant="ghost" onClick={() => setResult(null)}>
              Done
            </Button>
          </div>
        </Card>
      )}

      <div className="grid grid-2">
        <Card title="Choose the original invoice" subtitle="A return is always linked to an issued invoice, never to a blank document.">
          <Field label="Search issued invoices">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="INV/… or customer name" />
          </Field>
          <div className="product-list">
            {filteredDocuments.slice(0, 40).map((doc) => (
              <button
                key={doc._id}
                type="button"
                className="product-hit"
                onClick={() => {
                  setDocumentId(doc._id);
                  setParams({ documentId: doc._id });
                }}
              >
                <span>
                  <span className="mono">{doc.number}</span>
                  <span className="muted small"> · {doc.partySnapshot?.name || 'Walk-in'}</span>
                </span>
                <span className="row gap-s">
                  <span className="muted small">{doc.businessDate}</span>
                  <span className="mono">{inr(doc.totals?.totalPaise)}</span>
                </span>
              </button>
            ))}
            {filteredDocuments.length === 0 && <p className="empty">No invoices found.</p>}
          </div>
        </Card>

        <Card title="Return entitlement" subtitle="Cumulative credit can never exceed the original line value.">
          {!preview ? (
            <p className="empty">Pick an invoice to see what is still returnable.</p>
          ) : (
            <>
              <dl className="kv">
                <dt>Invoice</dt>
                <dd className="mono">{preview.document.number}</dd>
                <dt>Party</dt>
                <dd>{preview.document.partySnapshot?.name || 'Walk-in'}</dd>
                <dt>GST eligibility</dt>
                <dd>
                  <Chip tone={preview.gstEligibility?.eligible ? 'good' : 'warn'}>{preview.gstEligibility?.status}</Chip>{' '}
                  <span className="muted small">{preview.gstEligibility?.reason}</span>
                </dd>
              </dl>

              <form onSubmit={submit} className="col gap" style={{ marginTop: '0.6rem' }}>
                <Table
                  dense
                  columns={[
                    {
                      key: 'name',
                      label: 'Line',
                      render: (l) => (
                        <div>
                          <strong>{l.name}</strong>
                          <div className="muted tiny">
                            sold {scaledToInput(l.originalQuantityScaled, l.quantityScale ?? 0)} · returned{' '}
                            {scaledToInput(l.returnedQuantityScaled, l.quantityScale ?? 0)} · left{' '}
                            {scaledToInput(l.remainingQuantityScaled, l.quantityScale ?? 0)} {l.uom}
                          </div>
                        </div>
                      ),
                    },
                    {
                      key: 'qty',
                      label: 'Return qty',
                      render: (l) => (
                        <Input
                          style={{ width: 84 }}
                          value={quantities[l.lineId] ?? ''}
                          onChange={(e) => setQuantities({ ...quantities, [l.lineId]: e.target.value })}
                          inputMode="decimal"
                          aria-label={`Return quantity for ${l.name}`}
                        />
                      ),
                    },
                    {
                      key: 'restock',
                      label: 'Restock',
                      render: (l) =>
                        can('returns.restock') ? (
                          <input
                            type="checkbox"
                            disabled={!l.restockable}
                            checked={Boolean(restock[l.lineId])}
                            onChange={(e) => {
                              setRestock({ ...restock, [l.lineId]: e.target.checked });
                              if (e.target.checked) setConditions({ ...conditions, [l.lineId]: 'resaleable' });
                            }}
                            aria-label={`Restock ${l.name}`}
                          />
                        ) : (
                          <span className="muted small">no permission</span>
                        ),
                    },
                    {
                      key: 'condition',
                      label: 'Condition',
                      render: (l) => (
                        <Select
                          style={{ width: 150 }}
                          value={conditions[l.lineId] || 'unopened'}
                          onChange={(e) => {
                            setConditions({ ...conditions, [l.lineId]: e.target.value });
                            if (e.target.value !== 'resaleable') setRestock({ ...restock, [l.lineId]: false });
                          }}
                          aria-label={`Condition for ${l.name}`}
                        >
                          {CONDITIONS.map(([v, label]) => (
                            <option key={v} value={v}>
                              {label}
                            </option>
                          ))}
                        </Select>
                      ),
                    },
                    {
                      key: 'credit',
                      label: 'Remaining credit',
                      align: 'right',
                      render: (l) => <span className="mono">{inr(l.credit.commercialCreditPaise)}</span>,
                    },
                  ]}
                  rows={preview.lines}
                  rowKey={(l) => l.lineId}
                />

                <Field label="Reason (recorded on the credit note)" required>
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} required />
                </Field>
                <div className="grid grid-form">
                  <Field label="Disposition if not restocked">
                    <Select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
                      <option value="returned_to_customer">Returned to customer</option>
                      <option value="quarantine">Quarantine</option>
                      <option value="wastage">Wastage / write-off</option>
                    </Select>
                  </Field>
                  <Field label="GST treatment" hint="Commercial-only credit does not reduce output GST.">
                    <Select value={reduceGst ? 'reduce' : 'commercial'} onChange={(e) => setReduceGst(e.target.value === 'reduce')} disabled={!preview.gstEligibility?.eligible && preview.gstEligibility?.status !== 'eligible'}>
                      <option value="reduce">Reduce output GST (eligible)</option>
                      <option value="commercial">Commercial credit only</option>
                    </Select>
                  </Field>
                </div>

                <div className="totals">
                  <div className="t-row">
                    <span className="muted">Selected quantity credit (approx.)</span>
                    <span className="mono">{inr(estimatedCredit.toString())}</span>
                  </div>
                  <div className="t-row total">
                    <span>Exact credit</span>
                    <span className="mono">calculated server-side on submit</span>
                  </div>
                </div>

                <ErrorNotice error={error} onDismiss={() => setError(null)} />
                <Button type="submit" busy={busy} disabled={!reason.trim() || selectedLines.length === 0}>
                  Issue credit note
                </Button>
              </form>
            </>
          )}
        </Card>
      </div>

      <Card title="Credit notes" subtitle="Each note keeps its own number, snapshot and journal." actions={<Button size="sm" variant="ghost" onClick={list.reload}>Refresh</Button>}>
        {list.loading ? (
          <Loading />
        ) : (
          <>
            <ErrorNotice error={list.error} />
            <Table
              columns={[
                {
                  key: 'number',
                  label: 'Number',
                  render: (r) => (
                    <Link className="mono" to={`/documents/${r.sourceDocumentId}`}>
                      {r.number}
                    </Link>
                  ),
                },
                { key: 'sourceNumber', label: 'Against', render: (r) => <span className="mono">{r.sourceNumber}</span> },
                { key: 'partySnapshot', label: 'Party', render: (r) => r.partySnapshot?.name || 'Walk-in' },
                { key: 'reason', label: 'Reason' },
                { key: 'credit', label: 'Credit', align: 'right', render: (r) => <span className="mono">{inr(r.credit?.commercialCreditPaise)}</span> },
                { key: 'gst', label: 'GST', align: 'right', render: (r) => <span className="mono">{inr(r.credit?.gstAdjustmentPaise)}</span> },
                { key: 'status', label: 'GST status', render: (r) => <Chip tone={r.credit?.gstAdjustmentStatus === 'eligible' ? 'good' : 'warn'}>{r.credit?.gstAdjustmentStatus}</Chip> },
                { key: 'restock', label: 'Stock', render: (r) => (r.restock ? 'restocked' : 'not restocked') },
                {
                  key: 'print',
                  label: '',
                  render: (r) => (
                    <Button size="sm" variant="ghost" onClick={() => window.open(`/api/v1/returns/${r._id}/print?template=corporate`, '_blank', 'noopener')}>
                      Print
                    </Button>
                  ),
                },
              ]}
              rows={list.data?.returns || []}
              rowKey={(r) => r._id}
              empty="No credit notes yet."
            />
          </>
        )}
      </Card>
    </>
  );
}
