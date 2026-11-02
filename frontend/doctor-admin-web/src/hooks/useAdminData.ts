import { useCallback, useState } from 'react';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { AdminUser, Appointment, InventoryItem, InvoiceRow, PatientRow } from '../types';

export function useAdminData() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Load each panel independently: one failing endpoint must not blank the
      // whole admin dashboard or discard data that did load successfully.
      const [u, p, a, i, inv] = await Promise.allSettled([
        apiClient.get<AdminUser[]>('/admin/users?limit=200'),
        apiClient.get<PatientRow[]>('/admin/patients?limit=200&reveal=contact'),
        apiClient.get<Appointment[]>('/admin/appointments?limit=100&reveal=contact'),
        apiClient.get<InventoryItem[]>('/inventory?limit=100'),
        apiClient.get<InvoiceRow[]>('/billing/invoices?limit=50'),
      ]);

      const failures: string[] = [];
      if (u.status === 'fulfilled') {
        setUsers(Array.isArray(u.value.data) ? u.value.data : []);
      } else {
        failures.push(`Users — ${apiErrorMessage(u.reason, 'failed to load')}`);
      }
      if (p.status === 'fulfilled') {
        setPatients(Array.isArray(p.value.data) ? p.value.data : []);
      } else {
        failures.push(`Patients — ${apiErrorMessage(p.reason, 'failed to load')}`);
      }
      if (a.status === 'fulfilled') {
        setAppointments(Array.isArray(a.value.data) ? a.value.data : []);
      } else {
        failures.push(`Appointments — ${apiErrorMessage(a.reason, 'failed to load')}`);
      }
      if (i.status === 'fulfilled') {
        setInventory(Array.isArray(i.value.data) ? i.value.data : []);
      } else {
        failures.push(`Inventory — ${apiErrorMessage(i.reason, 'failed to load')}`);
      }
      if (inv.status === 'fulfilled') {
        setInvoices(Array.isArray(inv.value.data) ? inv.value.data : []);
      } else {
        failures.push(`Invoices — ${apiErrorMessage(inv.reason, 'failed to load')}`);
      }

      if (failures.length > 0) {
        setError(`Some data could not be loaded. ${failures.join(' · ')}`);
      }
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load admin data'));
    } finally {
      setLoading(false);
    }
  }, []);

  const createInventoryItem = useCallback(
    async (item: { name: string; stock: number; unit: string; mrp?: string; expiry_date?: string; category?: string; reorder_level?: number }) => {
      try {
        await apiClient.post('/inventory', item);
        await load();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to create inventory item'), { cause: err });
      }
    },
    [load],
  );

  const updateInventoryItem = useCallback(
    async (id: number, patch: { stock?: number; restock?: number; reorder_level?: number; name?: string; unit?: string; mrp?: string; expiry_date?: string | null; category?: string }) => {
      try {
        await apiClient.put(`/inventory/${id}`, patch);
        await load();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to update inventory item'), { cause: err });
      }
    },
    [load],
  );

  const toggleUserActive = useCallback(
    async (id: number, active: boolean) => {
      try {
        await apiClient.put(`/admin/users/${id}`, { active });
        await load();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to update user'), { cause: err });
      }
    },
    [load],
  );

  const createStaff = useCallback(
    async (staff: { name: string; email: string; password: string; role: 'doctor' | 'admin' }) => {
      try {
        await apiClient.post(`/auth/register/${staff.role}`, {
          name: staff.name,
          email: staff.email,
          password: staff.password,
        });
        await load();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to create staff account'), { cause: err });
      }
    },
    [load],
  );

  const updateAppointment = useCallback(
    async (id: number, patch: { status?: string; notes?: string }) => {
      try {
        await apiClient.patch(`/admin/appointments/${id}`, patch);
        await load();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to update appointment'), { cause: err });
      }
    },
    [load],
  );

  const createInvoice = useCallback(
    async (payload: {
      patient_id: number;
      patient_code?: string;
      appointment_id?: number | null;
      doctor_name?: string;
      doctor_fee?: string;
      items: Array<{ medicine_name: string; quantity: number; mrp: string; unit?: string }>;
    }) => {
      try {
        const res = await apiClient.post('/billing/invoices', payload);
        await load();
        return res.data;
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to create invoice'), { cause: err });
      }
    },
    [load],
  );

  const updateInvoiceStatus = useCallback(
    async (id: number, status: 'paid' | 'unpaid') => {
      try {
        await apiClient.patch(`/billing/invoices/${id}`, { status });
        await load();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to update invoice'), { cause: err });
      }
    },
    [load],
  );

  // Silent appointment check: refreshes the list WITHOUT the loading
  // spinner, so background polling never flashes the dashboard.
  // Returns the fresh list for change detection.
  const refreshAppointmentsQuiet = useCallback(async () => {
    const res = await apiClient.get<Appointment[]>('/admin/appointments?limit=100&reveal=contact');
    const fresh = Array.isArray(res.data) ? res.data : [];
    setAppointments(fresh);
    return fresh;
  }, []);

  return {
    users,
    patients,
    appointments,
    inventory,
    invoices,
    loading,
    error,
    setError,
    load,
    createInventoryItem,
    updateInventoryItem,
    toggleUserActive,
    createStaff,
    updateAppointment,
    createInvoice,
    updateInvoiceStatus,
    refreshAppointmentsQuiet,
  };
}
