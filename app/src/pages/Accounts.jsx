import React, { useMemo, useState } from 'react';
import { api, inr, inputToPaise, newIdempotencyKey } from '../api.js';
import { useSession } from '../session.jsx';
import { Banner, Button, Card, Chip, ErrorNotice, Field, Input, Loading, Select, Table, Tabs, useAsync, useToast } from '../components.jsx';
import { isoDay } from '../api.js';

export default function Accounts() {
  const { can, session } = useSession();
  const { push } = useToast();
  const [tab, setTab] = useState('trial');
  const ledger = useAsync(() => api('/accounts'), []);
  const pnl = useAsync(() => api('/accounts/pnl'), []);
  const sheet = useAsync(() => api('/accounts/balance-sheet'), []);
  const journals = useAsync(() => api('/accounts/journals'), []);
  const reconciliation = useAsync(() => api('/accounts/reconciliation'), []);
  const locks = useAsync(() => api('/period-locks'), []);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [journalForm, setJournalForm] = useState({
    businessDate: session?.businessDate || isoDay(),
    narration: '',
    lines: [
      { accountCode: '', debit: '', credit: '' },
      { accountCode: '', debit: '', credit: '' },
    ],
  });
  const [expenseForm, setExpenseForm] = useState({ businessDate: session?.businessDate || isoDay(), accountCode: '5290', amount: '', narration: '', method: 'cash' });
  const [lockForm, setLockForm] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() + 1, reason: '' });

  const accounts = ledger.data?.accounts || [];
  const expenseAccounts = useMemo(() => accounts.filter((a) => a.type === 'expense'), [accounts]);
  const debitTotal = journalForm.lines.reduce((a, l) => a + (l.debit ? BigInt(safePaise(l.debit)) : 0n), 0n);
  const creditTotal = journalForm.lines.reduce((a, l) => a + (l.credit ? BigInt(safePaise(l.credit)) : 0n), 0n);

  async function postJournal(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/accounts/journals', {
        method: 'POST',
        body: {
          businessDate: journalForm.businessDate,
          narration: journalForm.narration,
          lines: journalForm.lines
            .filter((l) => l.accountCode && (l.debit || l.credit))
            .map((l) => ({
              accountCode: l.accountCode,
              debitPaise: l.debit ? inputToPaise(l.debit) : '0',
              creditPaise: l.credit ? inputToPaise(l.credit) : '0',
            })),
        },
      });
      push('Journal posted');
      setJournalForm({ ...journalForm, narration: '', lines: [{ accountCode: '', debit: '', credit: '' }, { accountCode: '', debit: '', credit: '' }] });
      journals.reload();
      ledger.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function postExpense(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/expenses', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('expense'),
        body: {
          businessDate: expenseForm.businessDate,
          accountCode: expenseForm.accountCode,
          amountPaise: inputToPaise(expenseForm.amount),
          narration: expenseForm.narration,
          method: expenseForm.method,
        },
      });
      push('Expense recorded');
      setExpenseForm({ ...expenseForm, amount: '', narration: '' });
      journals.reload();
      pnl.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function lockPeriod(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/period-locks', { method: 'POST', body: lockForm });
      push('Period locked');
      locks.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function unlock(lock) {
    setBusy(true);
    setError(null);
    try {
      await api(`/period-locks/${lock._id}`, { method: 'DELETE', body: { reason: 'Reopened for correction' } });
      push('Period reopened');
      locks.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'trial', label: 'Trial balance' },
          { key: 'pl', label: 'Profit & loss' },
          { key: 'bs', label: 'Balance sheet' },
          { key: 'journals', label: 'Journals' },
          { key: 'recon', label: 'Reconciliation' },
          { key: 'coa', label: 'Chart of accounts' },
          { key: 'locks', label: 'Period locks' },
        ]}
      />
      <ErrorNotice error={error} onDismiss={() => setError(null)} />

      {tab === 'trial' && (
        <Card title="Trial balance" subtitle="Every posting is a balanced journal; the source event is unique so nothing posts twice.">
          {ledger.loading ? (
            <Loading />
          ) : (
            <>
              <Banner tone={ledger.data?.trialBalance?.balanced ? 'info' : 'error'} title={ledger.data?.trialBalance?.balanced ? 'Balanced' : 'Not balanced'}>
                Debits {inr(ledger.data?.trialBalance?.totalDebitPaise)} · Credits {inr(ledger.data?.trialBalance?.totalCreditPaise)}
              </Banner>
              <Table
                dense
                columns={[
                  { key: 'code', label: 'Code' },
                  { key: 'name', label: 'Account' },
                  { key: 'type', label: 'Type' },
                  { key: 'debitTotalPaise', label: 'Debits', align: 'right', render: (r) => <span className="mono">{inr(r.debitTotalPaise)}</span> },
                  { key: 'creditTotalPaise', label: 'Credits', align: 'right', render: (r) => <span className="mono">{inr(r.creditTotalPaise)}</span> },
                  {
                    key: 'balancePaise',
                    label: 'Balance',
                    align: 'right',
                    render: (r) => (
                      <span className="mono">
                        {inr(r.balancePaise)} {r.balanceSide === 'debit' ? 'Dr' : r.balanceSide === 'credit' ? 'Cr' : ''}
                      </span>
                    ),
                  },
                ]}
                rows={ledger.data?.trialBalance?.rows || []}
                rowKey={(r) => r.accountId}
              />
            </>
          )}
        </Card>
      )}

      {tab === 'pl' && (
        <div className="grid grid-2">
          <Card title="Profit & loss" subtitle="Revenue less expenses. Cost of goods sold comes from allocated batch cost.">
            {pnl.loading ? (
              <Loading />
            ) : (
              <>
                <div className="grid grid-stats">
                  <div className="stat">
                    <span className="stat-label">Revenue</span>
                    <strong className="stat-value">{inr(pnl.data?.revenueTotalPaise)}</strong>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Expenses</span>
                    <strong className="stat-value">{inr(pnl.data?.expenseTotalPaise)}</strong>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Profit</span>
                    <strong className="stat-value">{inr(pnl.data?.profitPaise)}</strong>
                  </div>
                </div>
                <Table
                  dense
                  columns={[
                    { key: 'name', label: 'Account' },
                    { key: 'balancePaise', label: 'Amount', align: 'right', render: (r) => <span className="mono">{inr(r.balancePaise)}</span> },
                  ]}
                  rows={[...(pnl.data?.revenue || []), ...(pnl.data?.expenses || [])]}
                  rowKey={(r) => r.accountId}
                />
              </>
            )}
          </Card>
          <Card title="Balance sheet" subtitle="Assets, liabilities and equity including current-period profit.">
            {sheet.loading ? (
              <Loading />
            ) : (
              <>
                <Table
                  dense
                  columns={[
                    { key: 'name', label: 'Account' },
                    { key: 'type', label: 'Type' },
                    { key: 'balancePaise', label: 'Balance', align: 'right', render: (r) => <span className="mono">{inr(r.balancePaise)}</span> },
                  ]}
                  rows={[...(sheet.data?.assets || []), ...(sheet.data?.liabilities || []), ...(sheet.data?.equity || [])]}
                  rowKey={(r) => r.accountId}
                />
                <p className="muted small">
                  Assets {inr(sheet.data?.assetTotalPaise)} · Liabilities {inr(sheet.data?.liabilityTotalPaise)} · Equity{' '}
                  {inr(sheet.data?.equityTotalPaise)} · Profit {inr(sheet.data?.profitPaise)}
                </p>
                <Banner tone={sheet.data?.balanced ? 'info' : 'warn'} title={sheet.data?.balanced ? 'Balance sheet balances' : 'Check reconciliation'}>
                  {sheet.data?.balanced
                    ? 'Assets equal liabilities plus equity for the recorded journals.'
                    : 'The recorded journals do not yet balance assets against liabilities plus equity.'}
                </Banner>
              </>
            )}
          </Card>
        </div>
      )}

      {tab === 'journals' && (
        <>
          <Card
            title="Journals"
            subtitle="Corrections are linked reversals; posted journals are never edited or deleted."
            actions={<Button size="sm" variant="ghost" onClick={() => journals.reload()}>Refresh</Button>}
          >
            {journals.loading ? (
              <Loading />
            ) : (
              <Table
                dense
                columns={[
                  { key: 'postedAt', label: 'Posted', render: (j) => new Date(j.postedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) },
                  { key: 'businessDate', label: 'Date' },
                  { key: 'narration', label: 'Narration' },
                  { key: 'postingKind', label: 'Kind' },
                  { key: 'lines', label: 'Lines', align: 'right', render: (j) => j.lines.length },
                  { key: 'totalDebitPaise', label: 'Debit', align: 'right', render: (j) => <span className="mono">{inr(j.totalDebitPaise)}</span> },
                  { key: 'status', label: 'Status', render: (j) => <Chip tone={j.status === 'posted' ? 'good' : 'warn'}>{j.status}</Chip> },
                ]}
                rows={journals.data?.entries || []}
                rowKey={(j) => j._id}
                empty="No journals yet."
              />
            )}
          </Card>

          {can('accounts.post') && (
            <div className="grid grid-2">
              <Card title="Manual journal" subtitle="Must balance exactly. Narrations and source events are audited.">
                <form onSubmit={postJournal} className="col gap">
                  <div className="grid grid-form">
                    <Field label="Business date" required>
                      <Input type="date" value={journalForm.businessDate} onChange={(e) => setJournalForm({ ...journalForm, businessDate: e.target.value })} required />
                    </Field>
                    <Field label="Narration" required>
                      <Input value={journalForm.narration} onChange={(e) => setJournalForm({ ...journalForm, narration: e.target.value })} required minLength={4} />
                    </Field>
                  </div>
                  {journalForm.lines.map((line, index) => (
                    <div key={index} className="grid grid-form">
                      <Field label="Account">
                        <Select
                          value={line.accountCode}
                          onChange={(e) => {
                            const lines = [...journalForm.lines];
                            lines[index] = { ...line, accountCode: e.target.value };
                            setJournalForm({ ...journalForm, lines });
                          }}
                        >
                          <option value="">Select</option>
                          {accounts.map((a) => (
                            <option key={a.code} value={a.code}>
                              {a.code} — {a.name}
                            </option>
                          ))}
                        </Select>
                      </Field>
                      <Field label="Debit ₹">
                        <Input
                          value={line.debit}
                          onChange={(e) => {
                            const lines = [...journalForm.lines];
                            lines[index] = { ...line, debit: e.target.value, credit: '' };
                            setJournalForm({ ...journalForm, lines });
                          }}
                          inputMode="decimal"
                        />
                      </Field>
                      <Field label="Credit ₹">
                        <Input
                          value={line.credit}
                          onChange={(e) => {
                            const lines = [...journalForm.lines];
                            lines[index] = { ...line, credit: e.target.value, debit: '' };
                            setJournalForm({ ...journalForm, lines });
                          }}
                          inputMode="decimal"
                        />
                      </Field>
                    </div>
                  ))}
                  <div className="row gap-s">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setJournalForm({ ...journalForm, lines: [...journalForm.lines, { accountCode: '', debit: '', credit: '' }] })}>
                      Add line
                    </Button>
                    <span className={`small ${debitTotal === creditTotal ? 'muted' : ''}`} style={{ color: debitTotal === creditTotal ? undefined : 'var(--red)' }}>
                      Debits {inr(debitTotal.toString())} · Credits {inr(creditTotal.toString())}
                    </span>
                  </div>
                  <Button type="submit" busy={busy} disabled={debitTotal !== creditTotal || debitTotal === 0n}>
                    Post journal
                  </Button>
                </form>
              </Card>

              <Card title="Expense" subtitle="Cash or bank expense against an expense account.">
                <form onSubmit={postExpense} className="col gap">
                  <div className="grid grid-form">
                    <Field label="Business date" required>
                      <Input type="date" value={expenseForm.businessDate} onChange={(e) => setExpenseForm({ ...expenseForm, businessDate: e.target.value })} required />
                    </Field>
                    <Field label="Expense account" required>
                      <Select value={expenseForm.accountCode} onChange={(e) => setExpenseForm({ ...expenseForm, accountCode: e.target.value })}>
                        {(expenseAccounts.length ? expenseAccounts : [{ code: '5290', name: 'General expenses' }]).map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} — {a.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Amount ₹" required>
                      <Input value={expenseForm.amount} onChange={(e) => setExpenseForm({ ...expenseForm, amount: e.target.value })} inputMode="decimal" required />
                    </Field>
                    <Field label="Paid by">
                      <Select value={expenseForm.method} onChange={(e) => setExpenseForm({ ...expenseForm, method: e.target.value })}>
                        {['cash', 'upi', 'card', 'bank', 'cheque', 'other'].map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <Field label="Narration" required>
                    <Input value={expenseForm.narration} onChange={(e) => setExpenseForm({ ...expenseForm, narration: e.target.value })} required minLength={4} />
                  </Field>
                  <Button type="submit" busy={busy}>
                    Record expense
                  </Button>
                </form>
              </Card>
            </div>
          )}
        </>
      )}

      {tab === 'recon' && (
        <div className="grid grid-2">
          <Card title="Stock vs ledger" subtitle="Batch valuation is compared with the inventory control account.">
            {reconciliation.loading ? (
              <Loading />
            ) : (
              <>
                <Banner tone={reconciliation.data?.reconciliation?.findings?.some((f) => f.severity === 'critical') ? 'error' : reconciliation.data?.reconciliation?.findings?.length ? 'warn' : 'info'} title={reconciliation.data?.reconciliation?.summary || 'Reconciliation'}>
                  {reconciliation.data?.reconciliation?.findings?.length
                    ? 'Differences are listed below with the affected amounts.'
                    : 'No differences were found between batch valuation, the inventory account, receivables and the sub-ledgers.'}
                </Banner>
                <Table
                  dense
                  columns={[
                    { key: 'code', label: 'Check' },
                    { key: 'severity', label: 'Severity', render: (f) => <Chip tone={f.severity === 'critical' ? 'bad' : 'warn'}>{f.severity}</Chip> },
                    { key: 'message', label: 'Detail' },
                  ]}
                  rows={reconciliation.data?.reconciliation?.findings || []}
                  rowKey={(f) => f.code}
                  empty="No findings."
                />
                <dl className="kv" style={{ marginTop: '0.6rem' }}>
                  <dt>Batch valuation</dt>
                  <dd className="mono">{inr(reconciliation.data?.valuation?.totalPaise)}</dd>
                  <dt>Batches valued</dt>
                  <dd>{reconciliation.data?.valuation?.batchCount ?? '—'}</dd>
                </dl>
              </>
            )}
          </Card>
          <Card title="Control checks" subtitle="What this reconciliation can and cannot see.">
            <ul className="small muted">
              <li>Trial balance must equal debits and credits before any other check runs.</li>
              <li>Inventory GL is compared with the exact batch valuation (quantity × layered cost).</li>
              <li>Receivables control is compared with the customer sub-ledger and unassigned receipts.</li>
              <li>This is an internal consistency check; it is not a statutory audit or a tax opinion.</li>
            </ul>
          </Card>
        </div>
      )}

      {tab === 'coa' && (
        <Card title="Chart of accounts" subtitle="System accounts are seeded per workspace; codes are stable.">
          {ledger.loading ? (
            <Loading />
          ) : (
            <Table
              dense
              columns={[
                { key: 'code', label: 'Code' },
                { key: 'name', label: 'Account' },
                { key: 'type', label: 'Type' },
                { key: 'normal', label: 'Normal side' },
                { key: 'system', label: 'System', render: (a) => (a.system ? <Chip tone="info">system</Chip> : 'custom') },
              ]}
              rows={accounts}
              rowKey={(a) => a._id}
            />
          )}
        </Card>
      )}

      {tab === 'locks' && (
        <Card title="Period locks" subtitle="A locked month rejects new postings dated inside it until reopened with a reason.">
          {can('accounts.period') && (
            <form onSubmit={lockPeriod} className="grid grid-form" style={{ marginBottom: '0.7rem' }}>
              <Field label="Year" required>
                <Input type="number" value={lockForm.year} onChange={(e) => setLockForm({ ...lockForm, year: Number(e.target.value) })} required />
              </Field>
              <Field label="Month" required>
                <Input type="number" min={1} max={12} value={lockForm.month} onChange={(e) => setLockForm({ ...lockForm, month: Number(e.target.value) })} required />
              </Field>
              <Field label="Reason" required>
                <Input value={lockForm.reason} onChange={(e) => setLockForm({ ...lockForm, reason: e.target.value })} required minLength={3} />
              </Field>
              <div style={{ alignSelf: 'end' }}>
                <Button type="submit" busy={busy}>
                  Lock period
                </Button>
              </div>
            </form>
          )}
          {locks.loading ? (
            <Loading />
          ) : (
            <Table
              dense
              columns={[
                { key: 'year', label: 'Year' },
                { key: 'month', label: 'Month' },
                { key: 'status', label: 'Status', render: (l) => <Chip tone={l.status === 'locked' ? 'bad' : 'good'}>{l.status}</Chip> },
                { key: 'reason', label: 'Reason' },
                {
                  key: 'actions',
                  label: '',
                  render: (l) =>
                    l.status === 'locked' && can('accounts.period') ? (
                      <Button size="sm" variant="ghost" onClick={() => unlock(l)} busy={busy}>
                        Reopen
                      </Button>
                    ) : null,
                },
              ]}
              rows={locks.data?.locks || []}
              rowKey={(l) => l._id}
              empty="No period locks."
            />
          )}
        </Card>
      )}
    </>
  );
}

function safePaise(value) {
  try {
    return inputToPaise(value);
  } catch {
    return '0';
  }
}
