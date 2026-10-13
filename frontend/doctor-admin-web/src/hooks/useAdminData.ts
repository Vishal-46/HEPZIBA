import { useCallback, useState } from 'react';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { AdminUser, Appointment, InventoryItem } from '../types';

export function useAdminData() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [u, a, i] = await Promise.all([
        apiClient.get<AdminUser[]>('/admin/users'),
        apiClient.get<Appointment[]>('/admin/appointments'),
        apiClient.get<InventoryItem[]>('/inventory'),
      ]);
      setUsers(Array.isArray(u.data) ? u.data : []);
      setAppointments(Array.isArray(a.data) ? a.data : []);
      setInventory(Array.isArray(i.data) ? i.data : []);
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load admin data'));
    } finally {
      setLoading(false);
    }
  }, []);

  const createInventoryItem = useCallback(
    async (item: { name: string; stock: number; reorder_level: number; unit: string }) => {
      try {
        await apiClient.post('/inventory', item);
        await load();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to create inventory item'), { cause: err });
      }
    },
    [load],
  );

  const deleteUser = useCallback(
    async (id: number) => {
      try {
        await apiClient.delete(`/admin/users/${id}`);
        await load();
      } catch (err) {
        throw new Error(apiErrorMessage(err, 'Failed to delete user'), { cause: err });
      }
    },
    [load],
  );

  return {
    users,
    appointments,
    inventory,
    loading,
    error,
    setError,
    load,
    createInventoryItem,
    deleteUser,
  };
}
