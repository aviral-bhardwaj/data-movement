import React from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';

export default function Login() {
  const nav = useNavigate();
  const [email, setEmail] = React.useState('admin@datamove.local');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post('/auth/login', { email, password });
      localStorage.setItem('dm_token', r.data.token);
      nav('/');
      location.reload();
    } catch (e2) {
      setError(e2.response?.data?.error || 'login failed');
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <h1>Data<span style={{ color: 'var(--accent)' }}>Move</span></h1>
        <p className="muted">Data integration platform — log in to continue.</p>
        <label>Email</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn" style={{ marginTop: 16, width: '100%' }}>Log in</button>
        {error && <div className="error-text">{error}</div>}
        <div className="hint" style={{ marginTop: 12 }}>default: admin@datamove.local / admin123</div>
      </form>
    </div>
  );
}
