import React from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../api';
import ConnIcon from '../components/ConnIcon';

// Connector catalog browser — search, type, category, letter and
// implementation-status filters over the full synced directory.
const TYPE_TABS = [['', 'All connectors'], ['source', 'Sources'], ['destination', 'Destinations']];

export default function Connectors() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [defs, setDefs] = React.useState([]);
  const [facets, setFacets] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [sel, setSel] = React.useState(null);

  const type = params.get('type') || '';
  const category = params.get('category') || '';
  const q = params.get('q') || '';
  const letter = params.get('letter') || '';
  const impl = params.get('implemented') || '';

  const [qInput, setQInput] = React.useState(q);
  React.useEffect(() => setQInput(q), [q]);

  const setP = (patch) => {
    const next = { type, category, q, letter, implemented: impl, ...patch };
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    setParams(next);
  };

  React.useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (type) qs.set('type', type);
    if (category) qs.set('category', category);
    if (q) qs.set('q', q);
    if (letter) qs.set('letter', letter);
    if (impl) qs.set('implemented', impl);
    api.get(`/connectors?${qs}`).then((r) => { setDefs(r.data); setLoading(false); });
  }, [type, category, q, letter, impl]);

  React.useEffect(() => {
    api.get('/connectors/meta/facets').then((r) => setFacets(r.data));
  }, []);

  const cats = [...new Set(facets.filter((f) => !type || f.type === type).map((f) => f.category).filter(Boolean))].sort();
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
  const implCount = defs.filter((d) => d.implemented).length;

  const setup = (d) => {
    if (!d.implemented) return;
    nav(d.type === 'source' ? `/app/sources?new=${d.name}` : `/app/destinations?new=${d.name}`);
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Connector catalog</h1>
          <div className="sub">{defs.length} connectors · {implCount} ready to use</div>
        </div>
        <div className="search-input" style={{ width: 320 }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            placeholder="Search 700+ connectors…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setP({ q: qInput, letter: '' })}
          />
        </div>
      </div>

      {/* type + implementation chips */}
      <div className="catalog-filters">
        {TYPE_TABS.map(([v, lbl]) => (
          <button key={v} className={`chip ${type === v ? 'active' : ''}`} onClick={() => setP({ type: v, category: '' })}>{lbl}</button>
        ))}
        <span style={{ width: 1, height: 22, background: 'var(--border-strong)', margin: '0 6px' }} />
        <button className={`chip ${impl === 'true' ? 'active' : ''}`} onClick={() => setP({ implemented: impl === 'true' ? '' : 'true' })}>
          Ready to use
        </button>
        <button className={`chip ${impl === 'false' ? 'active' : ''}`} onClick={() => setP({ implemented: impl === 'false' ? '' : 'false' })}>
          Catalog only
        </button>
      </div>

      {/* category chips */}
      {cats.length > 0 && (
        <div className="catalog-filters" style={{ marginTop: -4 }}>
          <button className={`chip ${!category ? 'active' : ''}`} onClick={() => setP({ category: '' })}>All categories</button>
          {cats.map((c) => (
            <button key={c} className={`chip ${category === c ? 'active' : ''}`} onClick={() => setP({ category: category === c ? '' : c })}>{c}</button>
          ))}
        </div>
      )}

      {/* A–Z */}
      <div className="alpha-bar">
        <button className={!letter ? 'active' : ''} onClick={() => setP({ letter: '' })}>All</button>
        {letters.map((l) => (
          <button key={l} className={letter === l ? 'active' : ''}
            onClick={() => setP({ letter: letter === l ? '' : l === '#' ? '' : l, q: l === '#' ? q : qInput })}>{l}</button>
        ))}
      </div>

      {loading ? (
        <div className="grid cols3">
          {[...Array(9)].map((_, i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}
        </div>
      ) : (
        <>
          <div className="grid cols3">
            {defs.slice(0, 240).map((d) => (
              <div className="conn-card" key={d.name} onClick={() => setSel(sel?.name === d.name ? null : d)}>
                <ConnIcon name={d.display_name} icon={d.icon} />
                <div style={{ minWidth: 0 }}>
                  <div className="name">
                    {d.display_name}
                    {d.badge && <span className={`pill ${d.badge === 'Lite' ? 'slate' : d.badge === 'Beta' ? 'amber' : 'purple'}`}>{d.badge}</span>}
                  </div>
                  <div className="desc">{d.description || `${d.display_name} connector`}</div>
                  <div className="meta">
                    {d.category && <span className="pill">{d.category}</span>}
                    {d.implemented
                      ? <span className="pill green">Ready</span>
                      : <span className="pill">Catalog</span>}
                    {d.supported_sync_modes?.includes('cdc') && <span className="pill blue">CDC</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {defs.length > 240 && (
            <div className="card tight muted tc">Showing 240 of {defs.length} — refine the filters or search.</div>
          )}
          {!defs.length && (
            <div className="card"><div className="empty"><div className="glyph">◌</div><h3>No connectors match</h3><p>Try clearing the filters or a different search.</p></div></div>
          )}
        </>
      )}

      {/* detail drawer */}
      {sel && (
        <div className="card" style={{ position: 'sticky', bottom: 16, boxShadow: 'var(--shadow-lg)' }}>
          <div className="row top between">
            <div className="row" style={{ gap: 14, flex: '0 1 auto' }}>
              <ConnIcon name={sel.display_name} icon={sel.icon} size="lg" />
              <div>
                <h3 style={{ margin: 0 }}>{sel.display_name}</h3>
                <div className="muted small">
                  {sel.type} {sel.category ? `· ${sel.category}` : ''} {sel.badge ? `· ${sel.badge}` : ''}
                </div>
              </div>
            </div>
            <div className="row shrink" style={{ gap: 8 }}>
              {sel.docs_url && <a className="btn small secondary" href={sel.docs_url} target="_blank" rel="noreferrer">Docs ↗</a>}
              {sel.implemented
                ? <button className="btn small" onClick={() => setup(sel)}>Set up as {sel.type}</button>
                : <span className="pill amber">Coming soon</span>}
              <button className="btn small ghost" onClick={() => setSel(null)}>✕</button>
            </div>
          </div>
          {sel.implemented && (
            <div className="row" style={{ marginTop: 12, gap: 16, flexWrap: 'wrap' }}>
              {(sel.supported_sync_modes || []).map((m) => <span key={m} className="pill blue">{m}</span>)}
              {Object.keys(sel.spec?.connectionSpecification?.properties || {}).slice(0, 8).map((k) => (
                <span key={k} className="pill">{k}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
