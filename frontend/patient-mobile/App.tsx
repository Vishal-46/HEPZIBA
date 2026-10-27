import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, SafeAreaView, Text, View } from 'react-native';
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
  clearSession,
  loadSession,
  saveSession,
} from './src/utils/tokenStore';
import { configureApiClient, apiGet } from './src/utils/apiClient';
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

  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_700Bold,
  });

  const handleLogout = useCallback(async () => {
    const stale = sessionRef.current;
    // Server-side logout first (best effort): revokes the refresh token and
    // denylists the access jti so the JWT dies now, not at expiry.
    if (stale?.token || stale?.refreshToken) {
      try {
        await fetch(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(stale.token ? { Authorization: `Bearer ${stale.token}` } : {}),
          },
          body: JSON.stringify(stale.refreshToken ? { refreshToken: stale.refreshToken } : {}),
        });
      } catch {
        // Offline logout still clears the local session below.
      }
    }
    try {
      await clearSession();
    } finally {
      setSession(null);
    }
  }, []);

  const handleLoginSuccess = useCallback(async (nextSession: Session) => {
    setSession(nextSession);
    try {
      await saveSession(nextSession);
    } catch {
      // Session still works in-memory for this launch.
    }
  }, []);

  // Wire the shared fetch client to the current token + global 401 logout.
  useEffect(() => {
    configureApiClient({
      getToken: () => sessionRef.current?.token ?? null,
      onUnauthorized: () => {
        // Fire-and-forget; guard against logout loops when already logged out.
        if (sessionRef.current) void handleLogout();
      },
      // Silent rotation: expired access (15m) is refreshed from the stored
      // refresh token and the failed request retried once — no re-login.
      refreshAccess: async () => {
        const stale = sessionRef.current;
        if (!stale?.refreshToken) return null;
        try {
          const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: stale.refreshToken }),
          });
          if (!res.ok) return null;
          const payload = (await res.json().catch(() => null)) as any;
          if (!payload?.token || !payload?.user) return null;
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
        } catch {
          return null;
        }
      },
    });
  }, [handleLogout]);

  // Restore persisted session once on launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await loadSession();
        if (!cancelled && stored?.token) {
          sessionRef.current = stored;
          setSession(stored);
          // Token present but cached user unusable (e.g. JSON corrupt / legacy
          // placeholder) → hydrate the real patient via /patients/me.
          if (stored.user.id === 0) {
            try {
              const me = await apiGet<any>('/patients/me');
              const meUser: User = {
                id: Number(me?.id ?? 0),
                name: String(me?.name ?? stored.user.name ?? ''),
                email: String(me?.email ?? stored.user.email ?? ''),
                role: (me?.role as User['role']) ?? stored.user.role,
              };
              const next: Session = {
                token: stored.token,
                ...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {}),
                user: meUser,
              };
              sessionRef.current = next;
              setSession(next);
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
  }, []);

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
              token={session.token}
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
