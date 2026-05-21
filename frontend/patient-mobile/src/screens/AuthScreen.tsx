import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_BASE_URL } from '../config/api';
import { COLOR, FONT, RADIUS, SHADOW, SPACING } from '../../theme';

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

  const canSubmit = useMemo(() => {
    if (!email.trim()) return false;
    if (mode === 'register') return !!name.trim() && !!password.trim();
    if (mode === 'verify') return !!code.trim();
    if (mode === 'forgot') return !code.trim() || !!newPassword.trim();
    return !!password.trim();
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
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim().toLowerCase(),
            password,
          }),
        });

        if (!registerResponse.ok) {
          const registerError = await safeJson(registerResponse);
          throw new Error(registerError?.error ?? 'Registration failed. Please check details.');
        }

        setMode('verify');
        setInfoText('Verification code sent to your email. Enter it below to activate your account.');
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
        if (!verifyResponse.ok) {
          throw new Error(verifyPayload?.error ?? 'Verification failed. Check code and try again.');
        }

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
          if (!forgotResponse.ok) {
            throw new Error(forgotPayload?.error ?? 'Could not send reset code.');
          }

          setInfoText('Reset OTP sent. Enter the code and new password below.');
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
        if (!resetResponse.ok) {
          throw new Error(resetPayload?.error ?? 'Reset failed.');
        }

        setMode('login');
        setPassword('');
        setNewPassword('');
        setCode('');
        setInfoText('Password reset successful. Sign in with your new password.');
        return;
      }

      const loginResponse = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          password,
        }),
      });

      const loginPayload = await safeJson(loginResponse);

      if (!loginResponse.ok) {
        if (loginPayload?.error === 'Email not verified.') {
          setMode('verify');
          setInfoText('This email is not verified yet. Enter the OTP sent to your inbox.');
        }
        throw new Error(loginPayload?.error ?? 'Login failed. Check your email or password.');
      }

      if (!loginPayload?.token || !loginPayload?.user) {
        throw new Error('Invalid login response from server.');
      }

      onLoginSuccess({ token: loginPayload.token, user: loginPayload.user });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
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
            <Text style={s.subheading}>
              {mode === 'login' && 'Sign in to access appointments, records, and profile.'}
              {mode === 'register' && 'Register as a patient to start booking appointments.'}
              {mode === 'verify' && 'Enter the OTP sent to your email after registration.'}
              {mode === 'forgot' && 'First request OTP, then enter OTP with new password.'}
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
                  placeholderTextColor={COLOR.accent}
                  autoCapitalize="words"
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
                placeholderTextColor={COLOR.accent}
                autoCapitalize="none"
                keyboardType="email-address"
                editable={mode !== 'verify'}
              />
            </View>

            {mode === 'login' || mode === 'register' ? (
              <View style={s.fieldGroup}>
                <Text style={s.label}>Password</Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  style={s.input}
                  placeholder="Enter your password"
                  placeholderTextColor={COLOR.accent}
                  secureTextEntry
                />
              </View>
            ) : (
              <View style={s.fieldGroup}>
                <Text style={s.label}>OTP code</Text>
                <TextInput
                  value={code}
                  onChangeText={setCode}
                  style={s.input}
                  placeholder="6-digit code"
                  placeholderTextColor={COLOR.accent}
                  keyboardType="number-pad"
                  autoCapitalize="none"
                />
              </View>
            )}

            {mode === 'forgot' && !!code.trim() && (
              <View style={s.fieldGroup}>
                <Text style={s.label}>New password</Text>
                <TextInput
                  value={newPassword}
                  onChangeText={setNewPassword}
                  style={s.input}
                  placeholder="Enter new password"
                  placeholderTextColor={COLOR.accent}
                  secureTextEntry
                />
              </View>
            )}

            {!!infoText && <Text style={s.infoText}>{infoText}</Text>}

            {!!errorText && <Text style={s.errorText}>{errorText}</Text>}

            <TouchableOpacity
              style={[s.primaryBtn, (!canSubmit || isLoading) && s.primaryBtnDisabled]}
              onPress={submit}
              activeOpacity={0.85}
              disabled={!canSubmit || isLoading}
            >
              {isLoading ? (
                <ActivityIndicator color={COLOR.surface} />
              ) : (
                <Text style={s.primaryBtnText}>
                  {mode === 'login' && 'Sign In'}
                  {mode === 'register' && 'Create Account'}
                  {mode === 'verify' && 'Verify and Continue'}
                  {mode === 'forgot' && (!code.trim() ? 'Send Reset OTP' : 'Reset Password')}
                </Text>
              )}
            </TouchableOpacity>

            {mode === 'login' && (
              <TouchableOpacity
                style={s.switchBtn}
                onPress={() => {
                  setMode('forgot');
                  setErrorText('');
                  setInfoText('');
                  setCode('');
                  setNewPassword('');
                }}
                activeOpacity={0.8}
              >
                <Text style={s.switchText}>Forgot password?</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={s.switchBtn}
              onPress={() => {
                setMode((current) => {
                  if (current === 'login') return 'register';
                  if (current === 'register') return 'login';
                  return 'login';
                });
                setErrorText('');
                setInfoText('');
                setCode('');
                setNewPassword('');
              }}
              activeOpacity={0.8}
            >
              <Text style={s.switchText}>
                {mode === 'login' && 'No account? Register as patient'}
                {mode === 'register' && 'Already have an account? Sign in'}
                {mode === 'verify' && 'Back to sign in'}
                {mode === 'forgot' && 'Back to sign in'}
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
  safeArea: {
    flex: 1,
    backgroundColor: COLOR.background,
  },
  keyboardWrap: {
    flex: 1,
  },
  container: {
    flex: 1,
    paddingHorizontal: SPACING.l,
    paddingVertical: SPACING.xl,
    justifyContent: 'center',
  },
  headerBlock: {
    marginBottom: SPACING.l,
  },
  brand: {
    fontFamily: FONT.medium,
    color: COLOR.primary,
    marginBottom: SPACING.s,
    fontSize: 15,
  },
  heading: {
    fontFamily: FONT.bold,
    color: COLOR.text,
    fontSize: 30,
    marginBottom: SPACING.s,
  },
  subheading: {
    fontFamily: FONT.regular,
    color: COLOR.primary,
    fontSize: 15,
    lineHeight: 22,
  },
  card: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.l,
    ...SHADOW.card,
  },
  fieldGroup: {
    marginBottom: SPACING.m,
  },
  label: {
    fontFamily: FONT.medium,
    color: COLOR.text,
    marginBottom: SPACING.s,
    fontSize: 14,
  },
  input: {
    borderWidth: 1,
    borderColor: COLOR.accent,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.m,
    paddingVertical: 14,
    fontFamily: FONT.regular,
    color: COLOR.text,
    backgroundColor: COLOR.background,
    fontSize: 15,
  },
  errorText: {
    fontFamily: FONT.regular,
    color: COLOR.text,
    marginBottom: SPACING.s,
    fontSize: 14,
  },
  infoText: {
    fontFamily: FONT.regular,
    color: COLOR.primary,
    marginBottom: SPACING.s,
    fontSize: 14,
  },
  primaryBtn: {
    backgroundColor: COLOR.primary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.m,
    alignItems: 'center',
    marginTop: SPACING.s,
  },
  primaryBtnDisabled: {
    opacity: 0.55,
  },
  primaryBtnText: {
    color: COLOR.surface,
    fontFamily: FONT.bold,
    fontSize: 16,
    letterSpacing: 0.2,
  },
  switchBtn: {
    marginTop: SPACING.l,
    alignItems: 'center',
  },
  switchText: {
    color: COLOR.primary,
    fontFamily: FONT.medium,
    fontSize: 14,
  },
});
