import React, { useState } from 'react';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { Patient } from '../types';

interface Props {
  patient: Patient;
  onClose: () => void;
  onSuccess: (tokenNumber: number) => void;
}

export default function AdminBookingModal({ patient, onClose, onSuccess }: Props) {
  const [scheduledAt, setScheduledAt] = useState(() => {
    // Default to tomorrow 10:00 AM local time
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [reason, setReason] = useState('Routine Chest Consultation');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleBook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scheduledAt) {
      setError('Please select appointment date and time');
      return;
    }
    const apptDate = new Date(scheduledAt);
    if (apptDate.getTime() < Date.now()) {
      setError('Appointment time must be in the future');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const res = await apiClient.post('/appointments', {
        patient_id: patient.id || patient.patient_id,
        scheduled_at: apptDate.toISOString(),
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
      });

      const token = res.data?.appointment?.token_number || 1;
      onSuccess(token);
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to book appointment'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modalOverlay" role="dialog" aria-modal="true" aria-labelledby="bookingTitle">
      <div className="modalContent" style={{ maxWidth: '500px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h3 id="bookingTitle" style={{ margin: 0 }}>Schedule Appointment</h3>
          <button className="ghostBtn" onClick={onClose} type="button">✕</button>
        </div>

        <div style={{ background: '#f8fafc', padding: '12px', borderRadius: '6px', marginBottom: '16px', border: '1px solid #e2e8f0' }}>
          <p style={{ margin: 0, fontSize: '14px' }}>
            <strong>Patient:</strong> {patient.name} ({patient.patient_code || `HEP-${patient.id}`})
          </p>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#64748b' }}>
            Doctor: Dr. T. Joseph Pratheeban, Pulmonologist & Bronchoscopist
          </p>
        </div>

        {error && <p className="errorText" role="alert">{error}</p>}

        <form onSubmit={handleBook}>
          <div style={{ marginBottom: '14px' }}>
            <label style={{ fontSize: '13px', fontWeight: 600 }}>Date & Time *</label>
            <input
              type="datetime-local"
              required
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </div>

          <div style={{ marginBottom: '14px' }}>
            <label style={{ fontSize: '13px', fontWeight: 600 }}>Reason / Symptoms</label>
            <input
              placeholder="e.g. Persistent cough, Wheezing, Follow-up"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ fontSize: '13px', fontWeight: 600 }}>Admin Notes (Optional)</label>
            <input
              placeholder="e.g. VIP patient, SpO2 check-in at desk"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button type="button" className="ghostBtn" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="primaryBtn" disabled={submitting}>
              {submitting ? 'Allocating Token…' : 'Confirm & Allocate Token'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
