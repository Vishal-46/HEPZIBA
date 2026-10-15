import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';
import { API_BASE_URL } from '../config/api';
import { COLOR, FONT, RADIUS, SHADOW, SPACING } from '../../theme';
import type { Session, User } from '../utils/sessionTypes';

WebBrowser.maybeCompleteAuthSession();

type AuthMode = 'login' | 'register' | 'verify' | 'forgot';

type Props = {
  onLoginSuccess: (session: Session) => void;
};

function asSession(payload: any): Session {
  const user = payload?.user as User;
  const token = String(payload?.token ?? '');
  if (!token || !user) throw new Error('Invalid login response from server.');
  const refreshToken = payload?.refreshToken ? String(payload.refreshToken) : undefined;
  return refreshToken ? { token, refreshToken, user } : { token, user };
}

export default function AuthScreen({ onLoginSuccess }: Props) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [forgotSent, setForgotSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [infoText, setInfoText] = useState('');
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [googleError, setGoogleError] = useState('');

  // Backend-mediated Google OAuth: the app never talks to Google directly,
  // so Google never sees an exp:// redirect (which it blocks with 400).
  const canSubmit = useMemo(() => {
    if (mode === 'register') return !!name.trim() && !!email.trim() && !!password.trim();
    if (mode === 'verify') return !!email.trim() && !!code.trim();
    if (mode === 'forgot') {
      if (!forgotSent) return !!email.trim();
      return !!email.trim() && !!code.trim() && !!newPassword.trim();
    }
    return !!email.trim() && !!password.trim();
  }, [code, email, forgotSent, mode, name, newPassword, password]);

  const handleDeepLink = (url: string | null | undefined) => {
    if (!url) return false;
    let parsed: any = null;
    try {
      parsed = Linking.parse(url);
    } catch {
      return false;
    }
    const path = String(parsed?.path ?? '');
    // Only handle our auth return (patient-mobile://auth or exp://.../--/auth).
    if (!path.startsWith('auth') && !url.includes('auth?') && !url.includes('auth&')) return false;
    const qp = (parsed?.queryParams ?? {}) as Record<string, any>;
    if (qp.error) {
      setIsGoogleLoading(false);
      setGoogleError(String(qp.error));
      return true;
    }
    if (qp.token) {
      const token = String(qp.token);
      const refreshToken = qp.refresh ? String(qp.refresh) : undefined;
      const user = {
        id: Number(qp.id) || 0,
        name: String(qp.name ?? 'Patient'),
        email: String(qp.email ?? ''),
        role: (qp.role ?? 'patient') as User['role'],
      };
      if (!token || !user.id || !user.email) {
        setIsGoogleLoading(false);
        setGoogleError('Google login returned an incomplete response.');
        return true;
      }
      setGoogleError('');
      setErrorText('');
      setIsGoogleLoading(false);
      onLoginSuccess(refreshToken ? { token, refreshToken, user } : { token, user });
      return true;
    }
    return false;
  };

  // Listen for the backend -> app redirect (patient-mobile://auth?... or exp://...).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const initial = await Linking.getInitialURL();
        if (!cancelled && initial) handleDeepLink(initial);
      } catch {
        // ignore
      }
    })();
    const sub = Linking.addEventListener('url', ({ url }) => {
      handleDeepLink(url);
    });
    // onLoginSuccess is stable from App (useCallback); safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  const submit = async () => {
    if (!canSubmit || isLoading) return;
    setIsLoading(true);
    setErrorText('');
    setGoogleError('');
    try {
      if (mode === 'register') {
        const registerResponse = await fetch(`${API_BASE_URL}/auth/register/patient`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim().toLowerCase(),
            password,
          }),
        });
        const registerPayload = await safeJson(registerResponse);
        if (!registerResponse.ok) {
          throw new Error(registerPayload?.error ?? 'Registration failed.');
        }
        // Real email verification: account exists but is unverified.
        // Go to code screen; backend emailed a 6-digit code (15-min expiry).
        const patientCode = registerPayload?.patient_code
          ? ` Patient ID: ${registerPayload.patient_code}.` : '';
        const mailNote = registerPayload?.mailSent === false
          ? ' Email could not be sent — tap Resend code.'
          : ' Verification code sent to your email.';
        setCode('');
        setMode('verify');
        setInfoText(`Account created.${patientCode}${mailNote}`);
        return;
      }
      if (mode === 'verify') {
        const verifyResponse = await fetch(`${API_BASE_URL}/auth/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim().toLowerCase(),
            code: code.trim(),
          }),
        });
        const verifyPayload = await safeJson(verifyResponse);
        if (!verifyResponse.ok)
          throw new Error(verifyPayload?.error ?? 'Verification failed.');
        setInfoText('Email verified. Signing you in...');
        // Auto-login with the credentials just registered.
        const loginResponse = await fetch(`${API_BASE_URL}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
        });
        const loginPayload = await safeJson(loginResponse);
        if (!loginResponse.ok)
          throw new Error(loginPayload?.error ?? 'Verified. Please sign in manually.');
        onLoginSuccess(asSession(loginPayload));
        return;
      }
      if (mode === 'forgot') {
        if (!forgotSent) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 25000);
          try {
            const forgotResponse = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: email.trim().toLowerCase() }),
              signal: ctrl.signal,
            });
            const forgotPayload = await safeJson(forgotResponse);
            if (!forgotResponse.ok)
              throw new Error(forgotPayload?.error ?? 'Could not send reset code.');
          } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') {
              throw new Error('Request timed out. Check your connection and try again.');
            }
            throw e;
          } finally {
            clearTimeout(timer);
          }
          setForgotSent(true);
          setInfoText('OTP sent. Enter it below with your new password.');
          return;
        }
        const resetResponse = await fetch(`${API_BASE_URL}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: email.trim().toLowerCase(),
            code: code.trim(),
            newPassword: newPassword.trim(),
          }),
        });
        const resetPayload = await safeJson(resetResponse);
        if (!resetResponse.ok)
          throw new Error(resetPayload?.error ?? 'Reset failed.');
        setMode('login');
        setForgotSent(false);
        setPassword('');
        setNewPassword('');
        setCode('');
        setInfoText('Password reset successful. Sign in with your new password.');
        return;
      }
      const loginResponse = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      const loginPayload = await safeJson(loginResponse);
      if (!loginResponse.ok) {
        if (loginResponse.status === 403 && loginPayload?.code === 'EMAIL_NOT_VERIFIED') {
          setCode('');
          setMode('verify');
          setInfoText('Email not verified. Enter the 6-digit code sent to your email.');
          return;
        }
        throw new Error(loginPayload?.error ?? 'Login failed.');
      }
      onLoginSuccess(asSession(loginPayload));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      setErrorText(
        message.includes('Network request failed')
          ? 'Cannot reach the server. Check your connection and API URL.'
          : message,
      );
    } finally {
      setIsLoading(false);
    }
  };

  const signInWithGoogle = async () => {
    if (isGoogleLoading || isLoading) return;
    setGoogleError('');
    setErrorText('');
    setIsGoogleLoading(true);
    try {
      // Deep link the backend should return to. In Expo Go this is
      // exp://192.168.x.x:8081/--/auth; in a build it is patient-mobile://auth.
      // Google never sees this — only the backend does.
      const returnUrl = Linking.createURL('auth');
      const startUrl =
        `${API_BASE_URL}/auth/google/start?redirect=${encodeURIComponent(returnUrl)}`;
      console.log(`[google] backend-oauth start platform=${Platform.OS}`);
      const result = await WebBrowser.openBrowserAsync(startUrl);
      // iOS/Android dismiss without a Linking event = user cancelled.
      if (result.type === 'dismiss' || result.type === 'cancel') {
        setIsGoogleLoading(false);
      }
      // On web, openBrowserAsync may return the final redirect URL directly.
      const finalUrl = (result as any)?.url as string | undefined;
      if (finalUrl && handleDeepLink(finalUrl)) return;
      // Otherwise the Linking listener above completes the login.
      // Fallback: clear spinner after 60s so it never sticks.
      setTimeout(() => setIsGoogleLoading((v) => (v ? false : v)), 60000);
    } catch (error) {
      setIsGoogleLoading(false);
      const message = error instanceof Error ? error.message : 'Google sign-in failed.';
      setGoogleError(
        message.includes('Network request failed')
          ? 'Cannot reach the server. Check your connection and API URL.'
          : message,
      );
    }
  };

  const busy = isLoading || isGoogleLoading;

  const resendCode = async () => {
    if (busy || !email.trim()) return;
    setIsLoading(true);
    setErrorText('');
    try {
      const res = await fetch(`${API_BASE_URL}/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const payload = await safeJson(res);
      if (!res.ok) throw new Error(payload?.error ?? 'Resend failed.');
      setInfoText(payload?.message ?? 'Verification code resent to your email.');
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Resend failed.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={s.safeArea}>
      <KeyboardAvoidingView
        style={s.keyboardWrap}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
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
                <TextInput
                  value={name}
                  onChangeText={setName}
                  style={s.input}
                  placeholder="Enter your full name"
                  editable={!busy}
                />
              </View>
            )}
            <View style={s.fieldGroup}>
              <Text style={s.label}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                style={s.input}
                placeholder="name@email.com"
                autoCapitalize="none"
                keyboardType="email-address"
                editable={!busy}
              />
            </View>
            {mode === 'login' && (
              <View style={s.fieldGroup}>
                <Text style={s.label}>Password</Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  style={s.input}
                  placeholder="Enter your password"
                  secureTextEntry
                  editable={!busy}
                />
                <TouchableOpacity style={s.switchBtn} onPress={() => {
                  setErrorText('');
                  setInfoText('');
                  setCode('');
                  setNewPassword('');
                  setForgotSent(false);
                  setMode('forgot');
                }}>
                  <Text style={s.switchText}>Forgot password?</Text>
                </TouchableOpacity>
              </View>
            )}
            {mode === 'register' && (
              <View style={s.fieldGroup}>
                <Text style={s.label}>Password</Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  style={s.input}
                  placeholder="Enter your password"
                  secureTextEntry
                  editable={!busy}
                />
              </View>
            )}
            {mode === 'verify' && (
              <>
                <View style={s.fieldGroup}>
                  <Text style={s.label}>OTP code</Text>
                  <TextInput
                    value={code}
                    onChangeText={setCode}
                    style={s.input}
                    placeholder="6-digit code"
                    keyboardType="number-pad"
                    editable={!busy}
                  />
                </View>
                <TouchableOpacity style={s.switchBtn} onPress={resendCode} disabled={busy}>
                  <Text style={s.switchText}>Resend code</Text>
                </TouchableOpacity>
              </>
            )}
            {mode === 'forgot' && forgotSent && (
              <View>
                <View style={s.fieldGroup}>
                  <Text style={s.label}>OTP code</Text>
                  <TextInput
                    value={code}
                    onChangeText={setCode}
                    style={s.input}
                    placeholder="6-digit code"
                    keyboardType="number-pad"
                    editable={!busy}
                  />
                </View>
                <View style={s.fieldGroup}>
                  <Text style={s.label}>New password</Text>
                  <TextInput
                    value={newPassword}
                    onChangeText={setNewPassword}
                    style={s.input}
                    placeholder="Enter new password"
                    secureTextEntry
                    editable={!busy}
                  />
                </View>
              </View>
            )}
            {!!infoText && <Text style={s.infoText}>{infoText}</Text>}
            {!!errorText && <Text style={s.errorText}>{errorText}</Text>}
            {!!googleError && <Text style={s.errorText}>{googleError}</Text>}
            <TouchableOpacity
              style={[s.primaryBtn, (!canSubmit || busy) && s.primaryBtnDisabled]}
              onPress={submit}
              disabled={!canSubmit || busy}
            >
              {isLoading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={s.primaryBtnText}>
                  {mode === 'login' && 'Sign In'}
                  {mode === 'register' && 'Create Account'}
                  {mode === 'verify' && 'Verify and Continue'}
                  {mode === 'forgot' && (!forgotSent ? 'Send Reset OTP' : 'Reset Password')}
                </Text>
              )}
            </TouchableOpacity>

            {(mode === 'login' || mode === 'register') && (
              <>
                {mode === 'login' && (
                  <Text style={[s.infoText, { marginBottom: 4 }]}>
                    Registered at the clinic? Sign in with the email you gave at reception — Google sign-in or your password both work.
                  </Text>
                )}
                <View style={s.dividerRow}>
                  <View style={s.dividerLine} />
                  <Text style={s.dividerText}>or</Text>
                  <View style={s.dividerLine} />
                </View>
                <TouchableOpacity
                  style={[s.googleBtn, busy && s.primaryBtnDisabled]}
                  onPress={signInWithGoogle}
                  disabled={busy}
                >
                  {isGoogleLoading ? (
                    <ActivityIndicator color={COLOR.primary} />
                  ) : (
                    <Text style={s.googleBtnText}>Continue with Google</Text>
                  )}
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              style={s.switchBtn}
              onPress={() => {
                setErrorText('');
                setGoogleError('');
                setInfoText('');
                setCode('');
                setNewPassword('');
                setForgotSent(false);
                setMode(mode === 'login' ? 'register' : 'login');
              }}
            >
              <Text style={s.switchText}>
                {mode === 'login'
                  ? 'No account? Register'
                  : 'Already have an account? Sign in'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const s = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLOR.background },
  keyboardWrap: { flex: 1 },
  container: {
    flex: 1,
    paddingHorizontal: SPACING.l,
    paddingVertical: SPACING.xl,
    justifyContent: 'center',
  },
  headerBlock: { marginBottom: SPACING.l },
  brand: { fontFamily: FONT.medium, color: COLOR.primary, marginBottom: SPACING.s, fontSize: 15 },
  heading: { fontFamily: FONT.bold, color: COLOR.text, fontSize: 30, marginBottom: SPACING.s },
  card: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.l,
    ...SHADOW.card,
  },
  fieldGroup: { marginBottom: SPACING.m },
  label: { fontFamily: FONT.medium, color: COLOR.text, marginBottom: SPACING.s, fontSize: 14 },
  input: {
    borderWidth: 1,
    borderColor: COLOR.accent,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.m,
    paddingVertical: 14,
    color: COLOR.text,
    backgroundColor: COLOR.background,
    fontSize: 15,
  },
  errorText: { fontFamily: FONT.regular, color: '#9C4A4A', marginBottom: SPACING.s, fontSize: 14 },
  infoText: { fontFamily: FONT.regular, color: COLOR.primary, marginBottom: SPACING.s, fontSize: 14 },
  hintText: {
    fontFamily: FONT.regular,
    color: COLOR.primary,
    marginTop: SPACING.s,
    fontSize: 12,
    textAlign: 'center',
  },
  primaryBtn: {
    backgroundColor: COLOR.primary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.m,
    alignItems: 'center',
    marginTop: SPACING.s,
  },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: COLOR.surface, fontFamily: FONT.bold, fontSize: 16 },
  googleBtn: {
    backgroundColor: COLOR.surface,
    borderWidth: 1,
    borderColor: COLOR.accent,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.m,
    alignItems: 'center',
    marginTop: SPACING.s,
  },
  googleBtnText: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 15 },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACING.l,
    gap: SPACING.s,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: COLOR.accent, opacity: 0.5 },
  dividerText: { fontFamily: FONT.medium, color: COLOR.primary, fontSize: 13 },
  switchBtn: { marginTop: SPACING.l, alignItems: 'center' },
  switchText: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 14 },
});
