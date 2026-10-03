import React from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../api';
import StatusBadge from '../components/StatusBadge';

export default function ConnectionDetail() {
  const { id } = useParams();
  const [conn, setConn] = React.useState(null);
  const [jobs, setJobs] = React.useState([]);
  const [tab, setTab] = React.useState('jobs');
  const [logs, setLogs] = React.useState(null);
  const [logJob, setLogJob] = React.useState(null);

  const load = () => {
    api.get(`/connections/${id}`).then((r) => setConn(r.data));
    api.get(`/connections/${id}/jobs`).then((r) => setJobs(r.data));
  };
  React.useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [id]);

  const showLogs = async (jobId) => {
    setLogJob(jobId);
    const r = await api.get(`/syncs/${jobId}/logs?limit=500`);
    setLogs(r.data.reverse());
  };

  if (!conn) return <div className="main">loading…</div>;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>{conn.name}</h1>
        <button className="btn shrink" onClick={async () => { await api.post(`/connections/${id}/sync`); load(); }}>Sync now</button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {conn.source_connector} → {conn.destination_connector} · schedule: {conn.schedule_type}{conn.schedule_value ? ` (${conn.schedule_value})` : ''} · <StatusBadge status={conn.status} />
        {conn.webhook_url && <> · webhook: <code>{conn.webhook_url}</code></>}
      </p>

      <div className="tabs">
        <button className={tab === 'jobs' ? 'active' : ''} onClick={() => setTab('jobs')}>Sync history</button>
        <button className={tab === 'streams' ? 'active' : ''} onClick={() => setTab('streams')}>Streams</button>
        <button className={tab === 'state' ? 'active' : ''} onClick={() => setTab('state')}>State</button>
      </div>

      {tab === 'jobs' && (
        <div className="card">
          <table>
            <thead><tr><th>Started</th><th>Status</th><th>Trigger</th><th>Attempt</th><th>Read</th><th>Written</th><th>Failed</th><th></th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="muted">{new Date(j.created_at).toLocaleString()}</td>
                  <td><StatusBadge status={j.status} /></td>
                  <td>{j.trigger_type}</td>
                  <td>{j.attempt}</td>
                  <td>{Number(j.records_read).toLocaleString()}</td>
                  <td>{Number(j.records_written).toLocaleString()}</td>
                  <td>{j.records_failed > 0 ? <span style={{ color: 'var(--err)' }}>{j.records_failed}</span> : 0}</td>
                  <td><button className="btn small secondary" onClick={() => showLogs(j.id)}>logs</button></td>
                </tr>
              ))}
              {!jobs.length && <tr><td colSpan={8} className="muted">No syncs yet.</td></tr>}
            </tbody>
          </table>
          {logJob && (
            <div style={{ marginTop: 16 }}>
              <h4>Logs — job {logJob.slice(0, 8)} <button className="btn small secondary" onClick={() => setLogJob(null)}>close</button></h4>
              <div style={{ maxHeight: 320, overflow: 'auto' }}>
                {(logs || []).map((l) => (
                  <div key={l.id} className={`log-line ${l.level}`}>
                    <span className="muted">{new Date(l.ts).toLocaleTimeString()}</span> [{l.level}] {l.message}
                  </div>
                ))}
                {logs && !logs.length && <div className="muted">no logs</div>}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'streams' && (
        <div className="card">
          <table>
            <thead><tr><th>Stream</th><th>Mode</th><th>Cursor</th><th>Primary key</th><th>Destination</th></tr></thead>
            <tbody>
              {conn.catalog?.streams?.map((s) => (
                <tr key={s.name}>
                  <td>{s.namespace ? `${s.namespace}.` : ''}{s.name}</td>
                  <td><span className="pill">{s.syncMode}</span></td>
                  <td>{s.cursorField || '—'}</td>
                  <td>{s.primaryKey?.join(', ') || '—'}</td>
                  <td>{s.destinationName || s.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'state' && (
        <div className="card">
          <pre>{JSON.stringify(conn.state, null, 2)}</pre>
          <button className="btn danger small" onClick={async () => { if (confirm('Reset all cursor state?')) { await api.delete(`/connections/${id}/state`); load(); } }}>Reset state</button>
        </div>
      )}
    </div>
  );
}
