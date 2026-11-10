import { useCallback, useState } from 'react';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type {
  AdminUser,
  Appointment,
  DoctorCatalogItem,
  InventoryItem,
  InvoiceRow,
  PatientRow,
} from '../types';

const USERS_BATCH = 50;
const PATIENTS_BATCH = 50;
const APPTS_BATCH = 30;
const INV_BATCH = 50;
const INVOICES_BATCH = 30;

type SectionKey = 'users' | 'patients' | 'appointments' | 'inventory' | 'invoices';

function mergeRows<T>(existing: T[], incoming: T[], keyOf: (row: T) => unknown, prepend = false): T[] {
  const map = new Map<unknown, T>();
  if (prepend) {
    for (const r of incoming) map.set(keyOf(r), r);
    for (const r of existing) {
      const k = keyOf(r);
      if (!map.has(k)) map.set(k, r);
    }
  } else {
    for (const r of existing) map.set(keyOf(r), r);
    for (const r of incoming) map.set(keyOf(r), r);
  }
  return Array.from(map.values());
}

export function useAdminData() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [doctorsCatalog, setDoctorsCatalog] = useState<DoctorCatalogItem[]>([]);
  const [hasMore, setHasMore] = useState<Record<SectionKey, boolean>>({
    users: false,
    patients: false,
    appointments: false,
    inventory: false,
    invoices: false,
  });
  const [loadingMore, setLoadingMore] = useState<SectionKey | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // Load each panel independently in initial batches: one failing endpoint
      // must not blank the whole admin dashboard or discard data that loaded.
      const [u, p, a, i, inv, docs] = await Promise.allSettled([
        apiClient.get<AdminUser[]>(`/admin/users?limit=${USERS_BATCH}&offset=0`),
        apiClient.get<PatientRow[]>(`/admin/patients?limit=${PATIENTS_BATCH}&offset=0&reveal=contact`),
        apiClient.get<Appointment[]>(`/admin/appointments?limit=${APPTS_BATCH}&offset=0&reveal=contact`),
        apiClient.get<InventoryItem[]>(`/inventory?limit=${INV_BATCH}&offset=0`),
        apiClient.get<InvoiceRow[]>(`/billing/invoices?limit=${INVOICES_BATCH}&offset=0`),
        apiClient.get<DoctorCatalogItem[]>('/appointments/catalog/doctors'),
      ]);

      const failures: string[] = [];
      const nextHasMore: Record<SectionKey, boolean> = {
        users: false,
        patients: false,
        appointments: false,
        inventory: false,
        invoices: false,
      };
      if (u.status === 'fulfilled') {
        const rows = Array.isArray(u.value.data) ? u.value.data : [];
        setUsers(rows);
        nextHasMore.users = rows.length === USERS_BATCH;
      } else {
        failures.push(`Users — ${apiErrorMessage(u.reason, 'failed to load')}`);
      }
      if (p.status === 'fulfilled') {
        const rows = Array.isArray(p.value.data) ? p.value.data : [];
        setPatients(rows);
        nextHasMore.patients = rows.length === PATIENTS_BATCH;
      } else {
        failures.push(`Patients — ${apiErrorMessage(p.reason, 'failed to load')}`);
      }
      if (a.status === 'fulfilled') {
        const rows = Array.isArray(a.value.data) ? a.value.data : [];
        setAppointments(rows);
        nextHasMore.appointments = rows.length === APPTS_BATCH;
      } else {
        failures.push(`Appointments — ${apiErrorMessage(a.reason, 'failed to load')}`);
      }
      if (i.status === 'fulfilled') {
        const rows = Array.isArray(i.value.data) ? i.value.data : [];
        setInventory(rows);
        nextHasMore.inventory = rows.length === INV_BATCH;
      } else {
        failures.push(`Inventory — ${apiErrorMessage(i.reason, 'failed to load')}`);
      }
      if (inv.status === 'fulfilled') {
        const rows = Array.isArray(inv.value.data) ? inv.value.data : [];
        setInvoices(rows);
        nextHasMore.invoices = rows.length === INVOICES_BATCH;
      } else {
        failures.push(`Invoices — ${apiErrorMessage(inv.reason, 'failed to load')}`);
      }
      if (docs.status === 'fulfilled') {
        setDoctorsCatalog(Array.isArray(docs.value.data) ? docs.value.data : []);
      }

      setHasMore(nextHasMore);
      if (failures.length > 0) {
        setError(`Some data could not be loaded. ${failures.join(' · ')}`);
      }
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load admin data'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(
    async (section: SectionKey) => {
      if (loadingMore || !hasMore[section]) return;
      setLoadingMore(section);
      try {
        if (section === 'appointments') {
          const res = await apiClient.get<Appointment[]>(
            `/admin/appointments?limit=${APPTS_BATCH}&offset=${appointments.length}&reveal=contact`,
          );
          const rows = Array.isArray(res.data) ? res.data : [];
          setAppointments((prev) => mergeRows(prev, rows, (r) => r.id));
          setHasMore((prev) => ({ ...prev, appointments: rows.length === APPTS_BATCH }));
        } else if (section === 'users') {
          const res = await apiClient.get<AdminUser[]>(
            `/admin/users?limit=${USERS_BATCH}&offset=${users.length}`,
          );
          const rows = Array.isArray(res.data) ? res.data : [];
          setUsers((prev) => mergeRows(prev, rows, (r) => r.id));
          setHasMore((prev) => ({ ...prev, users: rows.length === USERS_BATCH }));
        } else if (section === 'patients') {
          const res = await apiClient.get<PatientRow[]>(
            `/admin/patients?limit=${PATIENTS_BATCH}&offset=${patients.length}&reveal=contact`,
          );
          const rows = Array.isArray(res.data) ? res.data : [];
          setPatients((prev) => mergeRows(prev, rows, (r) => r.user_id));
          setHasMore((prev) => ({ ...prev, patients: rows.length === PATIENTS_BATCH }));
        } else if (section === 'inventory') {
          const res = await apiClient.get<InventoryItem[]>(
            `/inventory?limit=${INV_BATCH}&offset=${inventory.length}`,
          );
          const rows = Array.isArray(res.data) ? res.data : [];
          setInventory((prev) => mergeRows(prev, rows, (r) => r.id));
          setHasMore((prev) => ({ ...prev, inventory: rows.length === INV_BATCH }));
        } else if (section === 'invoices') {
          const res = await apiClient.get<InvoiceRow[]>(
            `/billing/invoices?limit=${INVOICES_BATCH}&offset=${invoices.length}`,
          );
          const rows = Array.isArray(res.data) ? res.data : [];
          setInvoices((prev) => mergeRows(prev, rows, (r) => r.id));
          setHasMore((prev) => ({ ...prev, invoices: rows.length === INVOICES_BATCH }));
        }
      } catch (err) {
        setError(apiErrorMessage(err, `Failed to load more ${section}`));
      } finally {
        setLoadingMore(null);
      }
    },
    [appointments.length, hasMore, inventory.length, invoices.length, loadingMore, patients.length, users.length],
  );

  const refreshInventoryOnly = useCallback(async () => {
    const res = await apiClient.get<InventoryItem[]>(`/inventory?limit=${INV_BATCH}&offset=0`);
    const rows = Array.isArray(res.data) ? res.data : [];
    setInventory((prev) => mergeRows(prev, rows, (r) => r.id, true));
  }, []);

  const refreshUsersAndCatalog = useCallback(async () => {
    const [u, docs] = await Promise.all([
      apiClient.get<AdminUser[]>(`/admin/users?limit=${USERS_BATCH}&offset=0`),
      apiClient.get<DoctorCatalogItem[]>('/appointments/catalog/doctors'),
    ]);
    const rows = Array.isArray(u.data) ? u.data : [];
    setUsers((prev) => mergeRows(prev, rows, (r) => r.id, true));
    setDoctorsCatalog(Array.isArray(docs.data) ? docs.data : []);
  }, []);

  const refreshAppointmentsQuiet = useCallback(async () => {
    const res = await apiClient.get<Appointment[]>(
      `/admin/appointments?limit=${APPTS_BATCH}&offset=0&reveal=contact`,
    );
    const fresh = Array.isArray(res.data) ? res.data : [];
    setAppointments((prev) => mergeRows(prev, fresh, (r) => r.id, true));
    return fresh;
  }, []);

  const refreshInvoicesOnly = useCallback(async () => {
    const res = await apiClient.get<InvoiceRow[]>(`/billing/invoices?limit=${INVOICES_BATCH}&offset=0`);
    const rows = Array.isArray(res.data) ? res.data : [];
    setInvoices((prev) => mergeRows(prev, rows, (r) => r.id, true));
  }, []);

  const createInventoryItem = useCallback(
    async (item: { name: string; stock: number; unit: string; mrp?: string; expiry_date?: string; category?: string; reorder_level?: number }) => {
      try {
        await apiClient.post('/inventory', item);
        await refreshInventoryOnly();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to create inventory item'), { cause: err });
      }
    },
    [refreshInventoryOnly],
  );

  const updateInventoryItem = useCallback(
    async (id: number, patch: { stock?: number; restock?: number; reorder_level?: number; name?: string; unit?: string; mrp?: string; expiry_date?: string | null; category?: string }) => {
      try {
        await apiClient.put(`/inventory/${id}`, patch);
        await refreshInventoryOnly();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to update inventory item'), { cause: err });
      }
    },
    [refreshInventoryOnly],
  );

  const toggleUserActive = useCallback(
    async (id: number, active: boolean) => {
      try {
        await apiClient.put(`/admin/users/${id}`, { active });
        await refreshUsersAndCatalog();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to update user'), { cause: err });
      }
    },
    [refreshUsersAndCatalog],
  );

  const createStaff = useCallback(
    async (staff: { name: string; email: string; password: string; role: 'doctor' | 'admin' }) => {
      try {
        await apiClient.post(`/auth/register/${staff.role}`, {
          name: staff.name,
          email: staff.email,
          password: staff.password,
        });
        await refreshUsersAndCatalog();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to create staff account'), { cause: err });
      }
    },
    [refreshUsersAndCatalog],
  );

  const updateAppointment = useCallback(
    async (id: number, patch: { status?: string; notes?: string; doctor_id?: number }) => {
      try {
        await apiClient.patch(`/admin/appointments/${id}`, patch);
        await refreshAppointmentsQuiet();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to update appointment'), { cause: err });
      }
    },
    [refreshAppointmentsQuiet],
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
        await Promise.all([refreshInvoicesOnly(), refreshInventoryOnly()]);
        return res.data;
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to create invoice'), { cause: err });
      }
    },
    [refreshInventoryOnly, refreshInvoicesOnly],
  );

  const updateInvoiceStatus = useCallback(
    async (id: number, status: 'paid' | 'unpaid') => {
      try {
        await apiClient.patch(`/billing/invoices/${id}`, { status });
        await refreshInvoicesOnly();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to update invoice'), { cause: err });
      }
    },
    [refreshInvoicesOnly],
  );

  return {
    users,
    patients,
    appointments,
    inventory,
    invoices,
    doctorsCatalog,
    hasMore,
    loadingMore,
    loading,
    error,
    setError,
    load,
    loadMore,
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
