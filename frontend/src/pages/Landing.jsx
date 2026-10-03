import React from 'react';
import { Link } from 'react-router-dom';
import ConnIcon from '../components/ConnIcon';
import Logo from '../components/Logo';
import api from '../api';

// Public marketing home — mirrors the structure of a real data-integration
// product site: hero, connector wall, features, pipeline, stats, CTA, footer.
export default function Landing() {
  const [stats, setStats] = React.useState(null);
  const [wall, setWall] = React.useState([]);
  const authed = !!localStorage.getItem('dm_token');

  React.useEffect(() => {
    api.get('/public/stats').then((r) => setStats(r.data)).catch(() => {});
    api.get('/public/connectors?limit=96').then((r) => setWall(r.data)).catch(() => {});
  }, []);

  const connTotal = stats?.connectors?.total ? `${Number(stats.connectors.total).toLocaleString()}+` : '790+';

  return (
    <div className="site">
      {/* ---- nav ---- */}
      <nav className="site-nav">
        <div className="inner">
          <Link to="/" style={{ textDecoration: 'none' }}><Logo /></Link>
          <div className="links">
            <a href="#product">Product</a>
            <a href="#connectors">Connectors</a>
            <a href="#pipeline">How it works</a>
            <a href="/docs/architecture.md" target="_blank" rel="noreferrer">Docs</a>
          </div>
          <div className="right">
            <Link to="/login" className="link-plain">Sign in</Link>
            <Link to={authed ? '/app' : '/login'} className="btn">{authed ? 'Open dashboard' : 'Get started free'}</Link>
          </div>
        </div>
      </nav>

      {/* ---- hero ---- */}
      <header className="hero">
        <div className="eyebrow">
          <span style={{ width: 6, height: 6, borderRadius: 6, background: 'var(--accent)', display: 'inline-block' }} />
          Now with {connTotal} pre-built connectors
        </div>
        <h1>
          Move data between<br />
          <span className="grad">every system</span> you rely on
        </h1>
        <p className="lead">
          DataMove automates ELT pipelines from databases, SaaS apps, files and
          streams into your warehouse — with schema evolution, CDC, scheduling
          and observability built in.
        </p>
        <div className="cta-row">
          <Link to={authed ? '/app' : '/login'} className="btn large">Start syncing for free</Link>
          <a href="#connectors" className="btn large secondary">Explore connectors</a>
        </div>
        <div className="trust">No credit card · Self-host in 5 minutes · Open connector SDK</div>
      </header>

      {/* ---- connector wall ---- */}
      <div className="conn-wall" id="connectors">
        <div className="wall">
          {wall.map((c) => (
            <Link to="/login" className="cell" key={c.name} title={c.display_name}>
              <ConnIcon name={c.display_name} icon={c.icon} size="sm" />
            </Link>
          ))}
        </div>
      </div>

      {/* ---- proof strip ---- */}
      <div className="logo-strip">
        <div className="lbl">Sync between the tools your stack already uses</div>
        <div className="names">
          <span>PostgreSQL</span><span>Snowflake</span><span>Salesforce</span>
          <span>Shopify</span><span>BigQuery</span><span>Kafka</span>
          <span>Stripe</span><span>HubSpot</span>
        </div>
      </div>

      {/* ---- features ---- */}
      <section className="section alt" id="product">
        <div className="inner">
          <div className="kicker">The platform</div>
          <h2>Everything Fivetran-style pipelines should do</h2>
          <p className="lead">
            One engine for full refreshes, incremental loads, log-based CDC and
            streaming webhooks — plus the operational plumbing a real data
            platform needs.
          </p>
          <div className="feature-grid">
            {[
              { t: '700+ connectors', d: 'Databases, SaaS apps, warehouses, files, events and custom functions — plus a declarative SDK to add your own in minutes.', icon: '◈' },
              { t: 'Automated schema evolution', d: 'New columns, changed types and nested JSON are detected and applied to the destination automatically — no pipeline breaks.', icon: '⧉' },
              { t: 'Log-based CDC', d: 'Postgres logical replication streams inserts, updates and deletes in real time. No cursor columns, no missed deletes.', icon: '≋' },
              { t: 'Incremental & idempotent', d: 'Per-stream cursors, checkpoint/resume, and primary-key dedup keep every row exactly-once — even after retries.', icon: '↻' },
              { t: 'Scheduling & queues', d: 'Cron, interval and continuous CDC drains on a BullMQ-backed queue with exponential-backoff retries and per-job logging.', icon: '◷' },
              { t: 'Security built-in', d: 'AES-256-GCM encrypted credentials, JWT + RBAC, API keys, audit logs and webhook-token isolation on every endpoint.', icon: '▣' },
            ].map((f) => (
              <div className="feature" key={f.t}>
                <div className="fi"><span style={{ fontSize: 20 }}>{f.icon}</span></div>
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- how it works ---- */}
      <section className="section" id="pipeline">
        <div className="kicker">How it works</div>
        <h2>From source to table in three steps</h2>
        <div className="steps">
          <div className="step">
            <div className="n">1</div>
            <h3>Connect</h3>
            <p>Pick a connector, drop in credentials, test the connection. Secrets are encrypted at rest and never leave your infrastructure.</p>
          </div>
          <div className="step">
            <div className="n">2</div>
            <h3>Configure</h3>
            <p>Discover the schema, select streams, choose sync modes and cursors, name the destination tables — the catalog handles the rest.</p>
          </div>
          <div className="step">
            <div className="n">3</div>
            <h3>Sync</h3>
            <p>Set a schedule or stream continuously. Monitor rows written, latency and errors from the dashboard — with webhook alerts on failure.</p>
          </div>
        </div>
      </section>

      {/* ---- stats ---- */}
      <section className="stats-band">
        <div className="inner">
          <div><div className="v">{connTotal}</div><div className="l">Pre-built connectors</div></div>
          <div><div className="v">{stats ? Number(stats.connectors.implemented).toLocaleString() : '140+'}</div><div className="l">Fully implemented</div></div>
          <div><div className="v">4</div><div className="l">Sync modes</div></div>
          <div><div className="v">{stats ? compactNum(stats.rowsWritten) : '12K+'}</div><div className="l">Rows synced</div></div>
        </div>
      </section>

      {/* ---- CTA ---- */}
      <section className="cta-band">
        <h2>Ship your first pipeline in minutes</h2>
        <p>Self-hosted, open connectors, zero egress markup. Get DataMove running with Docker Compose.</p>
        <Link to={authed ? '/app' : '/login'} className="btn large">Get started free</Link>
      </section>

      {/* ---- footer ---- */}
      <footer className="site-foot">
        <div className="inner">
          <div>
            <Logo />
            <p className="muted" style={{ marginTop: 12, fontSize: 13, maxWidth: 300 }}>
              Automated data integration for every stack — databases, SaaS, files and streams into your warehouse of choice.
            </p>
          </div>
          <div>
            <h4>Product</h4>
            <a href="#product">Overview</a>
            <a href="#connectors">Connectors</a>
            <a href="#pipeline">How it works</a>
            <Link to="/login">Sign in</Link>
          </div>
          <div>
            <h4>Developers</h4>
            <a href="/docs/architecture.md" target="_blank" rel="noreferrer">Architecture</a>
            <a href="/docs/api.md" target="_blank" rel="noreferrer">API reference</a>
            <a href="/docs/connector-sdk.md" target="_blank" rel="noreferrer">Connector SDK</a>
          </div>
          <div>
            <h4>Deploy</h4>
            <a href="https://github.com/aviral-bhardwaj/data-movement" target="_blank" rel="noreferrer">GitHub</a>
            <a href="#pipeline">Docker Compose</a>
            <a href="#pipeline">Self-hosting</a>
          </div>
        </div>
        <div className="bottom">
          <span>© {new Date().getFullYear()} DataMove</span>
          <span>Open source · Built on Postgres + Redis</span>
        </div>
      </footer>
    </div>
  );
}

function compactNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
