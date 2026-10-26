import React, { useEffect, useState } from 'react';
import { api, inr } from '../api.js';
import { Button, Card, ErrorNotice, Field, Input, Loading, Modal, Select, Table, useAsync, useToast } from '../components.jsx';

const EMPTY_CUSTOMER = { name: '', phone: '', email: '', gstin: '', stateCode: '09', address: '' };

export default function Customers() {
  const { push } = useToast();
  const customers = useAsync(() => api('/customers'), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_CUSTOMER);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [pets, setPets] = useState([]);
  const [petForm, setPetForm] = useState({ name: '', species: 'dog', breed: '', sex: '' });
  const [statement, setStatement] = useState(null);

  useEffect(() => {
    if (!selected) {
      setPets([]);
      setStatement(null);
      return;
    }
    api(`/pets?customerId=${selected._id}`)
      .then((d) => setPets(d.pets || []))
      .catch(() => setPets([]));
    api(`/customers/${selected._id}/statement`)
      .then(setStatement)
      .catch(() => setStatement(null));
  }, [selected]);

  async function createCustomer(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/customers', { method: 'POST', body: { ...form, gstin: form.gstin || undefined } });
      push('Customer added');
      setCreateOpen(false);
      setForm(EMPTY_CUSTOMER);
      customers.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function createPet(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/pets', { method: 'POST', body: { ...petForm, customerId: selected._id } });
      push('Pet added');
      setPetForm({ name: '', species: 'dog', breed: '', sex: '' });
      api(`/pets?customerId=${selected._id}`).then((d) => setPets(d.pets || []));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card
        title="Customers"
        subtitle="Billing parties only. Clinical notes, diagnosis and prescriptions are out of scope."
        actions={
          <Button size="sm" onClick={() => { setError(null); setCreateOpen(true); }}>
            New customer
          </Button>
        }
      >
        {customers.loading ? (
          <Loading />
        ) : (
          <>
            <ErrorNotice error={customers.error} />
            <Table
              columns={[
                { key: 'name', label: 'Name' },
                { key: 'phone', label: 'Phone' },
                { key: 'gstin', label: 'GSTIN', render: (c) => (c.gstin ? <span className="mono">{c.gstin}</span> : '—') },
                { key: 'billingStateCode', label: 'State' },
                { key: 'createdAt', label: 'Added', render: (c) => new Date(c.createdAt).toLocaleDateString('en-IN') },
              ]}
              rows={customers.data?.customers || []}
              rowKey={(c) => c._id}
              onRowClick={(c) => setSelected(c)}
              empty="No customers yet."
            />
          </>
        )}
      </Card>

      {selected && (
        <Card title={`${selected.name} — pets`} subtitle="A pet record is a billing identifier: name, species, breed, sex." actions={<Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close</Button>}>
          <div className="grid grid-2">
            <div>
              <Table
                dense
                columns={[
                  { key: 'name', label: 'Pet' },
                  { key: 'species', label: 'Species' },
                  { key: 'breed', label: 'Breed' },
                  { key: 'sex', label: 'Sex' },
                ]}
                rows={pets}
                rowKey={(p) => p._id}
                empty="No pets recorded for this customer."
              />
              <form onSubmit={createPet} className="grid grid-form" style={{ marginTop: '0.6rem' }}>
                <Field label="Pet name" required>
                  <Input value={petForm.name} onChange={(e) => setPetForm({ ...petForm, name: e.target.value })} required />
                </Field>
                <Field label="Species">
                  <Select value={petForm.species} onChange={(e) => setPetForm({ ...petForm, species: e.target.value })}>
                    {['dog', 'cat', 'bird', 'rabbit', 'cattle', 'other'].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Breed">
                  <Input value={petForm.breed} onChange={(e) => setPetForm({ ...petForm, breed: e.target.value })} />
                </Field>
                <Field label="Sex">
                  <Select value={petForm.sex} onChange={(e) => setPetForm({ ...petForm, sex: e.target.value })}>
                    <option value="">Not recorded</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </Select>
                </Field>
                <div style={{ alignSelf: 'end' }}>
                  <Button type="submit" size="sm" busy={busy}>
                    Add pet
                  </Button>
                </div>
              </form>
              <ErrorNotice error={error} onDismiss={() => setError(null)} />
            </div>
            <div>
              <h3>Statement</h3>
              {statement ? (
                <>
                  <p className="muted small">
                    Net billed {inr(statement.totals?.netBilledPaise ?? statement.netBilledPaise)} · received{' '}
                    {inr(statement.totals?.netReceivedPaise ?? statement.netReceivedPaise)} · due{' '}
                    <strong>{inr(statement.totals?.duePaise ?? statement.duePaise)}</strong>
                  </p>
                  <Table
                    dense
                    columns={[
                      { key: 'number', label: 'Document' },
                      { key: 'date', label: 'Date', render: (r) => r.date?.slice(0, 10) },
                      { key: 'totalPaise', label: 'Amount', align: 'right', render: (r) => <span className="mono">{inr(r.totalPaise)}</span> },
                    ]}
                    rows={statement.documents || statement.rows || []}
                    rowKey={(r) => r.number}
                    empty="No documents."
                  />
                </>
              ) : (
                <p className="muted small">Statement not available (needs the payments-read permission).</p>
              )}
            </div>
          </div>
        </Card>
      )}

      {createOpen && (
        <Modal title="New customer" onClose={() => setCreateOpen(false)}>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <form onSubmit={createCustomer} className="col gap">
            <div className="grid grid-form">
              <Field label="Name" required>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </Field>
              <Field label="Phone">
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
              <Field label="Email">
                <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label="GSTIN" hint="For a B2B invoice">
                <Input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} />
              </Field>
              <Field label="Billing state">
                <Input value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })} maxLength={2} />
              </Field>
            </div>
            <Field label="Address">
              <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </Field>
            <Button type="submit" busy={busy}>
              Add customer
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
