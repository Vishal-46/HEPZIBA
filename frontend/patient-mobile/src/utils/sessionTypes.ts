/** Shared auth/session shapes — single source of truth for App + screens. */

export type UserRole = 'patient' | 'doctor' | 'admin';

export type User = {
  id: number;
  name: string;
  email: string;
  role: UserRole;
};

export type Session = {
  /** Short-lived access JWT (15m). Sent as `Authorization: Bearer`. */
  token: string;
  /** Long-lived opaque refresh token (30d, rotating). Never sent as Bearer. */
  refreshToken?: string;
  user: User;
};
