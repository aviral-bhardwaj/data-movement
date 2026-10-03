import React from 'react';
import api from '../api';
import SpecForm from './SpecForm';
import ConnIcon from './ConnIcon';

// Create/edit form for a source or destination instance.
// `preset` pre-selects a connector (from the catalog "Set up" CTA).
export default function InstanceForm({ kind, preset, onSaved, onCancel }) {
  const [defs, setDefs] = React.useState([]);
  const [connector, setConnector] = React.useState(preset || '');
  const [name, setName] = React.useState('');
  const [config, setConfig] = React.useState({});
  const [testing, setTesting] = React.useState(null);
  const [testMsg, setTestMsg] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    api.get(`/connectors?type=${kind}&implemented=true`).then((r) => setDefs(r.data));
  }, [kind]);

  const def = defs.find((d) => d.name === connector);

  const test = async () => {
    setTesting('running'); setTestMsg('');
    try {
      const r = await api.post(`/connectors/${connector}/check`, { config });
      setTesting(r.data.status);
      setTestMsg(r.data.message || '');
    } catch (e) {
      setTesting('FAILED');
      setTestMsg(e.response?.data?.error || e.message);
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
      <div className="row between" style={{ marginBottom: 4 }}>
        <h3 style={{ margin: 0 }}>Set up {kind}</h3>
        <button className="btn small ghost" onClick={onCancel}>✕</button>
      </div>
      <label>Connector</label>
      <select value={connector} onChange={(e) => { setConnector(e.target.value); setConfig({}); setTesting(null); setTestMsg(''); }}>
        <option value="">— choose a connector —</option>
        {defs.map((d) => <option key={d.name} value={d.name}>{d.display_name}</option>)}
      </select>
      {def && (
        <>
          <div className="row" style={{ marginTop: 14, gap: 12, alignItems: 'center' }}>
            <ConnIcon name={def.display_name} icon={def.icon} />
            <div>
              <b>{def.display_name}</b>
              <div className="muted small">{def.description}</div>
              <div style={{ marginTop: 4 }}>
                {(def.supported_sync_modes || []).map((m) => <span key={m} className="pill blue">{m}</span>)}
              </div>
            </div>
          </div>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`My ${def.display_name}`} />
          <SpecForm spec={def.spec} value={config} onChange={setConfig} />
          <div className="row" style={{ marginTop: 18, gap: 8 }}>
            <button className="btn secondary" onClick={test} disabled={!connector || testing === 'running'}>
              {testing === 'running' ? <><span className="spinner" /> Testing…</> : 'Test connection'}
            </button>
            <button className="btn" onClick={save} disabled={!name || saving}>
              {saving ? 'Creating…' : `Create ${kind}`}
            </button>
            <button className="btn ghost" onClick={onCancel}>Cancel</button>
          </div>
          {testing && testing !== 'running' && (
            <div className={`alert-bar ${testing === 'SUCCEEDED' ? 'ok' : 'err'}`} style={{ marginTop: 14 }}>
              <b>{testing}</b> {testMsg && <span className="small">{testMsg}</span>}
            </div>
          )}
          {error && <div className="error-text">{error}</div>}
        </>
      )}
    </div>
  );
}
