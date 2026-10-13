import { useState } from 'react';
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

/**
 * Clinic-hours settings.
 * Persists to localStorage immediately (works offline) and attempts a
 * backend sync via POST /admin/settings when the endpoint exists.
 * TODO(backend): implement `POST /admin/settings` to persist clinic hours
 * server-side; until then the UI is backend-ready and degrades gracefully.
 */
export default function ClinicHoursSettings() {
  const [form, setForm] = useState<ClinicHours>(() => loadLocal());
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setStatus('');
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
      try {
        await apiClient.post('/admin/settings', { clinicHours: form });
        setStatus('Saved locally and synced to server.');
      } catch (err) {
        // Backend endpoint may not exist yet — local save still stands.
        const msg = apiErrorMessage(err, '');
        setStatus(
          `Saved locally. Server sync pending (TODO: POST /admin/settings)${msg ? ` — ${msg}` : ''}`,
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card" aria-label="Clinic hours settings">
      <h3>Clinic Hours</h3>
      <p className="muted">Stored locally; syncs to POST /admin/settings when available.</p>
      <form className="settingsGrid" onSubmit={save}>
        <label>
          Opens
          <input
            type="time"
            value={form.openTime}
            onChange={(e) => setForm((p) => ({ ...p, openTime: e.target.value }))}
          />
        </label>
        <label>
          Closes
          <input
            type="time"
            value={form.closeTime}
            onChange={(e) => setForm((p) => ({ ...p, closeTime: e.target.value }))}
          />
        </label>
        <label>
          Working days
          <input
            value={form.days}
            onChange={(e) => setForm((p) => ({ ...p, days: e.target.value }))}
            placeholder="Mon–Sat"
          />
        </label>
        <label>
          Slot (minutes)
          <input
            inputMode="numeric"
            value={form.slotMinutes}
            onChange={(e) => setForm((p) => ({ ...p, slotMinutes: e.target.value }))}
          />
        </label>
        <button className="primaryBtn" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save Hours'}
        </button>
      </form>
      {status && (
        <p className="infoText" role="status">
          {status}
        </p>
      )}
    </section>
  );
}
