import React from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import StatusBadge from '../components/StatusBadge';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export default function Dashboard() {
  const [overview, setOverview] = React.useState(null);
  const [series, setSeries] = React.useState([]);
  const [jobs, setJobs] = React.useState([]);
  const [health, setHealth] = React.useState(null);

  const load = () => {
    api.get('/metrics/overview').then((r) => setOverview(r.data));
    api.get('/metrics/timeseries?hours=24').then((r) => setSeries(r.data.map((d) => ({ ...d, bucket: new Date(d.bucket).toLocaleTimeString([], { hour: '2-digit' }) }))));
    api.get('/syncs?limit=8').then((r) => setJobs(r.data));
    api.get('/health').then((r) => setHealth(r.data));
  };
  React.useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);

  const h = overview?.last24h || {};
  return (
    <div>
      <h1>Dashboard</h1>
      <div className="grid cols4">
        <div className="card"><div className="stat">{overview?.connections?.active ?? '—'}</div><div className="stat-label">Active connections</div></div>
        <div className="card"><div className="stat">{h.total ?? '—'}</div><div className="stat-label">Syncs (24h)</div></div>
        <div className="card"><div className="stat" style={{ color: 'var(--ok)' }}>{Number(h.rows_written || 0).toLocaleString()}</div><div className="stat-label">Rows written (24h)</div></div>
        <div className="card"><div className="stat" style={{ color: h.failed > 0 ? 'var(--err)' : 'var(--ok)' }}>{h.failed ?? '—'}</div><div className="stat-label">Failed syncs (24h)</div></div>
      </div>

      <div className="grid cols2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Rows written — last 24h</h3>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={series}>
              <XAxis dataKey="bucket" stroke="#8a97b8" fontSize={11} />
              <YAxis stroke="#8a97b8" fontSize={11} />
              <Tooltip contentStyle={{ background: '#1d2739', border: '1px solid #2a3549' }} />
              <Area type="monotone" dataKey="rows_written" stroke="#4f7cff" fill="#4f7cff33" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>System health</h3>
          {health ? (
            <div>
              <p>Postgres: <StatusBadge status={health.checks?.postgres === 'up' ? 'succeeded' : 'failed'} /></p>
              <p>Redis: <StatusBadge status={health.checks?.redis === 'up' ? 'succeeded' : 'failed'} /></p>
              <p className="muted">Connectors installed: {health.connectors} · Queue: waiting {health.queue?.waiting ?? 0}, active {health.queue?.active ?? 0}</p>
            </div>
          ) : 'loading…'}
        </div>
      </div>

      <div className="card">
        <div className="row"><h3 style={{ margin: 0 }}>Recent syncs</h3><Link to="/syncs" className="shrink">view all →</Link></div>
        <table>
          <thead><tr><th>Connection</th><th>Status</th><th>Trigger</th><th>Read</th><th>Written</th><th>Failed</th><th>Finished</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td><Link to={`/connections/${j.connection_id}`}>{j.connection_name}</Link></td>
                <td><StatusBadge status={j.status} /></td>
                <td>{j.trigger_type}</td>
                <td>{Number(j.records_read).toLocaleString()}</td>
                <td>{Number(j.records_written).toLocaleString()}</td>
                <td>{j.records_failed > 0 ? <span style={{ color: 'var(--err)' }}>{j.records_failed}</span> : 0}</td>
                <td className="muted">{j.finished_at ? new Date(j.finished_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
            {!jobs.length && <tr><td colSpan={7} className="muted">No syncs yet — create a connection to get started.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
