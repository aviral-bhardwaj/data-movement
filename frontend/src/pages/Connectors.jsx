import React from 'react';
import api from '../api';

export default function Connectors() {
  const [defs, setDefs] = React.useState([]);
  const [sel, setSel] = React.useState(null);
  React.useEffect(() => { api.get('/connectors').then((r) => setDefs(r.data)); }, []);

  const groups = { source: 'Source connectors', destination: 'Destination connectors' };
  return (
    <div>
      <h1>Connector catalog</h1>
      {Object.entries(groups).map(([type, title]) => (
        <div key={type}>
          <h3>{title} ({defs.filter((d) => d.type === type).length})</h3>
          <div className="grid cols3">
            {defs.filter((d) => d.type === type).map((d) => (
              <div className="card connector-tile" key={d.name} style={{ cursor: 'pointer' }} onClick={() => setSel(sel?.name === d.name ? null : d)}>
                <div className="icon">{d.icon}</div>
                <div>
                  <b>{d.display_name}</b> <span className="pill">v{d.version}</span>
                  <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{d.description}</div>
                  {d.supported_sync_modes?.length > 0 && (
                    <div style={{ marginTop: 6 }}>{d.supported_sync_modes.map((m) => <span key={m} className="pill">{m}</span>)}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {sel && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{sel.icon} {sel.display_name} — spec</h3>
          <pre>{JSON.stringify(sel.spec, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
