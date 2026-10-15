import { useEffect, useMemo, useState } from 'react';
import { useAdminData } from '../hooks/useAdminData';
import type { Patient } from '../types';
import { formatDate } from '../utils/format';
import apiClient from '../utils/apiClient';
import { printInvoice } from '../utils/invoicePrint';
import AdminBookingModal from './AdminBookingModal';
import ClinicHoursSettings from './ClinicHoursSettings';
import EHRModal from './EHRModal';
import PatientManagement from './PatientManagement';
import { EmptyState, LoadingState } from './ListControls';

type View = 'queue' | 'accounts' | 'inventory' | 'billing' | 'settings';
type AcctTab = 'doctors' | 'admins' | 'patients';

export default function AdminPanel() {
  const {
    users, patients, appointments, inventory, invoices,
    loading, error, setError, load,
    createInventoryItem, updateInventoryItem,
    toggleUserActive, createStaff, updateAppointment, createInvoice, updateInvoiceStatus,
  } = useAdminData();

  const [view, setView] = useState<View>('queue');
  const [queueFilter, setQueueFilter] = useState<'pending' | 'today' | 'all'>('pending');
  const [queueQuery, setQueueQuery] = useState('');
  const [acctTab, setAcctTab] = useState<AcctTab>('doctors');
  const [acctQuery, setAcctQuery] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [invQuery, setInvQuery] = useState('');
  const [busy, setBusy] = useState('');

  // per-appointment message draft (notes → visible to patient in mobile app)
  const [msgDrafts, setMsgDrafts] = useState<Record<number, string>>({});
  // staff form
  const [staff, setStaff] = useState({ name: '', email: '', password: '', role: 'doctor' as 'doctor' | 'admin' });
  // inventory add (reorder threshold is automatic — not asked)
  const [newItem, setNewItem] = useState({ name: '', stock: '', unit: 'strips', mrp: '', expiry: '', category: '' });
  // restock picker
  const [restockQuery, setRestockQuery] = useState('');
  const [restockId, setRestockId] = useState<number | null>(null);
  const [restockQty, setRestockQty] = useState('10');
  // billing picker
  const [billQuery, setBillQuery] = useState('');
  const [billPatientId, setBillPatientId] = useState<number | null>(null);
  const [billApptId, setBillApptId] = useState('');
  const [billLines, setBillLines] = useState([{ medicine_name: '', quantity: '1', mrp: '' }]);
  const [linePick, setLinePick] = useState<number | null>(null);
  const [docFee, setDocFee] = useState('');
  // walk-in booking + EHR viewer + action feedback
  const [bookingPatient, setBookingPatient] = useState<Patient | null>(null);
  const [ehrPatient, setEhrPatient] = useState<Patient | null>(null);
  const [notice, setNotice] = useState('');

  const UNIT_OPTIONS = ['strips', 'tablets', 'bottles', 'pcs', 'tubes', 'vials'];

  useEffect(() => {
    load();
  }, [load]);

  // Live queue: re-check for new patient bookings by itself every 15s while
  // the queue is open (paused when the tab is hidden to save battery/data).
  const [lastSync, setLastSync] = useState<Date | null>(null);
  useEffect(() => {
    if (view !== 'queue') return;
    setLastSync(new Date());
    const id = setInterval(() => {
      if (document.hidden) return;
      load().then(() => setLastSync(new Date())).catch(() => {});
    }, 15000);
    return () => clearInterval(id);
  }, [view, load]);

  const ACCEPT_DEFAULT =
    'Your request is accepted. Please be at the clinic 10 minutes before your scheduled time.';

  // Prefill the message box with the default accept text for pending visits.
  useEffect(() => {
    setMsgDrafts((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const a of appointments) {
        if (a.status === 'pending' && !(a.id in next)) {
          next[a.id] = ACCEPT_DEFAULT;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [appointments]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy('');
    }
  };

  const todayStr = new Date().toDateString();
  const pendingCount = appointments.filter((a) => a.status === 'pending').length;
  const todayCount = appointments.filter((a) => {
    const s = String(a.scheduled_at_effective ?? a.scheduled_at ?? '');
    return s && new Date(s).toDateString() === todayStr;
  }).length;
  const lowStock = inventory.filter((i) => i.stock <= i.reorder_level);

  const queue = useMemo(() => {
    const q = queueQuery.trim().toLowerCase();
    return appointments
      .filter((a) => {
        if (queueFilter === 'pending' && a.status !== 'pending') return false;
        if (queueFilter === 'today') {
          const s = String(a.scheduled_at_effective ?? a.scheduled_at ?? '');
          if (!s || new Date(s).toDateString() !== todayStr) return false;
        }
        if (!q) return true;
        return [String(a.patient_name ?? ''), String(a.patient_code ?? ''), String(a.id), String(a.mobile ?? '')]
          .join(' ').toLowerCase().includes(q);
      })
      .sort((x, y) => {
        const px = x.status === 'pending' ? 0 : 1;
        const py = y.status === 'pending' ? 0 : 1;
        if (px !== py) return px - py;
        return +new Date(String(y.scheduled_at_effective ?? y.scheduled_at ?? 0)) - +new Date(String(x.scheduled_at_effective ?? x.scheduled_at ?? 0));
      });
  }, [appointments, queueFilter, queueQuery, todayStr]);

  const doctors = users.filter((u) => u.role === 'doctor');
  const admins = users.filter((u) => u.role === 'admin');
  const acctRows = useMemo(() => {
    const q = acctQuery.trim().toLowerCase();
    if (acctTab === 'patients') {
      return patients.filter((p) => !q || [p.name, p.email, p.patient_code, p.mobile].join(' ').toLowerCase().includes(q));
    }
    const list = acctTab === 'doctors' ? doctors : admins;
    return list.filter((u) => !q || [u.name, u.email].join(' ').toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acctTab, acctQuery, users, patients]);

  const invRows = useMemo(() => {
    const q = invQuery.trim().toLowerCase();
    return inventory.filter((i) => {
      if (lowOnly && i.stock > i.reorder_level) return false;
      return !q || `${i.name} ${i.unit}`.toLowerCase().includes(q);
    });
  }, [inventory, invQuery, lowOnly]);

  const billPatient = patients.find((p) => p.patient_id === billPatientId) ?? null;
  const billMatches = useMemo(() => {
    const q = billQuery.trim().toLowerCase();
    if (!q) return [];
    return patients
      .filter((p) => [p.name, p.patient_code, p.mobile, p.email].join(' ').toLowerCase().includes(q))
      .slice(0, 6);
  }, [billQuery, patients]);
  const patientAppts = useMemo(
    () => (billPatientId ? appointments.filter((a) => Number(a.patient_id) === billPatientId) : []),
    [appointments, billPatientId],
  );
  const billTotal = useMemo(() => {
    let cents = 0;
    for (const l of billLines) cents += Math.round((Number(l.mrp) || 0) * 100) * (Number(l.quantity) || 0);
    return (cents / 100).toFixed(2);
  }, [billLines]);

  const billGrand = useMemo(() => {
    const feeCents = Math.round((Number(docFee) || 0) * 100);
    const medCents = Math.round(Number(billTotal) * 100);
    return ((medCents + feeCents) / 100).toFixed(2);
  }, [billTotal, docFee]);

  return (
    <div className="adminShell">
      <aside className="adminSide" aria-label="Admin navigation">
        <div className="adminBrand">
          <strong>Hepziba Admin</strong>
          <span>Chest Clinic · Nagercoil</span>
        </div>
        <nav className="adminNav">
          <button className={`adminNavBtn ${view === 'queue' ? 'active' : ''}`} onClick={() => setView('queue')}>
            Queue {pendingCount > 0 && <span className="count">{pendingCount}</span>}
          </button>
          <button className={`adminNavBtn ${view === 'accounts' ? 'active' : ''}`} onClick={() => setView('accounts')}>Accounts</button>
          <button className={`adminNavBtn ${view === 'inventory' ? 'active' : ''}`} onClick={() => setView('inventory')}>
            Inventory {lowStock.length > 0 && <span className="count">{lowStock.length}</span>}
          </button>
          <button className={`adminNavBtn ${view === 'billing' ? 'active' : ''}`} onClick={() => setView('billing')}>Billing</button>
          <button className={`adminNavBtn ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>Hours</button>
        </nav>
        <button className="ghostBtn" style={{ marginTop: 12 }} onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh data'}
        </button>
      </aside>

      <div className="adminMain">
        {error && <p className="errorText" role="alert">{error}</p>}
        {loading && <LoadingState message="Loading clinic data…" />}

        {!loading && view === 'queue' && (
          <>
            <div className="kpiRow">
              <div className="kpi warn"><span>Needs decision</span><strong>{pendingCount}</strong></div>
              <div className="kpi"><span>Today</span><strong>{todayCount}</strong></div>
              <div className="kpi"><span>Total appts</span><strong>{appointments.length}</strong></div>
              <div className="kpi"><span>Patients</span><strong>{patients.length}</strong></div>
            </div>

            <section className="card" aria-label="Appointment queue">
              <div className="sectionTop">
                <div>
                  <h2>Appointment queue {queueFilter === 'pending' && pendingCount > 0 && <span className="liveDot" title="Live — checking for new bookings">● Live</span>}</h2>
                  <p className="muted">
                    New mobile bookings land here. Accept, decline, or message the patient.
                    {lastSync ? ` Last checked ${lastSync.toLocaleTimeString()}.` : ''}
                  </p>
                </div>
              </div>
              <div className="listToolbar">
                <div className="segRow" role="tablist" aria-label="Queue filter">
                  {(['pending', 'today', 'all'] as const).map((f) => (
                    <button key={f} role="tab" aria-selected={queueFilter === f}
                      className={`segBtn ${queueFilter === f ? 'active' : ''}`} onClick={() => setQueueFilter(f)}>
                      {f[0].toUpperCase() + f.slice(1)}
                    </button>
                  ))}
                </div>
                <label className="searchField">
                  <input placeholder="Search name, code, mobile…" value={queueQuery} onChange={(e) => setQueueQuery(e.target.value)} aria-label="Search queue" />
                </label>
              </div>

              {queue.length === 0 ? (
                <EmptyState message={appointments.length === 0 ? 'No appointments yet — patient bookings from the mobile app will appear here.' : 'Queue is clear.'} />
              ) : (
                queue.slice(0, 30).map((a) => (
                  <article key={a.id} className={`queueCard ${a.status === 'pending' ? 'urgent' : ''}`}>
                    <div className="queueTop">
                      <div>
                        <p className="queueName">{String(a.patient_name ?? 'Patient')} <span className="muted">#{a.id}</span></p>
                        <p className="queueSub">
                          {a.patient_code ? `${String(a.patient_code)} · ` : ''}
                          {a.mobile ? `${String(a.mobile)} · ` : ''}
                          {formatDate(String(a.scheduled_at_effective ?? a.scheduled_at ?? ''))}
                          {a.token_number ? ` · Token ${String(a.token_number)}` : ''}
                        </p>
                        {a.reason ? <p className="queueSub">Reason: {String(a.reason)}</p> : null}
                        {typeof a.notes === 'string' && a.notes ? (
                          <div className="queueNote" aria-label="Visit note">
                            <span className="queueNoteTag">Note</span>
                            <p>{a.notes}</p>
                          </div>
                        ) : null}
                      </div>
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                        <span className={`pill status ${String(a.status || 'pending')}`}>{String(a.status || 'pending')}</span>
                        {(() => {
                          const s = String(a.scheduled_at_effective ?? a.scheduled_at ?? '');
                          return s && new Date(s).toDateString() === todayStr ? (
                            <span className="pill status confirmed">Today</span>
                          ) : null;
                        })()}
                      </span>
                    </div>
                    <div className="queueActions">
                      {a.status === 'pending' && (
                        <>
                          <button className="acceptBtn" disabled={!!busy}
                            onClick={() => run(`accept-${a.id}`, () => updateAppointment(a.id, { status: 'confirmed', notes: msgDrafts[a.id] || undefined }))}>
                            Accept
                          </button>
                          <button className="declineBtn" disabled={!!busy}
                            onClick={() => run(`decline-${a.id}`, () => updateAppointment(a.id, { status: 'cancelled', notes: msgDrafts[a.id] || undefined }))}>
                            Decline
                          </button>
                        </>
                      )}
                      {a.status === 'confirmed' && (
                        <button className="doneBtn" disabled={!!busy}
                          onClick={() => run(`done-${a.id}`, () => updateAppointment(a.id, { status: 'done' }))}>
                          Mark done
                        </button>
                      )}
                      {Number(a.patient_id) > 0 && (
                        <button className="ghostBtn" disabled={!!busy}
                          onClick={() => setEhrPatient({
                            id: Number(a.patient_id),
                            name: String(a.patient_name ?? 'Patient'),
                            patient_code: typeof a.patient_code === 'string' ? a.patient_code : undefined,
                            mobile: typeof a.mobile === 'string' ? a.mobile : undefined,
                          })}>
                          Record
                        </button>
                      )}
                    </div>
                    <textarea className="msgBox" rows={2} placeholder="Message to patient (saved as visit note, visible in their app)…"
                      value={msgDrafts[a.id] ?? (typeof a.notes === 'string' ? a.notes : '')}
                      onChange={(e) => setMsgDrafts((p) => ({ ...p, [a.id]: e.target.value }))} aria-label={`Message for appointment ${a.id}`} />
                    <div className="queueActions">
                      <button className="ghostBtn" disabled={!!busy}
                        onClick={() => run(`msg-${a.id}`, () => updateAppointment(a.id, { notes: msgDrafts[a.id] ?? '' }))}>
                        {busy === `msg-${a.id}` ? 'Sending…' : 'Send message'}
                      </button>
                    </div>
                  </article>
                ))
              )}
            </section>
          </>
        )}

        {!loading && view === 'accounts' && (
          <section className="card" aria-label="Accounts">
            <h2>Accounts</h2>
            <p className="muted">Doctors and admins sign in here. Patients are read-only.</p>
            <div className="listToolbar">
              <div className="segRow" role="tablist" aria-label="Account type">
                {(['doctors', 'admins', 'patients'] as AcctTab[]).map((t) => (
                  <button key={t} role="tab" aria-selected={acctTab === t}
                    className={`segBtn ${acctTab === t ? 'active' : ''}`} onClick={() => setAcctTab(t)}>
                    {t[0].toUpperCase() + t.slice(1)} ({t === 'doctors' ? doctors.length : t === 'admins' ? admins.length : patients.length})
                  </button>
                ))}
              </div>
              <label className="searchField">
                <input placeholder={acctTab === 'patients' ? 'Search name, code, mobile…' : 'Search name, email…'}
                  value={acctQuery} onChange={(e) => setAcctQuery(e.target.value)} aria-label="Search accounts" />
              </label>
            </div>

            {acctTab !== 'patients' && (
              <div className="formRow" style={{ marginBottom: 14 }}>
                <input placeholder="Full name" aria-label="Staff name" value={staff.name} onChange={(e) => setStaff((p) => ({ ...p, name: e.target.value }))} />
                <input placeholder="Work email" type="email" aria-label="Staff email" value={staff.email} onChange={(e) => setStaff((p) => ({ ...p, email: e.target.value }))} />
                <input placeholder="Password (min 8)" type="password" aria-label="Staff password" value={staff.password} onChange={(e) => setStaff((p) => ({ ...p, password: e.target.value }))} />
                <label className="fieldLabel">Role
                  <select className="proSelect" aria-label="Staff role" value={staff.role} onChange={(e) => setStaff((p) => ({ ...p, role: e.target.value as 'doctor' | 'admin' }))}>
                    <option value="doctor">Doctor</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
                <button className="primaryBtn" disabled={busy === 'staff-create'}
                  onClick={() => run('staff-create', async () => {
                    if (!staff.name.trim() || !staff.email.trim() || staff.password.length < 8) throw new Error('Name, valid email and 8+ character password required.');
                    await createStaff({ name: staff.name.trim(), email: staff.email.trim().toLowerCase(), password: staff.password, role: staff.role });
                    setStaff({ name: '', email: '', password: '', role: 'doctor' });
                    setAcctTab(staff.role === 'admin' ? 'admins' : 'doctors');
                  })}>
                  {busy === 'staff-create' ? 'Creating…' : `Create ${staff.role}`}
                </button>
              </div>
            )}

            {acctTab === 'patients' ? (
              <PatientManagement
                onSelectPatientForBilling={(p) => {
                  setView('billing');
                  setBillPatientId(p.patient_id ?? p.id ?? null);
                  setBillQuery('');
                  setBillApptId('');
                  setNotice('');
                }}
                onSelectPatientForAppointment={(p) => setBookingPatient(p)}
                onViewEHR={(p) => setEhrPatient(p)}
              />
            ) : acctRows.length === 0 ? (
              <EmptyState message="No accounts in this group yet." />
            ) : (
              (acctRows as Array<Record<string, unknown>>).slice(0, 40).map((r, idx) => {
                const u = r as unknown as { id: number; name: string; email?: string; role: string; active?: boolean };
                return (
                  <div key={u.id ?? idx} className="acctRow">
                    <div className="who">
                      <strong>{u.name}<span className={`roleTag ${u.role}`}>{u.role}</span></strong>
                      <span>{u.email}{u.active === false ? ' · deactivated' : ''}</span>
                    </div>
                    <button className="ghostBtn" disabled={!!busy}
                      onClick={() => run(`u-${u.id}`, () => toggleUserActive(u.id, !(u.active !== false)))}>
                      {u.active === false ? 'Reactivate' : 'Deactivate'}
                    </button>
                  </div>
                );
              })
            )}
          </section>
        )}

        {!loading && view === 'inventory' && (
          <>
            <div className="kpiRow">
              <div className="kpi"><span>Items</span><strong>{inventory.length}</strong></div>
              <div className="kpi warn"><span>Low stock</span><strong>{lowStock.length}</strong></div>
            </div>
            <section className="card" aria-label="Restock">
              <h3>Restock</h3>
              <p className="muted">Pick an item, enter the received quantity — stock goes up immediately.</p>
              <div style={{ marginTop: 10 }}>
                {restockId ? (
                  <p>
                    <span className="chosenChip">
                      {inventory.find((i) => i.id === restockId)?.name ?? 'Item'}
                      <button onClick={() => { setRestockId(null); setRestockQuery(''); }}>change</button>
                    </span>
                  </p>
                ) : (
                  <label className="fieldLabel">Item
                    <input placeholder="Type medicine name…" value={restockQuery}
                      onChange={(e) => setRestockQuery(e.target.value)} aria-label="Find item to restock" />
                  </label>
                )}
                {!restockId && restockQuery.trim() && (
                  <div className="pickList" role="listbox" aria-label="Matching stock">
                    {inventory
                      .filter((i) => `${i.name}`.toLowerCase().includes(restockQuery.trim().toLowerCase()))
                      .slice(0, 6)
                      .map((i) => (
                        <button key={i.id} className="pickItem" role="option" aria-selected="false"
                          onClick={() => { setRestockId(i.id); setRestockQuery(''); }}>
                          <span className="pickCheck">✓</span>
                          <span><span className="pickMain">{i.name}</span><br /><span className="pickSub">have {i.stock} {i.unit}</span></span>
                        </button>
                      ))}
                  </div>
                )}
                <div className="formRow" style={{ marginTop: 10 }}>
                  <input placeholder="Qty received" aria-label="Restock quantity" inputMode="numeric"
                    value={restockQty} onChange={(e) => setRestockQty(e.target.value)} />
                  <button className="primaryBtn" disabled={busy === 'restock' || !restockId}
                    onClick={() => run('restock', async () => {
                      const q = Number(restockQty);
                      if (!restockId || !Number.isInteger(q) || q < 1) throw new Error('Pick an item and enter a quantity of 1 or more.');
                      await updateInventoryItem(restockId, { restock: q });
                      setRestockId(null); setRestockQuery(''); setRestockQty('10');
                    })}>
                    {busy === 'restock' ? 'Restocking…' : 'Restock'}
                  </button>
                </div>
              </div>
            </section>
            <section className="card" aria-label="Inventory">
              <div className="sectionTop">
                <div>
                  <h2>Stock on hand</h2>
                  <p className="muted">Tap − / + for quick counts. Selling on an invoice reduces stock automatically.</p>
                </div>
              </div>
              <div className="listToolbar">
                <label className="searchField">
                  <input placeholder="Search items…" value={invQuery} onChange={(e) => setInvQuery(e.target.value)} aria-label="Search inventory" />
                </label>
                <label className="checkRow"><input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Low only</label>
              </div>
              {invRows.length === 0 ? (
                <EmptyState message={inventory.length === 0 ? 'No items yet — add the first one below.' : 'No items match.'} />
              ) : (
                invRows.slice(0, 40).map((i) => (
                  <div key={i.id} className="acctRow">
                    <div className="who">
                      <strong>{i.name} {i.stock <= i.reorder_level && <span className="pill status cancelled">Low</span>}</strong>
                      <span>
                        {i.unit}{i.mrp ? ` · ₹${String(i.mrp)}` : ''}{i.expiry_date ? ` · exp ${String(i.expiry_date).slice(0, 7)}` : ''}
                      </span>
                    </div>
                    <div className="stepper" aria-label={`${i.name} stock`}>
                      <button disabled={!!busy} aria-label="Decrease stock"
                        onClick={() => run(`inv-${i.id}-dec`, () => updateInventoryItem(i.id, { stock: Math.max(0, i.stock - 1) }))}>−</button>
                      <strong>{i.stock}</strong>
                      <button disabled={!!busy} aria-label="Increase stock"
                        onClick={() => run(`inv-${i.id}-inc`, () => updateInventoryItem(i.id, { stock: i.stock + 1 }))}>+</button>
                    </div>
                  </div>
                ))
              )}
            </section>
            <section className="card" aria-label="Add item">
              <h3>Add item</h3>
              <div className="formRow">
                <input placeholder="Name (e.g. Dolo 650)" aria-label="Item name" value={newItem.name} onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))} />
                <input placeholder="Opening stock" aria-label="Opening stock" inputMode="numeric" value={newItem.stock} onChange={(e) => setNewItem((p) => ({ ...p, stock: e.target.value }))} />
                <label className="fieldLabel">Unit
                  <select className="proSelect" aria-label="Unit" value={newItem.unit} onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))}>
                    {UNIT_OPTIONS.map((u) => (<option key={u} value={u}>{u}</option>))}
                  </select>
                </label>
                <input placeholder="MRP ₹" aria-label="MRP" inputMode="decimal" value={newItem.mrp} onChange={(e) => setNewItem((p) => ({ ...p, mrp: e.target.value }))} />
                <input type="date" aria-label="Expiry date" value={newItem.expiry} onChange={(e) => setNewItem((p) => ({ ...p, expiry: e.target.value }))} />
                <button className="primaryBtn" disabled={busy === 'inv-add'}
                  onClick={() => run('inv-add', async () => {
                    if (!newItem.name.trim()) throw new Error('Item needs a name.');
                    await createInventoryItem({
                      name: newItem.name.trim(),
                      stock: Number(newItem.stock) || 0,
                      unit: newItem.unit,
                      mrp: newItem.mrp.trim() || undefined,
                      expiry_date: newItem.expiry || undefined,
                    });
                    setNewItem({ name: '', stock: '', unit: 'strips', mrp: '', expiry: '', category: '' });
                  })}>
                  {busy === 'inv-add' ? 'Adding…' : 'Add'}
                </button>
              </div>
            </section>
          </>
        )}

        {!loading && view === 'billing' && (
          <section className="card" aria-label="Billing">
            <h2>Billing</h2>
            <p className="muted">Search and pick the patient — no manual ids. Invoices issued: {invoices.length}.</p>
            <div style={{ marginTop: 12 }}>
              <label>Patient
                <input placeholder="Type name, code (HEP-XXXXX) or mobile…" value={billPatientId ? `${billPatient?.name ?? ''} · ${billPatient?.patient_code ?? ''}` : billQuery}
                  onChange={(e) => { setBillQuery(e.target.value); setBillPatientId(null); }} aria-label="Find patient" />
              </label>
              {!billPatientId && billMatches.length > 0 && (
                <div className="pickList" role="listbox" aria-label="Matching patients">
                  {billMatches.map((p) => (
                    <button key={p.patient_id ?? p.user_id} className="pickItem" role="option" aria-selected="false"
                      onClick={() => { setBillPatientId(p.patient_id); setBillQuery(''); setBillApptId(''); }}>
                      <span className="pickCheck">✓</span>
                      <span>
                        <span className="pickMain">{p.name}</span><br />
                        <span className="pickSub">{p.patient_code ?? 'no code'} · {p.mobile ?? 'no mobile'} · chart #{p.patient_id ?? '—'}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {billPatient && (
                <p style={{ marginTop: 8 }}>
                  <span className="chosenChip">
                    {billPatient.name} · {billPatient.patient_code}
                    <button onClick={() => setBillPatientId(null)}>change</button>
                  </span>
                </p>
              )}
              <label className="fieldLabel" style={{ marginTop: 8 }}>Visit (optional)
                <select className="proSelect" value={billApptId} onChange={(e) => setBillApptId(e.target.value)} aria-label="Appointment">
                  <option value="">Walk-in / no visit</option>
                  {patientAppts.map((a) => (
                    <option key={a.id} value={a.id}>#{a.id} · {formatDate(String(a.scheduled_at_effective ?? a.scheduled_at ?? ''))} · {String(a.status)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ marginTop: 12 }}>
              {billLines.map((l, idx) => {
                const stockOf = (name: string) => {
                  const m = inventory.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
                  return m ? m.stock : null;
                };
                const have = stockOf(l.medicine_name);
                const picking = linePick === idx;
                const lq = (l as { _q?: string })._q ?? l.medicine_name;
                const matches = picking && lq.trim()
                  ? inventory.filter((x) => x.name.toLowerCase().includes(lq.trim().toLowerCase())).slice(0, 6)
                  : [];
                return (
                  <div key={idx} style={{ marginBottom: 10 }}>
                    <div className="formRow">
                      <div style={{ flex: '2 1 200px' }}>
                        <input placeholder="Medicine — type to pick from stock" aria-label={`Line ${idx + 1} medicine`}
                          value={l.medicine_name}
                          onChange={(e) => {
                            const v = e.target.value;
                            setBillLines((p) => p.map((r, i) => (i === idx ? { ...r, medicine_name: v, _q: v } as typeof r & { _q?: string } : r)));
                            setLinePick(idx);
                          }}
                          onFocus={() => setLinePick(idx)} />
                        {have !== null && (
                          <span className={`stockTag ${have === 0 ? 'out' : have <= 5 ? '' : 'ok'}`} style={{ marginTop: 4, display: 'inline-block' }}>
                            {have === 0 ? 'out of stock' : `in stock: ${have}`}
                          </span>
                        )}
                      </div>
                      <input placeholder="Qty" aria-label={`Line ${idx + 1} qty`} inputMode="numeric" value={l.quantity} style={{ maxWidth: 80 }}
                        onChange={(e) => setBillLines((p) => p.map((r, i) => (i === idx ? { ...r, quantity: e.target.value } : r)))} />
                      <input placeholder="MRP ₹" aria-label={`Line ${idx + 1} mrp`} inputMode="decimal" value={l.mrp} style={{ maxWidth: 110 }}
                        onChange={(e) => setBillLines((p) => p.map((r, i) => (i === idx ? { ...r, mrp: e.target.value } : r)))} />
                      <button className="ghostBtn" disabled={billLines.length === 1}
                        onClick={() => { setBillLines((p) => p.filter((_, i) => i !== idx)); setLinePick(null); }}>Remove</button>
                    </div>
                    {picking && matches.length > 0 && (
                      <div className="pickList" role="listbox" aria-label="Matching stock">
                        {matches.map((m) => {
                          const isSel = m.name.toLowerCase() === l.medicine_name.trim().toLowerCase();
                          return (
                            <button key={m.id} className={`pickItem ${isSel ? 'selected' : ''}`} role="option" aria-selected={isSel}
                              onClick={() => {
                                setBillLines((p) => p.map((r, i) => (i === idx
                                  ? { ...r, medicine_name: m.name, mrp: m.mrp ? String(m.mrp) : r.mrp }
                                  : r)));
                                setLinePick(null);
                              }}>
                              <span className="pickCheck">✓</span>
                              <span>
                                <span className="pickMain">{m.name}</span><br />
                                <span className="pickSub">
                                  {m.mrp ? `₹${String(m.mrp)} · ` : ''}{m.stock} {m.unit} in stock
                                  {Number(l.quantity) > m.stock ? ' — not enough!' : ''}
                                </span>
                              </span>
                              <span className={`stockTag ${m.stock === 0 ? 'out' : 'ok'}`} style={{ marginLeft: 'auto' }}>
                                {m.stock === 0 ? 'out' : `${m.stock} left`}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="formRow">
                <button className="ghostBtn" onClick={() => setBillLines((p) => [...p, { medicine_name: '', quantity: '1', mrp: '' }])}>+ Add line</button>
                <label className="fieldLabel">Doctor charge ₹
                  <input placeholder="e.g. 300" aria-label="Doctor charge" inputMode="decimal" value={docFee}
                    onChange={(e) => setDocFee(e.target.value)} style={{ maxWidth: 110 }} />
                </label>
                <span className="muted">Medicines ₹{billTotal} + Doctor ₹{(Number(docFee) || 0).toFixed(2)} = <strong>₹{billGrand}</strong></span>
                <button className="primaryBtn" disabled={busy === 'bill-create' || !billPatientId}
                  onClick={() => run('bill-create', async () => {
                    if (!billPatient) throw new Error('Pick a patient from the search list first.');
                    const items = billLines.map((l) => ({ medicine_name: l.medicine_name.trim(), quantity: Number(l.quantity) || 1, mrp: l.mrp.trim(), unit: 'strip' }));
                    if (items.some((x) => !x.medicine_name || !x.mrp)) throw new Error('Every line needs a name and MRP.');
                    await createInvoice({
                      patient_id: billPatient.patient_id as number,
                      patient_code: billPatient.patient_code ?? undefined,
                      appointment_id: billApptId ? Number(billApptId) : null,
                      doctor_fee: docFee.trim() || undefined,
                      items,
                    } as never);
                    setBillPatientId(null); setBillQuery(''); setBillApptId(''); setDocFee('');
                    setBillLines([{ medicine_name: '', quantity: '1', mrp: '' }]);
                  })}>
                  {busy === 'bill-create' ? 'Creating…' : 'Create invoice'}
                </button>
              </div>
              {!billPatientId && <p className="formHint">Select a patient above — typing the id by hand is no longer needed.</p>}
            </div>
            <div style={{ marginTop: 14 }}>
              <h3>Recent invoices</h3>
              {invoices.length === 0 ? (
                <EmptyState message="No invoices yet." />
              ) : (
                invoices.slice(0, 20).map((v) => (
                  <div key={v.id} className="acctRow">
                    <div className="who">
                      <strong>#{v.id} · ₹{String(v.total_amount)}</strong>
                      <span>{String(v.patient_name ?? '')} {v.patient_code ? `(${String(v.patient_code)})` : ''} · {v.invoice_date ? formatDate(String(v.invoice_date)) : ''}</span>
                    </div>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span className={`pill status ${String(v.status || 'unpaid') === 'paid' ? 'confirmed' : 'pending'}`}>
                        {String(v.status || 'unpaid')}
                      </span>
                      <button className="ghostBtn" disabled={!!busy}
                        onClick={() => run(`pay-${v.id}`, () => updateInvoiceStatus(v.id, String(v.status) === 'paid' ? 'unpaid' : 'paid'))}>
                        {String(v.status) === 'paid' ? 'Mark unpaid' : 'Mark paid'}
                      </button>
                      <button className="ghostBtn" disabled={!!busy}
                        onClick={() => run(`print-${v.id}`, async () => {
                          const res = await apiClient.get(`/billing/invoices/${v.id}`);
                          printInvoice(res.data);
                        })}>
                        {busy === `print-${v.id}` ? '…' : 'Print'}
                      </button>
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        )}

        {!loading && view === 'settings' && <ClinicHoursSettings />}
        {notice && <p className="infoText" role="status">{notice}</p>}
      </div>
      {bookingPatient && (
        <AdminBookingModal
          patient={bookingPatient}
          onClose={() => setBookingPatient(null)}
          onSuccess={(token) => {
            setBookingPatient(null);
            setNotice(`Visit booked — token ${token}. It now shows in the queue.`);
            load();
          }}
        />
      )}
      {ehrPatient && <EHRModal patient={ehrPatient} onClose={() => setEhrPatient(null)} />}
    </div>
  );
}
