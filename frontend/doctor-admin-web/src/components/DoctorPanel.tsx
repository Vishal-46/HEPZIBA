import { useEffect, useMemo, useState } from 'react';
import { useDoctorAppointments } from '../hooks/useDoctorData';
import { usePaginatedSearch } from '../hooks/usePaginatedSearch';
import type { MedicineRow, Patient } from '../types';
import { formatDate, maskAadhaar } from '../utils/format';
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

export default function DoctorPanel() {
  const { appointments, loading, error, setError, load, updateStatus, createPrescription } =
    useDoctorAppointments();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [status, setStatus] = useState('confirmed');
  const [notes, setNotes] = useState('');
  const [medicines, setMedicines] = useState<MedicineRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [showTodayOnly, setShowTodayOnly] = useState(true);
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
      const key = a.status as keyof typeof tally;
      if (typeof a.status === 'string' && tally[key] !== undefined) tally[key] += 1;
    });
    return tally;
  }, [appointments]);

  const todayList = useMemo(() => {
    const today = new Date().toDateString();
    return appointments.filter((a) => {
      if (!a.scheduled_at) return false;
      return new Date(a.scheduled_at).toDateString() === today;
    });
  }, [appointments]);

  const sourceList = showTodayOnly && todayList.length > 0 ? todayList : appointments;

  const search = usePaginatedSearch(
    sourceList,
    (a) => [a.patient_name, a.reason, a.status, String(a.id)],
    PAGE_SIZE,
  );

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
      setNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create prescription');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="doctorLayout">
      <aside className="card doctorSidebar" aria-label="Doctor summary">
        <p className="clinicTag">Hepziba Chest Clinic</p>
        <h2>Doctor Desk</h2>
        <p className="muted">Manage your schedule, update visit status, and add prescriptions.</p>
        <div className="statGrid" role="list">
          <div className="statCard" role="listitem"><span>Total</span><strong>{stats.total}</strong></div>
          <div className="statCard" role="listitem"><span>Confirmed</span><strong>{stats.confirmed}</strong></div>
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
              <h2>Today&apos;s Schedule</h2>
              <p className="muted">{new Date().toDateString()}</p>
            </div>
            <span className="pill">{todayList.length} visits</span>
          </div>

          <div className="listToolbar">
            <SearchInput query={search.query} onQuery={search.setQuery} label="Search appointments…" />
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
                  ? 'No appointments assigned yet.'
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
                      setStatus(a.status || 'confirmed');
                      setNotes(typeof a.notes === 'string' ? a.notes : '');
                    }}
                    aria-pressed={selectedId === a.id}
                  >
                    <div>
                      <strong>{a.patient_name || 'Patient'}</strong>
                      <span className="appointmentMeta">{formatDate(a.scheduled_at)}</span>
                      <span className="appointmentMeta">
                        Aadhaar: {maskAadhaar(a.patient_aadhaar ?? a.aadhaar)}
                      </span>
                    </div>
                    <span className={`pill status ${a.status || 'pending'}`}>{a.status || 'pending'}</span>
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
                  <p><strong>{selected.patient_name || 'Patient'}</strong></p>
                  <p className="muted">Aadhaar: {maskAadhaar(selected.patient_aadhaar ?? selected.aadhaar)}</p>
                  <button
                    type="button"
                    className="ghostBtn"
                    style={{ fontSize: '12px', padding: '3px 8px', marginTop: '6px' }}
                    onClick={() => {
                      setEhrPatient({
                        id: Number(selected.patient_id) || selected.id,
                        name: String(selected.patient_name || 'Patient'),
                        patient_code: typeof selected.patient_code === 'string' ? selected.patient_code : undefined,
                        mobile: typeof selected.mobile === 'string' ? selected.mobile : undefined,
                        aadhar_number: typeof selected.patient_aadhaar === 'string' ? selected.patient_aadhaar : undefined,
                        bp: typeof selected.bp === 'string' ? selected.bp : undefined,
                        spo2: typeof selected.spo2 === 'number' || typeof selected.spo2 === 'string' ? selected.spo2 : undefined,
                        age: typeof selected.age === 'number' ? selected.age : undefined,
                        sex: typeof selected.sex === 'string' ? selected.sex : undefined,
                      });
                    }}
                  >
                    🩺 View Full EHR
                  </button>
                </div>
                <div>
                  <p className="label">Schedule & Token</p>
                  <p><strong>Token #{String(selected.token_number || selected.id)}</strong></p>
                  <p className="muted">{formatDate(selected.scheduled_at)}</p>
                </div>
                <div>
                  <p className="label">Reason / Clinical Note</p>
                  <p>{selected.reason || 'Respiratory consultation'}</p>
                </div>
                <div>
                  <p className="label">Status</p>
                  <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Visit status">
                    <option value="pending">pending</option>
                    <option value="confirmed">confirmed</option>
                    <option value="done">done</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </div>
              </div>

              {(Boolean(selected.bp) || Boolean(selected.spo2)) && (
                <div style={{ background: '#f0f9ff', padding: '8px 14px', borderRadius: '6px', border: '1px solid #bae6fd', margin: '10px 0', display: 'flex', gap: '20px' }}>
                  {Boolean(selected.bp) && <span><strong>Blood Pressure:</strong> {String(selected.bp)}</span>}
                  {Boolean(selected.spo2) && (
                    <span>
                      <strong>SpO2:</strong>{' '}
                      <span style={{ color: Number(selected.spo2) < 95 ? '#dc2626' : '#16a34a', fontWeight: 'bold' }}>
                        {String(selected.spo2)}%
                      </span>
                    </span>
                  )}
                </div>
              )}
              <label>
                Notes
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </label>

              <div className="sectionTop" style={{ marginTop: '15px' }}>
                <h4>Medicines</h4>
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

      {ehrPatient && (
        <EHRModal
          patient={ehrPatient}
          onClose={() => setEhrPatient(null)}
        />
      )}
    </div>
  );
}

