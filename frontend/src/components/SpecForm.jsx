import React from 'react';

// Renders a config form from a connector's connectionSpecification (JSON Schema).
export default function SpecForm({ spec, value, onChange }) {
  const props = spec?.connectionSpecification?.properties || {};
  const required = spec?.connectionSpecification?.required || [];
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div>
      {Object.entries(props).map(([key, p]) => {
        const v = value[key] ?? p.default ?? '';
        return (
          <div key={key}>
            <label>
              {p.title || key} {required.includes(key) && <span style={{ color: 'var(--err)' }}>*</span>}
            </label>
            {p.enum ? (
              <select value={v} onChange={(e) => set(key, e.target.value)}>
                {p.enum.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : p.type === 'boolean' ? (
              <select value={String(!!v)} onChange={(e) => set(key, e.target.value === 'true')}>
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            ) : p.type === 'integer' ? (
              <input type="number" value={v} onChange={(e) => set(key, e.target.value === '' ? '' : Number(e.target.value))} />
            ) : p.airbyte_secret ? (
              <input type="password" value={v} onChange={(e) => set(key, e.target.value)} autoComplete="new-password" />
            ) : (
              <input value={v} onChange={(e) => set(key, e.target.value)} />
            )}
            {p.description && <div className="hint">{p.description}</div>}
          </div>
        );
      })}
    </div>
  );
}
