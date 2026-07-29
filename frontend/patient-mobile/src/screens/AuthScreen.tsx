import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import { API_BASE_URL } from '../config/api';
import { COLOR, FONT, RADIUS, SHADOW, SPACING } from '../../theme';

WebBrowser.maybeCompleteAuthSession();

const createStyles = <T extends Record<string, unknown>>(styles: T): T => {
  return typeof (StyleSheet as { create?: (value: T) => T }).create === 'function'
    ? (StyleSheet as { create: (value: T) => T }).create(styles)
    : styles;
};

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

type AuthMode = 'login' | 'register' | 'verify' | 'forgot';

type Props = {
  onLoginSuccess: (session: Session) => void;
};

export default function AuthScreen({ onLoginSuccess }: Props) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [infoText, setInfoText] = useState('');
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const googleAndroidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
  const googleExpoClientId = process.env.EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID;
  const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;

  const [googleRequest, googleResponse, googlePromptAsync] = Google.useAuthRequest({
    androidClientId: googleAndroidClientId,
    clientId: googleExpoClientId,
    webClientId: googleWebClientId,
    scopes: ['openid', 'profile', 'email'],
    responseType: AuthSession.ResponseType.IdToken,
    extraParams: { prompt: 'select_account' },
  });

  const canSubmit = useMemo(() => {
    if (mode === 'register') return !!name.trim() && !!email.trim() && !!password.trim();
    if (mode === 'verify') return !!email.trim() && !!code.trim();
    if (mode === 'forgot') {
        if (!code.trim()) return !!email.trim();
        return !!email.trim() && !!code.trim() && !!newPassword.trim();
    }
    return !!email.trim() && !!password.trim();
  }, [code, email, mode, name, newPassword, password]);

  const submit = async () => {
    if (!canSubmit || isLoading) return;
    setIsLoading(true);
    setErrorText('');
    try {
      if (mode === 'register') {
        const registerResponse = await fetch(`${API_BASE_URL}/auth/register/patient`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), password }),
        });
        if (!registerResponse.ok) {
          const registerError = await safeJson(registerResponse);
          throw new Error(registerError?.error ?? 'Registration failed.');
        }
        setMode('verify');
        setInfoText('Verification code sent to your email.');
        return;
      }
      if (mode === 'verify') {
        const verifyResponse = await fetch(`${API_BASE_URL}/auth/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim().toLowerCase(), code: code.trim() }),
        });
        const verifyPayload = await safeJson(verifyResponse);
        if (!verifyResponse.ok) throw new Error(verifyPayload?.error ?? 'Verification failed.');
        setInfoText('Email verified. Signing you in...');
      }
      if (mode === 'forgot') {
        if (!code.trim()) {
          const forgotResponse = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.trim().toLowerCase() }),
          });
          const forgotPayload = await safeJson(forgotResponse);
          if (!forgotResponse.ok) throw new Error(forgotPayload?.error ?? 'Could not send reset code.');
          setInfoText('OTP sent. Please enter it below to verify.');
          return;
        }
        const resetResponse = await fetch(`${API_BASE_URL}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim().toLowerCase(), code: code.trim(), newPassword: newPassword.trim() }),
        });
        const resetPayload = await safeJson(resetResponse);
        if (!resetResponse.ok) throw new Error(resetPayload?.error ?? 'Reset failed.');
        setMode('login');
        setPassword(''); setNewPassword(''); setCode('');
        setInfoText('Password reset successful. Sign in.');
        return;
      }
      const loginResponse = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      const loginPayload = await safeJson(loginResponse);
      if (!loginResponse.ok) throw new Error(loginPayload?.error ?? 'Login failed.');
      onLoginSuccess({ token: loginPayload.token, user: loginPayload.user });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setIsLoading(false);
    }
  };

  const signInWithGoogle = async () => {
    if (isGoogleLoading || isLoading) return;
    setIsGoogleLoading(true);
    await googlePromptAsync();
  };

  return (
    <SafeAreaView style={s.safeArea}>
      <KeyboardAvoidingView style={s.keyboardWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.container}>
          <View style={s.headerBlock}>
            <Text style={s.brand}>Hepziba Chest Clinic</Text>
            <Text style={s.heading}>
              {mode === 'login' && 'Welcome back'}
              {mode === 'register' && 'Create patient account'}
              {mode === 'verify' && 'Verify your email'}
              {mode === 'forgot' && 'Reset password'}
            </Text>
          </View>
          <View style={s.card}>
            {mode === 'register' && (
              <View style={s.fieldGroup}>
                <Text style={s.label}>Full name</Text>
                <TextInput value={name} onChangeText={setName} style={s.input} placeholder="Enter your full name" />
              </View>
            )}
            <View style={s.fieldGroup}>
              <Text style={s.label}>Email</Text>
              <TextInput value={email} onChangeText={setEmail} style={s.input} placeholder="name@email.com" autoCapitalize="none" keyboardType="email-address" />
            </View>
            {mode === 'login' && (
              <View style={s.fieldGroup}>
                <Text style={s.label}>Password</Text>
                <TextInput value={password} onChangeText={setPassword} style={s.input} placeholder="Enter your password" secureTextEntry />
                <TouchableOpacity style={s.switchBtn} onPress={() => setMode('forgot')}>
                  <Text style={s.switchText}>Forgot password?</Text>
                </TouchableOpacity>
              </View>
            )}
            {mode === 'register' && (
              <View style={s.fieldGroup}>
                <Text style={s.label}>Password</Text>
                <TextInput value={password} onChangeText={setPassword} style={s.input} placeholder="Enter your password" secureTextEntry />
              </View>
            )}
            {mode === 'verify' && (
              <View style={s.fieldGroup}>
                <Text style={s.label}>OTP code</Text>
                <TextInput value={code} onChangeText={setCode} style={s.input} placeholder="6-digit code" keyboardType="number-pad" />
              </View>
            )}
            {mode === 'forgot' && !!infoText.includes('OTP sent') && (
              <View>
                <View style={s.fieldGroup}>
                  <Text style={s.label}>OTP code</Text>
                  <TextInput value={code} onChangeText={setCode} style={s.input} placeholder="6-digit code" keyboardType="number-pad" />
                </View>
                <View style={s.fieldGroup}>
                  <Text style={s.label}>New password</Text>
                  <TextInput value={newPassword} onChangeText={setNewPassword} style={s.input} placeholder="Enter new password" secureTextEntry />
                </View>
              </View>
            )}
            {!!infoText && <Text style={s.infoText}>{infoText}</Text>}
            {!!errorText && <Text style={s.errorText}>{errorText}</Text>}
             <TouchableOpacity style={s.primaryBtn} onPress={() => { console.log('Primary pressed'); submit(); }} disabled={!canSubmit || isLoading}>
              <Text style={s.primaryBtnText}>
                {mode === 'login' && 'Sign In'}
                {mode === 'register' && 'Create Account'}
                {mode === 'verify' && 'Verify and Continue'}
                {mode === 'forgot' && (!code.trim() ? 'Send Reset OTP' : 'Reset Password')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.switchBtn} onPress={() => { console.log('Switch pressed'); setMode(mode === 'login' ? 'register' : 'login'); }}>
              <Text style={s.switchText}>
                {mode === 'login' ? 'No account? Register' : 'Already have an account? Sign in'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

async function safeJson(response: Response): Promise<any> {
  try { return await response.json(); } catch { return null; }
}

const s = createStyles({
  safeArea: { flex: 1, backgroundColor: COLOR.background },
  keyboardWrap: { flex: 1 },
  container: { flex: 1, paddingHorizontal: SPACING.l, paddingVertical: SPACING.xl, justifyContent: 'center' },
  headerBlock: { marginBottom: SPACING.l },
  brand: { fontFamily: FONT.medium, color: COLOR.primary, marginBottom: SPACING.s, fontSize: 15 },
  heading: { fontFamily: FONT.bold, color: COLOR.text, fontSize: 30, marginBottom: SPACING.s },
  subheading: { fontFamily: FONT.regular, color: COLOR.primary, fontSize: 15, lineHeight: 22 },
  card: { backgroundColor: COLOR.surface, borderRadius: RADIUS.lg, padding: SPACING.l, ...SHADOW.card },
  fieldGroup: { marginBottom: SPACING.m },
  label: { fontFamily: FONT.medium, color: COLOR.text, marginBottom: SPACING.s, fontSize: 14 },
  input: { borderWidth: 1, borderColor: COLOR.accent, borderRadius: RADIUS.md, paddingHorizontal: SPACING.m, paddingVertical: 14, color: COLOR.text, backgroundColor: COLOR.background, fontSize: 15 },
  errorText: { fontFamily: FONT.regular, color: COLOR.text, marginBottom: SPACING.s, fontSize: 14 },
  infoText: { fontFamily: FONT.regular, color: COLOR.primary, marginBottom: SPACING.s, fontSize: 14 },
  primaryBtn: { backgroundColor: COLOR.primary, borderRadius: RADIUS.md, paddingVertical: SPACING.m, alignItems: 'center', marginTop: SPACING.s },
  primaryBtnText: { color: COLOR.surface, fontFamily: FONT.bold, fontSize: 16 },
  switchBtn: { marginTop: SPACING.l, alignItems: 'center' },
  switchText: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 14 },
});
