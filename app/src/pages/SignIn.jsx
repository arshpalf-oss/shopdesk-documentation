import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../session.jsx';
import { Banner, Button, ErrorNotice, Field, Input, Select } from '../components.jsx';

const STATES = [
  ['09', '09 — Uttar Pradesh'],
  ['07', '07 — Delhi'],
  ['27', '27 — Maharashtra'],
  ['29', '29 — Karnataka'],
  ['33', '33 — Tamil Nadu'],
  ['36', '36 — Telangana'],
  ['19', '19 — West Bengal'],
  ['24', '24 — Gujarat'],
  ['08', '08 — Rajasthan'],
  ['06', '06 — Haryana'],
  ['32', '32 — Kerala'],
  ['23', '23 — Madhya Pradesh'],
  ['10', '10 — Bihar'],
  ['22', '22 — Chhattisgarh'],
  ['34', '34 — Puducherry'],
  ['03', '03 — Punjab'],
];

export default function SignIn() {
  const { refresh } = useSession();
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [login, setLogin] = useState({ email: '', password: '' });
  const [setup, setSetup] = useState({
    setupToken: '',
    legalName: '',
    tradeName: '',
    branchName: 'Main clinic',
    address: '',
    stateCode: '09',
    profile: 'regular',
    gstin: '',
    identityEvidence: '',
    eInvoiceStatus: 'unverified',
    eInvoiceNote: '',
    ownerName: '',
    ownerEmail: '',
    ownerPassword: '',
  });

  useEffect(() => {
    api('/setup/status')
      .then((data) => {
        setStatus(data);
        if (data.needsSetup) setMode('setup');
        if (data.setupToken) setSetup((prev) => ({ ...prev, setupToken: data.setupToken }));
      })
      .catch(() => setStatus({ needsSetup: false }));
  }, []);

  async function submitLogin(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/login', { method: 'POST', body: login });
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitSetup(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { ...setup };
      if (!payload.gstin) delete payload.gstin;
      if (!payload.tradeName) delete payload.tradeName;
      await api('/setup', { method: 'POST', body: payload });
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="row gap-s" style={{ marginBottom: '0.6rem' }}>
          <span className="brand-mark" aria-hidden="true">◈</span>
          <div>
            <h1>shop desk</h1>
            <p className="muted small">Veterinary billing, inventory and double-entry accounts</p>
          </div>
        </div>

        {status?.needsSetup ? (
          <Banner tone="info" title="First run">
            This installation has no workspace yet. Setup creates one tenant, one branch, a chart of accounts and the legal-rule
            register — and <strong>no</strong> sample products, parties, stock or invoices.
          </Banner>
        ) : null}

        <div className="tabs" role="tablist">
          <button type="button" className={`tab ${mode === 'login' ? 'active' : ''}`} onClick={() => setMode('login')} role="tab" aria-selected={mode === 'login'}>
            Sign in
          </button>
          <button type="button" className={`tab ${mode === 'setup' ? 'active' : ''}`} onClick={() => setMode('setup')} role="tab" aria-selected={mode === 'setup'}>
            First-run setup
          </button>
        </div>

        <ErrorNotice error={error} onDismiss={() => setError(null)} />

        {mode === 'login' ? (
          <form onSubmit={submitLogin} className="col gap">
            <Field label="Work email" required htmlFor="email">
              <Input id="email" type="email" autoComplete="username" value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} required />
            </Field>
            <Field label="Password" required htmlFor="password">
              <Input id="password" type="password" autoComplete="current-password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} required />
            </Field>
            <Button type="submit" busy={busy}>
              Sign in
            </Button>
            <p className="auth-foot">
              Sessions are HttpOnly cookies with a CSRF token bound to the session. Failed attempts are rate limited.
            </p>
          </form>
        ) : (
          <form onSubmit={submitSetup} className="col gap">
            <Field label="Server setup token" required hint="Printed by the server at first start, or set in SHOPDESK_SETUP_TOKEN. Never stored in the browser bundle.">
              <Input value={setup.setupToken} onChange={(e) => setSetup({ ...setup, setupToken: e.target.value })} required autoComplete="off" />
            </Field>
            <div className="grid grid-form">
              <Field label="Legal name" required>
                <Input value={setup.legalName} onChange={(e) => setSetup({ ...setup, legalName: e.target.value })} required minLength={3} />
              </Field>
              <Field label="Trade name">
                <Input value={setup.tradeName} onChange={(e) => setSetup({ ...setup, tradeName: e.target.value })} />
              </Field>
              <Field label="Branch name">
                <Input value={setup.branchName} onChange={(e) => setSetup({ ...setup, branchName: e.target.value })} />
              </Field>
              <Field label="GST profile">
                <Select value={setup.profile} onChange={(e) => setSetup({ ...setup, profile: e.target.value })}>
                  <option value="regular">Regular GST registration</option>
                  <option value="composition">Composition scheme</option>
                  <option value="unregistered">Unregistered (no GST collected)</option>
                </Select>
              </Field>
              <Field label="State">
                <Select value={setup.stateCode} onChange={(e) => setSetup({ ...setup, stateCode: e.target.value })}>
                  {STATES.map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="GSTIN" hint="Syntactic check only; not official verification.">
                <Input value={setup.gstin} onChange={(e) => setSetup({ ...setup, gstin: e.target.value.toUpperCase() })} placeholder="09ABCDE1234F1Z5" />
              </Field>
            </div>
            <Field label="Business address">
              <Input value={setup.address} onChange={(e) => setSetup({ ...setup, address: e.target.value })} />
            </Field>
            <Field label="Identity verification evidence" required hint="What you checked and where it is recorded. Live issuance stays blocked until the tenant is marked verified.">
              <Input value={setup.identityEvidence} onChange={(e) => setSetup({ ...setup, identityEvidence: e.target.value })} required minLength={8} />
            </Field>
            <div className="grid grid-form">
              <Field label="e-invoice applicability">
                <Select value={setup.eInvoiceStatus} onChange={(e) => setSetup({ ...setup, eInvoiceStatus: e.target.value })}>
                  <option value="unverified">Not yet verified (blocks live issue)</option>
                  <option value="reviewed_not_applicable">Reviewed: not applicable</option>
                  <option value="applicable">Applicable — IRP integration needed</option>
                </Select>
              </Field>
              <Field label="Review note">
                <Input value={setup.eInvoiceNote} onChange={(e) => setSetup({ ...setup, eInvoiceNote: e.target.value })} />
              </Field>
            </div>
            <div className="grid grid-form">
              <Field label="Owner name" required>
                <Input value={setup.ownerName} onChange={(e) => setSetup({ ...setup, ownerName: e.target.value })} required />
              </Field>
              <Field label="Owner email" required>
                <Input type="email" value={setup.ownerEmail} onChange={(e) => setSetup({ ...setup, ownerEmail: e.target.value })} required />
              </Field>
              <Field label="Owner password" required hint="At least 10 characters.">
                <Input type="password" value={setup.ownerPassword} onChange={(e) => setSetup({ ...setup, ownerPassword: e.target.value })} required minLength={10} autoComplete="new-password" />
              </Field>
            </div>
            <Button type="submit" busy={busy}>
              Create empty workspace
            </Button>
          </form>
        )}

        <p className="auth-foot">
          shop desk is billing and inventory software for veterinary clinics. It is not a tax opinion, a GST filing service, an
          e-invoice provider or an audited-statements generator. Statutory applicability must be reviewed by your CA.
        </p>
      </div>
    </div>
  );
}
