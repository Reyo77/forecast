import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  AuthResponse,
  AuthUser,
  ChangePasswordInput,
  LoginInput,
  SignupInput,
} from '@supplycast/shared';
import { api, refreshSession, tokenStore } from '../../api/client';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  signup: (input: SignupInput) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (input: ChangePasswordInput) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const accept = useCallback((res: AuthResponse) => {
    tokenStore.set(res.accessToken);
    setUser(res.user);
  }, []);

  useEffect(() => {
    tokenStore.onAuthLost(() => {
      tokenStore.set(null);
      setUser(null);
    });
    // Restore the session from the httpOnly refresh cookie on page load.
    refreshSession()
      .then((session) => session && accept(session))
      .finally(() => setLoading(false));
    return () => tokenStore.onAuthLost(null);
  }, [accept]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      login: async (input) => accept(await api<AuthResponse>('/auth/login', 'POST', input)),
      signup: async (input) => accept(await api<AuthResponse>('/auth/signup', 'POST', input)),
      changePassword: async (input) =>
        accept(await api<AuthResponse>('/auth/change-password', 'POST', input)),
      logout: async () => {
        await api('/auth/logout', 'POST').catch(() => undefined);
        tokenStore.set(null);
        setUser(null);
      },
    }),
    [user, loading, accept],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
