import React from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import StatusBadge from '../components/StatusBadge';

export default function Syncs() {
  const [rows, setRows] = React.useState([]);
  const load = () => api.get('/syncs?limit=100').then((r) => setRows(r.data));
  React.useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  return (
    <div>
      <h1>Sync jobs</h1>
      <div className="card">
        <table>
          <thead><tr><th>Job</th><th>Connection</th><th>Status</th><th>Trigger</th><th>Worker</th><th>Read</th><th>Written</th><th>Failed</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {rows.map((j) => (
              <tr key={j.id}>
                <td className="muted">{j.id.slice(0, 8)}</td>
                <td><Link to={`/connections/${j.connection_id}`}>{j.connection_name}</Link></td>
                <td><StatusBadge status={j.status} /></td>
                <td>{j.trigger_type}</td>
                <td className="muted">{j.worker_id || '—'}</td>
                <td>{Number(j.records_read).toLocaleString()}</td>
                <td>{Number(j.records_written).toLocaleString()}</td>
                <td>{j.records_failed > 0 ? <span style={{ color: 'var(--err)' }}>{j.records_failed}</span> : 0}</td>
                <td className="muted">{new Date(j.created_at).toLocaleString()}</td>
                <td>{['queued', 'running'].includes(j.status) && (
                  <button className="btn small danger" onClick={async () => { await api.post(`/syncs/${j.id}/cancel`); load(); }}>Cancel</button>
                )}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={10} className="muted">No sync jobs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
