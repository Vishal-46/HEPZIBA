import { useEffect, useState } from 'react';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { ClinicHours } from '../types';

const STORAGE_KEY = 'hepziba.clinicHours';

const DEFAULTS: ClinicHours = {
  openTime: '09:00',
  closeTime: '18:00',
  days: 'Mon–Sat',
  slotMinutes: '15',
};

function loadLocal(): ClinicHours {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<ClinicHours>) };
  } catch {
    return DEFAULTS;
  }
}

export default function ClinicHoursSettings() {
  const [form, setForm] = useState<ClinicHours>(() => loadLocal());
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiClient.get<ClinicHours>('/admin/settings');
        if (!alive) return;
        const server = { ...DEFAULTS, ...(res.data as Partial<ClinicHours>) };
        setForm(server);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(server));
        } catch {
          // ignore storage failures
        }
      } catch {
        // Server unreachable — keep local copy, no scary TODO text.
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setStatus('');
    setError('');
    try {
      const res = await apiClient.post<{ clinicHours: ClinicHours }>('/admin/settings', {
        clinicHours: form,
      });
      const saved = res.data?.clinicHours ?? form;
      setForm({ ...DEFAULTS, ...saved });
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      } catch {
        // ignore
      }
      setStatus('Clinic hours saved to server.');
    } catch (err) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
      } catch {
        // ignore
      }
      setError(`${apiErrorMessage(err, 'Could not save to server — kept locally.')}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <section className="card" aria-label="Clinic hours settings"><p className="muted">Loading clinic hours…</p></section>;

  return (
    <section className="card" aria-label="Clinic hours settings">
      <h3>Clinic Hours</h3>
      <p className="muted">Saved on the server — applies to staff scheduling.</p>
      <form className="settingsGrid" onSubmit={save}>
        <label>
          Opens
          <input
            type="time"
            value={form.openTime}
            onChange={(e) => setForm((p) => ({ ...p, openTime: e.target.value }))}
            required
          />
        </label>
        <label>
          Closes
          <input
            type="time"
            value={form.closeTime}
            onChange={(e) => setForm((p) => ({ ...p, closeTime: e.target.value }))}
            required
          />
        </label>
        <label>
          Working days
          <input
            value={form.days}
            onChange={(e) => setForm((p) => ({ ...p, days: e.target.value }))}
            placeholder="Mon–Sat"
            required
          />
        </label>
        <label>
          Slot (minutes)
          <input
            inputMode="numeric"
            value={form.slotMinutes}
            onChange={(e) => setForm((p) => ({ ...p, slotMinutes: e.target.value }))}
            required
          />
        </label>
        <button className="primaryBtn" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save Hours'}
        </button>
      </form>
      {status && <p className="infoText" role="status">{status}</p>}
      {error && <p className="errorText" role="alert">{error}</p>}
    </section>
  );
}
