import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Session } from '../types';

export function RequireAuth({
  session,
  restored,
  children,
}: {
  session: Session | null;
  restored: boolean;
  children: ReactNode;
}) {
  const location = useLocation();
  if (!restored) return <p className="muted shell">Restoring session…</p>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function RequireRole({
  session,
  restored,
  role,
  children,
}: {
  session: Session | null;
  restored: boolean;
  role: 'doctor' | 'admin';
  children: ReactNode;
}) {
  const location = useLocation();
  if (!restored) return <p className="muted shell">Restoring session…</p>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (session.user.role !== role) {
    return (
      <div className="shell">
        <p className="errorText" role="alert">
          This area requires a {role} account. Signed in as {session.user.role}.
        </p>
        <Navigate to={session.user.role === 'admin' ? '/admin' : '/doctor'} replace />
      </div>
    );
  }
  void location;
  return <>{children}</>;
}
