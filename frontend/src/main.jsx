import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Building2, Calculator, CircleDollarSign, ClipboardCheck, ClipboardList, FileText,
  LayoutDashboard, LogIn, Menu, Radar, ShieldCheck, Truck, Users, Warehouse, MessageSquare, HardDrive } from 'lucide-react';
import './styles.css';
import './theme.css';
import './reference.css';
import './responsive.css';

import { announceDataChanged, api, post, setUploadLimit, slug, token } from './api.js';
import { Avatar, Modal } from './ui.jsx';
import NotificationBell from './NotificationBell.jsx';
import Banners, { useBanners, SoundToggle } from './Banners.jsx';
import DocumentSearch, { DocumentSearchButton } from './DocumentSearch.jsx';
import Tour from './Tour.jsx';
import Chat from './Chat.jsx';
import Drive from './Drive.jsx';
import { onRealtime, startRealtime, stopRealtime } from './realtime.js';
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
import Admin, { TABS as ADMIN_TABS } from './pages/Admin.jsx';
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
  ['Chat', MessageSquare, 'chat.use'],
  ['Drive', HardDrive, 'drive.use'],
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
    messages: any('messages.send'),
    lists: any('admin.lists'),
    chat: any('chat.use'),
    drive: any('drive.use'),
    projects: any('projects.manage'),
    gallery: any('gallery.manage'),
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
      {/*
        * Never prefilled in a build.
        *
        * These carried the Managing Director's address and password as defaults so the
        * client could click straight in during review. Shipped, that hands the top account
        * to anyone who opens the page, so the convenience is limited to the dev server.
        */}
      <label>Email address<input type="email" name="email" autoComplete="username"
        defaultValue={import.meta.env.DEV ? 'owner@gkuc.lk' : ''} required /></label>
      <label>Password<input type="password" name="password" autoComplete="current-password"
        defaultValue={import.meta.env.DEV ? 'GKUC@2026' : ''} required /></label>
      {error && <p className="login-error">{error}</p>}
      <button className="primary" disabled={busy}><LogIn size={17} />{busy ? 'Signing in...' : 'Sign in'}</button>
      {import.meta.env.DEV && <small className="demo-note">Development sign-in: owner@gkuc.lk</small>}
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

/*
 * The address bar is the source of truth for which page is open.
 *
 * The navigation used to move a piece of React state and nothing else, so every screen sat
 * at "/" — the back button left the app entirely, a reload always returned to the
 * dashboard, and a page could not be sent to a colleague as a link. Each section now has a
 * path of its own, pushed with the History API, and the page is read back out of the URL.
 *
 * Only the section is in the path. What is open *within* a section — a tab, a dialog, the
 * row being looked at — deliberately is not: those are working state, and putting them in
 * the URL would fill a person's history with steps they never chose to take. The one
 * exception is the Administration tab, because alerts elsewhere in the product link
 * straight to the notification centre.
 */
const pathFor = (name, tab) => {
  if (name === 'Dashboard') return '/';
  const base = `/${slug(name)}`;
  return tab && tab !== 'Users' ? `${base}/${slug(tab)}` : base;
};

const pageFromPath = pathname => {
  const [section] = pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (!section) return 'Dashboard';
  return NAV.find(([name]) => slug(name) === section)?.[0] || null;
};

const adminTabFromPath = (pathname, tabs) => {
  const [, second] = pathname.replace(/^\/+|\/+$/g, '').split('/');
  return tabs.find(tab => slug(tab) === second) || 'Users';
};

function App() {
  /* Read from the address bar on first paint, so a deep link or a reload opens the page
     that was asked for rather than always the dashboard. */
  const [page, setPage] = useState(() => pageFromPath(window.location.pathname) || 'Dashboard');
  const [adminTab, setAdminTab] = useState(() => adminTabFromPath(window.location.pathname, ADMIN_TABS));
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
      /* So the upload limit quoted to people is the server's, not a guess baked in here. */
      setUploadLimit(result.limits?.maxUploadMb);
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

  const banners = useBanners();
  const [live, setLive] = useState(false);
  const [searching, setSearching] = useState(false);
  /*
   * Shown once, the first time somebody signs in. Held here rather than read straight from
   * the user record so that finishing it closes the tour immediately, without waiting for
   * the next reload to notice.
   */
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => { if (user && !user.tourSeenAt) setTourOpen(true); }, [user?.id, user?.tourSeenAt]);

  /*
   * The live connection, held for as long as somebody is signed in.
   *
   * Two kinds of event arrive. A notification is shown as a banner and rings; a data event
   * means something was written somewhere and whatever is on screen should be re-read. The
   * re-read goes through the ordinary bootstrap call, so the viewer still only receives
   * what their permissions allow — the push is a prompt to refresh, never the data itself.
   *
   * Refreshes are coalesced: a bulk action can announce twenty changes in a second, and
   * twenty bootstrap calls would be slower than the reload they are trying to avoid.
   */
  useEffect(() => {
    if (!user) return undefined;
    let pending = null;

    const off = onRealtime((type, payload) => {
      if (type === 'connected') setLive(true);
      else if (type === 'disconnected') setLive(false);
      else if (type === 'unauthorised') { setLive(false); token.clear(); setUser(null); }
      else if (type === 'notification' || type === 'banner') {
        banners.show(payload);
        clearTimeout(pending);
        pending = setTimeout(() => load(user), 250);
      } else if (type === 'data') {
        clearTimeout(pending);
        pending = setTimeout(() => load(user), 250);
      }
    });

    startRealtime();
    return () => { off(); stopRealtime(); clearTimeout(pending); setLive(false); };
  }, [user?.id]);

  /* The back and forward buttons move between sections rather than out of the app. */
  useEffect(() => {
    const onPop = () => {
      setPage(pageFromPath(window.location.pathname) || 'Dashboard');
      setAdminTab(adminTabFromPath(window.location.pathname, ADMIN_TABS));
      setMenu(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /*
   * One way in and out of a section, so the address bar and the screen cannot disagree.
   * Navigating to the section already open replaces the entry instead of stacking another,
   * which otherwise makes the back button appear to do nothing.
   */
  const goTo = (name, tab) => {
    const path = pathFor(name, tab);
    const method = path === `${window.location.pathname}` ? 'replaceState' : 'pushState';
    window.history[method]({}, '', path);
    setPage(name);
    if (tab) setAdminTab(tab);
    else if (name !== 'Administration') setAdminTab('Users');
    setMenu(false);
  };

  const can = useMemo(() => capabilities(user?.permissions), [user?.permissions]);

  const logout = async () => {
    try { await post('/auth/logout'); } finally {
      token.clear();
      setUser(null);
      setData(null);
      goTo('Dashboard');
    }
  };

  const visibleNav = NAV.filter(([, , permission]) => !permission || can.has(permission));
  /*
   * The page being viewed is state, but whether it may be viewed is not — it follows the
   * permissions, which can change underneath it: signing in as someone else, or the MD
   * turning a permission off while the person is looking at that very screen. Deriving the
   * active page from what is currently visible means those cases land on the dashboard
   * instead of a screen that will only ever sit there loading.
   */
  const activePage = visibleNav.some(([name]) => name === page) ? page : 'Dashboard';

  /*
   * Keep the address bar honest.
   *
   * A path can name a section that does not exist, or one this person is not allowed to
   * open — a link passed between colleagues with different permissions does exactly that.
   * The page falls back to the dashboard either way, and the URL is corrected to match so
   * that a reload does not send them back to a page they cannot see.
   *
   * Declared above the early returns below: a hook that only runs on some renders changes
   * the hook order between them, which React refuses outright.
   */
  useEffect(() => {
    if (!user || !data) return;
    const wanted = pathFor(activePage, activePage === 'Administration' ? adminTab : null);
    if (window.location.pathname !== wanted) window.history.replaceState({}, '', wanted);
  }, [activePage, adminTab, user, data]);

  if (loading) return <div className="loading-screen"><Building2 size={30} /><strong>Loading SiteOps...</strong></div>;
  if (!user || !data) return <Login onLogin={async next => { setLoading(true); await load(next); }} />;

  const reload = () => load(user);
  const shared = { data, reload, can, user };

  /* Declared above the page map, which now references it: the dashboard's alert card offers
     a way through to the full notification centre. */
  const openNotifications = () => goTo('Administration', 'Notifications');

  const content = {
    Dashboard: <Dashboard {...shared} go={goTo} onViewAlerts={openNotifications} />,
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
    Chat: <Chat user={user} />,
    Drive: <Drive user={user} />,
    Administration: <Admin {...shared} initialTab={adminTab} onTabChange={tab => goTo('Administration', tab)} />
  }[activePage] || <Dashboard {...shared} go={goTo} />;

  const openTasks = data.tasks.filter(task => task.status !== 'Completed' && task.status !== 'Approved').length;
  /* A dialog rather than a page, because everyone may change their own password but most
     people cannot open the Administration page it would otherwise live on. */
  const openAccount = () => { setAccountOpen(true); setMenu(false); };
  const bell = placement => (
    /* The placement travels on the group, not only on the bell inside it. The bell is
       rendered in both the bar and the header with CSS showing whichever fits the width;
       when search and sound joined it, only the bell was being hidden — so both copies of
       the other two stayed on screen. */
    <span className={`bell-group bell-group-${placement}${live ? ' is-live' : ''}`}
      title={live ? 'Live — updates arrive as they happen' : 'Reconnecting to live updates…'}>
      <DocumentSearchButton onOpen={() => setSearching(true)} />
      <SoundToggle />
      <NotificationBell notifications={data.notifications} reload={reload} onViewAll={openNotifications} placement={placement} />
    </span>
  );

  return <div className="app">
    <Banners items={banners.items} onDismiss={banners.dismiss} onOpen={openNotifications} />
    <DocumentSearch open={searching} onClose={() => setSearching(false)} />
    {tourOpen && <Tour user={user} can={can} onNavigate={goTo}
      onClose={() => { setTourOpen(false); setUser(current => ({ ...current, tourSeenAt: new Date().toISOString() })); }} />}
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
        onSelect={goTo}
      />
      <div className="sidebar-bottom">
        {bell('bar')}
        <AccountMenu user={user} onLogout={logout} onAccount={openAccount} onTour={() => setTourOpen(true)} />
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
