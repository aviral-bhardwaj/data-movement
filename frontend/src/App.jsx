import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Landing from './pages/Landing';
import Login from './pages/Login';

// code-split the app pages — keeps the landing bundle small
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const Connections = React.lazy(() => import('./pages/Connections'));
const ConnectionDetail = React.lazy(() => import('./pages/ConnectionDetail'));
const ConnectionNew = React.lazy(() => import('./pages/ConnectionNew'));
const Sources = React.lazy(() => import('./pages/Sources'));
const Destinations = React.lazy(() => import('./pages/Destinations'));
const Connectors = React.lazy(() => import('./pages/Connectors'));
const Syncs = React.lazy(() => import('./pages/Syncs'));
const Settings = React.lazy(() => import('./pages/Settings'));

const Fallback = (
  <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
    <span className="spinner" style={{ width: 26, height: 26 }} />
  </div>
);

export default function App() {
  const authed = !!localStorage.getItem('dm_token');
  return (
    <React.Suspense fallback={Fallback}>
      <Routes>
        {/* public */}
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />

        {/* authenticated app */}
        <Route path="/app" element={authed ? <Layout /> : <Navigate to="/login" />}>
          <Route index element={<Dashboard />} />
          <Route path="connections" element={<Connections />} />
          <Route path="connections/new" element={<ConnectionNew />} />
          <Route path="connections/:id" element={<ConnectionDetail />} />
          <Route path="sources" element={<Sources />} />
          <Route path="destinations" element={<Destinations />} />
          <Route path="connectors" element={<Connectors />} />
          <Route path="syncs" element={<Syncs />} />
          <Route path="settings" element={<Settings />} />
        </Route>

        {/* legacy paths -> /app */}
        <Route path="/connections/*" element={<Navigate to={authed ? '/app/connections' : '/login'} />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </React.Suspense>
  );
}
