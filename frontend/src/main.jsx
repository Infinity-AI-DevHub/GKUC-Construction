import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Building2, Calculator, ChevronDown, CircleDollarSign, ClipboardCheck, ClipboardList, FileText,
  LayoutDashboard, LogIn, LogOut, Menu, Radar, ShieldCheck, Truck, Users, Warehouse
} from 'lucide-react';
import './styles.css';
import './theme.css';
import './reference.css';
import './responsive.css';

import { api, post, token } from './api.js';
import { Avatar, Modal } from './ui.jsx';
import NotificationBell from './NotificationBell.jsx';
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
    <div className="login-brand"><span><Building2 size={28} /></span><strong>GKUC</strong><small>CONSTRUCTION SITEOPS</small></div>
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
  const [user, setUser] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async currentUser => {
    try {
      const result = await api('/bootstrap');
      setUser(currentUser || result.user);
      setData(result.data);
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
    }
  };

  if (loading) return <div className="loading-screen"><Building2 size={30} /><strong>Loading SiteOps...</strong></div>;
  if (!user || !data) return <Login onLogin={async next => { setLoading(true); await load(next); }} />;

  const reload = () => load(user);
  const shared = { data, reload, can, user };
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
  }[page] || <Dashboard {...shared} go={setPage} />;

  const visibleNav = NAV.filter(([, , permission]) => !permission || can.has(permission));
  const openTasks = data.tasks.filter(task => task.status !== 'Completed' && task.status !== 'Approved').length;
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
    <aside className={menu ? 'open' : ''}>
      <div className="brand">
        <span><Building2 size={22} /></span>
        <div><strong>GKUC</strong><small>SITEOPS</small></div>
      </div>
      <nav>
        {visibleNav.map(([name, Icon]) => (
          <button className={page === name ? 'active' : ''} key={name} onClick={() => { setPage(name); setMenu(false); }}>
            <Icon size={18} /><span>{name}</span>
            {name === 'Tasks' && openTasks > 0 && <b>{openTasks}</b>}
          </button>
        ))}
      </nav>
      <div className="sidebar-bottom">
        {bell('bar')}
        <button onClick={logout} title="Sign out"><LogOut size={18} />Sign out</button>
        <div className="profile">
          <Avatar name={user.name} />
          <div><strong>{user.name}</strong><span>{user.role}</span></div>
          <ChevronDown size={15} />
        </div>
      </div>
    </aside>

    <div className="workspace">
      <header>
        <button className="menu-btn" aria-label="Menu" title="Menu" onClick={() => setMenu(!menu)}><Menu size={20} /></button>
        <div className="mobile-brand">GKUC SITEOPS</div>
        <div className="header-actions">
          {bell('topbar')}
          <div className="header-user">
            <Avatar name={user.name} />
            <div><strong>{user.name}</strong><span>{user.role}</span></div>
          </div>
        </div>
      </header>
      <main>{content}</main>
    </div>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
