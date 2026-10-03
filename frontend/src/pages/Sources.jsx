import React from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import StatusBadge from '../components/StatusBadge';
import InstanceForm from '../components/InstanceForm';
import ConnIcon from '../components/ConnIcon';

export default function Sources() {
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = React.useState([]);
  const [showForm, setShowForm] = React.useState(!!params.get('new'));
  const [preset, setPreset] = React.useState(params.get('new') || '');
  const load = () => api.get('/sources').then((r) => setRows(r.data));
  React.useEffect(() => { load(); }, []);

  const openForm = (connector) => { setPreset(connector || ''); setShowForm(true); };
  const closeForm = () => { setShowForm(false); setPreset(''); setParams({}); load(); };
  const check = async (id) => { await api.post(`/sources/${id}/check`); load(); };
  const del = async (id) => {
    try { if (confirm('Delete source?')) { await api.delete(`/sources/${id}`); load(); } }
    catch (e) { alert(e.response?.data?.error || e.message); }
  };

  return (
    <div>
      <div className="page-head">
        <div><h1>Sources</h1><div className="sub">{rows.length} configured</div></div>
        <button className="btn" onClick={() => openForm('')}>+ New source</button>
      </div>
      {showForm && <InstanceForm kind="source" preset={preset} onSaved={closeForm} onCancel={closeForm} />}
      <div className="card pad0">
        <table>
          <thead><tr><th>Name</th><th>Connector</th><th>Status</th><th>Last check</th><th>Created</th><th className="tr">Actions</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td><div className="row shrink" style={{ gap: 10 }}><ConnIcon name={s.connector_name} icon={s.icon} size="sm" /><b>{s.name}</b></div></td>
                <td className="muted">{s.connector_name}</td>
                <td><StatusBadge status={s.last_check_status || s.status} /></td>
                <td className="muted">{s.last_check_at ? new Date(s.last_check_at).toLocaleString() : '—'}</td>
                <td className="muted">{new Date(s.created_at).toLocaleDateString()}</td>
                <td className="tr nowrap">
                  <button className="btn small secondary" onClick={() => check(s.id)}>Test</button>{' '}
                  <button className="btn small danger" onClick={() => del(s.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td colSpan={6}>
                <div className="empty"><div className="glyph">◎</div><h3>No sources yet</h3><p>Add your first source to start building pipelines.</p><button className="btn" onClick={() => openForm('')}>+ New source</button></div>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
