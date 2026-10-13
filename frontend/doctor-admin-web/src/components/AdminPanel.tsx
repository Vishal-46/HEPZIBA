import { useEffect, useMemo, useState } from 'react';
import { useAdminData } from '../hooks/useAdminData';
import { usePaginatedSearch } from '../hooks/usePaginatedSearch';
import { maskAadhaar } from '../utils/format';
import ClinicHoursSettings from './ClinicHoursSettings';
import { EmptyState, LoadingState, Pager, SearchInput } from './ListControls';

const PAGE_SIZE = 8;

export default function AdminPanel() {
  const {
    users,
    appointments,
    inventory,
    loading,
    error,
    setError,
    load,
    createInventoryItem,
    deleteUser,
  } = useAdminData();

  const [newItem, setNewItem] = useState({ name: '', stock: '0', reorder_level: '0', unit: 'pcs' });
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  const userSearch = usePaginatedSearch(users, (u) => [u.name, u.email, u.role, String(u.id)], PAGE_SIZE);
  const apptSearch = usePaginatedSearch(
    appointments,
    (a) => [a.patient_name, a.status, String(a.id)],
    PAGE_SIZE,
  );
  const invSearch = usePaginatedSearch(inventory, (i) => [i.name, i.unit, String(i.id)], PAGE_SIZE);

  const lowStock = useMemo(() => inventory.filter((i) => i.stock <= i.reorder_level).length, [inventory]);

  const handleAdd = async () => {
    if (!newItem.name.trim()) {
      setError('Inventory item needs a name.');
      return;
    }
    setAdding(true);
    setError('');
    try {
      await createInventoryItem({
        name: newItem.name.trim(),
        stock: Number(newItem.stock) || 0,
        reorder_level: Number(newItem.reorder_level) || 0,
        unit: newItem.unit.trim() || 'pcs',
      });
      setNewItem({ name: '', stock: '0', reorder_level: '0', unit: 'pcs' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create inventory item');
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Are you sure you want to deactivate this user?')) return;
    setError('');
    try {
      await deleteUser(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  return (
    <div className="stack">
      <div className="sectionTop">
        <h2>Admin Overview</h2>
        <button className="primaryBtn" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {error && (
        <p className="errorText" role="alert">
          {error}
        </p>
      )}
      {loading && <LoadingState message="Loading admin data…" />}

      {!loading && (
        <div className="grid3">
          <section className="card" aria-label="Users">
            <h3>Users</h3>
            <p className="muted">
              Total: {users.length}
            </p>
            <SearchInput query={userSearch.query} onQuery={userSearch.setQuery} label="Search users…" />
            {userSearch.total === 0 ? (
              <EmptyState message={users.length === 0 ? 'No users yet.' : 'No users match your search.'} />
            ) : (
              <>
                {userSearch.pageRows.map((u) => (
                  <div key={u.id} className="miniRow">
                    <span>
                      {u.name} ({u.role})
                      {u.aadhaar ? <span className="muted"> · {maskAadhaar(u.aadhaar)}</span> : null}
                    </span>
                    <button className="ghostBtn" onClick={() => handleDelete(u.id)}>
                      Delete
                    </button>
                  </div>
                ))}
                <Pager
                  page={userSearch.page}
                  totalPages={userSearch.totalPages}
                  onPage={userSearch.setPage}
                  total={userSearch.total}
                  label="Users"
                />
              </>
            )}
          </section>

          <section className="card" aria-label="Appointments">
            <h3>Appointments</h3>
            <p className="muted">Total: {appointments.length}</p>
            <SearchInput
              query={apptSearch.query}
              onQuery={apptSearch.setQuery}
              label="Search appointments…"
            />
            {apptSearch.total === 0 ? (
              <EmptyState
                message={appointments.length === 0 ? 'No appointments yet.' : 'No appointments match.'}
              />
            ) : (
              <>
                {apptSearch.pageRows.map((a) => (
                  <div key={a.id} className="miniRow">
                    #{a.id} {a.patient_name || ''} - {a.status}
                  </div>
                ))}
                <Pager
                  page={apptSearch.page}
                  totalPages={apptSearch.totalPages}
                  onPage={apptSearch.setPage}
                  total={apptSearch.total}
                  label="Appointments"
                />
              </>
            )}
          </section>

          <section className="card" aria-label="Inventory">
            <h3>
              Inventory {lowStock > 0 && <span className="pill status cancelled">{lowStock} low</span>}
            </h3>
            <SearchInput
              query={invSearch.query}
              onQuery={invSearch.setQuery}
              label="Search inventory…"
            />
            {invSearch.total === 0 ? (
              <EmptyState
                message={inventory.length === 0 ? 'No inventory items yet.' : 'No items match.'}
              />
            ) : (
              <>
                {invSearch.pageRows.map((i) => (
                  <div key={i.id} className="miniRow">
                    <span>
                      {i.name} - Stock: {i.stock} {i.unit}
                    </span>
                    {i.stock <= i.reorder_level && (
                      <span className="pill status cancelled">Low Stock</span>
                    )}
                  </div>
                ))}
                <Pager
                  page={invSearch.page}
                  totalPages={invSearch.totalPages}
                  onPage={invSearch.setPage}
                  total={invSearch.total}
                  label="Inventory"
                />
              </>
            )}
          </section>
        </div>
      )}

      <section className="card" aria-label="Add inventory item">
        <h3>Add Inventory Item</h3>
        <div className="formRow">
          <input
            placeholder="Name"
            aria-label="Item name"
            value={newItem.name}
            onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
          />
          <input
            placeholder="Stock"
            aria-label="Stock"
            inputMode="numeric"
            value={newItem.stock}
            onChange={(e) => setNewItem((p) => ({ ...p, stock: e.target.value }))}
          />
          <input
            placeholder="Reorder level"
            aria-label="Reorder level"
            inputMode="numeric"
            value={newItem.reorder_level}
            onChange={(e) => setNewItem((p) => ({ ...p, reorder_level: e.target.value }))}
          />
          <input
            placeholder="Unit"
            aria-label="Unit"
            value={newItem.unit}
            onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))}
          />
          <button className="primaryBtn" onClick={handleAdd} disabled={adding}>
            {adding ? 'Adding…' : 'Add'}
          </button>
        </div>
      </section>

      <ClinicHoursSettings />
    </div>
  );
}
