import React, { useState, useEffect } from 'react';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { Patient } from '../types';
import { maskAadhaar } from '../utils/format';

import { SearchInput, Pager, LoadingState, EmptyState } from './ListControls';

interface Props {
  onSelectPatientForBilling?: (patient: Patient) => void;
  onSelectPatientForAppointment?: (patient: Patient) => void;
  onViewEHR?: (patient: Patient) => void;
}

const PAGE_SIZE = 8;

export default function PatientManagement({
  onSelectPatientForBilling,
  onSelectPatientForAppointment,
  onViewEHR,
}: Props) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  // New patient modal state
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    age: '',
    sex: 'Male',
    mobile: '',
    address: '',
    aadhar_number: '',
    height_cm: '',
    weight_kg: '',
    bp: '',
    spo2: '',
    photo_url: '',
  });

  const loadPatients = async (query = '') => {
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get<Patient[]>('/patients', {
        params: { q: query || undefined, limit: 100 },
      });
      setPatients(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load patients'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPatients(searchQuery);
  }, [searchQuery]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      setError('Patient name is required');
      return;
    }
    if (!formData.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email.trim())) {
      setError('Patient email is required — they sign into the app with it');
      return;
    }
    if (formData.password && formData.password.length < 8) {
      setError('App password must be at least 8 characters (or leave it blank for Google sign-in)');
      return;
    }
    if (formData.mobile && !/^\d{10,15}$/.test(formData.mobile.trim())) {
      setError('Mobile number must be 10-15 digits');
      return;
    }
    if (formData.aadhar_number && !/^\d{12}$/.test(formData.aadhar_number.trim())) {
      setError('Aadhaar number must be exactly 12 digits');
      return;
    }
    if (formData.spo2 && (Number(formData.spo2) < 0 || Number(formData.spo2) > 100)) {
      setError('SpO2 must be between 0 and 100%');
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res = await apiClient.post('/patients/walkin', {
        ...formData,
        age: formData.age ? Number(formData.age) : undefined,
        height_cm: formData.height_cm ? Number(formData.height_cm) : undefined,
        weight_kg: formData.weight_kg ? Number(formData.weight_kg) : undefined,
        spo2: formData.spo2 ? Number(formData.spo2) : undefined,
      });

      setSuccess(
        `${res.data?.message || 'Patient registered.'} Code: ${res.data?.patient?.patient_code || 'Issued'} — app login: ${res.data?.login?.email || formData.email.trim().toLowerCase()}`
      );
      setShowModal(false);
      setFormData({
        name: '',
        email: '',
        password: '',
        age: '',
        sex: 'Male',
        mobile: '',
        address: '',
        aadhar_number: '',
        height_cm: '',
        weight_kg: '',
        bp: '',
        spo2: '',
        photo_url: '',
      });
      loadPatients();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to register patient'));
    } finally {
      setSaving(false);
    }
  };

  // Pagination
  const totalPages = Math.max(1, Math.ceil(patients.length / PAGE_SIZE));
  const currentPatients = patients.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="stack">
      <div className="sectionTop">
        <div>
          <h2>Patient Registration & Directory</h2>
          <p className="muted">Manage demographics, clinical vitals (SpO2, BP), and records for clinic patients.</p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="primaryBtn" onClick={() => setShowModal(true)}>
            + Register New Patient
          </button>
          <button className="ghostBtn" onClick={() => loadPatients(searchQuery)} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      {error && <p className="errorText" role="alert">{error}</p>}
      {success && <p className="infoText" role="status">{success}</p>}

      <div className="card">
        <div style={{ marginBottom: '16px' }}>
          <SearchInput
            query={searchQuery}
            onQuery={(q) => {
              setSearchQuery(q);
              setPage(1);
            }}
            label="Search patients by name, mobile, Aadhaar, or Patient ID…"
          />
        </div>

        {loading ? (
          <LoadingState message="Loading patients..." />
        ) : patients.length === 0 ? (
          <EmptyState message="No patients registered yet. Click '+ Register New Patient' to add the first patient." />
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>Patient ID</th>
                    <th>Name</th>
                    <th>Age / Sex</th>
                    <th>Mobile</th>
                    <th>BP / SpO2</th>
                    <th>Height / Weight</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {currentPatients.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>{p.patient_code || `HEP-${p.id}`}</strong>
                      </td>
                      <td>
                        <div><strong>{p.name}</strong></div>
                        {p.aadhar_number && (
                          <span className="muted" style={{ fontSize: '12px' }}>
                            Aadhaar: {maskAadhaar(p.aadhar_number)}
                          </span>
                        )}
                      </td>
                      <td>
                        {p.age ? `${p.age} yrs` : '—'} / {p.sex || '—'}
                      </td>
                      <td>{p.mobile || '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          {p.bp && <span className="pill status confirmed">BP: {p.bp}</span>}
                          {p.spo2 && (
                            <span className={`pill ${Number(p.spo2) < 95 ? 'status cancelled' : 'status done'}`}>
                              SpO2: {p.spo2}%
                            </span>
                          )}
                          {!p.bp && !p.spo2 && <span className="muted">—</span>}
                        </div>
                      </td>
                      <td>
                        <span style={{ fontSize: '13px' }}>
                          {p.height_cm ? `${p.height_cm} cm` : '—'} / {p.weight_kg ? `${p.weight_kg} kg` : '—'}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          {onViewEHR && (
                            <button
                              className="ghostBtn"
                              style={{ padding: '4px 8px', fontSize: '12px' }}
                              onClick={() => onViewEHR(p)}
                              title="View Electronic Health Record"
                            >
                              EHR
                            </button>
                          )}
                          {onSelectPatientForAppointment && (
                            <button
                              className="ghostBtn"
                              style={{ padding: '4px 8px', fontSize: '12px' }}
                              onClick={() => onSelectPatientForAppointment(p)}
                              title="Book Doctor Appointment"
                            >
                              Book
                            </button>
                          )}
                          {onSelectPatientForBilling && (
                            <button
                              className="primaryBtn"
                              style={{ padding: '4px 8px', fontSize: '12px' }}
                              onClick={() => onSelectPatientForBilling(p)}
                              title="Create Invoice / Bill"
                            >
                              Bill
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pager
              page={page}
              totalPages={totalPages}
              onPage={setPage}
              total={patients.length}
              label="Patients"
            />
          </>
        )}
      </div>

      {/* Walk-in Registration Modal */}
      {showModal && (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
          <div className="modalContent" style={{ maxWidth: '640px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 id="modalTitle" style={{ margin: 0 }}>Register New Patient (Walk-in)</h3>
              <button className="ghostBtn" onClick={() => setShowModal(false)} type="button">✕</button>
            </div>

            <form onSubmit={handleRegister}>
              <div className="grid2" style={{ gap: '12px', marginBottom: '12px' }}>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Full Name *</label>
                  <input
                    required
                    placeholder="Patient Name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Mobile Number</label>
                  <input
                    placeholder="10-15 digits"
                    value={formData.mobile}
                    onChange={(e) => setFormData({ ...formData, mobile: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid3" style={{ gap: '12px', marginBottom: '12px' }}>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Age</label>
                  <input
                    type="number"
                    placeholder="Years"
                    min="0"
                    max="125"
                    value={formData.age}
                    onChange={(e) => setFormData({ ...formData, age: e.target.value })}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Sex</label>
                  <select
                    value={formData.sex}
                    onChange={(e) => setFormData({ ...formData, sex: e.target.value })}
                  >
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Aadhaar Number</label>
                  <input
                    placeholder="12 digits"
                    maxLength={12}
                    value={formData.aadhar_number}
                    onChange={(e) => setFormData({ ...formData, aadhar_number: e.target.value })}
                  />
                </div>
              </div>

              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '13px', fontWeight: 600 }}>Address</label>
                <input
                  placeholder="Residential Address"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                />
              </div>

              <div style={{ background: '#eef7f2', padding: '12px', borderRadius: '8px', border: '1px solid #bfe3cf', marginBottom: '12px' }}>
                <h4 style={{ margin: '0 0 4px 0', fontSize: '14px', color: '#147a5c' }}>App login (ask the patient to download the app)</h4>
                <p className="muted" style={{ margin: '0 0 10px 0' }}>They sign in with this email — Google sign-in with the same email, or the password below.</p>
                <div className="grid2" style={{ gap: '12px' }}>
                  <div>
                    <label style={{ fontSize: '13px', fontWeight: 600 }}>Email for app login *</label>
                    <input
                      required
                      type="email"
                      placeholder="patient@email.com"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '13px', fontWeight: 600 }}>App password (optional, min 8)</label>
                    <input
                      type="password"
                      placeholder="Leave blank for Google sign-in"
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      autoComplete="new-password"
                    />
                  </div>
                </div>
              </div>

              <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '16px' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '14px', color: '#0056b3' }}>Clinical Vitals (Chest Clinic Check-in)</h4>
                <div className="grid4" style={{ gap: '10px' }}>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600 }}>SpO2 (%)</label>
                    <input
                      type="number"
                      placeholder="e.g. 98"
                      min="50"
                      max="100"
                      value={formData.spo2}
                      onChange={(e) => setFormData({ ...formData, spo2: e.target.value })}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600 }}>Blood Pressure</label>
                    <input
                      placeholder="e.g. 120/80"
                      value={formData.bp}
                      onChange={(e) => setFormData({ ...formData, bp: e.target.value })}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600 }}>Height (cm)</label>
                    <input
                      type="number"
                      step="0.1"
                      placeholder="e.g. 170"
                      value={formData.height_cm}
                      onChange={(e) => setFormData({ ...formData, height_cm: e.target.value })}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600 }}>Weight (kg)</label>
                    <input
                      type="number"
                      step="0.1"
                      placeholder="e.g. 68"
                      value={formData.weight_kg}
                      onChange={(e) => setFormData({ ...formData, weight_kg: e.target.value })}
                    />
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button type="button" className="ghostBtn" onClick={() => setShowModal(false)} disabled={saving}>
                  Cancel
                </button>
                <button type="submit" className="primaryBtn" disabled={saving}>
                  {saving ? 'Registering…' : 'Save Patient'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
