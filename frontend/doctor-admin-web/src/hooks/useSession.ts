import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '../types';
import { clearSession, loadSession, saveSession } from '../utils/authStorage';
import apiClient from '../utils/apiClient';

/**
 * Persistent session hook.
 * - Restores token+user from localStorage on load.
 * - `login` persists, `logout` revokes server-side then clears.
 */
export function useSession() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    // Session is already restored via the lazy initializer above; this effect
    // only flips the flag after mount to avoid a sync setState-in-effect.
    const id = requestAnimationFrame(() => setRestored(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const login = useCallback((next: Session) => {
    saveSession(next);
    setSession(next);
  }, []);

  const logout = useCallback(() => {
    // Server-side logout (best effort): revokes refresh + denylists access
    // so the JWT dies now instead of at expiry. Local state clears regardless.
    const stale = session;
    if (stale?.token || stale?.refreshToken) {
      void apiClient
        .post(
          '/auth/logout',
          stale.refreshToken ? { refreshToken: stale.refreshToken } : {},
          stale.token ? { headers: { Authorization: `Bearer ${stale.token}` } } : undefined,
        )
        .catch(() => {
          // Offline logout still clears local state below.
        });
    }
    clearSession();
    setSession(null);
  }, [session]);

  return useMemo(
    () => ({ session, restored, login, logout, setSession }),
    [session, restored, login, logout],
  );
}
