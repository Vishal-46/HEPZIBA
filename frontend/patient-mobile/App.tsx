import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, AppState, Platform, SafeAreaView, Text, View } from 'react-native';
import {
  useFonts,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_700Bold,
} from '@expo-google-fonts/manrope';
import { Provider as PaperProvider, DefaultTheme } from 'react-native-paper';
import { NavigationContainer } from '@react-navigation/native';
import AuthScreen from './src/screens/AuthScreen';
import PatientHomeScreen from './src/screens/PatientHomeScreen';
import { COLOR } from './theme';
import type { Session, User } from './src/utils/sessionTypes';
import {
  clearPushToken,
  clearSession,
  loadPushToken,
  loadSession,
  saveSession,
} from './src/utils/tokenStore';
import {
  configureApiClient,
  apiGet,
  isJwtExpiringSoon,
  RefreshTransientError,
} from './src/utils/apiClient';
import { API_BASE_URL } from './src/config/api';

const paperTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: COLOR.primary,
    background: COLOR.background,
    surface: COLOR.surface,
    // `DefaultTheme.colors.text` exists at runtime; keep the override typed loosely.
    ...( { text: COLOR.text } as object ),
  },
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState('');
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  const loggingOutRef = useRef(false);
  const inflightRefreshRef = useRef<Promise<string | null> | null>(null);

  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_700Bold,
  });

  const handleLogout = useCallback(async () => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    const stale = sessionRef.current;
    // Clear the live ref before network calls so concurrent 401s cannot
    // re-enter logout or trigger a refresh loop.
    sessionRef.current = null;
    try {
      const pushToken = await loadPushToken().catch(() => null);
      // Best-effort push deactivation via direct fetch (never apiRequest, which
      // would attempt refresh / onUnauthorized on an expired JWT).
      if (stale?.token && Platform.OS !== 'web') {
        try {
          await fetch(`${API_BASE_URL}/patients/push-token`, {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${stale.token}`,
            },
            body: JSON.stringify(pushToken ? { token: pushToken } : {}),
          });
        } catch {
          // /auth/logout below also deactivates pushToken using refreshToken.
        }
        await clearPushToken().catch(() => {});
      }
      // Server-side logout (best effort): revokes the refresh token,
      // denylists the access jti, and deactivates pushToken even when JWT expired.
      if (stale?.token || stale?.refreshToken) {
        try {
          await fetch(`${API_BASE_URL}/auth/logout`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(stale.token ? { Authorization: `Bearer ${stale.token}` } : {}),
            },
            body: JSON.stringify({
              ...(stale.refreshToken ? { refreshToken: stale.refreshToken } : {}),
              ...(pushToken ? { pushToken } : {}),
            }),
          });
        } catch {
          // Offline logout still clears the local session below.
        }
      }
      await clearSession();
    } finally {
      setSession(null);
      loggingOutRef.current = false;
    }
  }, []);

  const handleLoginSuccess = useCallback(async (nextSession: Session) => {
    sessionRef.current = nextSession;
    setSession(nextSession);
    try {
      await saveSession(nextSession);
    } catch {
      // Session still works in-memory for this launch.
    }
  }, []);

  const refreshAccessToken = useCallback(async (): Promise<string | null> => {
    if (inflightRefreshRef.current) return inflightRefreshRef.current;
    const run = (async (): Promise<string | null> => {
      const stale = sessionRef.current ?? (await loadSession().catch(() => null));
      if (!stale?.refreshToken) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: stale.refreshToken }),
          signal: controller.signal,
        });
        if (res.status === 401 || res.status === 400) {
          // Definitive server rejection (expired/revoked/invalid refresh token).
          return null;
        }
        if (!res.ok) {
          // 5xx / 429 / cold-start failure: do NOT wipe user's persisted login.
          throw new RefreshTransientError(`Refresh failed (${res.status})`);
        }
        const payload = (await res.json().catch(() => null)) as any;
        if (!payload?.token || !payload?.user) {
          throw new RefreshTransientError('Invalid refresh response');
        }
        const next: Session = {
          token: String(payload.token),
          refreshToken: payload.refreshToken ? String(payload.refreshToken) : stale.refreshToken,
          user: payload.user,
        };
        sessionRef.current = next;
        setSession(next);
        try {
          await saveSession(next);
        } catch {
          // In-memory session still works for this launch.
        }
        return next.token;
      } catch (err) {
        if (err instanceof RefreshTransientError) throw err;
        throw new RefreshTransientError(
          err instanceof Error ? err.message : 'Network error during refresh',
        );
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => {
      inflightRefreshRef.current = null;
    });
    inflightRefreshRef.current = run;
    return run;
  }, []);

  // Wire the shared fetch client to the current token + global 401 logout.
  useEffect(() => {
    configureApiClient({
      getToken: () => sessionRef.current?.token ?? null,
      onUnauthorized: () => {
        // Fire-and-forget; guard against logout loops when already logged out.
        if (sessionRef.current && !loggingOutRef.current) void handleLogout();
      },
      refreshAccess: refreshAccessToken,
    });
  }, [handleLogout, refreshAccessToken]);

  // Restore persisted session once on launch, proactively refreshing an
  // expired/expiring access token before child screens fire requests.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await loadSession();
        if (!cancelled && stored?.token) {
          sessionRef.current = stored;
          let activeSession = stored;
          if (stored.refreshToken && isJwtExpiringSoon(stored.token)) {
            try {
              const fresh = await refreshAccessToken();
              if (!fresh && !cancelled) {
                // Refresh token was definitively rejected -> clear stale session.
                await clearSession().catch(() => {});
                sessionRef.current = null;
                setSession(null);
                return;
              }
              if (sessionRef.current) activeSession = sessionRef.current;
            } catch {
              // Offline / transient error: keep persisted session and let UI show offline state.
            }
          }
          if (!cancelled) setSession(activeSession);
          // Token present but cached user unusable (e.g. JSON corrupt / legacy
          // placeholder) -> hydrate the real patient via /patients/me.
          if (!cancelled && activeSession.user.id === 0) {
            try {
              const me = await apiGet<any>('/patients/me');
              const meUser: User = {
                id: Number(me?.id ?? 0),
                name: String(me?.name ?? activeSession.user.name ?? ''),
                email: String(me?.email ?? activeSession.user.email ?? ''),
                role: (me?.role as User['role']) ?? activeSession.user.role,
              };
              const next: Session = {
                token: sessionRef.current?.token ?? activeSession.token,
                refreshToken: sessionRef.current?.refreshToken ?? activeSession.refreshToken,
                user: meUser,
              };
              sessionRef.current = next;
              if (!cancelled) setSession(next);
              try {
                await saveSession(next);
              } catch {
                // In-memory session still works for this launch.
              }
            } catch {
              // Keep the placeholder; data calls will surface the error.
            }
          }
        }
      } catch {
        if (!cancelled) setRestoreError('Could not restore your session.');
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshAccessToken]);

  // Proactively refresh expiring access token when returning to foreground so
  // resumed sessions stay seamlessly logged in across idle periods.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      const cur = sessionRef.current;
      if (!cur?.token || !cur.refreshToken) return;
      if (isJwtExpiringSoon(cur.token)) {
        void refreshAccessToken()
          .then((fresh) => {
            if (!fresh && sessionRef.current && !loggingOutRef.current) {
              void handleLogout();
            }
          })
          .catch(() => {
            // Keep session on transient/offline error.
          });
      }
    });
    return () => sub.remove();
  }, [handleLogout, refreshAccessToken]);

  if (!fontsLoaded || restoring) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: COLOR.background,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={COLOR.primary} />
        <Text style={{ marginTop: 12, color: COLOR.primary }}>
          {restoring ? 'Restoring your session...' : 'Loading app...'}
        </Text>
        {!!restoreError && (
          <Text style={{ marginTop: 8, color: COLOR.text }}>{restoreError}</Text>
        )}
      </SafeAreaView>
    );
  }

  return (
    <NavigationContainer>
      <PaperProvider theme={paperTheme}>
        <View style={{ flex: 1, backgroundColor: COLOR.background }}>
          <StatusBar style="dark" />
          {session ? (
            <PatientHomeScreen
              user={session.user}
              onLogout={() => void handleLogout()}
            />
          ) : (
            <AuthScreen onLoginSuccess={(s) => void handleLoginSuccess(s)} />
          )}
        </View>
      </PaperProvider>
    </NavigationContainer>
  );
}
