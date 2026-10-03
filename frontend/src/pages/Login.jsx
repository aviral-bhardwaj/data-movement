import React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api';
import Logo from '../components/Logo';

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = React.useState('admin@datamove.local');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const r = await api.post('/auth/login', { email, password });
      localStorage.setItem('dm_token', r.data.token);
      nav('/app');
      location.reload();
    } catch (e2) {
      setError(e2.response?.data?.error || 'login failed');
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <aside className="login-side">
        <Link to="/" style={{ textDecoration: 'none' }}><Logo light /></Link>
        <div>
          <h2>Every source.<br/>Every destination.<br/>One pipeline.</h2>
          <div className="pts">
            <div><span className="dot" /> 700+ pre-built connectors</div>
            <div><span className="dot" /> Log-based CDC, incremental &amp; streaming</div>
            <div><span className="dot" /> Schema evolution handled for you</div>
            <div><span className="dot" /> Self-hosted, open connector SDK</div>
          </div>
        </div>
        <p className="quote">
          “DataMove gave us Fivetran-style pipelines without the per-connector pricing — our
          Postgres CDC to Snowflake runs every 30 seconds.”
        </p>
      </aside>

      <main className="login-main">
        <form className="login-form" onSubmit={submit}>
          <Link to="/" style={{ textDecoration: 'none' }}><Logo /></Link>
          <h1>Welcome back</h1>
          <div className="sub">Sign in to your DataMove workspace</div>
          <label>Work email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button className="btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          {error && <div className="error-text">{error}</div>}
          <div className="fine">Demo instance: admin@datamove.local / admin123</div>
        </form>
      </main>
    </div>
  );
}
