import React, { useMemo, useState } from 'react';
import { api, inr, scaledToInput } from '../api.js';
import { useSession } from '../session.jsx';
import { Banner, Button, Card, Chip, ErrorNotice, Field, Input, Loading, Select, Stat, Table, useAsync } from '../components.jsx';

const PRESETS = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['month', 'This month'],
  ['last_month', 'Last month'],
  ['fy', 'This financial year'],
  ['all', 'All time'],
  ['custom', 'Custom range'],
];

function label(key) {
  return String(key)
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/\bPaise\b/, '(₹)')
    .replace(/\bScaled\b/, '(units)');
}

function renderCell(key, value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return <span className="mono">{JSON.stringify(value)}</span>;
  if (key.endsWith('Paise')) return <span className="mono">{inr(value)}</span>;
  if (/Scaled$/.test(key)) return <span className="mono">{scaledToInput(value, 0)}</span>;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

export default function Reports() {
  const { can, branch } = useSession();
  const catalogue = useAsync(() => api('/reports'), []);
  const [tab, setTab] = useState('summary');
  const [preset, setPreset] = useState('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = useMemo(() => {
    const params = new URLSearchParams({ preset });
    if (preset === 'custom') {
      if (from) params.set('from', from);
      if (to) params.set('to', to);
    }
    if (branch?.id) params.set('branchId', branch.id);
    return params.toString();
  }, [preset, from, to, branch]);
  const report = useAsync(() => api(`/reports/${tab}?${query}`), [tab, query]);

  const coreTabs = catalogue.data?.coreTabs || [];
  const extraTabs = catalogue.data?.extraTabs || [];
  const data = report.data;
  const rows = data?.rows || null;
  const columns = useMemo(() => {
    if (!rows?.length) return [];
    const keys = Object.keys(rows[0]).filter((k) => !['key', 'accountId', 'productId', 'partyId', 'branchId'].includes(k));
    return keys.slice(0, 9).map((k) => ({
      key: k,
      label: label(k),
      align: k.endsWith('Paise') || /Scaled$/.test(k) || typeof rows[0][k] === 'number' ? 'right' : undefined,
    }));
  }, [rows]);

  return (
    <>
      <Card title="Report tabs" subtitle="Twelve operating tabs, plus reviewer extras. Every figure carries its definition.">
        <TabsRow>
          {coreTabs.map((t) => (
            <button key={t.key} type="button" className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </TabsRow>
        <details>
          <summary className="muted small">Additional reviewer tabs</summary>
          <TabsRow>
            {extraTabs.map((t) => (
              <button key={t.key} type="button" className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </TabsRow>
        </details>

        <div className="row gap-s" style={{ marginTop: '0.6rem', flexWrap: 'wrap' }}>
          <Select value={preset} onChange={(e) => setPreset(e.target.value)} style={{ width: 170 }} aria-label="Period preset">
            {PRESETS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          {preset === 'custom' && (
            <>
              <Field label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
            </>
          )}
          <div style={{ alignSelf: 'flex-end' }} className="row gap-s">
            <Button size="sm" variant="ghost" onClick={report.reload}>
              Refresh
            </Button>
            {can('reports.export') && (
              <Button size="sm" variant="secondary" onClick={() => window.open(`/api/v1/reports/${tab}.csv?${query}`, '_blank', 'noopener')}>
                Download CSV
              </Button>
            )}
          </div>
        </div>
      </Card>

      {report.loading ? (
        <Loading />
      ) : (
        <>
          <ErrorNotice error={report.error} />
          {data && (
            <Card
              title={data.label}
              subtitle={`${data.period?.label} · generated ${new Date(data.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`}
              actions={
                <>
                  {data.quantityOnly && <Chip tone="warn">quantity only</Chip>}
                  <Chip tone="info">working paper</Chip>
                </>
              }
            >
              {data.warning && <Banner tone="warn" title="Working paper">{data.warning}</Banner>}

              {data.cards?.length > 0 && (
                <div className="grid grid-stats" style={{ marginBottom: '0.75rem' }}>
                  {data.cards.map((card) => (
                    <Stat key={card.key} label={card.label} value={inr(card.valuePaise)} hint={card.definition} />
                  ))}
                </div>
              )}

              {data.rateGroups?.length > 0 && (
                <>
                  <h3>Rate groups</h3>
                  <Table
                    dense
                    columns={[
                      { key: 'taxRateBps', label: 'Rate', align: 'right', render: (r) => `${Number(r.taxRateBps) / 100}%` },
                      { key: 'supplyMode', label: 'Supply' },
                      { key: 'taxableValuePaise', label: 'Taxable', align: 'right', render: (r) => <span className="mono">{inr(r.taxableValuePaise)}</span> },
                      { key: 'cgstPaise', label: 'CGST', align: 'right', render: (r) => <span className="mono">{inr(r.cgstPaise)}</span> },
                      { key: 'sgstPaise', label: 'SGST', align: 'right', render: (r) => <span className="mono">{inr(r.sgstPaise)}</span> },
                      { key: 'igstPaise', label: 'IGST', align: 'right', render: (r) => <span className="mono">{inr(r.igstPaise)}</span> },
                      { key: 'taxPaise', label: 'Tax', align: 'right', render: (r) => <span className="mono">{inr(r.taxPaise)}</span> },
                    ]}
                    rows={data.rateGroups}
                    rowKey={(r, i) => `${r.taxRateBps}-${r.supplyMode}-${i}`}
                  />
                </>
              )}

              {rows && (
                <Table
                  dense
                  columns={columns}
                  rows={rows}
                  rowKey={(r, i) => r.key || r.accountId || i}
                  empty="No rows for this period."
                />
              )}

              {data.totals && (
                <div className="row gap" style={{ marginTop: '0.6rem', flexWrap: 'wrap' }}>
                  {Object.entries(data.totals).map(([key, value]) => (
                    <span key={key} className="chip">
                      {label(key)}: <span className="mono">{key.endsWith('Paise') ? inr(value) : value}</span>
                    </span>
                  ))}
                </div>
              )}

              {!rows && !data.cards?.length && !data.rateGroups?.length && (
                <pre className="details">{JSON.stringify(data, null, 2).slice(0, 4000)}</pre>
              )}

              <details style={{ marginTop: '0.75rem' }}>
                <summary className="muted small">Definitions used on this tab</summary>
                <dl className="kv" style={{ marginTop: '0.4rem' }}>
                  {Object.entries(data.definitions || {}).map(([key, value]) => (
                    <React.Fragment key={key}>
                      <dt>{label(key)}</dt>
                      <dd className="muted">{value}</dd>
                    </React.Fragment>
                  ))}
                </dl>
              </details>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function TabsRow({ children }) {
  return (
    <div className="tabs" role="tablist" style={{ flexWrap: 'wrap' }}>
      {children}
    </div>
  );
}
