import React, { useState } from 'react';
import { api } from '../api.js';
import { Button, Card, ErrorNotice, Field, Input, Loading, Modal, Table, useAsync, useToast } from '../components.jsx';

const EMPTY = { name: '', gstin: '', stateCode: '09', phone: '', email: '' };

export default function Suppliers() {
  const { push } = useToast();
  const suppliers = useAsync(() => api('/suppliers'), []);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/suppliers', { method: 'POST', body: { ...form, gstin: form.gstin || undefined } });
      push('Supplier added');
      setOpen(false);
      setForm(EMPTY);
      suppliers.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card
        title="Suppliers"
        subtitle="Supplier bills can only be posted against a recorded vendor; duplicate bill numbers per FY are refused."
        actions={<Button size="sm" onClick={() => { setError(null); setOpen(true); }}>New supplier</Button>}
      >
        {suppliers.loading ? (
          <Loading />
        ) : (
          <>
            <ErrorNotice error={suppliers.error} />
            <Table
              columns={[
                { key: 'name', label: 'Supplier' },
                { key: 'gstin', label: 'GSTIN', render: (s) => (s.gstin ? <span className="mono">{s.gstin}</span> : '—') },
                { key: 'stateCode', label: 'State' },
                { key: 'phone', label: 'Phone' },
                { key: 'email', label: 'Email' },
              ]}
              rows={suppliers.data?.suppliers || []}
              rowKey={(s) => s._id}
              empty="No suppliers yet."
            />
          </>
        )}
      </Card>

      {open && (
        <Modal title="New supplier" onClose={() => setOpen(false)}>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <form onSubmit={create} className="col gap">
            <div className="grid grid-form">
              <Field label="Name" required>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </Field>
              <Field label="GSTIN">
                <Input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="State code">
                <Input value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })} maxLength={2} />
              </Field>
              <Field label="Phone">
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
              <Field label="Email">
                <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
            </div>
            <Button type="submit" busy={busy}>
              Add supplier
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
