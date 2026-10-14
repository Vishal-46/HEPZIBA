import React, { useEffect, useMemo, useState } from 'react';
import { useAdminData } from '../hooks/useAdminData';
import { usePaginatedSearch } from '../hooks/usePaginatedSearch';
import { formatDate } from '../utils/format';

import ClinicHoursSettings from './ClinicHoursSettings';
import PatientManagement from './PatientManagement';
import BillingPanel from './BillingPanel';
import AdminBookingModal from './AdminBookingModal';
import EHRModal from './EHRModal';
import { EmptyState, LoadingState, Pager, SearchInput } from './ListControls';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { Patient } from '../types';


const PAGE_SIZE = 8;
type TabType = 'overview' | 'patients' | 'billing' | 'inventory' | 'settings';

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

  const [currentTab, setCurrentTab] = useState<TabType>('overview');
  const [successMsg, setSuccessMsg] = useState('');

  // Modals & cross-panel navigation
  const [bookingPatient, setBookingPatient] = useState<Patient | null>(null);
  const [ehrPatient, setEhrPatient] = useState<Patient | null>(null);
  const [billingPatient, setBillingPatient] = useState<Patient | null>(null);

  // Inventory form
  const [newItem, setNewItem] = useState({ name: '', stock: '0', reorder_level: '0', unit: 'pcs' });
  const [adding, setAdding] = useState(false);

  // Staff creation form (Admin & Doctor accounts)
  const [newStaff, setNewStaff] = useState({
    name: '',
    email: '',
    password: '',
    role: 'admin',
    specialty: 'Pulmonologist & Bronchoscopist',
    phone: '9500907968',
    bio: '',
  });
  const [creatingStaff, setCreatingStaff] = useState(false);

  const handleCreateStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStaff.name.trim() || !newStaff.email.trim() || !newStaff.password) {
      setError('Name, email, and password are required.');
      return;
    }
    if (newStaff.password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setCreatingStaff(true);
    setError('');
    try {
      if (newStaff.role === 'admin') {
        await apiClient.post('/auth/register/admin', {
          name: newStaff.name.trim(),
          email: newStaff.email.trim(),
          password: newStaff.password,
        });
        setSuccessMsg(`Admin account "${newStaff.email}" created successfully!`);
      } else {
        await apiClient.post('/auth/register/doctor', {
          name: newStaff.name.trim(),
          email: newStaff.email.trim(),
          password: newStaff.password,
          specialty: newStaff.specialty.trim() || undefined,
          phone: newStaff.phone.trim() || undefined,
          bio: newStaff.bio.trim() || undefined,
        });
        setSuccessMsg(`Doctor account "${newStaff.email}" created successfully!`);
      }
      setNewStaff({
        name: '',
        email: '',
        password: '',
        role: 'admin',
        specialty: 'Pulmonologist & Bronchoscopist',
        phone: '9500907968',
        bio: '',
      });
      load();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to create staff account'));
    } finally {
      setCreatingStaff(false);
    }
  };


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

  const handleAddInventory = async (e: React.FormEvent) => {
    e.preventDefault();
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
      setSuccessMsg('Inventory item added successfully');
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
      {/* Top Clinic Admin Navigation Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #e2e8f0', paddingBottom: '12px' }}>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`tabBtn ${currentTab === 'overview' ? 'tabActive' : ''}`}
            onClick={() => setCurrentTab('overview')}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: currentTab === 'overview' ? '#0056b3' : '#f1f5f9',
              color: currentTab === 'overview' ? '#ffffff' : '#334155',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={`tabBtn ${currentTab === 'patients' ? 'tabActive' : ''}`}
            onClick={() => setCurrentTab('patients')}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: currentTab === 'patients' ? '#0056b3' : '#f1f5f9',
              color: currentTab === 'patients' ? '#ffffff' : '#334155',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Patients & Registration
          </button>
          <button
            type="button"
            className={`tabBtn ${currentTab === 'billing' ? 'tabActive' : ''}`}
            onClick={() => setCurrentTab('billing')}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: currentTab === 'billing' ? '#0056b3' : '#f1f5f9',
              color: currentTab === 'billing' ? '#ffffff' : '#334155',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Billing & Invoicing
          </button>
          <button
            type="button"
            className={`tabBtn ${currentTab === 'inventory' ? 'tabActive' : ''}`}
            onClick={() => setCurrentTab('inventory')}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: currentTab === 'inventory' ? '#0056b3' : '#f1f5f9',
              color: currentTab === 'inventory' ? '#ffffff' : '#334155',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Inventory {lowStock > 0 && <span style={{ background: '#dc2626', color: 'white', borderRadius: '10px', padding: '1px 6px', fontSize: '11px', marginLeft: '4px' }}>{lowStock} low</span>}
          </button>
          <button
            type="button"
            className={`tabBtn ${currentTab === 'settings' ? 'tabActive' : ''}`}
            onClick={() => setCurrentTab('settings')}
            style={{
              padding: '8px 16px',
              borderRadius: '6px',
              border: 'none',
              background: currentTab === 'settings' ? '#0056b3' : '#f1f5f9',
              color: currentTab === 'settings' ? '#ffffff' : '#334155',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Settings
          </button>
        </div>

        <button className="ghostBtn" onClick={load} disabled={loading} style={{ fontSize: '13px' }}>
          {loading ? 'Refreshing…' : 'Refresh All'}
        </button>
      </div>

      {error && <p className="errorText" role="alert">{error}</p>}
      {successMsg && <p className="infoText" role="status">{successMsg}</p>}

      {/* TAB 1: OVERVIEW & QUEUE */}
      {currentTab === 'overview' && (
        <div className="stack">
          {loading && <LoadingState message="Loading admin overview…" />}

          {!loading && (
            <>
              {/* Quick Summary Cards */}
              <div className="grid3" style={{ gap: '16px' }}>
                <div className="card" style={{ borderLeft: '4px solid #0056b3' }}>
                  <span className="muted" style={{ fontSize: '12px' }}>Total Appointments</span>
                  <h2 style={{ margin: '6px 0', fontSize: '28px' }}>{appointments.length}</h2>
                  <p className="muted" style={{ fontSize: '13px', margin: 0 }}>Live consultation queue</p>
                </div>
                <div className="card" style={{ borderLeft: '4px solid #16a34a' }}>
                  <span className="muted" style={{ fontSize: '12px' }}>Active Users</span>
                  <h2 style={{ margin: '6px 0', fontSize: '28px' }}>{users.length}</h2>
                  <p className="muted" style={{ fontSize: '13px', margin: 0 }}>Patients, staff & admins</p>
                </div>
                <div className="card" style={{ borderLeft: `4px solid ${lowStock > 0 ? '#dc2626' : '#2563eb'}` }}>
                  <span className="muted" style={{ fontSize: '12px' }}>Inventory Items</span>
                  <h2 style={{ margin: '6px 0', fontSize: '28px' }}>{inventory.length}</h2>
                  <p className="muted" style={{ fontSize: '13px', margin: 0 }}>
                    {lowStock > 0 ? (
                      <span style={{ color: '#dc2626', fontWeight: 'bold' }}>{lowStock} items low in stock</span>
                    ) : (
                      'All stock levels healthy'
                    )}
                  </p>
                </div>
              </div>

              {/* Main Queue & Users Grid */}
              <div className="grid2" style={{ gap: '16px' }}>
                {/* Appointments Queue with Token numbers */}
                <section className="card" aria-label="Appointments Queue">
                  <div className="sectionTop">
                    <h3>Appointments Queue</h3>
                    <span className="pill">{appointments.length} total</span>
                  </div>
                  <SearchInput
                    query={apptSearch.query}
                    onQuery={apptSearch.setQuery}
                    label="Search appointments…"
                  />
                  {apptSearch.total === 0 ? (
                    <EmptyState message="No appointments scheduled." />
                  ) : (
                    <>
                      {apptSearch.pageRows.map((a: any) => (
                        <div key={a.id} className="miniRow" style={{ padding: '10px 8px' }}>
                          <div>
                            <strong>Token #{a.token_number || a.id}</strong> — {a.patient_name || 'Patient'}
                            <div className="appointmentMeta">
                              {formatDate(a.scheduled_at_effective || a.scheduled_at)} · {a.reason || 'General Visit'}
                            </div>
                          </div>
                          <span className={`pill status ${a.status}`}>{a.status}</span>
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

                {/* Users List */}
                <section className="card" aria-label="Users">
                  <div className="sectionTop">
                    <h3>User Accounts</h3>
                    <span className="pill">{users.length} accounts</span>
                  </div>
                  <SearchInput query={userSearch.query} onQuery={userSearch.setQuery} label="Search users…" />
                  {userSearch.total === 0 ? (
                    <EmptyState message="No users match search." />
                  ) : (
                    <>
                      {userSearch.pageRows.map((u) => (
                        <div key={u.id} className="miniRow" style={{ padding: '10px 8px' }}>
                          <div>
                            <strong>{u.name}</strong> <span className="muted">({u.role})</span>
                            <div className="appointmentMeta">{u.email}</div>
                          </div>
                          {u.role !== 'admin' && (
                            <button className="ghostBtn" style={{ color: '#dc2626' }} onClick={() => handleDelete(u.id)}>
                              Deactivate
                            </button>
                          )}
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
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 2: PATIENTS & REGISTRATION */}
      {currentTab === 'patients' && (
        <PatientManagement
          onSelectPatientForAppointment={(p) => setBookingPatient(p)}
          onSelectPatientForBilling={(p) => {
            setBillingPatient(p);
            setCurrentTab('billing');
          }}
          onViewEHR={(p) => setEhrPatient(p)}
        />
      )}

      {/* TAB 3: BILLING & INVOICING */}
      {currentTab === 'billing' && (
        <BillingPanel
          initialPatient={billingPatient}
          onClearInitialPatient={() => setBillingPatient(null)}
        />
      )}

      {/* TAB 4: INVENTORY TRACKING */}
      {currentTab === 'inventory' && (
        <div className="stack">
          <section className="card" aria-label="Add inventory item" style={{ borderTop: '4px solid #0056b3' }}>
            <h3>Add New Medication / Supply Item</h3>
            <form onSubmit={handleAddInventory}>
              <div className="grid4" style={{ gap: '12px', alignItems: 'flex-end' }}>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Medicine / Item Name *</label>
                  <input
                    required
                    placeholder="e.g. Salbutamol Inhaler"
                    value={newItem.name}
                    onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Current Stock *</label>
                  <input
                    type="number"
                    min="0"
                    placeholder="Stock quantity"
                    value={newItem.stock}
                    onChange={(e) => setNewItem((p) => ({ ...p, stock: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Reorder Alert Level *</label>
                  <input
                    type="number"
                    min="0"
                    placeholder="Alert threshold"
                    value={newItem.reorder_level}
                    onChange={(e) => setNewItem((p) => ({ ...p, reorder_level: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Unit</label>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      placeholder="e.g. pcs, tabs, bottles"
                      value={newItem.unit}
                      onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))}
                    />
                    <button type="submit" className="primaryBtn" disabled={adding}>
                      {adding ? 'Adding…' : 'Add Item'}
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </section>

          <section className="card" aria-label="Inventory Table">
            <div className="sectionTop">
              <h3>
                Inventory Stock Levels {lowStock > 0 && <span className="pill status cancelled">{lowStock} low stock items</span>}
              </h3>
            </div>
            <SearchInput
              query={invSearch.query}
              onQuery={invSearch.setQuery}
              label="Search inventory items…"
            />
            {invSearch.total === 0 ? (
              <EmptyState message="No inventory items found." />
            ) : (
              <>
                <table className="dataTable">
                  <thead>
                    <tr>
                      <th>Item Name</th>
                      <th>Unit</th>
                      <th>Current Stock</th>
                      <th>Reorder Level</th>
                      <th>Stock Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invSearch.pageRows.map((i) => {
                      const isLow = i.stock <= i.reorder_level;
                      return (
                        <tr key={i.id}>
                          <td><strong>{i.name}</strong></td>
                          <td>{i.unit}</td>
                          <td><strong>{i.stock}</strong></td>
                          <td>{i.reorder_level}</td>
                          <td>
                            {isLow ? (
                              <span className="pill status cancelled">⚠️ Reorder Needed</span>
                            ) : (
                              <span className="pill status done">In Stock</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
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

      {/* TAB 5: SETTINGS & STAFF MANAGEMENT */}
      {currentTab === 'settings' && (
        <div className="stack">
          {/* Create Staff Account Card */}
          <section className="card" style={{ borderTop: '4px solid #0056b3' }}>
            <div className="sectionTop">
              <div>
                <h3>Create Staff Account (Admin or Doctor)</h3>
                <p className="muted">Authorized clinic administrators can provision new staff access here.</p>
              </div>
            </div>

            <form onSubmit={handleCreateStaff}>
              <div className="grid3" style={{ gap: '14px', marginBottom: '14px' }}>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Role *</label>
                  <select
                    value={newStaff.role}
                    onChange={(e) => setNewStaff({ ...newStaff, role: e.target.value })}
                  >
                    <option value="admin">Administrator (Full Admin Access)</option>
                    <option value="doctor">Doctor (Consultation Desk & EHR)</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Full Name *</label>
                  <input
                    required
                    placeholder="e.g. Dr. John Doe / Clinic Manager"
                    value={newStaff.name}
                    onChange={(e) => setNewStaff({ ...newStaff, name: e.target.value })}
                  />
                </div>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Login Email *</label>
                  <input
                    type="email"
                    required
                    placeholder="e.g. staff@hepzibaclinic.com"
                    value={newStaff.email}
                    onChange={(e) => setNewStaff({ ...newStaff, email: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid3" style={{ gap: '14px', marginBottom: '14px' }}>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 600 }}>Password (min 8 chars) *</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    placeholder="Set strong password"
                    value={newStaff.password}
                    onChange={(e) => setNewStaff({ ...newStaff, password: e.target.value })}
                  />
                </div>
                {newStaff.role === 'doctor' && (
                  <>
                    <div>
                      <label style={{ fontSize: '13px', fontWeight: 600 }}>Specialty</label>
                      <input
                        placeholder="e.g. Pulmonologist & Bronchoscopist"
                        value={newStaff.specialty}
                        onChange={(e) => setNewStaff({ ...newStaff, specialty: e.target.value })}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: '13px', fontWeight: 600 }}>Contact Phone</label>
                      <input
                        placeholder="e.g. 9500907968"
                        value={newStaff.phone}
                        onChange={(e) => setNewStaff({ ...newStaff, phone: e.target.value })}
                      />
                    </div>
                  </>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="submit" className="primaryBtn" disabled={creatingStaff}>
                  {creatingStaff ? 'Creating Account…' : `Create ${newStaff.role === 'admin' ? 'Admin' : 'Doctor'} Account`}
                </button>
              </div>
            </form>
          </section>

          <ClinicHoursSettings />
        </div>
      )}


      {/* Modals */}
      {bookingPatient && (
        <AdminBookingModal
          patient={bookingPatient}
          onClose={() => setBookingPatient(null)}
          onSuccess={(token) => {
            setBookingPatient(null);
            setSuccessMsg(`Appointment successfully scheduled! Token #${token} allocated.`);
            load();
          }}
        />
      )}

      {ehrPatient && (
        <EHRModal
          patient={ehrPatient}
          onClose={() => setEhrPatient(null)}
        />
      )}
    </div>
  );
}
