import { useCallback, useState } from 'react';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { Appointment, MedicineRow } from '../types';

export function useDoctorAppointments() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get<Appointment[]>('/appointments/for-me');
      setAppointments(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load appointments'));
    } finally {
      setLoading(false);
    }
  }, []);

  const updateStatus = useCallback(
    async (id: number, status: string, notes: string) => {
      try {
        await apiClient.patch(`/doctors/appointments/${id}`, { status, notes });
        await load();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to update appointment'), { cause: err });
      }
    },
    [load],
  );

  const createPrescription = useCallback(
    async (appointmentId: number, notes: string, medicines: MedicineRow[]) => {
      const items = medicines.map((m) => ({
        medicine_name: m.name.trim(),
        dosage_morning: m.m,
        dosage_afternoon: m.a,
        dosage_evening: m.e,
        dosage_night: m.n,
        before_food: m.bf,
        after_food: m.af,
      }));
      try {
        await apiClient.post('/prescriptions', {
          appointment_id: appointmentId,
          notes,
          items,
        });
        await load();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to create prescription'), { cause: err });
      }
    },
    [load],
  );

  return { appointments, loading, error, setError, load, updateStatus, createPrescription };
}
