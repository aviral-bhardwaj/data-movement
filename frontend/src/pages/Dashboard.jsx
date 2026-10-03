import React from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import StatusBadge from '../components/StatusBadge';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

export default function Dashboard() {
  const [overview, setOverview] = React.useState(null);
  const [series, setSeries] = React.useState([]);
  const [jobs, setJobs] = React.useState([]);
  const [health, setHealth] = React.useState(null);

  const load = () => {
    api.get('/metrics/overview').then((r) => setOverview(r.data));
    api.get('/metrics/timeseries?hours=24').then((r) => setSeries(r.data.map((d) => ({ ...d, bucket: new Date(d.bucket).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }))));
    api.get('/syncs?limit=8').then((r) => setJobs(r.data));
    api.get('/health').then((r) => setHealth(r.data));
  };
  React.useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);

  const h = overview?.last24h || {};
  const successRate = h.total ? Math.round(((h.succeeded || 0) / h.total) * 100) : null;
  return (
    <div>
      <div className="page-head">
        <div><h1>Overview</h1><div className="sub">Platform activity — refreshed live</div></div>
        <Link to="/app/connections/new" className="btn">+ New connection</Link>
      </div>

      <div className="grid cols4">
        <div className="card tight">
          <div className="stat">{overview?.connections?.active ?? '—'}</div>
          <div className="stat-label">Active connections</div>
        </div>
        <div className="card tight">
          <div className="stat">{h.total ?? '—'}</div>
          <div className="stat-label">Syncs (24h)</div>
          {successRate !== null && <div className={`stat-trend ${successRate >= 95 ? 'up' : 'down'}`}>{successRate}% success</div>}
        </div>
        <div className="card tight">
          <div className="stat" style={{ color: 'var(--ok)' }}>{Number(h.rows_written || 0).toLocaleString()}</div>
          <div className="stat-label">Rows written (24h)</div>
        </div>
        <div className="card tight">
          <div className="stat" style={{ color: h.failed > 0 ? 'var(--err)' : 'var(--text)' }}>{h.failed ?? '—'}</div>
          <div className="stat-label">Failed syncs (24h)</div>
        </div>
      </div>

      <div className="grid cols2">
        <div className="card">
          <h3>Rows written — last 24h</h3>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e3e8f0" vertical={false} />
              <XAxis dataKey="bucket" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} width={60} />
              <Tooltip contentStyle={{ background: '#fff', border: '1px solid #e3e8f0', borderRadius: 8, fontSize: 13 }} />
              <Area type="monotone" dataKey="rows_written" stroke="#0b5fff" strokeWidth={2} fill="#0b5fff" fillOpacity={0.1} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h3>System health</h3>
          {health ? (
            <div>
              <dl className="kv">
                <dt>Postgres</dt><dd><StatusBadge status={health.checks?.postgres === 'up' ? 'succeeded' : 'failed'} /></dd>
                <dt>Redis</dt><dd><StatusBadge status={health.checks?.redis === 'up' ? 'succeeded' : 'failed'} /></dd>
                <dt>Connectors</dt><dd>{health.connectors} installed</dd>
                <dt>Queue</dt><dd className="muted">waiting {health.queue?.waiting ?? 0} · active {health.queue?.active ?? 0}</dd>
              </dl>
            </div>
          ) : <div className="skeleton" style={{ height: 120 }} />}
        </div>
      </div>

      <div className="card pad0">
        <div className="row between" style={{ padding: '16px 20px 12px' }}>
          <h3 style={{ margin: 0 }}>Recent syncs</h3>
          <Link to="/app/syncs" className="small">view all →</Link>
        </div>
        <table>
          <thead><tr><th>Connection</th><th>Status</th><th>Trigger</th><th className="tr">Read</th><th className="tr">Written</th><th className="tr">Failed</th><th>Finished</th></tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td><Link to={`/app/connections/${j.connection_id}`}>{j.connection_name}</Link></td>
                <td><StatusBadge status={j.status} /></td>
                <td className="muted">{j.trigger_type}</td>
                <td className="tr">{Number(j.records_read).toLocaleString()}</td>
                <td className="tr">{Number(j.records_written).toLocaleString()}</td>
                <td className="tr">{j.records_failed > 0 ? <span style={{ color: 'var(--err)' }}>{j.records_failed}</span> : 0}</td>
                <td className="muted">{j.finished_at ? new Date(j.finished_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
            {!jobs.length && <tr><td colSpan={7} className="muted tc" style={{ padding: 30 }}>No syncs yet — <Link to="/app/connections/new">create a connection</Link> to get started.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
