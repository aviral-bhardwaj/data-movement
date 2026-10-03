import React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api';
import ConnIcon from '../components/ConnIcon';

// Connection setup wizard: endpoints -> streams -> schedule.
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

  const src = sources.find((s) => s.id === sourceId);
  const dst = dests.find((d) => d.id === destId);
  const enabledCount = Object.values(selected).filter((s) => s.enabled).length;

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
      setStep(1);
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
        name: name || `${src?.name || 'source'} → ${dst?.name || 'destination'}`,
        sourceId, destinationId: destId, catalog: { streams },
        scheduleType, scheduleValue: scheduleType === 'manual' ? null : scheduleValue,
      });
      nav(`/app/connections/${r.data.id}`);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
      setBusy(false);
    }
  };

  const STEPS = ['Endpoints', 'Streams', 'Schedule'];

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div><h1>New connection</h1><div className="sub">Wire a source to a destination</div></div>
      </div>

      <div className="wizard-steps">
        {STEPS.map((t, i) => (
          <React.Fragment key={t}>
            <div className={`ws ${i < step ? 'done' : i === step ? 'current' : ''}`}>
              <span className="wn">{i < step ? '✓' : i + 1}</span> {t}
            </div>
            {i < STEPS.length - 1 && <span className="ws-sep" />}
          </React.Fragment>
        ))}
      </div>

      {step === 0 && (
        <div className="card">
          <h3>Source</h3>
          {sources.length ? (
            <div className="pick-grid">
              {sources.map((s) => (
                <div key={s.id} className={`pick ${sourceId === s.id ? 'sel' : ''}`} onClick={() => setSourceId(s.id)}>
                  <ConnIcon name={s.connector_name} icon={s.icon} size="sm" />
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">{s.name}</div>
                    <div className="sm">{s.connector_name}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="alert-bar info">No sources yet — <Link to="/app/sources">create one first</Link>.</div>
          )}

          <h3 style={{ marginTop: 22 }}>Destination</h3>
          {dests.length ? (
            <div className="pick-grid">
              {dests.map((d) => (
                <div key={d.id} className={`pick ${destId === d.id ? 'sel' : ''}`} onClick={() => setDestId(d.id)}>
                  <ConnIcon name={d.connector_name} icon={d.icon} size="sm" />
                  <div style={{ minWidth: 0 }}>
                    <div className="nm">{d.name}</div>
                    <div className="sm">{d.connector_name}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="alert-bar info">No destinations yet — <Link to="/app/destinations">create one first</Link>.</div>
          )}

          <label>Connection name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={src && dst ? `${src.name} → ${dst.name}` : 'e.g. Postgres → Warehouse'} />
          <div style={{ marginTop: 20 }}>
            <button className="btn" disabled={!sourceId || !destId || busy} onClick={discover}>
              {busy ? <><span className="spinner" /> Discovering…</> : 'Discover streams →'}
            </button>
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
      )}

      {step === 1 && catalog && (
        <div className="card">
          <div className="row between" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>Streams — {catalog.streams.length} discovered, {enabledCount} selected</h3>
            <div className="row shrink" style={{ gap: 6 }}>
              <button className="btn small ghost" onClick={() => setSelected(Object.fromEntries(Object.entries(selected).map(([k, v]) => [k, { ...v, enabled: true }])))}>All</button>
              <button className="btn small ghost" onClick={() => setSelected(Object.fromEntries(Object.entries(selected).map(([k, v]) => [k, { ...v, enabled: false }])))}>None</button>
            </div>
          </div>
          <div style={{ maxHeight: 440, overflow: 'auto' }}>
            {catalog.streams.map((s) => {
              const sel = selected[s.name] || {};
              return (
                <div className="stream-row" key={s.name}>
                  <input type="checkbox" checked={!!sel.enabled}
                    onChange={(e) => setSelected({ ...selected, [s.name]: { ...sel, enabled: e.target.checked } })} />
                  <div className="grow">
                    <b>{s.namespace ? `${s.namespace}.` : ''}{s.name}</b>{' '}
                    <span className="pill">{Object.keys(s.jsonSchema?.properties || {}).length} cols</span>
                    {s.sourceDefinedPrimaryKey?.length > 0 && <span className="pill">pk {s.sourceDefinedPrimaryKey.join(',')}</span>}
                  </div>
                  <select value={sel.syncMode} onChange={(e) => setSelected({ ...selected, [s.name]: { ...sel, syncMode: e.target.value } })}>
                    {s.supportedSyncModes.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  {sel.syncMode === 'incremental' && (
                    <select value={sel.cursorField} onChange={(e) => setSelected({ ...selected, [s.name]: { ...sel, cursorField: e.target.value } })}>
                      <option value="">cursor…</option>
                      {(s.availableCursorFields || []).map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  )}
                  <input type="text" value={sel.destinationName || ''} placeholder="dest table"
                    onChange={(e) => setSelected({ ...selected, [s.name]: { ...sel, destinationName: e.target.value } })} />
                </div>
              );
            })}
          </div>
          <div className="row" style={{ marginTop: 18, gap: 8 }}>
            <button className="btn" onClick={() => setStep(2)} disabled={!enabledCount}>Schedule →</button>
            <button className="btn ghost" onClick={() => setStep(0)}>← Back</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card">
          <h3>Sync schedule</h3>
          <label>Frequency</label>
          <select value={scheduleType} onChange={(e) => setScheduleType(e.target.value)} style={{ width: 300 }}>
            <option value="manual">Manual only</option>
            <option value="interval">Interval</option>
            <option value="cron">Cron expression</option>
            <option value="cdc">CDC drain (continuous)</option>
          </select>
          {scheduleType === 'interval' && (
            <>
              <label>Every</label>
              <input style={{ width: 180 }} value={scheduleValue} onChange={(e) => setScheduleValue(e.target.value)} />
              <div className="hint">e.g. 15m, 1h, 30s, 1d</div>
            </>
          )}
          {scheduleType === 'cron' && (
            <>
              <label>Cron</label>
              <input style={{ width: 300 }} value={scheduleValue} onChange={(e) => setScheduleValue(e.target.value)} placeholder="0 */6 * * *" />
            </>
          )}
          {scheduleType === 'cdc' && (
            <>
              <label>Drain interval</label>
              <input style={{ width: 180 }} value={scheduleValue} onChange={(e) => setScheduleValue(e.target.value)} />
              <div className="hint">How often to drain the replication slot (e.g. 30s).</div>
            </>
          )}

          <div className="alert-bar info" style={{ marginTop: 20 }}>
            <b>{enabledCount}</b> streams · <b>{src?.name}</b> → <b>{dst?.name}</b> · {scheduleType === 'manual' ? 'manual trigger' : `${scheduleType} ${scheduleValue}`}
          </div>

          <div className="row" style={{ marginTop: 14, gap: 8 }}>
            <button className="btn" onClick={create} disabled={busy}>{busy ? <><span className="spinner" /> Creating…</> : 'Create connection'}</button>
            <button className="btn ghost" onClick={() => setStep(1)}>← Back</button>
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
      )}
    </div>
  );
}
