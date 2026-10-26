import React, { useState } from 'react';
import { api } from '../api.js';
import { Banner, Button, Card, Chip, ErrorNotice, Field, Input, Loading, Modal, Select, Table, useAsync, useToast } from '../components.jsx';

const ROLE_KEYS = ['manager', 'cashier', 'inventory', 'accountant'];

export default function Staff() {
  const { push } = useToast();
  const staff = useAsync(() => api('/staff'), []);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'cashier' });
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function sendInvite(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api('/staff/invite', { method: 'POST', body: form });
      setInvite(result);
      setOpen(false);
      setForm({ email: '', role: 'cashier' });
      staff.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function patch(membership, body) {
    setBusy(true);
    setError(null);
    try {
      await api(`/staff/${membership.membershipId}`, { method: 'PATCH', body });
      push('Staff updated');
      staff.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card
        title="Staff and roles"
        subtitle="Named cashiers are required for attribution. Permissions are enforced server-side, not just hidden in the UI."
        actions={<Button size="sm" onClick={() => { setError(null); setOpen(true); }}>Invite staff</Button>}
      >
        {staff.loading ? (
          <Loading />
        ) : (
          <>
            <ErrorNotice error={error} onDismiss={() => setError(null)} />
            <Table
              columns={[
                { key: 'name', label: 'Name' },
                { key: 'email', label: 'Email' },
                { key: 'role', label: 'Role', render: (s) => <Chip tone={s.role === 'owner' ? 'info' : 'neutral'}>{staff.data?.roles?.[s.role]?.label || s.role}</Chip> },
                { key: 'status', label: 'Status', render: (s) => <Chip tone={s.status === 'active' ? 'good' : 'bad'}>{s.status}</Chip> },
                { key: 'permissions', label: 'Permissions', render: (s) => s.permissions?.length || 0 },
                {
                  key: 'actions',
                  label: '',
                  render: (s) =>
                    s.role === 'owner' ? (
                      <span className="muted small">owner</span>
                    ) : (
                      <div className="row gap-s">
                        <Select
                          value={s.role}
                          onChange={(e) => patch(s, { role: e.target.value })}
                          style={{ width: 150 }}
                          aria-label={`Role for ${s.name}`}
                        >
                          {ROLE_KEYS.map((r) => (
                            <option key={r} value={r}>
                              {staff.data?.roles?.[r]?.label || r}
                            </option>
                          ))}
                        </Select>
                        <Button
                          size="sm"
                          variant={s.status === 'active' ? 'danger' : 'ghost'}
                          onClick={() => patch(s, { status: s.status === 'active' ? 'disabled' : 'active' })}
                        >
                          {s.status === 'active' ? 'Disable' : 'Enable'}
                        </Button>
                      </div>
                    ),
                },
              ]}
              rows={staff.data?.staff || []}
              rowKey={(s) => s.membershipId}
            />

            {staff.data?.invitations?.length > 0 && (
              <>
                <h3 style={{ marginTop: '0.9rem' }}>Pending invitations</h3>
                <Table
                  dense
                  columns={[
                    { key: 'emailLower', label: 'Email' },
                    { key: 'role', label: 'Role' },
                    { key: 'expiresAt', label: 'Expires', render: (i) => new Date(i.expiresAt).toLocaleDateString('en-IN') },
                  ]}
                  rows={staff.data.invitations}
                  rowKey={(i) => i._id}
                />
              </>
            )}
          </>
        )}
      </Card>

      {invite && (
        <Card title="Share this one-time invitation token">
          <Banner tone="warn" title="No email provider is configured">
            Send this token through an approved channel. It is shown once and expires in seven days. The staff member accepts it on the
            sign-in screen.
          </Banner>
          <pre className="details">{invite.inviteToken}</pre>
          <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(invite.inviteToken)}>
            Copy token
          </Button>
        </Card>
      )}

      {open && (
        <Modal title="Invite staff" onClose={() => setOpen(false)}>
          <ErrorNotice error={error} onDismiss={() => setError(null)} />
          <form onSubmit={sendInvite} className="col gap">
            <Field label="Work email" required>
              <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </Field>
            <Field label="Role" hint="Least privilege by default. Quantity-only roles never receive cost fields.">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ROLE_KEYS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" busy={busy}>
              Create invitation
            </Button>
          </form>
        </Modal>
      )}
    </>
  );
}
