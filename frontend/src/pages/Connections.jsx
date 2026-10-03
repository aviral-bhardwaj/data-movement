import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api';
import StatusBadge from '../components/StatusBadge';

export default function Connections() {
  const [rows, setRows] = React.useState([]);
  const nav = useNavigate();
  const load = () => api.get('/connections').then((r) => setRows(r.data));
  React.useEffect(() => { load(); }, []);

  const act = async (id, action) => { await api.post(`/connections/${id}/${action}`); load(); };
  const del = async (id) => { if (confirm('Delete this connection and its state?')) { await api.delete(`/connections/${id}`); load(); } };

  return (
    <div>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Connections</h1>
        <button className="btn shrink" onClick={() => nav('/connections/new')}>+ New connection</button>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Pipeline</th><th>Schedule</th><th>Status</th><th>Last sync</th><th>Streams</th><th></th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td><Link to={`/connections/${c.id}`}>{c.name}</Link></td>
                <td><span className="conn-flow">{c.source_connector} <span className="arrow">→</span> {c.destination_connector}</span></td>
                <td className="muted">{c.schedule_type}{c.schedule_value ? ` (${c.schedule_value})` : ''}</td>
                <td><StatusBadge status={c.last_status || c.status} /></td>
                <td className="muted">{c.last_finished ? new Date(c.last_finished).toLocaleString() : 'never'}</td>
                <td>{c.catalog?.streams?.length ?? 0}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn small" onClick={() => act(c.id, 'sync')}>Sync now</button>{' '}
                  {c.status === 'active'
                    ? <button className="btn small secondary" onClick={() => act(c.id, 'pause')}>Pause</button>
                    : <button className="btn small secondary" onClick={() => act(c.id, 'resume')}>Resume</button>}{' '}
                  <button className="btn small danger" onClick={() => del(c.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted">No connections yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
