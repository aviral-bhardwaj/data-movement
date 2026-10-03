import React from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import StatusBadge from '../components/StatusBadge';
import InstanceForm from '../components/InstanceForm';
import ConnIcon from '../components/ConnIcon';

export default function Destinations() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = React.useState([]);
  const [showForm, setShowForm] = React.useState(!!params.get('new'));
  const [preset, setPreset] = React.useState(params.get('new') || '');
  const load = () => api.get('/destinations').then((r) => setRows(r.data));
  React.useEffect(() => { load(); }, []);

  const openForm = (connector) => { setPreset(connector || ''); setShowForm(true); };
  const closeForm = () => { setShowForm(false); setPreset(''); setParams({}); load(); };
  const check = async (id) => { await api.post(`/destinations/${id}/check`); load(); };
  const del = async (id) => {
    try { if (confirm('Delete destination?')) { await api.delete(`/destinations/${id}`); load(); } }
    catch (e) { alert(e.response?.data?.error || e.message); }
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>Destinations</h1><div className="sub">{rows.length} configured</div></div>
        <button className="btn" onClick={() => openForm('')}>+ New destination</button>
      </div>
      {showForm && <InstanceForm kind="destination" preset={preset} onSaved={closeForm} onCancel={closeForm} />}
      <div className="card pad0">
        <table>
          <thead><tr><th>Name</th><th>Connector</th><th>Status</th><th>Last check</th><th>Created</th><th className="tr">Actions</th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td><div className="row shrink" style={{ gap: 10 }}><ConnIcon name={d.connector_name} icon={d.icon} size="sm" /><b>{d.name}</b></div></td>
                <td className="muted">{d.connector_name}</td>
                <td><StatusBadge status={d.last_check_status || d.status} /></td>
                <td className="muted">{d.last_check_at ? new Date(d.last_check_at).toLocaleString() : '—'}</td>
                <td className="muted">{new Date(d.created_at).toLocaleDateString()}</td>
                <td className="tr nowrap">
                  <button className="btn small secondary" onClick={() => check(d.id)}>Test</button>{' '}
                  <button className="btn small danger" onClick={() => del(d.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={6}>
                <div className="empty"><div className="glyph">◎</div><h3>No destinations yet</h3><p>Add a warehouse, database or lake to land your data.</p><button className="btn" onClick={() => openForm('')}>+ New destination</button></div>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
