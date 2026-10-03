import React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import api from '../api';

export default function Layout() {
  const nav = useNavigate();
  const [user, setUser] = React.useState(null);
  React.useEffect(() => { api.get('/auth/me').then((r) => setUser(r.data)).catch(() => {}); }, []);
  const logout = () => { localStorage.removeItem('dm_token'); nav('/login'); };
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Data<span>Move</span></div>
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/connections">Connections</NavLink>
        <NavLink to="/sources">Sources</NavLink>
        <NavLink to="/destinations">Destinations</NavLink>
        <NavLink to="/connectors">Connector Catalog</NavLink>
        <NavLink to="/syncs">Sync Jobs</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </aside>
      <main className="main">
        <div className="topbar">
          <div />
          <div className="user" onClick={logout} title="Click to log out">
            {user ? `${user.email} (${user.role}) — logout` : ''}
          </div>
        </div>
        <Outlet />
      </main>
    </div>
  );
}
