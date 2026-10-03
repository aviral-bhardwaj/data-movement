import React from 'react';
import api from '../api';
import SpecForm from './SpecForm';

// Create/edit form for a source or destination instance.
export default function InstanceForm({ kind, onSaved, onCancel }) {
  const [defs, setDefs] = React.useState([]);
  const [connector, setConnector] = React.useState('');
  const [name, setName] = React.useState('');
  const [config, setConfig] = React.useState({});
  const [testing, setTesting] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    api.get(`/connectors?type=${kind}`).then((r) => setDefs(r.data));
  }, [kind]);

  const def = defs.find((d) => d.name === connector);

  const test = async () => {
    setTesting('running');
    try {
      const r = await api.post(`/connectors/${connector}/check`, { config });
      setTesting(r.data.status);
    } catch (e) {
      setTesting('FAILED');
      setError(e.response?.data?.error || e.message);
    }
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      const r = await api.post(`/${kind}s`, { name, connector, config });
      onSaved(r.data);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setSaving(false); }
  };

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>New {kind}</h3>
      <label>Connector</label>
      <select value={connector} onChange={(e) => { setConnector(e.target.value); setConfig({}); setTesting(null); }}>
        <option value="">— choose —</option>
        {defs.map((d) => <option key={d.name} value={d.name}>{d.icon} {d.display_name}</option>)}
      </select>
      {def && (
        <>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`My ${def.display_name}`} />
          <SpecForm spec={def.spec} value={config} onChange={setConfig} />
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn secondary" onClick={test} disabled={!connector || testing === 'running'}>
              {testing === 'running' ? 'Testing…' : 'Test connection'}
            </button>
            <button className="btn" onClick={save} disabled={!name || saving}>
              {saving ? 'Saving…' : `Create ${kind}`}
            </button>
            <button className="btn secondary" onClick={onCancel}>Cancel</button>
          </div>
          {testing && testing !== 'running' && (
            <div style={{ marginTop: 10 }}>
              <span className={`badge ${testing}`}>{testing}</span>
            </div>
          )}
          {error && <div className="error-text">{error}</div>}
        </>
      )}
    </div>
  );
}
