import { useMemo, useState } from 'react';
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

  if (!session) {
    return (
      <div className="shell">
        <AuthCard
          onSuccess={(nextSession) => {
            setSession(nextSession);
            setErrorText('');
          }}
          onError={setErrorText}
        />
        {!!errorText && <p className="errorText">{errorText}</p>}
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

function AuthCard({ onSuccess, onError }: { onSuccess: (session: Session) => void; onError: (msg: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    onError('');
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      const payload = await safeJson(response);
      if (!response.ok) throw new Error(payload?.error || 'Login failed');
      onSuccess(payload);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="card authCard" onSubmit={submit}>
      <h2>Doctor/Admin Login</h2>
      <p>Sign in with your verified hospital account.</p>
      <label>
        Email
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
      </label>
      <label>
        Password
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
      </label>
      <button className="primaryBtn" type="submit" disabled={loading}>{loading ? 'Signing in...' : 'Sign in'}</button>
    </form>
  );
}

function DoctorPanel({ token }: { token: string }) {
  const [appointments, setAppointments] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [status, setStatus] = useState('confirmed');
  const [notes, setNotes] = useState('');

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

  return (
    <div className="grid2">
      <section className="card">
        <div className="sectionTop">
          <h2>My Appointments</h2>
          <button className="primaryBtn" onClick={load}>Refresh</button>
        </div>
        {!!error && <p className="errorText">{error}</p>}
        {appointments.map((a) => (
          <button
            key={a.id}
            className={`rowBtn ${selectedId === a.id ? 'active' : ''}`}
            onClick={() => setSelectedId(a.id)}
          >
            <strong>{a.patient_name || 'Patient'}</strong>
            <span>{new Date(a.scheduled_at).toLocaleString()} | {a.status}</span>
          </button>
        ))}
      </section>

      <section className="card">
        <h2>Appointment Actions</h2>
        {selected ? (
          <>
            <p>Appointment #{selected.id}</p>
            <label>
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="pending">pending</option>
                <option value="confirmed">confirmed</option>
                <option value="done">done</option>
                <option value="cancelled">cancelled</option>
              </select>
            </label>
            <label>
              Notes
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
            </label>
            <div className="inlineBtns">
              <button className="primaryBtn" onClick={updateAppointment}>Update</button>
              <button className="ghostBtn" onClick={createPrescription}>Add Prescription</button>
            </div>
          </>
        ) : (
          <p>Select an appointment to proceed.</p>
        )}
      </section>
    </div>
  );
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
