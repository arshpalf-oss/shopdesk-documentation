import React, { useState } from 'react';
import { api } from '../api.js';
import { Banner, Button, Card, Chip, ErrorNotice, Input, Loading, Table, useAsync } from '../components.jsx';

export default function Audit() {
  const audit = useAsync(() => api('/audit'), []);
  const [search, setSearch] = useState('');
  const chain = audit.data?.chain;
  const events = (audit.data?.events || []).filter((e) =>
    !search.trim()
      ? true
      : [e.action, e.entityType, e.actorName, e.reason, e.entityId].filter(Boolean).some((v) => String(v).toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <>
      <Card
        title="Audit trail"
        subtitle="Append-only. There is no update or delete path in the application. A hash chain makes privileged tampering detectable."
        actions={
          <div className="row gap-s">
            <Button size="sm" variant="ghost" onClick={audit.reload}>
              Refresh
            </Button>
            <Button size="sm" variant="secondary" onClick={() => window.open('/api/v1/exports/audit.csv', '_blank', 'noopener')}>
              Export CSV
            </Button>
          </div>
        }
      >
        {audit.loading ? (
          <Loading />
        ) : (
          <>
            <ErrorNotice error={audit.error} />
            <Banner tone={chain?.valid ? 'info' : 'error'} title={chain?.valid ? 'Audit hash chain intact' : 'Audit chain broken'}>
              {chain?.checked ?? 0} event(s) verified, {chain?.tenantId ? 'tenant scoped' : 'no tenant'}. A hash chain is tamper-evident
              evidence, not a statutory digital signature or a compliance certificate.
            </Banner>
            <Input placeholder="Filter by action, entity, actor or reason" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 380, marginBottom: '0.6rem' }} />
            <Table
              dense
              columns={[
                { key: 'sequence', label: '#', align: 'right' },
                { key: 'atLabel', label: 'When' },
                { key: 'actorName', label: 'Actor' },
                { key: 'action', label: 'Action' },
                { key: 'entityType', label: 'Entity' },
                { key: 'reason', label: 'Reason', render: (e) => e.reason || '—' },
                {
                  key: 'hash',
                  label: 'Hash',
                  render: (e) => <span className="mono tiny">{String(e.hash || '').slice(0, 12)}…</span>,
                },
              ]}
              rows={events}
              rowKey={(e) => e._id}
              empty="No audit events."
            />
          </>
        )}
      </Card>

      <Card title="What is recorded" subtitle="Financial actions, refusals, prints, permission changes and exports.">
        <div className="grid grid-3">
          <div>
            <h3>Always</h3>
            <ul className="small muted">
              <li>Issued documents, credit notes, receipts and refunds</li>
              <li>Stock movements, batch status changes and adjustments</li>
              <li>Journals, expenses, openings and period locks</li>
              <li>Prints and reprints (no financial effect)</li>
            </ul>
          </div>
          <div>
            <h3>Also</h3>
            <ul className="small muted">
              <li>Staff invitations, role changes and disablement</li>
              <li>Legal-rule reviews and registration verification</li>
              <li>Report exports, including the period and quantity-only flag</li>
            </ul>
          </div>
          <div>
            <h3>Never</h3>
            <ul className="small muted">
              <li>Edit or delete an audit entry</li>
              <li>Store passwords, session tokens or card data in the trail</li>
              <li>Claim that a hash chain equals a statutory audit</li>
            </ul>
          </div>
        </div>
      </Card>
    </>
  );
}
