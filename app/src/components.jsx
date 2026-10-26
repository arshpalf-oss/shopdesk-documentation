import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError } from './api.js';

export function Card({ title, subtitle, actions, children, className = '', tone }) {
  return (
    <section className={`card ${className}`} data-tone={tone}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          {actions && <div className="row gap-s">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone = 'default' }) {
  return (
    <div className="stat" data-tone={tone}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function Chip({ children, tone = 'neutral' }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function Button({ children, variant = 'primary', size = 'md', type = 'button', busy, block, ...rest }) {
  return (
    <button type={type} className={`btn btn-${variant} btn-${size}${block ? ' btn-block' : ''}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? <span className="spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, required, children, htmlFor }) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">
        {label} {required && <em aria-hidden="true">*</em>}
      </span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error" role="alert">{error}</span>}
    </label>
  );
}

export function Input(props) {
  return <input className="input" {...props} />;
}

export function Textarea(props) {
  return <textarea className="input" rows={3} {...props} />;
}

export function Select({ children, ...props }) {
  return (
    <select className="input" {...props}>
      {children}
    </select>
  );
}

export function Banner({ tone = 'info', title, children, onDismiss }) {
  const role = tone === 'error' || tone === 'legal' ? 'alert' : 'status';
  return (
    <div className={`banner banner-${tone}`} role={role}>
      <div>
        {title && <strong>{title}</strong>}
        {children && <div className="banner-body">{children}</div>}
      </div>
      {onDismiss && (
        <button className="banner-x" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={value === tab.key}
          className={`tab ${value === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Table({ columns, rows, empty = 'Nothing recorded yet.', rowKey, onRowClick, dense }) {
  if (!rows?.length) return <p className="empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table className={`table ${dense ? 'dense' : ''}`}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'right' : ''} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey ? rowKey(row, index) : index}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={onRowClick ? 'clickable' : ''}
            >
              {columns.map((c) => (
                <td key={c.key} className={c.align === 'right' ? 'right' : ''}>
                  {c.render ? c.render(row, index) : row[c.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="banner-x" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="loading" role="status">
      <span className="spin" /> {label}
    </div>
  );
}

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext) || { push: () => {} };
}

/**
 * Renders the server's error verbatim. Legal gates show each blocker; nothing is
 * ever converted into a success state in the browser.
 */
export function ErrorNotice({ error, onDismiss }) {
  if (!error) return null;
  const isLegal = error.code === 'LEGAL_GATE_BLOCKED' || error.blockers?.length;
  const details = error.details;
  return (
    <Banner tone={isLegal ? 'legal' : 'error'} title={isLegal ? 'Blocked by a compliance gate' : 'Request rejected'} onDismiss={onDismiss}>
      <p>{error.message}</p>
      {Array.isArray(error.blockers) && error.blockers.length > 0 && (
        <ul className="blocker-list">
          {error.blockers.map((b, i) => (
            <li key={i}>
              <code>{b.code}</code> {b.message}
              {b.line ? <span className="muted"> (line {b.line})</span> : null}
            </li>
          ))}
        </ul>
      )}
      {details && !Array.isArray(error.blockers) && typeof details === 'object' && (
        <pre className="details">{JSON.stringify(details, null, 2)}</pre>
      )}
      {error.requestId && <p className="muted small">Request reference: {error.requestId}</p>}
    </Banner>
  );
}

export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const reload = useCallback(() => {
    let active = true;
    setState((prev) => ({ ...prev, loading: true }));
    loader()
      .then((data) => active && setState({ data, error: null, loading: false }))
      .catch((error) => active && setState({ data: null, error, loading: false }));
    return () => {
      active = false;
    };
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

export { ApiError };
