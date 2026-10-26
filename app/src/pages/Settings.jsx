import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Banner, Button, Card, Chip, ErrorNotice, Field, Input, Loading, Select, Table, useAsync, useToast } from '../components.jsx';

const RULE_STATES = [
  ['unverified', 'Unverified (blocks dependent automation)'],
  ['reviewed_applicable', 'Reviewed: applicable'],
  ['reviewed_not_applicable', 'Reviewed: not applicable'],
  ['future_not_effective', 'Future / not yet effective'],
  ['unsupported', 'Unsupported in this build (blocked)'],
];

export default function Settings() {
  const { push } = useToast();
  const bundle = useAsync(() => api('/settings'), []);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tenantForm, setTenantForm] = useState(null);
  const [registration, setRegistration] = useState(null);
  const [ruleEdit, setRuleEdit] = useState(null);

  useEffect(() => {
    if (bundle.data?.tenant && !tenantForm) {
      setTenantForm({
        legalName: bundle.data.tenant.legalName,
        tradeName: bundle.data.tenant.tradeName || '',
        phone: bundle.data.tenant.phone || '',
        email: bundle.data.tenant.email || '',
        identityEvidence: '',
      });
    }
  }, [bundle.data, tenantForm]);

  async function saveTenant(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/settings/tenant', { method: 'PATCH', body: tenantForm });
      push('Workspace settings saved');
      bundle.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function verifyIdentity(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/settings/tenant', { method: 'PATCH', body: { identityVerified: true, identityEvidence: tenantForm.identityEvidence } });
      push('Identity marked verified');
      bundle.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveRegistration(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        profile: registration.profile,
        gstin: registration.gstin || undefined,
        stateCode: registration.stateCode,
        series: registration.series,
        eInvoice: { status: registration.eInvoiceStatus, note: registration.eInvoiceNote || undefined },
        drugLicence: {
          number: registration.drugLicenceNumber || undefined,
          expiresOn: registration.drugLicenceExpiry || undefined,
          status: registration.drugLicenceStatus,
          evidence: registration.drugLicenceEvidence || undefined,
        },
      };
      await api(`/settings/registrations/${registration._id}`, { method: 'PATCH', body });
      push('Registration saved');
      setRegistration(null);
      bundle.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function verifyRegistration(data) {
    setBusy(true);
    setError(null);
    try {
      await api(`/settings/registrations/${data._id}`, {
        method: 'PATCH',
        body: { verified: true, verificationEvidence: 'Synthetic demo verification — registration evidence recorded in the compliance file' },
      });
      push('Registration marked verified');
      bundle.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function saveRule(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/settings/rules/${ruleEdit.key}`, {
        method: 'PATCH',
        body: {
          state: ruleEdit.state,
          reviewer: ruleEdit.reviewer || undefined,
          evidence: ruleEdit.evidence || undefined,
          interpretation: ruleEdit.interpretation || undefined,
        },
      });
      push('Legal rule updated');
      setRuleEdit(null);
      bundle.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (bundle.loading) return <Loading />;
  if (bundle.error) return <ErrorNotice error={bundle.error} />;
  const { tenant, branches, registrations, readiness, legalRules, profiles, eInvoiceStates } = bundle.data;
  const blockers = (readiness || []).filter((i) => i.severity === 'blocker');
  const warnings = (readiness || []).filter((i) => i.severity !== 'blocker');

  return (
    <>
      <ErrorNotice error={error} onDismiss={() => setError(null)} />

      <Card
        title="Compliance readiness"
        subtitle="Live issuance is blocked while any blocker is open. No blocker is silent or hidden behind a disclaimer."
        actions={<Button size="sm" variant="ghost" onClick={bundle.reload}>Recheck</Button>}
      >
        {readiness?.length === 0 ? (
          <Banner tone="info" title="No readiness issues recorded">The configuration passes the checks this build can perform.</Banner>
        ) : (
          <>
            {blockers.length > 0 && (
              <Banner tone="legal" title={`${blockers.length} blocker(s) — documents cannot be issued`}>
                <ul className="blocker-list">
                  {blockers.map((b) => (
                    <li key={b.code}>
                      <code>{b.code}</code> {b.message}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}
            {warnings.length > 0 && (
              <Banner tone="warn" title={`${warnings.length} warning(s)`}>
                <ul className="blocker-list">
                  {warnings.map((b) => (
                    <li key={b.code}>
                      <code>{b.code}</code> {b.message}
                    </li>
                  ))}
                </ul>
              </Banner>
            )}
          </>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="Workspace identity" subtitle="After a recorded identity check, live issuing can proceed subject to the other gates.">
          <form onSubmit={saveTenant} className="col gap">
            <Field label="Legal name" required>
              <Input value={tenantForm?.legalName || ''} onChange={(e) => setTenantForm({ ...tenantForm, legalName: e.target.value })} required />
            </Field>
            <Field label="Trade name">
              <Input value={tenantForm?.tradeName || ''} onChange={(e) => setTenantForm({ ...tenantForm, tradeName: e.target.value })} />
            </Field>
            <div className="grid grid-form">
              <Field label="Phone">
                <Input value={tenantForm?.phone || ''} onChange={(e) => setTenantForm({ ...tenantForm, phone: e.target.value })} />
              </Field>
              <Field label="Email">
                <Input value={tenantForm?.email || ''} onChange={(e) => setTenantForm({ ...tenantForm, email: e.target.value })} />
              </Field>
            </div>
            <Button type="submit" busy={busy} size="sm">
              Save details
            </Button>
          </form>
          <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: '0.8rem', paddingTop: '0.7rem' }}>
            <p className="small">
              Identity:{' '}
              {tenant.identityVerified ? <Chip tone="good">verified</Chip> : <Chip tone="bad">not verified</Chip>}
              {tenant.identityEvidence && <span className="muted tiny"> · {tenant.identityEvidence}</span>}
            </p>
            {!tenant.identityVerified && (
              <form onSubmit={verifyIdentity} className="col gap" style={{ marginTop: '0.5rem' }}>
                <Field label="Verification evidence" required hint="What was checked (GST certificate, municipal licence, etc.) and where it is filed.">
                  <Input value={tenantForm?.identityEvidence || ''} onChange={(e) => setTenantForm({ ...tenantForm, identityEvidence: e.target.value })} required minLength={8} />
                </Field>
                <Button type="submit" size="sm" variant="secondary" busy={busy}>
                  Mark identity verified
                </Button>
              </form>
            )}
          </div>
          <p className="muted tiny" style={{ marginTop: '0.6rem' }}>
            Branches: {branches.map((b) => `${b.name} (${b.code})`).join(' · ')}
          </p>
        </Card>

        <Card title="GST registrations" subtitle="Profile, numbering and statutory applicability live here.">
          {registrations.map((reg) => (
            <div key={reg._id} className="card" style={{ background: 'var(--bg-sunken)', marginBottom: '0.6rem' }}>
              <div className="row gap-s" style={{ justifyContent: 'space-between' }}>
                <strong>{reg.tradeName || reg.legalName}</strong>
                <Chip tone={reg.status === 'verified' ? 'good' : 'warn'}>{reg.status}</Chip>
              </div>
              <p className="muted small">
                {reg.gstin || 'No GSTIN'} · {reg.profile} · state {reg.stateCode}
              </p>
              <p className="muted tiny">
                Series: {(reg.series || []).map((s) => `${s.docKind}=${s.series}`).join(' · ')}
              </p>
              <p className="muted tiny">
                e-invoice: {reg.eInvoice?.status || 'unverified'} · drug licence: {reg.drugLicence?.status || 'none'}
                {reg.drugLicence?.expiresOn ? ` (expires ${reg.drugLicence.expiresOn})` : ''}
              </p>
              <div className="row gap-s">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setRegistration({
                      _id: reg._id,
                      profile: reg.profile,
                      gstin: reg.gstin || '',
                      stateCode: reg.stateCode,
                      series: reg.series || [],
                      eInvoiceStatus: reg.eInvoice?.status || 'unverified',
                      eInvoiceNote: reg.eInvoice?.note || '',
                      drugLicenceNumber: reg.drugLicence?.number || '',
                      drugLicenceExpiry: reg.drugLicence?.expiresOn || '',
                      drugLicenceStatus: reg.drugLicence?.status || 'unverified',
                      drugLicenceEvidence: reg.drugLicence?.evidence || '',
                    })
                  }
                >
                  Edit registration
                </Button>
                {reg.status !== 'verified' && (
                  <Button size="sm" variant="secondary" onClick={() => verifyRegistration(reg)} busy={busy}>
                    Mark verified
                  </Button>
                )}
              </div>
            </div>
          ))}
          <Banner tone="info" title="e-invoicing and e-way bill">
            This build has no IRP or e-way portal integration. A registration marked “applicable” is blocked from live issue rather than
            printing an unofficial document.
          </Banner>
        </Card>
      </div>

      <Card title="Legal assumption register" subtitle="Every legal position used by the software has a state, a reviewer and evidence.">
        <Table
          dense
          columns={[
            { key: 'key', label: 'Key' },
            { key: 'title', label: 'Position' },
            { key: 'state', label: 'State', render: (r) => <Chip tone={r.state === 'reviewed_applicable' || r.state === 'reviewed_not_applicable' ? 'good' : 'warn'}>{r.state}</Chip> },
            { key: 'reviewer', label: 'Reviewer', render: (r) => r.reviewer || '—' },
            { key: 'nextReviewAt', label: 'Next review', render: (r) => (r.nextReviewAt ? String(r.nextReviewAt).slice(0, 10) : '—') },
            {
              key: 'actions',
              label: '',
              render: (r) => (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRuleEdit({ key: r.key, state: r.state, reviewer: r.reviewer || '', evidence: r.evidence || '', interpretation: r.interpretation || '' })}
                >
                  Record review
                </Button>
              ),
            },
          ]}
          rows={legalRules || []}
          rowKey={(r) => r.key}
        />
      </Card>

      {registration && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && setRegistration(null)}>
          <div className="modal wide">
            <header className="modal-head">
              <h2>Registration settings</h2>
              <button className="banner-x" onClick={() => setRegistration(null)} aria-label="Close">
                ×
              </button>
            </header>
            <div className="modal-body">
              <form onSubmit={saveRegistration} className="col gap">
                <div className="grid grid-form">
                  <Field label="GST profile">
                    <Select value={registration.profile} onChange={(e) => setRegistration({ ...registration, profile: e.target.value })}>
                      {Object.entries(profiles).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="GSTIN">
                    <Input value={registration.gstin} onChange={(e) => setRegistration({ ...registration, gstin: e.target.value.toUpperCase() })} />
                  </Field>
                  <Field label="State code">
                    <Input value={registration.stateCode} maxLength={2} onChange={(e) => setRegistration({ ...registration, stateCode: e.target.value })} />
                  </Field>
                  <Field label="e-invoice applicability">
                    <Select value={registration.eInvoiceStatus} onChange={(e) => setRegistration({ ...registration, eInvoiceStatus: e.target.value })}>
                      {Object.entries(eInvoiceStates).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="e-invoice review note">
                    <Input value={registration.eInvoiceNote} onChange={(e) => setRegistration({ ...registration, eInvoiceNote: e.target.value })} />
                  </Field>
                </div>

                <h3>Number series (Rule 46 — at most 16 characters)</h3>
                {registration.series.map((s, index) => (
                  <div key={s.docKind} className="grid grid-form">
                    <Field label="Document kind">
                      <Input value={s.docKind} readOnly />
                    </Field>
                    <Field label="Series prefix">
                      <Input
                        value={s.series}
                        onChange={(e) => {
                          const next = [...registration.series];
                          next[index] = { ...s, series: e.target.value.toUpperCase() };
                          setRegistration({ ...registration, series: next });
                        }}
                      />
                    </Field>
                    <Field label="Padding">
                      <Input
                        type="number"
                        min={1}
                        max={8}
                        value={s.padding}
                        onChange={(e) => {
                          const next = [...registration.series];
                          next[index] = { ...s, padding: Number(e.target.value) };
                          setRegistration({ ...registration, series: next });
                        }}
                      />
                    </Field>
                  </div>
                ))}

                <h3>Drug sale licence (gates restricted medicines)</h3>
                <div className="grid grid-form">
                  <Field label="Licence number">
                    <Input value={registration.drugLicenceNumber} onChange={(e) => setRegistration({ ...registration, drugLicenceNumber: e.target.value })} />
                  </Field>
                  <Field label="Expiry">
                    <Input type="date" value={registration.drugLicenceExpiry} onChange={(e) => setRegistration({ ...registration, drugLicenceExpiry: e.target.value })} />
                  </Field>
                  <Field label="Status">
                    <Select value={registration.drugLicenceStatus} onChange={(e) => setRegistration({ ...registration, drugLicenceStatus: e.target.value })}>
                      <option value="unverified">Unverified</option>
                      <option value="verified">Verified</option>
                    </Select>
                  </Field>
                  <Field label="Verification evidence">
                    <Input value={registration.drugLicenceEvidence} onChange={(e) => setRegistration({ ...registration, drugLicenceEvidence: e.target.value })} />
                  </Field>
                </div>

                <Button type="submit" busy={busy}>
                  Save registration
                </Button>
              </form>
            </div>
          </div>
        </div>
      )}

      {ruleEdit && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(e) => e.target === e.currentTarget && setRuleEdit(null)}>
          <div className="modal">
            <header className="modal-head">
              <h2>{ruleEdit.key}</h2>
              <button className="banner-x" onClick={() => setRuleEdit(null)} aria-label="Close">
                ×
              </button>
            </header>
            <div className="modal-body">
              <form onSubmit={saveRule} className="col gap">
                <Field label="State">
                  <Select value={ruleEdit.state} onChange={(e) => setRuleEdit({ ...ruleEdit, state: e.target.value })}>
                    {RULE_STATES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reviewer" required>
                  <Input value={ruleEdit.reviewer} onChange={(e) => setRuleEdit({ ...ruleEdit, reviewer: e.target.value })} />
                </Field>
                <Field label="Evidence / reference" required>
                  <Input value={ruleEdit.evidence} onChange={(e) => setRuleEdit({ ...ruleEdit, evidence: e.target.value })} />
                </Field>
                <Field label="Interpretation used">
                  <Input value={ruleEdit.interpretation} onChange={(e) => setRuleEdit({ ...ruleEdit, interpretation: e.target.value })} />
                </Field>
                <Button type="submit" busy={busy}>
                  Save review
                </Button>
              </form>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
