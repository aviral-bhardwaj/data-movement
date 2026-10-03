import React from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';

// Connection setup wizard: source -> destination -> stream selection -> schedule.
export default function ConnectionNew() {
  const nav = useNavigate();
  const [step, setStep] = React.useState(0);
  const [sources, setSources] = React.useState([]);
  const [dests, setDests] = React.useState([]);
  const [sourceId, setSourceId] = React.useState('');
  const [destId, setDestId] = React.useState('');
  const [name, setName] = React.useState('');
  const [catalog, setCatalog] = React.useState(null);
  const [selected, setSelected] = React.useState({});
  const [scheduleType, setScheduleType] = React.useState('manual');
  const [scheduleValue, setScheduleValue] = React.useState('15m');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    api.get('/sources').then((r) => setSources(r.data));
    api.get('/destinations').then((r) => setDests(r.data));
  }, []);

  const discover = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/sources/${sourceId}/discover`);
      setCatalog(r.data);
      const sel = {};
      for (const s of r.data.streams) {
        sel[s.name] = {
          enabled: true,
          syncMode: s.supportedSyncModes.includes('incremental') ? 'incremental' : 'full_refresh',
          cursorField: s.defaultCursorField || s.availableCursorFields?.[0] || '',
          primaryKey: s.sourceDefinedPrimaryKey || [],
          destinationName: s.name,
          jsonSchema: s.jsonSchema,
          namespace: s.namespace,
        };
      }
      setSelected(sel);
      setStep(2);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setBusy(false); }
  };

  const create = async () => {
    setBusy(true); setError('');
    try {
      const streams = Object.entries(selected)
        .filter(([, v]) => v.enabled)
        .map(([streamName, v]) => ({
          name: streamName, namespace: v.namespace, syncMode: v.syncMode,
          cursorField: v.cursorField || undefined, primaryKey: v.primaryKey,
          destinationName: v.destinationName, jsonSchema: v.jsonSchema,
        }));
      const r = await api.post('/connections', {
        name: name || `connection-${Date.now()}`,
        sourceId, destinationId: destId, catalog: { streams },
        scheduleType, scheduleValue: scheduleType === 'manual' ? null : scheduleValue,
      });
      nav(`/connections/${r.data.id}`);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setBusy(false);
    }
  };

  return (
    <div>
      <h1>New connection</h1>
      <div className="tabs">
        {['Endpoints', 'Streams', 'Schedule'].map((t, i) => (
          <button key={t} className={step === i ? 'active' : ''} onClick={() => i < step && setStep(i)}>{i + 1}. {t}</button>
        ))}
      </div>

      {step === 0 && (
        <div className="card">
          <div className="row">
            <div>
              <label>Source</label>
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">— choose —</option>
                {sources.map((s) => <option key={s.id} value={s.id}>{s.icon} {s.name} ({s.connector_name})</option>)}
              </select>
              {!sources.length && <div className="hint">No sources — <a href="/sources">create one first</a>.</div>}
            </div>
            <div>
              <label>Destination</label>
              <select value={destId} onChange={(e) => setDestId(e.target.value)}>
                <option value="">— choose —</option>
                {dests.map((d) => <option key={d.id} value={d.id}>{d.icon} {d.name} ({d.connector_name})</option>)}
              </select>
              {!dests.length && <div className="hint">No destinations — <a href="/destinations">create one first</a>.</div>}
            </div>
          </div>
          <label>Connection name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Postgres → Warehouse" />
          <div style={{ marginTop: 16 }}>
            <button className="btn" disabled={!sourceId || !destId || busy} onClick={discover}>
              {busy ? 'Discovering…' : 'Discover streams →'}
            </button>
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
      )}

      {step === 2 && catalog && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Select streams ({catalog.streams.length} discovered)</h3>
          {catalog.streams.map((s) => {
            const sel = selected[s.name] || {};
            return (
              <div className="stream-row" key={s.name}>
                <input type="checkbox" checked={!!sel.enabled}
                  onChange={(e) => setSelected({ ...selected, [s.name]: { ...sel, enabled: e.target.checked } })} />
                <div className="grow">
                  <b>{s.namespace ? `${s.namespace}.` : ''}{s.name}</b>
                  <span className="pill">{Object.keys(s.jsonSchema?.properties || {}).length} cols</span>
                  {s.sourceDefinedPrimaryKey?.length > 0 && <span className="pill">pk: {s.sourceDefinedPrimaryKey.join(',')}</span>}
                </div>
                <select value={sel.syncMode} onChange={(e) => setSelected({ ...selected, [s.name]: { ...sel, syncMode: e.target.value } })}>
                  {s.supportedSyncModes.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                {(sel.syncMode === 'incremental') && (
                  <select value={sel.cursorField} onChange={(e) => setSelected({ ...selected, [s.name]: { ...sel, cursorField: e.target.value } })}>
                    <option value="">cursor…</option>
                    {(s.availableCursorFields || []).map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                )}
                <input style={{ width: 180 }} value={sel.destinationName || ''} placeholder="dest table"
                  onChange={(e) => setSelected({ ...selected, [s.name]: { ...sel, destinationName: e.target.value } })} />
              </div>
            );
          })}
          <div style={{ marginTop: 16 }}>
            <button className="btn" onClick={() => setStep(3)}>Schedule →</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Sync schedule</h3>
          <label>Frequency</label>
          <select value={scheduleType} onChange={(e) => setScheduleType(e.target.value)} style={{ width: 260 }}>
            <option value="manual">Manual only</option>
            <option value="interval">Interval</option>
            <option value="cron">Cron expression</option>
            <option value="cdc">CDC drain (continuous)</option>
          </select>
          {scheduleType === 'interval' && (
            <>
              <label>Every</label>
              <input style={{ width: 160 }} value={scheduleValue} onChange={(e) => setScheduleValue(e.target.value)} />
              <div className="hint">e.g. 15m, 1h, 30s, 1d</div>
            </>
          )}
          {scheduleType === 'cron' && (
            <>
              <label>Cron</label>
              <input style={{ width: 260 }} value={scheduleValue} onChange={(e) => setScheduleValue(e.target.value)} placeholder="0 */6 * * *" />
            </>
          )}
          {scheduleType === 'cdc' && (
            <>
              <label>Drain interval</label>
              <input style={{ width: 160 }} value={scheduleValue} onChange={(e) => setScheduleValue(e.target.value)} />
              <div className="hint">How often to drain the replication slot (e.g. 30s).</div>
            </>
          )}
          <div className="row" style={{ marginTop: 20 }}>
            <button className="btn" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create connection'}</button>
            <button className="btn secondary" onClick={() => setStep(2)}>← Back</button>
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
      )}
    </div>
  );
}
