import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { type AuthUser, fetchMe, login, logout } from '../api/auth';
import { setUnauthorizedHandler } from '../api/client';

type AuthState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; user: AuthUser };

interface AuthContextValue {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Keeps the signed-in user in memory; the session itself lives in an HttpOnly cookie. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    setUnauthorizedHandler(() => setState({ status: 'anonymous' }));
    fetchMe().then(
      ({ user }) => setState({ status: 'authenticated', user }),
      () => setState((s) => (s.status === 'loading' ? { status: 'anonymous' } : s)),
    );
    return () => setUnauthorizedHandler(null);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { user } = await login(email, password);
    setState({ status: 'authenticated', user });
  }, []);

  const signOut = useCallback(async () => {
    await logout().catch(() => undefined);
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo(() => ({ state, signIn, signOut }), [state, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}

/** The signed-in user. Only call from components rendered after login. */
export function useUser(): AuthUser {
  const { state } = useAuth();
  if (state.status !== 'authenticated') throw new Error('useUser called while signed out.');
  return state.user;
}
