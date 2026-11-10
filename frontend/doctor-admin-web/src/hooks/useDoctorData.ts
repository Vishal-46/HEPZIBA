import { useCallback, useState } from 'react';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { Appointment, MedicineRow } from '../types';

const BATCH_SIZE = 25;

export function useDoctorAppointments() {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get<Appointment[]>(`/appointments/for-me?limit=${BATCH_SIZE}&offset=0&reveal=contact`);
      const rows = Array.isArray(res.data) ? res.data : [];
      setAppointments(rows);
      setHasMore(rows.length === BATCH_SIZE);
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load appointments'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    setError('');
    try {
      const res = await apiClient.get<Appointment[]>(
        `/appointments/for-me?limit=${BATCH_SIZE}&offset=${appointments.length}&reveal=contact`,
      );
      const next = Array.isArray(res.data) ? res.data : [];
      setAppointments((prev) => {
        const seen = new Set(prev.map((a) => a.id));
        return [...prev, ...next.filter((a) => !seen.has(a.id))];
      });
      setHasMore(next.length === BATCH_SIZE);
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load more appointments'));
    } finally {
      setLoadingMore(false);
    }
  }, [appointments.length, hasMore, loadingMore]);

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

  const getPrescription = useCallback(async (appointmentId: number) => {
    try {
      const res = await apiClient.get(`/prescriptions/appointment/${appointmentId}`);
      return res.data as {
        id: number;
        notes?: string;
        items: Array<{ medicine_name: string; dosage_morning?: boolean; dosage_afternoon?: boolean; dosage_evening?: boolean; dosage_night?: boolean; before_food?: boolean; after_food?: boolean }>;
      };
    } catch (err) {
      throw new Error(apiErrorMessage(err, 'Failed to load prescription'), { cause: err });
    }
  }, []);

  return {
    appointments,
    loading,
    loadingMore,
    hasMore,
    error,
    setError,
    load,
    loadMore,
    updateStatus,
    createPrescription,
    getPrescription,
  };
}
