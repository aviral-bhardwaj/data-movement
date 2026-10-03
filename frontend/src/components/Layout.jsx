import React from 'react';
import { NavLink, Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import api from '../api';
import Logo from './Logo';

const Ico = ({ d }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const icons = {
  dashboard: <Ico d={<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>} />,
  connections: <Ico d={<><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>} />,
  sources: <Ico d={<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>} />,
  destinations: <Ico d={<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>} />,
  connectors: <Ico d={<><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>} />,
  syncs: <Ico d={<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>} />,
  settings: <Ico d={<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" /></>} />,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
};

export default function Layout() {
  const nav = useNavigate();
  const loc = useLocation();
  const [user, setUser] = React.useState(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [q, setQ] = React.useState('');

  React.useEffect(() => { api.get('/auth/me').then((r) => setUser(r.data)).catch(() => {}); }, []);
  React.useEffect(() => {
    const close = () => setMenuOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const logout = () => { localStorage.removeItem('dm_token'); nav('/login'); location.reload(); };
  const goSearch = (e) => {
    if (e.key === 'Enter' && q.trim()) nav(`/app/connectors?q=${encodeURIComponent(q.trim())}`);
  };
  const initials = (user?.name || user?.email || '?').slice(0, 2).toUpperCase();
  const isCatalog = loc.pathname.startsWith('/app/connectors');

  return (
    <div className="shell">
      <aside className="side">
        <Link to="/" style={{ textDecoration: 'none' }}><Logo light /></Link>
        <div className="nav-section">Pipelines</div>
        <NavLink to="/app" end className="nav-item">{icons.dashboard}Dashboard</NavLink>
        <NavLink to="/app/connections" className="nav-item">{icons.connections}Connections</NavLink>
        <NavLink to="/app/syncs" className="nav-item">{icons.syncs}Syncs</NavLink>
        <div className="nav-section">Endpoints</div>
        <NavLink to="/app/sources" className="nav-item">{icons.sources}Sources</NavLink>
        <NavLink to="/app/destinations" className="nav-item">{icons.destinations}Destinations</NavLink>
        <div className="nav-section">Platform</div>
        <NavLink to="/app/connectors" className="nav-item">{icons.connectors}Connector catalog</NavLink>
        <NavLink to="/app/settings" className="nav-item">{icons.settings}Settings</NavLink>
        <div className="side-foot">DataMove v1.0<br/>Self-hosted data integration</div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="crumb">{crumbFor(loc.pathname)}</div>
          <div className="search">
            {icons.search}
            <input placeholder="Search connectors…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={goSearch} />
          </div>
          <div className="user-menu" onClick={(e) => e.stopPropagation()}>
            <div className="avatar" onClick={() => setMenuOpen(!menuOpen)}>{initials}</div>
            {menuOpen && (
              <div className="menu">
                <div className="mi head">
                  <div style={{ fontWeight: 600 }}>{user?.name || 'Admin'}</div>
                  <div className="small muted">{user?.email}</div>
                  <div className="small" style={{ marginTop: 4 }}><span className="pill blue">{user?.role}</span></div>
                </div>
                <div className="mi" onClick={() => nav('/app/settings')}>Account settings</div>
                <div className="mi" onClick={() => nav('/')}>Product home</div>
                <div className="mi" style={{ color: 'var(--err)' }} onClick={logout}>Sign out</div>
              </div>
            )}
          </div>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function crumbFor(p) {
  const seg = p.replace(/^\/app\/?/, '').split('/')[0];
  const map = {
    '': 'Overview', connections: 'Connections', sources: 'Sources',
    destinations: 'Destinations', connectors: 'Connector catalog',
    syncs: 'Syncs', settings: 'Settings',
  };
  return map[seg] || 'Overview';
}
