/** Shared auth/session shapes — single source of truth for App + screens. */

export type UserRole = 'patient' | 'doctor' | 'admin';

export type User = {
  id: number;
  name: string;
  email: string;
  role: UserRole;
};

export type Session = {
  token: string;
  user: User;
};
