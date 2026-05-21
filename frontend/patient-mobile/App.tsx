import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, SafeAreaView, Text, View } from 'react-native';
import { useFonts, Manrope_400Regular, Manrope_500Medium, Manrope_700Bold } from '@expo-google-fonts/manrope';
import AuthScreen from './src/screens/AuthScreen';
import PatientHomeScreen from './src/screens/PatientHomeScreen';
import { COLOR } from './theme';

type User = {
  id: number;
  name: string;
  email: string;
  role: 'patient' | 'doctor' | 'admin';
};

type Session = {
  token: string;
  user: User;
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [fontsLoaded] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_700Bold,
  });

  if (!fontsLoaded) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: COLOR.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={COLOR.primary} />
        <Text style={{ marginTop: 12, color: COLOR.primary }}>Loading app...</Text>
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: COLOR.background }}>
      <StatusBar style="dark" backgroundColor={COLOR.background}/>
      {session ? (
        <PatientHomeScreen
          token={session.token}
          user={session.user}
          onLogout={() => setSession(null)}
        />
      ) : (
        <AuthScreen onLoginSuccess={(nextSession) => setSession(nextSession)} />
      )}
    </View>
  );
}
