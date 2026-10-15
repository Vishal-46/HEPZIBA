import { useEffect, useMemo, useState } from 'react';
import { useDoctorAppointments } from '../hooks/useDoctorData';
import { usePaginatedSearch } from '../hooks/usePaginatedSearch';
import type { MedicineRow, Patient } from '../types';
import { formatDate } from '../utils/format';
import { printPrescription } from '../utils/prescriptionPrint';
import EHRModal from './EHRModal';
import { EmptyState, LoadingState, Pager, SearchInput } from './ListControls';

const PAGE_SIZE = 8;

const blankMedicine = (): MedicineRow => ({
  name: '',
  m: false,
  a: false,
  e: false,
  n: false,
  bf: false,
  af: true,
});

type History = {
  id: number;
  notes?: string;
  items: Array<{
    medicine_name: string;
    dosage_morning?: boolean;
    dosage_afternoon?: boolean;
    dosage_evening?: boolean;
    dosage_night?: boolean;
    before_food?: boolean;
    after_food?: boolean;
  }>;
} | null;

export default function DoctorPanel() {
  const { appointments, loading, error, setError, load, updateStatus, createPrescription, getPrescription } =
    useDoctorAppointments();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [status, setStatus] = useState('confirmed');
  const [notes, setNotes] = useState('');
  const [medicines, setMedicines] = useState<MedicineRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [showTodayOnly, setShowTodayOnly] = useState(false);
  const [history, setHistory] = useState<History>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [ehrPatient, setEhrPatient] = useState<Patient | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  const selected = useMemo(
    () => appointments.find((a) => a.id === selectedId) ?? null,
    [appointments, selectedId],
  );

  const stats = useMemo(() => {
    const tally = { total: appointments.length, pending: 0, confirmed: 0, done: 0, cancelled: 0 };
    appointments.forEach((a) => {
      const s = a.status === 'completed' ? 'done' : a.status;
      const key = s as keyof typeof tally;
      if (typeof s === 'string' && tally[key] !== undefined) tally[key] += 1;
    });
    return tally;
  }, [appointments]);

  const todayList = useMemo(() => {
    const today = new Date().toDateString();
    return appointments.filter((a) => {
      const s = String(a.scheduled_at_effective ?? a.scheduled_at ?? '');
      if (!s) return false;
      return new Date(s).toDateString() === today;
    });
  }, [appointments]);

  const sourceList = showTodayOnly ? todayList : appointments;

  const search = usePaginatedSearch(
    sourceList,
    (a) => [a.patient_name, a.reason, a.status, String(a.id), String(a.patient_code ?? ''), String(a.mobile ?? '')],
    PAGE_SIZE,
  );

  useEffect(() => {
    if (!selectedId) {
      setHistory(null);
      return;
    }
    let alive = true;
    setHistoryLoading(true);
    getPrescription(selectedId)
      .then((h) => {
        if (alive) setHistory(h);
      })
      .catch(() => {
        if (alive) setHistory(null);
      })
      .finally(() => {
        if (alive) setHistoryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedId, getPrescription, appointments.length]);

  const addMedicineRow = () => setMedicines((prev) => [...prev, blankMedicine()]);

  const updateMedicine = (index: number, field: keyof MedicineRow, value: string | boolean) => {
    setMedicines((prev) => prev.map((m, i) => (i === index ? { ...m, [field]: value } : m)));
  };

  const removeMedicine = (index: number) => {
    setMedicines((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdate = async () => {
    if (!selectedId) return;
    setSaving(true);
    setError('');
    try {
      await updateStatus(selectedId, status, notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update appointment');
    } finally {
      setSaving(false);
    }
  };

  const handlePrescription = async () => {
    if (!selectedId || medicines.length === 0) return;
    if (medicines.some((m) => !m.name.trim())) {
      setError('Give every medicine a name before saving.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await createPrescription(selectedId, notes, medicines);
      setMedicines([]);
      const h = await getPrescription(selectedId).catch(() => null);
      setHistory(h);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create prescription');
    } finally {
      setSaving(false);
    }
  };

  const schedOf = (a: typeof selected) =>
    String(a?.scheduled_at_effective ?? a?.scheduled_at ?? '');

  return (
    <div className="doctorLayout">
      <aside className="card doctorSidebar" aria-label="Doctor summary">
        <p className="clinicTag">Hepziba Chest Clinic</p>
        <h2>Doctor Desk</h2>
        <p className="muted">Today&apos;s patient bookings, visit status, and prescriptions.</p>
        <div className="statGrid" role="list">
          <div className="statCard" role="listitem"><span>Total</span><strong>{stats.total}</strong></div>
          <div className="statCard" role="listitem"><span>Today</span><strong>{todayList.length}</strong></div>
          <div className="statCard" role="listitem"><span>Pending</span><strong>{stats.pending}</strong></div>
          <div className="statCard" role="listitem"><span>Done</span><strong>{stats.done}</strong></div>
        </div>
        <button className="primaryBtn" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh Schedule'}
        </button>
        {error && (
          <p className="errorText" role="alert">
            {error}
          </p>
        )}
      </aside>

      <div className="doctorContent">
        <section className="card" aria-label="Schedule">
          <div className="sectionTop">
            <div>
              <h2>Schedule</h2>
              <p className="muted">{new Date().toDateString()} · {todayList.length} today · {appointments.length} total</p>
            </div>
          </div>

          <div className="listToolbar">
            <SearchInput query={search.query} onQuery={search.setQuery} label="Search name, code, mobile, id…" />
            <label className="checkRow">
              <input
                type="checkbox"
                checked={showTodayOnly}
                onChange={(e) => setShowTodayOnly(e.target.checked)}
              />
              Today only
            </label>
          </div>

          {loading ? (
            <LoadingState message="Loading schedule…" />
          ) : search.total === 0 ? (
            <EmptyState
              message={
                appointments.length === 0
                  ? 'No appointments assigned yet — patient bookings from the mobile app will appear here.'
                  : 'No appointments match your search.'
              }
            />
          ) : (
            <>
              <div className="appointmentList">
                {search.pageRows.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`appointmentRow ${selectedId === a.id ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedId(a.id);
                      setStatus(['confirmed', 'done', 'cancelled'].includes(String(a.status)) ? String(a.status) : 'confirmed');
                      setNotes(typeof a.notes === 'string' ? a.notes : '');
                      setMedicines([]);
                    }}
                    aria-pressed={selectedId === a.id}
                  >
                    <div>
                      <strong>{String(a.patient_name || 'Patient')}</strong>
                      {a.patient_code ? <span className="appointmentMeta">Code: {String(a.patient_code)}</span> : null}
                      <span className="appointmentMeta">
                        {formatDate(String(a.scheduled_at_effective ?? a.scheduled_at ?? ''))}
                        {a.token_number ? ` · Token ${String(a.token_number)}` : ''}
                      </span>
                      <span className="appointmentMeta">
                        {a.age ? `${String(a.age)}y` : ''}{a.sex ? ` · ${String(a.sex)}` : ''}{a.mobile ? ` · ${String(a.mobile)}` : ''}
                      </span>
                    </div>
                    <span className={`pill status ${a.status || 'pending'}`}>{String(a.status || 'pending')}</span>
                  </button>
                ))}
              </div>
              <Pager
                page={search.page}
                totalPages={search.totalPages}
                onPage={search.setPage}
                total={search.total}
                label="Appointments"
              />
            </>
          )}
        </section>

        <section className="card detailCard" aria-label="Appointment details" aria-live="polite">
          <h2>Appointment Details</h2>
          {selected ? (
            <>
              <div className="detailGrid">
                <div>
                  <p className="label">Patient</p>
                  <p>{String(selected.patient_name || 'Patient')}</p>
                  <p className="muted">
                    {selected.patient_code ? `Code ${String(selected.patient_code)} · ` : ''}
                    {selected.age ? `${String(selected.age)}y · ` : ''}
                    {selected.sex ? `${String(selected.sex)} · ` : ''}
                    {selected.mobile ? String(selected.mobile) : 'No mobile'}
                  </p>
                  {(selected.bp || selected.spo2) ? (
                    <p className="muted">BP {String(selected.bp ?? '—')} · SpO2 {String(selected.spo2 ?? '—')}</p>
                  ) : null}
                  <button
                    type="button"
                    className="ghostBtn"
                    style={{ marginTop: 8 }}
                    onClick={() =>
                      setEhrPatient({
                        id: Number(selected.patient_id) || selected.id,
                        name: String(selected.patient_name || 'Patient'),
                        patient_code: typeof selected.patient_code === 'string' ? selected.patient_code : undefined,
                        mobile: typeof selected.mobile === 'string' ? selected.mobile : undefined,
                        bp: typeof selected.bp === 'string' ? selected.bp : undefined,
                        spo2: typeof selected.spo2 === 'number' || typeof selected.spo2 === 'string' ? selected.spo2 : undefined,
                        age: typeof selected.age === 'number' ? selected.age : undefined,
                        sex: typeof selected.sex === 'string' ? selected.sex : undefined,
                      })
                    }
                  >
                    View full EHR
                  </button>
                </div>
                <div>
                  <p className="label">Schedule</p>
                  <p>{formatDate(schedOf(selected))}</p>
                  {selected.token_number ? <p className="muted">Token {String(selected.token_number)}</p> : null}
                </div>
                <div>
                  <p className="label">Reason</p>
                  <p>{String(selected.reason || 'Respiratory consultation')}</p>
                </div>
                <div>
                  <p className="label">Status</p>
                  <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Visit status">
                    <option value="confirmed">confirmed</option>
                    <option value="done">done</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                  <p className="muted" style={{ marginTop: 4 }}>Current: {String(selected.status || 'pending')}</p>
                </div>
              </div>
              <label>
                Notes
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </label>

              <div className="sectionTop" style={{ marginTop: '15px' }}>
                <h4>Existing prescription</h4>
              </div>
              {historyLoading ? (
                <p className="muted">Loading prescription…</p>
              ) : history ? (
                <div className="miniRow" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <span>Prescription #{history.id}{history.notes ? ` — ${history.notes}` : ''}</span>
                  {history.items.map((it, idx) => (
                    <span key={idx} className="muted">· {it.medicine_name}</span>
                  ))}
                </div>
              ) : (
                <p className="muted">No prescription saved for this visit yet.</p>
              )}

              <div className="sectionTop" style={{ marginTop: '15px' }}>
                <h4>New prescription</h4>
                <button type="button" className="ghostBtn" onClick={addMedicineRow}>
                  + Add Medicine
                </button>
              </div>

              {medicines.length === 0 ? (
                <p className="muted">No medicines added yet.</p>
              ) : (
                medicines.map((m, i) => (
                  <div key={i} className="formRow medRow">
                    <input
                      className="medName"
                      placeholder="Medicine name"
                      value={m.name}
                      onChange={(e) => updateMedicine(i, 'name', e.target.value)}
                      aria-label={`Medicine ${i + 1} name`}
                    />
                    {(
                      [
                        ['m', 'M'],
                        ['a', 'A'],
                        ['e', 'E'],
                        ['n', 'N'],
                        ['bf', 'BF'],
                        ['af', 'AF'],
                      ] as Array<[keyof MedicineRow, string]>
                    ).map(([field, short]) => (
                      <label key={field} className="doseCheck">
                        <input
                          type="checkbox"
                          checked={Boolean(m[field])}
                          onChange={(e) => updateMedicine(i, field, e.target.checked)}
                        />
                        {short}
                      </label>
                    ))}
                    <button type="button" className="linkBtn" onClick={() => removeMedicine(i)}>
                      Remove
                    </button>
                  </div>
                ))
              )}

              <div className="inlineBtns" style={{ marginTop: '20px' }}>
                <button className="primaryBtn" onClick={handleUpdate} disabled={saving}>
                  {saving ? 'Saving…' : 'Update Status'}
                </button>
                <button
                  className="ghostBtn"
                  onClick={handlePrescription}
                  disabled={medicines.length === 0 || saving}
                >
                  Save Prescription
                </button>
                <button
                  className="ghostBtn"
                  onClick={() => selected && printPrescription(selected, medicines, notes)}
                  disabled={medicines.length === 0}
                >
                  Print / PDF
                </button>
              </div>
            </>
          ) : (
            <EmptyState message="Select an appointment to view details and add notes." />
          )}
        </section>
      </div>
      {ehrPatient && <EHRModal patient={ehrPatient} onClose={() => setEhrPatient(null)} />}
    </div>
  );
}
