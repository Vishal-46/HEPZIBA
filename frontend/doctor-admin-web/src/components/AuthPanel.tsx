import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { Session } from '../types';

type AuthPanelProps = {
  onSuccess: (session: Session) => void;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
};

/**
 * Staff sign-in only. Doctor/admin accounts are created by an existing
 * admin (Admin panel or POST /auth/register/doctor|admin) — no public signup.
 */
export default function AuthPanel({ onSuccess, onError, onInfo }: AuthPanelProps) {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    onError('');
    onInfo('');
    setLoading(true);

    try {
      const res = await apiClient.post<Session>('/auth/login', {
        email: email.trim().toLowerCase(),
        password,
      });
      onSuccess(res.data);
      const nextRole = res.data.user.role;
      navigate(nextRole === 'admin' ? '/admin' : nextRole === 'doctor' ? '/doctor' : '/', {
        replace: true,
      });
    } catch (error) {
      onError(apiErrorMessage(error, 'Login failed — check email and password.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="card authPanel" onSubmit={submit} aria-label="Staff sign in">
      <div className="authHeader">
        <div>
          <p className="authOverline">Secure staff access</p>
          <h2>Doctor / Admin Login</h2>
          <p className="muted">Sign in with your clinic account to reach the dashboard.</p>
        </div>
      </div>

      <div className="formStack">
        <label>
          Work email
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
            autoComplete="email"
            placeholder="doctor@hepziba.local"
          />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••"
          />
        </label>
      </div>
      <p className="formHint">
        Staff only. New doctor/admin accounts are created by an admin — there is no self-registration here.
        Patients: please use the mobile app.
      </p>
      <button className="primaryBtn" type="submit" disabled={loading} aria-busy={loading}>
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
