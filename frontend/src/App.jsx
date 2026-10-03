import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Connections from './pages/Connections';
import ConnectionDetail from './pages/ConnectionDetail';
import ConnectionNew from './pages/ConnectionNew';
import Sources from './pages/Sources';
import Destinations from './pages/Destinations';
import Connectors from './pages/Connectors';
import Syncs from './pages/Syncs';
import Settings from './pages/Settings';

export default function App() {
  const authed = !!localStorage.getItem('dm_token');
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={authed ? <Layout /> : <Navigate to="/login" />}>
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
    </Routes>
  );
}
