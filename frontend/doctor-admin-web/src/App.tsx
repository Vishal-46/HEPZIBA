import { useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import AdminPanel from './components/AdminPanel';
import AuthPanel from './components/AuthPanel';
import DoctorPanel from './components/DoctorPanel';
import { RequireAuth, RequireRole } from './components/RequireAuth';
import { useSession } from './hooks/useSession';
import './App.css';

export default function App() {
  const { session, restored, login, logout } = useSession();
  const [errorText, setErrorText] = useState('');
  const [infoText, setInfoText] = useState('');
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    setErrorText('');
    setInfoText('');
    navigate('/login', { replace: true });
  };

  if (!restored) {
    return (
      <div className="shell">
        <p className="muted" role="status">
          Restoring session…
        </p>
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={
          session ? (
            session.user.role === 'patient' ? (
              <div className="authShell">
                <div className="shell">
                  <p className="errorText" role="alert">
                    Only doctor/admin accounts can use this portal. You are signed in as
                    patient — please use the mobile app.
                  </p>
                  <button className="primaryBtn" onClick={handleLogout}>
                    Back to Login
                  </button>
                </div>
              </div>
            ) : (
              <Navigate
                to={session.user.role === 'admin' ? '/admin' : '/doctor'}
                replace
              />
            )
          ) : (
            <div className="authShell">
              <div className="authLayout">
                <section className="authHero">
                  <span className="clinicBadge">Hepziba Chest Clinic • Nagercoil</span>
                  <h1>Staff Sign In</h1>
                  <p className="lead">
                    Pulmonology clinic of Dr. T. Joseph Pratheeban. This portal is for
                    doctors and administrators only — patients, please use the mobile app.
                  </p>
                  <div className="heroGrid">
                    <div className="heroCard">
                      <h3>Doctor</h3>
                      <p>Today&apos;s appointments, visit status, and prescriptions with print.</p>
                    </div>
                    <div className="heroCard">
                      <h3>Admin</h3>
                      <p>Users, all appointments, inventory stock, and clinic hours.</p>
                    </div>
                  </div>
                  <div className="heroFooter">
                    <div>
                      <p className="statValue">Pulmonology</p>
                      <p className="statLabel">Chest care • Nagercoil</p>
                    </div>
                    <div>
                      <p className="statValue">Staff only</p>
                      <p className="statLabel">Doctor / admin accounts</p>
                    </div>
                  </div>
                </section>

                <AuthPanel
                  onSuccess={(nextSession) => {
                    login(nextSession);
                    setErrorText('');
                    setInfoText('');
                  }}
                  onError={setErrorText}
                  onInfo={setInfoText}
                />
              </div>
              <div className="authMessages" aria-live="polite">
                {!!errorText && (
                  <p className="errorText" role="alert">
                    {errorText}
                  </p>
                )}
                {!!infoText && <p className="infoText">{infoText}</p>}
              </div>
            </div>
          )
        }
      />

      <Route
        path="/doctor"
        element={
          <RequireRole session={session} restored={restored} role="doctor">
            <AuthedShell
              name={session?.user.name ?? ''}
              role={session?.user.role ?? ''}
              onLogout={handleLogout}
            >
              <DoctorPanel />
            </AuthedShell>
          </RequireRole>
        }
      />

      <Route
        path="/admin"
        element={
          <RequireRole session={session} restored={restored} role="admin">
            <AuthedShell
              name={session?.user.name ?? ''}
              role={session?.user.role ?? ''}
              onLogout={handleLogout}
            >
              <AdminPanel />
            </AuthedShell>
          </RequireRole>
        }
      />

      {/* Backward compat: root + unknown paths resolve by session/role. */}
      <Route
        path="/"
        element={
          <RequireAuth session={session} restored={restored}>
            {session?.user.role === 'admin' ? (
              <Navigate to="/admin" replace />
            ) : session?.user.role === 'doctor' ? (
              <Navigate to="/doctor" replace />
            ) : (
              <div className="shell">
                <p className="errorText" role="alert">
                  Only doctor/admin accounts can use this panel.
                </p>
                <button className="primaryBtn" onClick={handleLogout}>
                  Back to Login
                </button>
              </div>
            )}
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function AuthedShell({
  name,
  role,
  onLogout,
  children,
}: {
  name: string;
  role: string;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="shell appShell">
      <header className="topBar">
        <div>
          <h1>Hepziba Clinic Control Panel</h1>
          <p>
            {name} ({role})
          </p>
        </div>
        <nav aria-label="Session">
          <button className="ghostBtn" onClick={onLogout}>
            Log out
          </button>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
