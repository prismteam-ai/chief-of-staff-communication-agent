import { useState } from 'react';

/**
 * Login form (Task 8.5) — replaces the old demo-user selector entirely. Collects a username and
 * password and hands them to `App.tsx`'s `onLogin`, which calls the `auth.login` tRPC procedure;
 * the server verifies the credential and mints a session token this component never sees directly
 * (it only reports success/failure via `busy`/`error`, `App.tsx` owns the resulting token).
 */

export interface LoginViewProps {
  onLogin: (username: string, password: string) => void;
  busy: boolean;
  error?: string;
}

export function LoginView(props: LoginViewProps) {
  const { onLogin, busy, error } = props;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    onLogin(username, password);
  }

  return (
    <section data-testid="login-view">
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'grid',
          gap: '0.75rem',
          maxWidth: 360,
          border: '1px solid #d1d5db',
          borderRadius: 8,
          padding: '1.25rem',
        }}
      >
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Sign in</h2>
        <label>
          Username
          <input
            data-testid="login-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            style={{ width: '100%' }}
          />
        </label>
        <label>
          Password
          <input
            data-testid="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            style={{ width: '100%' }}
          />
        </label>
        {error && (
          <p data-testid="login-error" style={{ color: '#b91c1c', margin: 0 }}>
            {error}
          </p>
        )}
        <button data-testid="login-submit" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </section>
  );
}
