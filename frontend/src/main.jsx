import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Building2, Calculator, CircleDollarSign, ClipboardCheck, ClipboardList, FileText,
  LayoutDashboard, LogIn, Menu, Radar, ShieldCheck, Truck, Users, Warehouse
} from 'lucide-react';
import './styles.css';
import './theme.css';
import './reference.css';
import './responsive.css';

import { announceDataChanged, api, post, token } from './api.js';
import { Avatar, Modal } from './ui.jsx';
import NotificationBell from './NotificationBell.jsx';
import NavBar from './NavBar.jsx';
import AccountMenu from './AccountMenu.jsx';
import AccountPanel from './AccountPanel.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Projects from './pages/Projects.jsx';
import Tasks from './pages/Tasks.jsx';
import People from './pages/People.jsx';
import Materials from './pages/Materials.jsx';
import Fleet from './pages/Fleet.jsx';
import Finance from './pages/Finance.jsx';
import DailyReports from './pages/DailyReports.jsx';
import Reports from './pages/Reports.jsx';
import Admin from './pages/Admin.jsx';
import Coordination from './pages/Coordination.jsx';
import QuantitySurveying from './pages/QuantitySurveying.jsx';

const NAV = [
  ['Dashboard', LayoutDashboard, null],
  ['Coordination', Radar, 'projects.view'],
  ['Projects', Building2, 'projects.view'],
  ['Tasks', ClipboardCheck, 'projects.view'],
  ['Quantity Surveying', Calculator, 'qs.view'],
  ['People', Users, 'hr.view'],
  ['Materials', Warehouse, 'store.view'],
  ['Fleet', Truck, 'transport.view'],
  ['Finance', CircleDollarSign, 'finance.view'],
  ['Daily reports', FileText, 'projects.view'],
  ['Reports', ClipboardList, null],
  ['Administration', ShieldCheck, 'admin.users']
];

/**
 * Capability comes from the server, not from a list kept in the client. With roles under
 * the MD's control (PID v3 §2.2), any hardcoded mapping here would be wrong the moment a
 * role changed. The API enforces the same grants regardless — this only decides what to show.
 */
const capabilities = permissions => {
  const held = new Set(permissions || []);
  const any = (...keys) => keys.some(key => held.has(key));
  return {
    has: key => held.has(key),
    manage: any('admin.users'),
    roles: any('admin.roles'),
    audit: any('admin.audit'),
    projects: any('projects.manage'),
    schedule: any('projects.schedule'),
    resources: any('resources.view'),
    reassign: any('resources.reassign'),
    enquiries: any('enquiries.manage'),
    site: any('site.tasks'),
    reports: any('site.reports'),
    attendance: any('site.attendance'),
    stock: any('store.manage'),
    lending: any('store.lending'),
    purchasing: any('store.manage', 'finance.pay'),
    finance: any('finance.manage'),
    money: any('finance.view', 'finance.manage'),
    invoice: any('finance.invoice'),
    hr: any('hr.manage'),
    hrImport: any('hr.attendance'),
    payroll: any('hr.payroll'),
    qs: any('qs.boq'),
    quotation: any('qs.quotation'),
    tender: any('qs.tender'),
    retention: any('qs.retention'),
    subcontractors: any('subcontractors.manage'),
    transport: any('transport.manage')
  };
};

function Login({ onLogin }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const result = await post('/auth/login', { email: form.get('email'), password: form.get('password') });
      token.set(result.token);
      onLogin(result.user);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="login-page">
    <div className="login-brand">
      <span><img src="/brand/gkuc-mark-256.png" alt="" width="34" height="37" /></span>
      <strong>GKUC</strong><small>CONSTRUCTION SITEOPS</small>
    </div>
    <form className="login-panel" onSubmit={submit}>
      <div>
        <p className="eyebrow">SECURE OPERATIONS PORTAL</p>
        <h1>Sign in to SiteOps</h1>
        <p>Use your company account to access assigned projects and workflows.</p>
      </div>
      <label>Email address<input type="email" name="email" defaultValue="owner@gkuc.lk" required /></label>
      <label>Password<input type="password" name="password" defaultValue="GKUC@2026" required /></label>
      {error && <p className="login-error">{error}</p>}
      <button className="primary" disabled={busy}><LogIn size={17} />{busy ? 'Signing in...' : 'Sign in'}</button>
      <small className="demo-note">Client review account: owner@gkuc.lk</small>
    </form>
  </div>;
}

/** A scanned QR label lands here: resolve the token, then jump to the asset. */
function useScanTarget() {
  const [token] = useState(() => window.location.pathname.match(/^\/scan\/([a-f0-9]{32})$/i)?.[1] || null);
  const clear = () => window.history.replaceState({}, '', '/');
  return { token, clear };
}

function ScanResult({ token, onClose }) {
  const [item, setItem] = useState(undefined);
  useEffect(() => { api(`/equipment/scan/${token}`).then(setItem).catch(() => setItem(null)); }, [token]);
  if (item === undefined) return null;
  return <Modal title={item ? `${item.code} — ${item.name}` : 'Unknown label'} close={onClose}>
    <div className="report-form">
      {item ? <>
        <div className="project-stats wide">
          <div><span>Category</span><strong>{item.category}</strong></div>
          <div><span>Status</span><strong>{item.status}</strong></div>
        </div>
        <div className="project-stats wide">
          <div><span>Currently with</span><strong>{item.holder || 'In store'}</strong></div>
          <div><span>Site</span><strong>{item.project || '—'}</strong></div>
        </div>
      </> : <p className="empty-state wide">That label does not match any equipment on record.</p>}
      <div className="form-actions"><button type="button" className="secondary" onClick={onClose}>Close</button></div>
    </div>
  </Modal>;
}

function App() {
  const [page, setPage] = useState('Dashboard');
  const [adminTab, setAdminTab] = useState('Users');
  const scan = useScanTarget();
  const [scanned, setScanned] = useState(true);
  const [menu, setMenu] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [user, setUser] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async currentUser => {
    try {
      const result = await api('/bootstrap');
      setUser(currentUser || result.user);
      setData(result.data);
      /* Panels that fetch their own rows listen for this, so a record created on one of
         them appears straight away rather than after a page reload. */
      announceDataChanged();
    } catch {
      token.clear();
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token.get()) load();
    else setLoading(false);
  }, []);

  const can = useMemo(() => capabilities(user?.permissions), [user?.permissions]);

  const logout = async () => {
    try { await post('/auth/logout'); } finally {
      token.clear();
      setUser(null);
      setData(null);
      setPage('Dashboard');
    }
  };

  if (loading) return <div className="loading-screen"><Building2 size={30} /><strong>Loading SiteOps...</strong></div>;
  if (!user || !data) return <Login onLogin={async next => { setLoading(true); await load(next); }} />;

  const reload = () => load(user);
  const shared = { data, reload, can, user };

  const visibleNav = NAV.filter(([, , permission]) => !permission || can.has(permission));
  /*
   * The page being viewed is state, but whether it may be viewed is not — it follows the
   * permissions, which can change underneath it: signing in as someone else, or the MD
   * turning a permission off while the person is looking at that very screen. Deriving the
   * active page from what is currently visible means those cases land on the dashboard
   * instead of a screen that will only ever sit there loading.
   */
  const activePage = visibleNav.some(([name]) => name === page) ? page : 'Dashboard';

  const content = {
    Dashboard: <Dashboard {...shared} go={setPage} />,
    Coordination: <Coordination {...shared} />,
    'Quantity Surveying': <QuantitySurveying {...shared} />,
    Projects: <Projects {...shared} />,
    Tasks: <Tasks {...shared} />,
    People: <People {...shared} />,
    Materials: <Materials {...shared} />,
    Fleet: <Fleet {...shared} />,
    Finance: <Finance {...shared} />,
    'Daily reports': <DailyReports {...shared} />,
    Reports: <Reports {...shared} />,
    Administration: <Admin {...shared} initialTab={adminTab} />
  }[activePage] || <Dashboard {...shared} go={setPage} />;
  const openTasks = data.tasks.filter(task => task.status !== 'Completed' && task.status !== 'Approved').length;
  /* A dialog rather than a page, because everyone may change their own password but most
     people cannot open the Administration page it would otherwise live on. */
  const openAccount = () => { setAccountOpen(true); setMenu(false); };
  const openNotifications = () => {
    setAdminTab('Notifications');
    setPage('Administration');
    setMenu(false);
  };
  const bell = placement => (
    <NotificationBell notifications={data.notifications} reload={reload} onViewAll={openNotifications} placement={placement} />
  );

  return <div className="app">
    {scan.token && scanned && <ScanResult token={scan.token} onClose={() => { setScanned(false); scan.clear(); }} />}
    {accountOpen && (
      <Modal title="My account" close={() => setAccountOpen(false)}>
        <AccountPanel onDone={() => setAccountOpen(false)} />
      </Modal>
    )}
    <aside className={menu ? 'open' : ''}>
      <div className="brand">
        <span><img src="/brand/gkuc-mark-128.png" alt="" width="26" height="29" /></span>
        <div><strong>GKUC</strong><small>SITEOPS</small></div>
      </div>
      <NavBar
        items={visibleNav}
        activePage={activePage}
        openTasks={openTasks}
        onSelect={name => { setPage(name); setMenu(false); }}
      />
      <div className="sidebar-bottom">
        {bell('bar')}
        <AccountMenu user={user} onLogout={logout} onAccount={openAccount} />
      </div>
    </aside>

    <div className="workspace">
      <header>
        <button className="menu-btn" aria-label="Menu" title="Menu" onClick={() => setMenu(!menu)}><Menu size={20} /></button>
        <div className="mobile-brand">
          <img src="/brand/gkuc-mark-128.png" alt="" width="22" height="24" />GKUC SITEOPS
        </div>
        <div className="header-actions">
          {bell('topbar')}
          <AccountMenu user={user} onLogout={logout} onAccount={openAccount} />
        </div>
      </header>
      <main>{content}</main>
    </div>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
