import React from 'react';
import api from '../api';
import StatusBadge from '../components/StatusBadge';
import InstanceForm from '../components/InstanceForm';

export default function Sources() {
  const [rows, setRows] = React.useState([]);
  const [showForm, setShowForm] = React.useState(false);
  const load = () => api.get('/sources').then((r) => setRows(r.data));
  React.useEffect(() => { load(); }, []);

  const check = async (id) => { await api.post(`/sources/${id}/check`); load(); };
  const del = async (id) => {
    try { if (confirm('Delete source?')) { await api.delete(`/sources/${id}`); load(); } }
    catch (e) { alert(e.response?.data?.error || e.message); }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Sources</h1>
        <button className="btn shrink" onClick={() => setShowForm(!showForm)}>+ New source</button>
      </div>
      {showForm && <InstanceForm kind="source" onSaved={() => { setShowForm(false); load(); }} onCancel={() => setShowForm(false)} />}
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Connector</th><th>Status</th><th>Last check</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.icon} {s.name}</td>
                <td>{s.connector_name}</td>
                <td><StatusBadge status={s.last_check_status || s.status} /></td>
                <td className="muted">{s.last_check_at ? new Date(s.last_check_at).toLocaleString() : '—'}</td>
                <td className="muted">{new Date(s.created_at).toLocaleDateString()}</td>
                <td>
                  <button className="btn small secondary" onClick={() => check(s.id)}>Test</button>{' '}
                  <button className="btn small danger" onClick={() => del(s.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="muted">No sources configured.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
