import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client';
import { field } from '../components/table';
import { useAuth } from '../lib/auth';

const DEMO_ACCOUNTS = [
  { email: 'admin@retailpulse.test', label: 'Admin' },
  { email: 'inventory@retailpulse.test', label: 'Inventory manager' },
  { email: 'store1@retailpulse.test', label: 'Store manager (STR-01)' },
  { email: 'store2@retailpulse.test', label: 'Store manager (STR-02)' },
  { email: 'analyst@retailpulse.test', label: 'Analyst (read-only)' },
];

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setPassword('');
      if (err instanceof ApiError && err.code === 'TOO_MANY_REQUESTS') {
        setError('Too many failed attempts. Please wait a few minutes and try again.');
      } else if (err instanceof ApiError && err.status === 401) {
        setError('Incorrect email or password.');
      } else if (err instanceof ApiError && err.status === 400) {
        setError('Enter a valid email address and your password.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Unexpected error.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="login-heading" className="mx-auto max-w-md space-y-4">
      <form onSubmit={submit} className="space-y-4 rounded-xl border bg-card shadow-sm p-6">
        <h2 id="login-heading" className="text-xl font-semibold">
          Sign in
        </h2>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            className={field}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            className={field}
            type="password"
            autoComplete="current-password"
            required
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-slate-900 px-4 py-2 text-sm text-white enabled:hover:bg-slate-700 disabled:opacity-50 focus:outline-2 focus:outline-sky-500"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <div className="rounded-xl border bg-card shadow-sm p-4 text-sm">
        <h3 className="mb-1 font-medium">Synthetic demo accounts</h3>
        <p className="mb-2 text-xs text-slate-500">
          Fictional users created by <code>npm run db:seed</code>. The shared password is{' '}
          <code>DEMO_PASSWORD</code> in your <code>.env</code> file. Click an account to fill in the
          email.
        </p>
        <ul className="space-y-1">
          {DEMO_ACCOUNTS.map((a) => (
            <li key={a.email}>
              <button
                type="button"
                onClick={() => setEmail(a.email)}
                className="text-left text-sky-700 hover:underline focus:outline-2 focus:outline-sky-500"
              >
                {a.label}
              </button>{' '}
              <span className="text-slate-500">— {a.email}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
