import React, { useState } from 'react';
import { api, inr, inputToPaise, newIdempotencyKey } from '../api.js';
import { useSession } from '../session.jsx';
import { Banner, Button, Card, Chip, ErrorNotice, Field, Input, Loading, Select, Table, useAsync, useToast } from '../components.jsx';

const PRESETS = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['month', 'This month'],
  ['last_month', 'Last month'],
  ['all', 'All time'],
];

export default function Payments() {
  const { session, can } = useSession();
  const { push } = useToast();
  const [preset, setPreset] = useState('month');
  const payments = useAsync(() => api(`/payments?preset=${preset}`), [preset]);
  const closes = useAsync(() => api('/cash-close'), []);
  const intents = useAsync(() => api('/payment-intents'), []);
  const [form, setForm] = useState({ opening: '', counted: '', reason: '', businessDate: session?.businessDate || '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [intentForm, setIntentForm] = useState({ documentId: '', amount: '', method: 'upi' });
  const [intentOpen, setIntentOpen] = useState(false);
  const [documents, setDocuments] = useState([]);

  async function cashClose(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/cash-close', {
        method: 'POST',
        body: {
          branchId: session.branch?.id,
          businessDate: form.businessDate || session.businessDate,
          openingCashPaise: inputToPaise(form.opening || '0'),
          countedCashPaise: inputToPaise(form.counted || '0'),
          varianceReason: form.reason || undefined,
        },
      });
      push('Cash close recorded');
      setForm({ ...form, opening: '', counted: '', reason: '' });
      closes.reload();
      payments.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirmIntent(intent) {
    setBusy(true);
    setError(null);
    try {
      await api(`/payment-intents/${intent._id}/confirm`, { method: 'POST', body: {} });
      push('Payment attempt confirmed');
      intents.reload();
      payments.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function createIntent(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!documents.length) {
        const data = await api('/documents?preset=all');
        setDocuments(data.documents || []);
      }
      await api('/payment-intents', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('intent'),
        body: {
          documentId: intentForm.documentId,
          amountPaise: inputToPaise(intentForm.amount),
          method: intentForm.method,
        },
      });
      push('Pending attempt recorded (no cash effect until confirmed)');
      setIntentOpen(false);
      intents.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ErrorNotice error={error} onDismiss={() => setError(null)} />

      <Card
        title="Money received and paid"
        subtitle="Only confirmed entries affect balances. Pending attempts and reversals are shown separately."
        actions={
          <div className="row gap-s">
            <Select value={preset} onChange={(e) => setPreset(e.target.value)} style={{ width: 160 }} aria-label="Period">
              {PRESETS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" onClick={payments.reload}>
              Refresh
            </Button>
          </div>
        }
      >
        {payments.loading ? (
          <Loading />
        ) : (
          <Table
            columns={[
              { key: 'number', label: 'Number', render: (p) => <span className="mono">{p.number}</span> },
              { key: 'kind', label: 'Kind', render: (p) => <Chip tone={p.kind === 'refund' ? 'warn' : p.kind === 'receipt_reversal' ? 'bad' : 'good'}>{p.kind}</Chip> },
              { key: 'partyName', label: 'Party' },
              { key: 'method', label: 'Method' },
              { key: 'amountPaise', label: 'Amount', align: 'right', render: (p) => <span className="mono">{inr(p.amountPaise)}</span> },
              { key: 'businessDate', label: 'Business date' },
              { key: 'recordedByName', label: 'Recorded by' },
              { key: 'status', label: 'Status' },
            ]}
            rows={payments.data?.payments || []}
            rowKey={(p) => p._id}
            empty="No payments in this period."
          />
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="Cash close" subtitle="Expected = opening + cash receipts − cash refunds − reversals. Variance needs a reason.">
          <form onSubmit={cashClose} className="col gap">
            <div className="grid grid-form">
              <Field label="Business date" required>
                <Input type="date" value={form.businessDate} onChange={(e) => setForm({ ...form, businessDate: e.target.value })} required />
              </Field>
              <Field label="Opening cash ₹" required>
                <Input value={form.opening} onChange={(e) => setForm({ ...form, opening: e.target.value })} inputMode="decimal" required />
              </Field>
              <Field label="Counted cash ₹" required>
                <Input value={form.counted} onChange={(e) => setForm({ ...form, counted: e.target.value })} inputMode="decimal" required />
              </Field>
            </div>
            <Field label="Variance reason" hint="Required only when counted differs from expected.">
              <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </Field>
            <Button type="submit" busy={busy}>
              Record cash close
            </Button>
          </form>

          <h3 style={{ marginTop: '0.9rem' }}>Recent closes</h3>
          {closes.loading ? (
            <Loading />
          ) : (
            <Table
              dense
              columns={[
                { key: 'businessDate', label: 'Date' },
                { key: 'cashierName', label: 'Cashier' },
                { key: 'expectedCashPaise', label: 'Expected', align: 'right', render: (c) => <span className="mono">{inr(c.expectedCashPaise)}</span> },
                { key: 'countedCashPaise', label: 'Counted', align: 'right', render: (c) => <span className="mono">{inr(c.countedCashPaise)}</span> },
                { key: 'variancePaise', label: 'Variance', align: 'right', render: (c) => <span className="mono">{inr(c.variancePaise, { sign: true })}</span> },
                { key: 'status', label: 'Status', render: (c) => <Chip tone={c.status === 'balanced' ? 'good' : 'warn'}>{c.status}</Chip> },
              ]}
              rows={closes.data?.closes || []}
              rowKey={(c) => c._id}
              empty="No cash closes recorded."
            />
          )}
        </Card>

        <Card
          title="Pending payment attempts"
          subtitle="An attempt is not money. Confirming it creates a confirmed receipt and a journal."
          actions={can('payments.record') ? <Button size="sm" variant="ghost" onClick={() => setIntentOpen(true)}>Record attempt</Button> : null}
        >
          {intents.loading ? (
            <Loading />
          ) : (
            <Table
              dense
              columns={[
                { key: 'method', label: 'Method' },
                { key: 'amountPaise', label: 'Amount', align: 'right', render: (i) => <span className="mono">{inr(i.amountPaise)}</span> },
                { key: 'status', label: 'Status', render: (i) => <Chip tone={i.status === 'pending' ? 'warn' : 'neutral'}>{i.status}</Chip> },
                {
                  key: 'actions',
                  label: '',
                  render: (i) =>
                    i.status === 'pending' && can('payments.pending.confirm') ? (
                      <Button size="sm" onClick={() => confirmIntent(i)} busy={busy}>
                        Confirm
                      </Button>
                    ) : (
                      <span className="muted small">—</span>
                    ),
                },
              ]}
              rows={intents.data?.intents || []}
              rowKey={(i) => i._id}
              empty="No payment attempts."
            />
          )}
          <Banner tone="info" title="Never assume success">
            A payment attempt is never treated as money received. Nothing is posted until a person confirms the settlement.
          </Banner>
        </Card>
      </div>

      {intentOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Record payment attempt" onMouseDown={(e) => e.target === e.currentTarget && setIntentOpen(false)}>
          <div className="modal">
            <header className="modal-head">
              <h2>Record payment attempt</h2>
              <button className="banner-x" onClick={() => setIntentOpen(false)} aria-label="Close">
                ×
              </button>
            </header>
            <div className="modal-body">
              <form onSubmit={createIntent} className="col gap">
                <Field label="Invoice" required>
                  <Select
                    value={intentForm.documentId}
                    onChange={(e) => setIntentForm({ ...intentForm, documentId: e.target.value })}
                    onFocus={async () => {
                      if (!documents.length) {
                        const data = await api('/documents?preset=all').catch(() => ({ documents: [] }));
                        setDocuments(data.documents || []);
                      }
                    }}
                    required
                  >
                    <option value="">Select an invoice</option>
                    {documents.map((d) => (
                      <option key={d._id} value={d._id}>
                        {d.number} · {d.partySnapshot?.name || 'Walk-in'} · {inr(d.totals?.totalPaise)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Amount ₹" required>
                  <Input value={intentForm.amount} onChange={(e) => setIntentForm({ ...intentForm, amount: e.target.value })} inputMode="decimal" required />
                </Field>
                <Field label="Method">
                  <Select value={intentForm.method} onChange={(e) => setIntentForm({ ...intentForm, method: e.target.value })}>
                    {['upi', 'cash', 'card', 'bank', 'cheque', 'other'].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button type="submit" busy={busy}>
                  Record pending attempt
                </Button>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
