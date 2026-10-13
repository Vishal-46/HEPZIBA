import type { AuthUser, Session } from '../types';
import { TOKEN_KEY, USER_KEY } from './apiClient';

export function loadSession(): Session | null {
  try {
    const token =
      localStorage.getItem(TOKEN_KEY) ?? localStorage.getItem('token');
    const rawUser =
      localStorage.getItem(USER_KEY) ?? localStorage.getItem('user');
    if (!token || !rawUser) return null;
    const user = JSON.parse(rawUser) as AuthUser;
    if (!user || typeof user !== 'object' || !user.role) return null;
    return { token, user };
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(USER_KEY, JSON.stringify(session.user));
  // Keep legacy `token` key in sync for any older code paths.
  localStorage.setItem('token', session.token);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}
