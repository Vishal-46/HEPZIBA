import { useEffect, useMemo, useState } from 'react';
import './App.css';

type Role = 'doctor' | 'admin';

type AuthUser = {
  id: number;
  name: string;
  email: string;
  role: 'patient' | 'doctor' | 'admin';
};

type Session = {
  token: string;
  user: AuthUser;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [errorText, setErrorText] = useState('');
  const [infoText, setInfoText] = useState('');

  if (!session) {
    return (
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
              setSession(nextSession);
              setErrorText('');
              setInfoText('');
            }}
            onError={setErrorText}
            onInfo={setInfoText}
          />
        </div>
        <div className="authMessages">
          {!!errorText && <p className="errorText">{errorText}</p>}
          {!!infoText && <p className="infoText">{infoText}</p>}
        </div>
      </div>
    );
  }

  const role = session.user.role as Role;
  if (role !== 'doctor' && role !== 'admin') {
    return (
      <div className="shell">
        <p className="errorText">Only doctor/admin accounts can use this panel.</p>
        <button className="primaryBtn" onClick={() => setSession(null)}>Back to Login</button>
      </div>
    );
  }

  return (
    <div className="shell appShell">
      <header className="topBar">
        <div>
          <h1>Hepziba Clinic Control Panel</h1>
        <p>{session.user.name} ({session.user.role})</p>
      </div>
      <button className="ghostBtn" onClick={() => setSession(null)}>Log out</button>
    </header>

      {role === 'doctor' ? (
        <DoctorPanel token={session.token} />
      ) : (
        <AdminPanel token={session.token} />
      )}
    </div>
  );
}

function AuthPanel({
  onSuccess,
  onError,
  onInfo,
}: {
  onSuccess: (session: Session) => void;
  onError: (msg: string) => void;
  onInfo: (msg: string) => void;
}) {
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
        const response = await fetch(`${API_BASE_URL}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
        });
        const payload = await safeJson(response);
        if (!response.ok) throw new Error(payload?.error || 'Login failed');
        onSuccess(payload);
      } else {
        const endpoint = role === 'admin' ? '/auth/register/admin' : '/auth/register/doctor';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (adminToken.trim()) headers.Authorization = `Bearer ${adminToken.trim()}`;
        const response = await fetch(`${API_BASE_URL}${endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: name.trim(), email: email.trim().toLowerCase(), password }),
        });
        const payload = await safeJson(response);
        if (!response.ok) throw new Error(payload?.error || 'Account creation failed');
        if (payload?.token && payload?.user) {
          onSuccess(payload);
          return;
        }
        setPassword('');
        onInfo(payload?.message || 'Account created. Verify your email, then sign in.');
        setMode('signin');
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="card authPanel" onSubmit={submit}>
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
        <div className="tabRow">
          <button
            type="button"
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
            <input value={name} onChange={(e) => setName(e.target.value)} type="text" required={mode === 'signup'} />
          </label>
        )}
        <label>
          Work email
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        </label>
        <label>
          Password
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
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
      <button className="primaryBtn" type="submit" disabled={loading}>
        {loading ? 'Processing...' : mode === 'signin' ? 'Sign in' : 'Create account'}
      </button>
    </form>
  );
}

function DoctorPanel({ token }: { token: string }) {
  const [appointments, setAppointments] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [status, setStatus] = useState('confirmed');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    load();
  }, []);

  const selected = useMemo(() => appointments.find((a) => a.id === selectedId) || null, [appointments, selectedId]);

  const load = async () => {
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/appointments/for-me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || 'Failed to load appointments');
      setAppointments(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load appointments');
    }
  };

  const updateAppointment = async () => {
    if (!selectedId) return;
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/doctors/appointments/${selectedId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status, notes }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || 'Failed to update appointment');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update appointment');
    }
  };

  const createPrescription = async () => {
    if (!selectedId) return;
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/prescriptions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          appointment_id: selectedId,
          notes: notes || undefined,
          items: [
            {
              medicine_name: 'Sample Medicine',
              dosage_morning: true,
              after_food: true,
            },
          ],
        }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data?.error || 'Failed to create prescription');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create prescription');
    }
  };

  const stats = useMemo(() => {
    const tally = { total: appointments.length, pending: 0, confirmed: 0, done: 0, cancelled: 0 };
    appointments.forEach((a) => {
      if (a.status && tally[a.status as keyof typeof tally] !== undefined) {
        tally[a.status as keyof typeof tally] += 1;
      }
    });
    return tally;
  }, [appointments]);

  const todayList = useMemo(() => {
    const today = new Date().toDateString();
    return appointments.filter((a) => new Date(a.scheduled_at).toDateString() === today);
  }, [appointments]);

  return (
    <div className="doctorLayout">
      <aside className="card doctorSidebar">
        <p className="clinicTag">Hepziba Chest Clinic</p>
        <h2>Doctor Desk</h2>
        <p className="muted">Manage your schedule, update visit status, and add prescriptions.</p>
        <div className="statGrid">
          <div className="statCard">
            <span>Total</span>
            <strong>{stats.total}</strong>
          </div>
          <div className="statCard">
            <span>Confirmed</span>
            <strong>{stats.confirmed}</strong>
          </div>
          <div className="statCard">
            <span>Pending</span>
            <strong>{stats.pending}</strong>
          </div>
          <div className="statCard">
            <span>Done</span>
            <strong>{stats.done}</strong>
          </div>
        </div>
        <button className="primaryBtn" onClick={load}>Refresh Schedule</button>
        {!!error && <p className="errorText">{error}</p>}
      </aside>

      <div className="doctorContent">
        <section className="card">
          <div className="sectionTop">
            <div>
              <h2>Today&apos;s Schedule</h2>
              <p className="muted">{new Date().toDateString()}</p>
            </div>
            <span className="pill">{todayList.length} visits</span>
          </div>
          <div className="appointmentList">
            {(todayList.length ? todayList : appointments).map((a) => (
              <button
                key={a.id}
                className={`appointmentRow ${selectedId === a.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedId(a.id);
                  setStatus(a.status || 'confirmed');
                  setNotes(a.notes || '');
                }}
              >
                <div>
                  <strong>{a.patient_name || 'Patient'}</strong>
                  <span className="appointmentMeta">{formatDate(a.scheduled_at)}</span>
                </div>
                <span className={`pill status ${a.status || 'pending'}`}>{a.status || 'pending'}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="card detailCard">
          <h2>Appointment Details</h2>
          {selected ? (
            <>
              <div className="detailGrid">
                <div>
                  <p className="label">Patient</p>
                  <p>{selected.patient_name || 'Patient'}</p>
                </div>
                <div>
                  <p className="label">Schedule</p>
                  <p>{formatDate(selected.scheduled_at)}</p>
                </div>
                <div>
                  <p className="label">Reason</p>
                  <p>{selected.reason || 'Respiratory consultation'}</p>
                </div>
                <div>
                  <p className="label">Status</p>
                  <select value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="pending">pending</option>
                    <option value="confirmed">confirmed</option>
                    <option value="done">done</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </div>
              </div>
              <label>
                Notes
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
              </label>
              <div className="inlineBtns">
                <button className="primaryBtn" onClick={updateAppointment}>Update Status</button>
                <button className="ghostBtn" onClick={createPrescription}>Add Prescription</button>
              </div>
            </>
          ) : (
            <p className="muted">Select an appointment to view details and add notes.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function formatDate(value?: string) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleString();
}

function AdminPanel({ token }: { token: string }) {
  const [users, setUsers] = useState<any[]>([]);
  const [appointments, setAppointments] = useState<any[]>([]);
  const [inventory, setInventory] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [newItem, setNewItem] = useState({ name: '', stock: '0', reorder_level: '0', unit: 'pcs' });

  const load = async () => {
    setError('');
    try {
      const [u, a, i] = await Promise.all([
        fetch(`${API_BASE_URL}/admin/users`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_BASE_URL}/admin/appointments`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_BASE_URL}/inventory`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      const usersPayload = await safeJson(u);
      const appPayload = await safeJson(a);
      const invPayload = await safeJson(i);
      if (!u.ok) throw new Error(usersPayload?.error || 'Failed users load');
      if (!a.ok) throw new Error(appPayload?.error || 'Failed appointments load');
      if (!i.ok) throw new Error(invPayload?.error || 'Failed inventory load');

      setUsers(usersPayload || []);
      setAppointments(appPayload || []);
      setInventory(invPayload || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin data');
    }
  };

  const createInventoryItem = async () => {
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/inventory`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: newItem.name,
          stock: Number(newItem.stock),
          reorder_level: Number(newItem.reorder_level),
          unit: newItem.unit,
        }),
      });

      const payload = await safeJson(res);
      if (!res.ok) throw new Error(payload?.error || 'Failed to create inventory item');
      setNewItem({ name: '', stock: '0', reorder_level: '0', unit: 'pcs' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create inventory item');
    }
  };

  return (
    <div className="stack">
      <div className="sectionTop">
        <h2>Admin Overview</h2>
        <button className="primaryBtn" onClick={load}>Refresh</button>
      </div>
      {!!error && <p className="errorText">{error}</p>}

      <div className="grid3">
        <section className="card">
          <h3>Users</h3>
          <p>Total: {users.length}</p>
          {users.slice(0, 6).map((u) => (
            <div key={u.id} className="miniRow">{u.name} - {u.role}</div>
          ))}
        </section>

        <section className="card">
          <h3>Appointments</h3>
          <p>Total: {appointments.length}</p>
          {appointments.slice(0, 6).map((a) => (
            <div key={a.id} className="miniRow">#{a.id} {a.patient_name || ''} - {a.status}</div>
          ))}
        </section>

        <section className="card">
          <h3>Inventory</h3>
          {inventory.slice(0, 6).map((i) => (
            <div key={i.id} className="miniRow">{i.name} ({i.stock})</div>
          ))}
        </section>
      </div>

      <section className="card">
        <h3>Add Inventory Item</h3>
        <div className="formRow">
          <input placeholder="Name" value={newItem.name} onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))} />
          <input placeholder="Stock" value={newItem.stock} onChange={(e) => setNewItem((p) => ({ ...p, stock: e.target.value }))} />
          <input placeholder="Reorder level" value={newItem.reorder_level} onChange={(e) => setNewItem((p) => ({ ...p, reorder_level: e.target.value }))} />
          <input placeholder="Unit" value={newItem.unit} onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))} />
          <button className="primaryBtn" onClick={createInventoryItem}>Add</button>
        </div>
      </section>
    </div>
  );
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
