import React from 'react';
import api from '../api';

export default function Settings() {
  const [keys, setKeys] = React.useState([]);
  const [newKey, setNewKey] = React.useState(null);
  const [keyName, setKeyName] = React.useState('');
  const [users, setUsers] = React.useState([]);
  const [audit, setAudit] = React.useState([]);
  const [me, setMe] = React.useState(null);

  const load = () => {
    api.get('/auth/me').then((r) => setMe(r.data));
    api.get('/auth/apikeys').then((r) => setKeys(r.data));
    api.get('/auth/users').then((r) => setUsers(r.data)).catch(() => {});
    api.get('/audit?limit=50').then((r) => setAudit(r.data)).catch(() => {});
  };
  React.useEffect(() => { load(); }, []);

  const createKey = async () => {
    const r = await api.post('/auth/apikeys', { name: keyName || 'default' });
    setNewKey(r.data.key);
    setKeyName('');
    load();
  };

  return (
    <div>
      <h1>Settings</h1>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>API keys</h3>
        <p className="muted">Use <code>x-api-key</code> header for programmatic access.</p>
        <div className="row" style={{ maxWidth: 480 }}>
          <input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="key name" />
          <button className="btn shrink" onClick={createKey}>Generate</button>
        </div>
        {newKey && <pre style={{ marginTop: 12 }}>{newKey}<div className="hint">shown once — store it safely</div></pre>}
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Name</th><th>Prefix</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td><td><code>{k.prefix}…</code></td>
                <td className="muted">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</td>
                <td><button className="btn small danger" onClick={async () => { await api.delete(`/auth/apikeys/${k.id}`); load(); }}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Users</h3>
        <table>
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Created</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}><td>{u.email}</td><td>{u.name}</td><td><span className="pill">{u.role}</span></td><td className="muted">{new Date(u.created_at).toLocaleDateString()}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      {me?.role === 'admin' && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Audit log</h3>
          <div style={{ maxHeight: 300, overflow: 'auto' }}>
            {audit.map((a) => (
              <div className="log-line" key={a.id}>
                <span className="muted">{new Date(a.ts).toLocaleString()}</span> {a.action} {a.entity_type} {a.entity_id?.slice(0, 8)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
