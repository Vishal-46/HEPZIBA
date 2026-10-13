import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { Role, Session } from '../types';

type AuthPanelProps = {
  onSuccess: (session: Session) => void;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
};

/**
 * Staff sign-in / invite-only registration.
 * Migrated from raw fetch to the shared apiClient (token + 401 handling).
 */
export default function AuthPanel({ onSuccess, onError, onInfo }: AuthPanelProps) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [inviteMode, setInviteMode] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('doctor');
  const [adminToken, setAdminToken] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    onError('');
    onInfo('');
    setLoading(true);

    try {
      if (mode === 'signin') {
        const res = await apiClient.post<Session>('/auth/login', {
          email: email.trim().toLowerCase(),
          password,
        });
        onSuccess(res.data);
        const nextRole = res.data.user.role;
        navigate(nextRole === 'admin' ? '/admin' : nextRole === 'doctor' ? '/doctor' : '/', {
          replace: true,
        });
      } else {
        const endpoint = role === 'admin' ? '/auth/register/admin' : '/auth/register/doctor';
        const res = await apiClient.post(
          endpoint,
          { name: name.trim(), email: email.trim().toLowerCase(), password },
          adminToken.trim() ? { headers: { Authorization: `Bearer ${adminToken.trim()}` } } : undefined,
        );
        const payload = res.data as Session & { message?: string };
        if (payload?.token && payload?.user) {
          onSuccess(payload);
          const nextRole = payload.user.role;
          navigate(nextRole === 'admin' ? '/admin' : '/doctor', { replace: true });
          return;
        }
        setPassword('');
        onInfo(payload?.message || 'Account created. Verify your email, then sign in.');
        setMode('signin');
      }
    } catch (error) {
      onError(apiErrorMessage(error, mode === 'signin' ? 'Login failed' : 'Account creation failed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="card authPanel" onSubmit={submit} aria-label="Staff authentication">
      <div className="authHeader">
        <div>
          <p className="authOverline">Secure staff access</p>
          <h2>{mode === 'signin' ? 'Doctor/Admin Login' : 'Create Staff Account'}</h2>
          <p className="muted">
            {mode === 'signin'
              ? 'Sign in with your clinic account to reach the dashboard.'
              : 'Invite doctors or admins with verified clinic credentials.'}
          </p>
        </div>
        <div className="tabRow" role="tablist" aria-label="Auth mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'signin'}
            className={`tabBtn ${mode === 'signin' ? 'active' : ''}`}
            onClick={() => {
              setMode('signin');
              setInviteMode(false);
            }}
          >
            Sign in
          </button>
          {inviteMode && (
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'signup'}
              className={`tabBtn ${mode === 'signup' ? 'active' : ''}`}
              onClick={() => setMode('signup')}
            >
              Create
            </button>
          )}
        </div>
      </div>

      <div className="formStack">
        {mode === 'signup' && (
          <label>
            Full name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              type="text"
              required={mode === 'signup'}
              autoComplete="name"
            />
          </label>
        )}
        <label>
          Work email
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
            autoComplete="email"
          />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            required
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
          />
        </label>
        {mode === 'signup' && (
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="doctor">Doctor</option>
              <option value="admin">Admin</option>
            </select>
          </label>
        )}
        {mode === 'signup' && (
          <label>
            Admin invite token
            <input
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              type="password"
              placeholder="Provided by clinic admin"
              required={mode === 'signup'}
              autoComplete="off"
            />
          </label>
        )}
      </div>
      {mode === 'signin' ? (
        <div className="inviteRow">
          <p className="formHint">New staff accounts are invite-only.</p>
          <button
            type="button"
            className="linkBtn"
            onClick={() => {
              setInviteMode(true);
              setMode('signup');
            }}
          >
            Have an invite token?
          </button>
        </div>
      ) : (
        <p className="formHint">Doctor and admin accounts require clinic approval before use.</p>
      )}
      <button className="primaryBtn" type="submit" disabled={loading} aria-busy={loading}>
        {loading ? 'Processing…' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>
    </form>
  );
}
