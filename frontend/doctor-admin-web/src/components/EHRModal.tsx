import { useEffect, useState } from 'react';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { Patient } from '../types';
import { formatDate, maskAadhaar } from '../utils/format';
import { printInvoice } from '../utils/invoicePrint';
import { LoadingState } from './ListControls';


interface Props {
  patient: Patient;
  onClose: () => void;
}

export default function EHRModal({ patient, onClose }: Props) {
  const [data, setData] = useState<Patient | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<'vitals' | 'visits' | 'prescriptions' | 'billing'>('vitals');

  useEffect(() => {
    const fetchEHR = async () => {
      setLoading(true);
      setError('');
      try {
        const id = patient.id || patient.patient_id;
        const res = await apiClient.get<Patient>(`/patients/${id}`);
        setData(res.data);
      } catch (err) {
        setError(apiErrorMessage(err, 'Failed to fetch electronic health records'));
      } finally {
        setLoading(false);
      }
    };
    fetchEHR();
  }, [patient]);

  const p = data || patient;

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true" aria-labelledby="ehrTitle">
      <div className="modalContent" style={{ maxWidth: '800px', maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid #e2e8f0', paddingBottom: '12px', marginBottom: '16px' }}>
          <div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span className="clinicBadge" style={{ fontSize: '11px', padding: '2px 8px' }}>EHR RECORD</span>
              <span className="muted" style={{ fontSize: '13px' }}>ID: <strong>{p.patient_code || `HEP-${p.id}`}</strong></span>
            </div>
            <h2 id="ehrTitle" style={{ margin: '4px 0 0 0', fontSize: '20px' }}>{p.name}</h2>
            <p className="muted" style={{ margin: '2px 0 0 0', fontSize: '13px' }}>
              {p.age ? `${p.age} yrs` : 'Age N/A'} · {p.sex || 'Sex N/A'} · Mobile: {p.mobile || 'N/A'}
              {p.aadhar_number ? ` · Aadhaar: ${maskAadhaar(p.aadhar_number)}` : ''}
            </p>
          </div>
          <button className="ghostBtn" onClick={onClose} type="button">✕</button>
        </div>

        {error && <p className="errorText" role="alert">{error}</p>}

        {loading ? (
          <LoadingState message="Loading health records…" />
        ) : (
          <div>
            {/* Tabs */}
            <div style={{ display: 'flex', gap: '8px', borderBottom: '2px solid #e2e8f0', marginBottom: '16px' }}>
              <button
                type="button"
                className={`tabBtn ${activeTab === 'vitals' ? 'tabActive' : ''}`}
                onClick={() => setActiveTab('vitals')}
                style={{ padding: '8px 16px', background: 'none', border: 'none', borderBottom: activeTab === 'vitals' ? '2px solid #0056b3' : 'none', fontWeight: activeTab === 'vitals' ? 'bold' : 'normal', color: activeTab === 'vitals' ? '#0056b3' : '#64748b', cursor: 'pointer' }}
              >
                Vitals & Demographics
              </button>
              <button
                type="button"
                className={`tabBtn ${activeTab === 'visits' ? 'tabActive' : ''}`}
                onClick={() => setActiveTab('visits')}
                style={{ padding: '8px 16px', background: 'none', border: 'none', borderBottom: activeTab === 'visits' ? '2px solid #0056b3' : 'none', fontWeight: activeTab === 'visits' ? 'bold' : 'normal', color: activeTab === 'visits' ? '#0056b3' : '#64748b', cursor: 'pointer' }}
              >
                Visits & Tokens ({p.appointments?.length || 0})
              </button>
              <button
                type="button"
                className={`tabBtn ${activeTab === 'prescriptions' ? 'tabActive' : ''}`}
                onClick={() => setActiveTab('prescriptions')}
                style={{ padding: '8px 16px', background: 'none', border: 'none', borderBottom: activeTab === 'prescriptions' ? '2px solid #0056b3' : 'none', fontWeight: activeTab === 'prescriptions' ? 'bold' : 'normal', color: activeTab === 'prescriptions' ? '#0056b3' : '#64748b', cursor: 'pointer' }}
              >
                Prescriptions ({p.prescriptions?.length || 0})
              </button>
              <button
                type="button"
                className={`tabBtn ${activeTab === 'billing' ? 'tabActive' : ''}`}
                onClick={() => setActiveTab('billing')}
                style={{ padding: '8px 16px', background: 'none', border: 'none', borderBottom: activeTab === 'billing' ? '2px solid #0056b3' : 'none', fontWeight: activeTab === 'billing' ? 'bold' : 'normal', color: activeTab === 'billing' ? '#0056b3' : '#64748b', cursor: 'pointer' }}
              >
                Billing ({p.invoices?.length || 0})
              </button>
            </div>

            {/* Vitals Tab */}
            {activeTab === 'vitals' && (
              <div className="stack" style={{ gap: '14px' }}>
                <div className="grid4" style={{ gap: '12px' }}>
                  <div className="card" style={{ padding: '12px', background: '#f8fafc' }}>
                    <span className="muted" style={{ fontSize: '12px' }}>Blood Pressure</span>
                    <h3 style={{ margin: '4px 0', color: '#0056b3' }}>{p.bp || '—'}</h3>
                  </div>
                  <div className="card" style={{ padding: '12px', background: '#f8fafc' }}>
                    <span className="muted" style={{ fontSize: '12px' }}>Oxygen Saturation (SpO2)</span>
                    <h3 style={{ margin: '4px 0', color: Number(p.spo2) < 95 ? '#dc2626' : '#16a34a' }}>
                      {p.spo2 ? `${p.spo2}%` : '—'}
                    </h3>
                  </div>
                  <div className="card" style={{ padding: '12px', background: '#f8fafc' }}>
                    <span className="muted" style={{ fontSize: '12px' }}>Height</span>
                    <h3 style={{ margin: '4px 0' }}>{p.height_cm ? `${p.height_cm} cm` : '—'}</h3>
                  </div>
                  <div className="card" style={{ padding: '12px', background: '#f8fafc' }}>
                    <span className="muted" style={{ fontSize: '12px' }}>Weight</span>
                    <h3 style={{ margin: '4px 0' }}>{p.weight_kg ? `${p.weight_kg} kg` : '—'}</h3>
                  </div>
                </div>

                <div className="card" style={{ padding: '14px' }}>
                  <h4 style={{ margin: '0 0 10px 0' }}>Demographic Details</h4>
                  <div className="grid2" style={{ gap: '8px', fontSize: '14px' }}>
                    <p style={{ margin: 0 }}><strong>Address:</strong> {p.address || '—'}</p>
                    <p style={{ margin: 0 }}><strong>Email:</strong> {p.email || '—'}</p>
                    <p style={{ margin: 0 }}><strong>Registered On:</strong> {formatDate(p.created_at)}</p>
                    <p style={{ margin: 0 }}><strong>Clinic:</strong> Hepziba Chest Clinic, Nagercoil</p>
                  </div>
                </div>
              </div>
            )}

            {/* Visits Tab */}
            {activeTab === 'visits' && (
              <div>
                {!p.appointments || p.appointments.length === 0 ? (
                  <p className="muted">No visit history recorded for this patient.</p>
                ) : (
                  <table className="dataTable">
                    <thead>
                      <tr>
                        <th>Date & Time</th>
                        <th>Token #</th>
                        <th>Doctor</th>
                        <th>Reason / Symptoms</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.appointments.map((a: any) => (
                        <tr key={a.id}>
                          <td>{formatDate(String(a.scheduled_at_effective || a.scheduled_at || ''))}</td>
                          <td><strong>Token #{String(a.token_number || a.id)}</strong></td>
                          <td>{String(a.doctor_name || 'Dr. T. Joseph Pratheeban')}</td>
                          <td>{String(a.reason || '—')}</td>
                          <td>
                            <span className={`pill status ${String(a.status || 'pending')}`}>{String(a.status || 'pending')}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {/* Prescriptions Tab */}
            {activeTab === 'prescriptions' && (
              <div>
                {!p.prescriptions || p.prescriptions.length === 0 ? (
                  <p className="muted">No prescriptions recorded yet.</p>
                ) : (
                  <div className="stack" style={{ gap: '12px' }}>
                    {p.prescriptions.map((rx: any) => (
                      <div key={rx.id} className="card" style={{ padding: '12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                          <strong>Prescription #{rx.id} · {formatDate(rx.prescribed_on)}</strong>
                          <span className="muted">Doctor: {rx.doctor_name || 'Dr. T. Joseph Pratheeban'}</span>
                        </div>
                        {rx.notes && <p style={{ fontSize: '13px', margin: '0 0 8px 0' }}><em>Notes: {rx.notes}</em></p>}
                        <table className="dataTable" style={{ fontSize: '13px' }}>
                          <thead>
                            <tr>
                              <th>Medicine</th>
                              <th>Dosage (M-A-E-N)</th>
                              <th>Food Instruction</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(rx.items || []).map((m: any, idx: number) => {
                              const timing = [
                                m.dosage_morning ? 'M' : '',
                                m.dosage_afternoon ? 'A' : '',
                                m.dosage_evening ? 'E' : '',
                                m.dosage_night ? 'N' : '',
                              ].filter(Boolean).join('–') || '—';
                              const food = m.before_food ? 'Before food' : m.after_food ? 'After food' : '—';
                              return (
                                <tr key={idx}>
                                  <td><strong>{m.medicine_name}</strong></td>
                                  <td>{timing}</td>
                                  <td>{food}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Billing Tab */}
            {activeTab === 'billing' && (
              <div>
                {!p.invoices || p.invoices.length === 0 ? (
                  <p className="muted">No invoices found for this patient.</p>
                ) : (
                  <div className="stack" style={{ gap: '12px' }}>
                    {p.invoices.map((inv) => (
                      <div key={inv.id} className="card" style={{ padding: '12px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                          <div>
                            <strong>Invoice #{inv.id}</strong> · {formatDate(inv.invoice_date)}
                            <span style={{ marginLeft: '12px', color: '#0056b3', fontWeight: 'bold' }}>
                              ₹{Number(inv.total_amount).toFixed(2)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="primaryBtn"
                            style={{ padding: '4px 10px', fontSize: '12px' }}
                            onClick={() => printInvoice(inv)}
                          >
                            Print Bill
                          </button>
                        </div>
                        <table className="dataTable" style={{ fontSize: '13px' }}>
                          <thead>
                            <tr>
                              <th>Item</th>
                              <th>Unit</th>
                              <th>MRP</th>
                              <th>Qty</th>
                              <th>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(inv.items || []).map((it, idx) => (
                              <tr key={idx}>
                                <td>{it.medicine_name}</td>
                                <td>{it.unit || 'pcs'}</td>
                                <td>₹{Number(it.mrp).toFixed(2)}</td>
                                <td>{it.quantity}</td>
                                <td><strong>₹{Number(it.total).toFixed(2)}</strong></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: '20px', textAlign: 'right' }}>
          <button className="primaryBtn" onClick={onClose} type="button">Close</button>
        </div>
      </div>
    </div>
  );
}
