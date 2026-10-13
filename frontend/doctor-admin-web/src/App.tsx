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
            <Navigate
              to={session.user.role === 'admin' ? '/admin' : session.user.role === 'doctor' ? '/doctor' : '/login'}
              replace
            />
          ) : (
            <div className="authShell">
              <div className="authLayout">
                <section className="authHero">
                  <span className="clinicBadge">Hepziba Chest Clinic</span>
                  <h1>Clinic Command Center</h1>
                  <p className="lead">
                    Secure access for doctors and administrators to manage appointments, review
                    patient updates, and keep the clinic running on time.
                  </p>
                  <div className="heroGrid">
                    <div className="heroCard">
                      <h3>Doctor Desk</h3>
                      <p>Track today&apos;s schedule, update visit status, and add prescriptions in one place.</p>
                    </div>
                    <div className="heroCard">
                      <h3>Admin Control</h3>
                      <p>Oversee staff accounts, inventory levels, and patient flow with live summaries.</p>
                    </div>
                  </div>
                  <div className="heroFooter">
                    <div>
                      <p className="statValue">15 min</p>
                      <p className="statLabel">Average check-in window</p>
                    </div>
                    <div>
                      <p className="statValue">96%</p>
                      <p className="statLabel">Same-day appointment closure</p>
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
