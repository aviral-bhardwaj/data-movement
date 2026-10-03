import React from 'react';
import api from '../api';
import StatusBadge from '../components/StatusBadge';
import InstanceForm from '../components/InstanceForm';

export default function Destinations() {
  const [rows, setRows] = React.useState([]);
  const [showForm, setShowForm] = React.useState(false);
  const load = () => api.get('/destinations').then((r) => setRows(r.data));
  React.useEffect(() => { load(); }, []);

  const check = async (id) => { await api.post(`/destinations/${id}/check`); load(); };
  const del = async (id) => {
    try { if (confirm('Delete destination?')) { await api.delete(`/destinations/${id}`); load(); } }
    catch (e) { alert(e.response?.data?.error || e.message); }
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Destinations</h1>
        <button className="btn shrink" onClick={() => setShowForm(!showForm)}>+ New destination</button>
      </div>
      {showForm && <InstanceForm kind="destination" onSaved={() => { setShowForm(false); load(); }} onCancel={() => setShowForm(false)} />}
      <div className="card">
        <table>
          <thead><tr><th>Name</th><th>Connector</th><th>Status</th><th>Last check</th><th>Created</th><th></th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>{d.icon} {d.name}</td>
                <td>{d.connector_name}</td>
                <td><StatusBadge status={d.last_check_status || d.status} /></td>
                <td className="muted">{d.last_check_at ? new Date(d.last_check_at).toLocaleString() : '—'}</td>
                <td className="muted">{new Date(d.created_at).toLocaleDateString()}</td>
                <td>
                  <button className="btn small secondary" onClick={() => check(d.id)}>Test</button>{' '}
                  <button className="btn small danger" onClick={() => del(d.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="muted">No destinations configured.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
