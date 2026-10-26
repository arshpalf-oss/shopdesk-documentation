import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, inr } from '../api.js';
import { useSession } from '../session.jsx';
import { Banner, Card, Chip, ErrorNotice, Loading, Stat, Table, useAsync } from '../components.jsx';

const PRESETS = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['month', 'This month'],
  ['last_month', 'Last month'],
  ['fy', 'This financial year'],
  ['all', 'All time'],
];

export default function Overview() {
  const { session, can } = useSession();
  const [preset, setPreset] = useState('month');
  const { data, error, loading, reload } = useAsync(() => api(`/overview?preset=${preset}`), [preset]);

  if (loading) return <Loading />;
  if (error) return <ErrorNotice error={error} />;

  const blockers = data.alerts?.readinessBlockers || [];

  return (
    <>
      <div className="row gap-s" style={{ marginBottom: '0.75rem', justifyContent: 'space-between' }}>
        <div className="row gap-s">
          {PRESETS.map(([key, label]) => (
            <button key={key} type="button" className={`tab ${preset === key ? 'active' : ''}`} onClick={() => setPreset(key)}>
              {label}
            </button>
          ))}
        </div>
        <Chip tone="info">{data.period?.label}</Chip>
      </div>

      {data.scope === 'your own authorised work' ? (
        <Banner tone="info" title="Scoped view">
          You are seeing only your own issued bills and receipts. Whole-clinic figures need the reporting permission.
        </Banner>
      ) : null}

      {blockers.length > 0 && (
        <Banner tone="warn" title={`${blockers.length} compliance readiness item(s) block live issuing`}>
          <ul className="blocker-list">
            {blockers.slice(0, 4).map((b, i) => (
              <li key={i}>
                <code>{b.code}</code> {b.message}
              </li>
            ))}
          </ul>
          {can('settings.manage') && <p><Link to="/settings">Open compliance readiness</Link></p>}
        </Banner>
      )}

      {data.self ? (
        <Card title="Your work this period">
          <div className="grid grid-stats">
            <Stat label="Bills issued by you" value={data.self.invoices} />
            <Stat label="Gross billed by you" value={inr(data.self.grossBilledPaise)} />
            <Stat label="Receipts you recorded" value={inr(data.self.confirmedReceiptsPaise)} />
          </div>
        </Card>
      ) : (
        <div className="grid grid-stats" style={{ marginBottom: '0.9rem' }}>
          {(data.cards || []).map((card) => (
            <Stat
              key={card.key}
              label={card.label}
              value={inr(card.valuePaise)}
              hint={card.definition}
              tone={card.key === 'due' && BigInt(card.valuePaise) > 0n ? 'warn' : 'default'}
            />
          ))}
        </div>
      )}

      <div className="grid grid-2">
        <Card
          title="Stock needing attention"
          subtitle="Zero or negative availability in the current branch"
          actions={<Link to="/inventory">Inventory →</Link>}
        >
          <Table
            dense
            columns={[
              { key: 'product', label: 'Product' },
              { key: 'batchNo', label: 'Batch' },
              {
                key: 'available',
                label: 'Available',
                align: 'right',
                render: (row) => <span>{row.available ?? row.availableScaled} {row.uom}</span>,
              },
            ]}
            rows={data.alerts?.lowStock || []}
            empty="No product is out of stock."
          />
        </Card>

        <Card
          title="Expiring within 60 days"
          subtitle="FEFO sells the earliest eligible batch first; expired stock is never saleable"
          actions={<Link to="/inventory">Batches →</Link>}
        >
          <Table
            dense
            columns={[
              { key: 'product', label: 'Product' },
              { key: 'batchNo', label: 'Batch' },
              { key: 'expiryLabel', label: 'Expiry' },
              { key: 'daysToExpiry', label: 'Days left', align: 'right' },
            ]}
            rows={data.alerts?.nearExpiry || []}
            empty="Nothing expires in the next 60 days."
          />
        </Card>
      </div>

      <Card title="Start here" subtitle="Common tasks for the counters and the back office">
        <div className="grid grid-3">
          {can('billing.use') && <QuickLink to="/billing" title="New bill" text="Quote, check stock and issue a numbered invoice." />}
          {can('documents.read') && <QuickLink to="/documents" title="Find a document" text="Reprint an A4 or thermal copy; reprints have no financial effect." />}
          {can('documents.read') && <QuickLink to="/returns" title="Return or credit note" text="Entitlement is calculated from the original invoice." />}
          {can('payments.read') && <QuickLink to="/payments" title="Cash close" text="Expected vs counted cash with a recorded variance reason." />}
          {can('reports.read') && <QuickLink to="/reports" title="Reports" text="Twelve operating tabs with working-paper labels and CSV." />}
          {can('accounts.read') && <QuickLink to="/accounts" title="Trial balance" text="Balanced journals and stock/GL reconciliation." />}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={reload} style={{ marginTop: '0.6rem' }}>
          Refresh
        </button>
      </Card>

      <p className="site-foot">
        Server time {session?.serverTime?.slice(0, 19).replace('T', ' ')} UTC · business date {data.businessDate} (Asia/Kolkata) ·{' '}
        {data.scope}
      </p>
    </>
  );
}

function QuickLink({ to, title, text }) {
  return (
    <Link to={to} className="card" style={{ display: 'block', textDecoration: 'none', marginBottom: 0 }}>
      <h3>{title}</h3>
      <p className="muted small">{text}</p>
    </Link>
  );
}
