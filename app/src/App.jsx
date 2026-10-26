import React, { Suspense, lazy } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { SessionProvider, useSession } from './session.jsx';
import { Button, Loading, ToastProvider } from './components.jsx';

const Overview = lazy(() => import('./pages/Overview.jsx'));
const Billing = lazy(() => import('./pages/Billing.jsx'));
const Documents = lazy(() => import('./pages/Documents.jsx'));
const DocumentDetail = lazy(() => import('./pages/Documents.jsx').then((m) => ({ default: m.DocumentDetail })));
const ReturnsPage = lazy(() => import('./pages/Returns.jsx'));
const Inventory = lazy(() => import('./pages/Inventory.jsx'));
const Purchases = lazy(() => import('./pages/Purchases.jsx'));
const Customers = lazy(() => import('./pages/Customers.jsx'));
const Suppliers = lazy(() => import('./pages/Suppliers.jsx'));
const Payments = lazy(() => import('./pages/Payments.jsx'));
const Accounts = lazy(() => import('./pages/Accounts.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Staff = lazy(() => import('./pages/Staff.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Audit = lazy(() => import('./pages/Audit.jsx'));
const SignIn = lazy(() => import('./pages/SignIn.jsx'));

const ROUTES = {
  overview: '/',
  billing: '/billing',
  documents: '/documents',
  returns: '/returns',
  inventory: '/inventory',
  purchases: '/purchases',
  customers: '/customers',
  suppliers: '/suppliers',
  payments: '/payments',
  accounts: '/accounts',
  reports: '/reports',
  staff: '/staff',
  settings: '/settings',
  audit: '/audit',
};

const PAGE_META = {
  overview: { title: 'Overview', subtitle: 'Sales, money and stock at a glance' },
  billing: { title: 'Billing & POS', subtitle: 'Quote, check and issue a bill' },
  documents: { title: 'Documents & printing', subtitle: 'Immutable invoices, credit notes and reprints' },
  returns: { title: 'Returns & credit notes', subtitle: 'Entitlement-checked returns, separate from refunds' },
  inventory: { title: 'Inventory', subtitle: 'Batches, expiry and approved adjustments' },
  purchases: { title: 'Purchases & supplier returns', subtitle: 'Supplier bills, input tax and returns' },
  customers: { title: 'Customers & pets', subtitle: 'Billing parties and pet identifiers only' },
  suppliers: { title: 'Suppliers', subtitle: 'Vendors and their GST details' },
  payments: { title: 'Payments & cash close', subtitle: 'Confirmed money, refunds and cash variance' },
  accounts: { title: 'Accounts & ledgers', subtitle: 'Double-entry journals, trial balance and reconciliation' },
  reports: { title: 'Reports', subtitle: 'Twelve operating tabs with working-paper labels' },
  staff: { title: 'Staff & permissions', subtitle: 'Named cashiers and least-privilege roles' },
  settings: { title: 'Settings & compliance readiness', subtitle: 'Legal profile, numbering and blockers' },
  audit: { title: 'Audit & exports', subtitle: 'Append-only trail with tamper evidence' },
};

function Shell({ children }) {
  const { session, can } = useSession();
  const location = useLocation();
  const nav = session?.navigation || [];
  const current = Object.entries(ROUTES).find(([, path]) => (path === '/' ? location.pathname === '/' : location.pathname.startsWith(path)));
  const meta = PAGE_META[current?.[0]] || PAGE_META.overview;

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">◈</span>
          <div>
            <strong>shop desk</strong>
            <span className="brand-sub">billing · stock · books</span>
          </div>
        </div>
        <nav className="nav scroll-y">
          {nav.map((item) => {
            const path = ROUTES[item.key] || '/';
            const active = path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
            return (
              <Link key={item.key} to={path} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
                <span className="nav-dot" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <p className="tiny muted">
            Signed in as <strong>{session?.user?.name}</strong>
            <br />
            {session?.roleLabel}
          </p>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              await import('./api.js').then(({ api }) => api('/logout', { method: 'POST', body: {} }).catch(() => {}));
              window.location.href = '/';
            }}
          >
            <Button variant="ghost" size="sm" type="submit">
              Sign out
            </Button>
          </form>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="context">
            <span className="context-tenant">{session?.tenant?.name || 'No workspace'}</span>
            {session?.tenant?.sample && <span className="chip chip-warn">sample data</span>}
            <span className="context-sep" aria-hidden="true">/</span>
            <span className="context-branch">{session?.branch?.name || 'No branch'}</span>
            <span className="context-sep" aria-hidden="true">/</span>
            <span className="chip chip-neutral">{session?.roleLabel}</span>
          </div>
          <div className="context-right">
            <span className="muted small">Business date {session?.businessDate}</span>
            {session?.driver === 'file' && <span className="chip chip-info" title="Local single-writer store; the production target is MongoDB Atlas.">file store</span>}
          </div>
        </header>

        <div className="page-head">
          <h1>{meta.title}</h1>
          <p className="muted">{meta.subtitle}</p>
        </div>

        <main className="content scroll-y" id="main">{children}</main>
      </div>
    </div>
  );
}

function Guard({ permission, children, navKey }) {
  const { can } = useSession();
  if (!can(permission)) {
    return (
      <div className="card">
        <h2>Not available for your role</h2>
        <p className="muted">
          Your role does not include the <code>{permission}</code> permission. Ask the owner to review{' '}
          <Link to={navKey ? ROUTES[navKey] || '/' : '/'}>your access</Link>. The API enforces the same rule, so nothing here is
          hidden by the browser alone.
        </p>
      </div>
    );
  }
  return children;
}

function AppRoutes() {
  const { loading, session } = useSession();

  if (loading) return <div className="boot"><Loading label="Opening shop desk…" /></div>;

  if (!session?.authenticated || !session?.tenant) {
    return (
      <ToastProvider>
        <Suspense fallback={<div className="boot"><Loading /></div>}>
          <SignIn />
        </Suspense>
      </ToastProvider>
    );
  }

  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/billing" element={<Guard permission="billing.use"><Billing /></Guard>} />
          <Route path="/documents" element={<Guard permission="documents.read"><Documents /></Guard>} />
          <Route path="/documents/:id" element={<Guard permission="documents.read"><DocumentDetail /></Guard>} />
          <Route path="/returns" element={<Guard permission="documents.read"><ReturnsPage /></Guard>} />
          <Route path="/inventory" element={<Guard permission="inventory.read"><Inventory /></Guard>} />
          <Route path="/purchases" element={<Guard permission="inventory.read"><Purchases /></Guard>} />
          <Route path="/customers" element={<Guard permission="customers.manage"><Customers /></Guard>} />
          <Route path="/suppliers" element={<Guard permission="suppliers.manage"><Suppliers /></Guard>} />
          <Route path="/payments" element={<Guard permission="payments.read"><Payments /></Guard>} />
          <Route path="/accounts" element={<Guard permission="accounts.read"><Accounts /></Guard>} />
          <Route path="/reports" element={<Guard permission="reports.read"><Reports /></Guard>} />
          <Route path="/staff" element={<Guard permission="staff.manage"><Staff /></Guard>} />
          <Route path="/settings" element={<Guard permission="settings.manage"><Settings /></Guard>} />
          <Route path="/audit" element={<Guard permission="audit.read"><Audit /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </ToastProvider>
  );
}
