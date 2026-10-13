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
import type { Session } from './src/utils/sessionTypes';
import {
  clearSession,
  loadSession,
  saveSession,
} from './src/utils/tokenStore';
import { configureApiClient } from './src/utils/apiClient';

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
    });
  }, [handleLogout]);

  // Restore persisted session once on launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await loadSession();
        if (!cancelled && stored?.token) setSession(stored);
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
