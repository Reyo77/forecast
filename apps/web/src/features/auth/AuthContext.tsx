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
  AcceptInviteInput,
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
  acceptInvite: (input: AcceptInviteInput) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (input: ChangePasswordInput) => Promise<void>;
  suspended: boolean;
  impersonation: { tenantName: string } | null;
  startImpersonation: (tenantId: string) => Promise<void>;
  stopImpersonation: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [suspended, setSuspended] = useState(false);
  const [impersonation, setImpersonation] = useState<{ tenantName: string } | null>(null);

  const accept = useCallback((res: AuthResponse) => {
    tokenStore.set(res.accessToken);
    setUser(res.user);
  }, []);

  useEffect(() => {
    tokenStore.onAuthLost(() => {
      tokenStore.set(null);
      setUser(null);
      setImpersonation(null);
    });
    tokenStore.onSuspended(() => setSuspended(true));
    // Restore the session from the httpOnly refresh cookie on page load.
    refreshSession()
      .then((session) => session && accept(session))
      .finally(() => setLoading(false));
    return () => {
      tokenStore.onAuthLost(null);
      tokenStore.onSuspended(null);
    };
  }, [accept]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      suspended,
      impersonation,
      startImpersonation: async (tenantId) => {
        const res = await api<AuthResponse & { tenantName: string }>(
          `/admin/tenants/${tenantId}/impersonate`,
          'POST',
        );
        tokenStore.set(res.accessToken);
        setUser(res.user);
        setImpersonation({ tenantName: res.tenantName });
      },
      stopImpersonation: async () => {
        setImpersonation(null);
        setSuspended(false);
        const session = await refreshSession();
        if (session) accept(session);
        else {
          tokenStore.set(null);
          setUser(null);
        }
      },
      login: async (input) => accept(await api<AuthResponse>('/auth/login', 'POST', input)),
      acceptInvite: async (input) =>
        accept(await api<AuthResponse>('/invites/accept', 'POST', input)),
      signup: async (input) => accept(await api<AuthResponse>('/auth/signup', 'POST', input)),
      changePassword: async (input) =>
        accept(await api<AuthResponse>('/auth/change-password', 'POST', input)),
      logout: async () => {
        await api('/auth/logout', 'POST').catch(() => undefined);
        tokenStore.set(null);
        setUser(null);
      },
    }),
    [user, loading, accept, suspended, impersonation],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
