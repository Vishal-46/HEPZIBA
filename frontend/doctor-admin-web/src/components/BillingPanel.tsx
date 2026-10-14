import React, { useState, useEffect, useMemo } from 'react';
import apiClient, { apiErrorMessage } from '../utils/apiClient';
import type { Invoice, InvoiceItem, Patient } from '../types';
import { formatDate } from '../utils/format';
import { printInvoice } from '../utils/invoicePrint';
import { SearchInput, Pager, LoadingState, EmptyState } from './ListControls';

interface Props {
  initialPatient?: Patient | null;
  onClearInitialPatient?: () => void;
}

const DEFAULT_DOCTOR = 'Dr. T. Joseph Pratheeban, DCH, MD (Respiratory Medicine)';
const PAGE_SIZE = 8;

const blankItem = (): InvoiceItem => ({
  medicine_name: '',
  expiry_date: '',
  unit: 'tabs',
  mrp: '0',
  quantity: '1',
  total: '0',
});

export default function BillingPanel({ initialPatient, onClearInitialPatient }: Props) {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);

  // Bill creation form
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(initialPatient || null);
  const [patientSearch, setPatientSearch] = useState('');
  const [patientResults, setPatientResults] = useState<Patient[]>([]);
  const [doctorName, setDoctorName] = useState(DEFAULT_DOCTOR);
  const [invoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [items, setItems] = useState<InvoiceItem[]>([blankItem()]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (initialPatient) {
      setSelectedPatient(initialPatient);
    }
  }, [initialPatient]);

  const loadInvoices = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiClient.get<Invoice[]>('/billing/invoices');
      setInvoices(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to load invoices'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInvoices();
  }, []);

  // Search patients for billing
  const searchPatients = async (q: string) => {
    setPatientSearch(q);
    if (!q.trim()) {
      setPatientResults([]);
      return;
    }
    try {
      const res = await apiClient.get<Patient[]>('/patients', { params: { q } });
      setPatientResults(Array.isArray(res.data) ? res.data : []);
    } catch {
      setPatientResults([]);
    }
  };

  const addItemRow = () => {
    setItems((prev) => [...prev, blankItem()]);
  };

  const removeItemRow = (index: number) => {
    setItems((prev) => prev.filter((_, idx) => idx !== index));
  };

  const updateItem = (index: number, field: keyof InvoiceItem, value: string) => {
    setItems((prev) =>
      prev.map((item, idx) => {
        if (idx !== index) return item;
        const updated = { ...item, [field]: value };
        if (field === 'mrp' || field === 'quantity') {
          const mrp = Number(field === 'mrp' ? value : updated.mrp) || 0;
          const qty = Number(field === 'quantity' ? value : updated.quantity) || 0;
          updated.total = (mrp * qty).toFixed(2);
        }
        return updated;
      })
    );
  };

  const grandTotal = useMemo(() => {
    return items
      .reduce((sum, item) => sum + (Number(item.total) || 0), 0)
      .toFixed(2);
  }, [items]);

  const handleGenerateInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPatient) {
      setError('Please select a patient for this bill.');
      return;
    }
    const validItems = items.filter((i) => i.medicine_name.trim() !== '');
    if (!validItems.length) {
      setError('At least one medicine or service line item is required.');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      const payload = {
        patient_id: selectedPatient.id || selectedPatient.patient_id,
        doctor_name: doctorName,
        items: validItems.map((item) => ({
          medicine_name: item.medicine_name.trim(),
          expiry_date: item.expiry_date || null,
          unit: item.unit || 'pcs',
          mrp: Number(item.mrp) || 0,
          quantity: Number(item.quantity) || 1,
          total: Number(item.total) || 0,
        })),
      };

      const res = await apiClient.post('/billing/invoices', payload);
      const invoiceId = res.data?.invoice_id;

      // Construct invoice object for printing
      const createdInvoice: Invoice = {
        id: invoiceId,
        patient_id: selectedPatient.id,
        patient_name: selectedPatient.name,
        patient_code: selectedPatient.patient_code,
        patient_age: selectedPatient.age ? Number(selectedPatient.age) : undefined,
        patient_sex: selectedPatient.sex,
        patient_mobile: selectedPatient.mobile,
        doctor_name: doctorName,
        invoice_date: new Date().toISOString(),
        total_amount: grandTotal,
        items: validItems,
      };

      setSuccess(`Invoice #${invoiceId} generated successfully!`);
      // Automatically prompt to print
      printInvoice(createdInvoice);

      // Reset form
      setItems([blankItem()]);
      setSelectedPatient(null);
      if (onClearInitialPatient) onClearInitialPatient();
      loadInvoices();
    } catch (err) {
      setError(apiErrorMessage(err, 'Failed to create invoice'));
    } finally {
      setSubmitting(false);
    }
  };

  // Filter invoices for table
  const filteredInvoices = useMemo(() => {
    if (!searchQuery.trim()) return invoices;
    const q = searchQuery.toLowerCase();
    return invoices.filter(
      (inv) =>
        String(inv.id).includes(q) ||
        (inv.patient_name && inv.patient_name.toLowerCase().includes(q)) ||
        (inv.patient_code && inv.patient_code.toLowerCase().includes(q))
    );
  }, [invoices, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredInvoices.length / PAGE_SIZE));
  const currentInvoices = filteredInvoices.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="stack">
      <div className="sectionTop">
        <div>
          <h2>Billing & Invoicing</h2>
          <p className="muted">Generate bills, track medicine sales/procedures, and print patient receipts.</p>
        </div>
        <button className="ghostBtn" onClick={loadInvoices} disabled={loading}>
          Refresh Invoices
        </button>
      </div>

      {error && <p className="errorText" role="alert">{error}</p>}
      {success && <p className="infoText" role="status">{success}</p>}

      {/* Invoice Generator Card */}
      <section className="card" style={{ borderTop: '4px solid #0056b3' }}>
        <h3>Create New Invoice / Bill</h3>
        <form onSubmit={handleGenerateInvoice}>
          {/* Header defaults */}
          <div className="grid3" style={{ gap: '16px', marginBottom: '16px', background: '#f8fafc', padding: '14px', borderRadius: '8px' }}>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Doctor Name (Default)</label>
              <input
                value={doctorName}
                onChange={(e) => setDoctorName(e.target.value)}
                required
              />
            </div>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Invoice Date (Default)</label>
              <input value={invoiceDate} readOnly style={{ background: '#e2e8f0' }} />
            </div>
            <div>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569' }}>Patient Identification *</label>
              {selectedPatient ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: '#e0f2fe', borderRadius: '6px', border: '1px solid #7dd3fc' }}>
                  <div>
                    <strong>{selectedPatient.name}</strong> ({selectedPatient.patient_code || `HEP-${selectedPatient.id}`})
                    <div style={{ fontSize: '11px', color: '#0369a1' }}>
                      {selectedPatient.age ? `${selectedPatient.age} yrs` : ''} {selectedPatient.sex ? `· ${selectedPatient.sex}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ghostBtn"
                    style={{ padding: '2px 6px', fontSize: '11px' }}
                    onClick={() => {
                      setSelectedPatient(null);
                      if (onClearInitialPatient) onClearInitialPatient();
                    }}
                  >
                    Change
                  </button>
                </div>
              ) : (
                <div style={{ position: 'relative' }}>
                  <input
                    placeholder="Search patient name, phone, or ID…"
                    value={patientSearch}
                    onChange={(e) => searchPatients(e.target.value)}
                  />
                  {patientResults.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'white', border: '1px solid #cbd5e1', borderRadius: '6px', maxHeight: '180px', overflowY: 'auto', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                      {patientResults.map((p) => (
                        <div
                          key={p.id}
                          style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9' }}
                          onClick={() => {
                            setSelectedPatient(p);
                            setPatientSearch('');
                            setPatientResults([]);
                          }}
                        >
                          <strong>{p.name}</strong> ({p.patient_code || `HEP-${p.id}`}) · {p.mobile || 'No phone'}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Line items table */}
          <div style={{ overflowX: 'auto', marginBottom: '16px' }}>
            <table className="dataTable">
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>Sl.No</th>
                  <th>Medicine / Service Name *</th>
                  <th style={{ width: '130px' }}>Exp. Date</th>
                  <th style={{ width: '90px' }}>Unit</th>
                  <th style={{ width: '100px' }}>MRP (₹)</th>
                  <th style={{ width: '80px' }}>Qty</th>
                  <th style={{ width: '110px' }}>Total (₹)</th>
                  <th style={{ width: '40px' }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => (
                  <tr key={idx}>
                    <td style={{ textAlign: 'center', fontWeight: 'bold' }}>{idx + 1}</td>
                    <td>
                      <input
                        placeholder="e.g. Paracetamol 650mg / Spirometry"
                        value={item.medicine_name}
                        onChange={(e) => updateItem(idx, 'medicine_name', e.target.value)}
                        required
                      />
                    </td>
                    <td>
                      <input
                        type="date"
                        value={item.expiry_date || ''}
                        onChange={(e) => updateItem(idx, 'expiry_date', e.target.value)}
                      />
                    </td>
                    <td>
                      <select
                        value={item.unit || 'tabs'}
                        onChange={(e) => updateItem(idx, 'unit', e.target.value)}
                      >
                        <option value="tabs">tabs</option>
                        <option value="caps">caps</option>
                        <option value="syrup">syrup</option>
                        <option value="inhaler">inhaler</option>
                        <option value="respules">respules</option>
                        <option value="test">test</option>
                        <option value="pcs">pcs</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={item.mrp}
                        onChange={(e) => updateItem(idx, 'mrp', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={(e) => updateItem(idx, 'quantity', e.target.value)}
                      />
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      ₹{item.total}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {items.length > 1 && (
                        <button
                          type="button"
                          className="ghostBtn"
                          style={{ color: '#dc2626', padding: '2px 6px' }}
                          onClick={() => removeItemRow(idx)}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <button type="button" className="ghostBtn" onClick={addItemRow}>
              + Add Medicine Row
            </button>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#0056b3' }}>
              Grand Total: ₹{grandTotal}
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
            <button
              type="button"
              className="ghostBtn"
              onClick={() => {
                if (selectedPatient) {
                  printInvoice({
                    id: 0,
                    patient_id: selectedPatient.id,
                    patient_name: selectedPatient.name,
                    patient_code: selectedPatient.patient_code,
                    patient_age: selectedPatient.age ? Number(selectedPatient.age) : undefined,
                    patient_sex: selectedPatient.sex,
                    patient_mobile: selectedPatient.mobile,
                    doctor_name: doctorName,
                    invoice_date: new Date().toISOString(),
                    total_amount: grandTotal,
                    items: items.filter((i) => i.medicine_name.trim() !== ''),
                  });
                }
              }}
              disabled={!selectedPatient}
            >
              Preview Print
            </button>
            <button type="submit" className="primaryBtn" disabled={submitting}>
              {submitting ? 'Generating…' : 'Generate & Print Invoice'}
            </button>
          </div>
        </form>
      </section>

      {/* Invoices History Table */}
      <section className="card">
        <h3>Invoice History & Receipts</h3>
        <div style={{ marginBottom: '16px' }}>
          <SearchInput
            query={searchQuery}
            onQuery={(q) => {
              setSearchQuery(q);
              setPage(1);
            }}
            label="Search invoices by patient name, ID, or bill #…"
          />
        </div>

        {loading ? (
          <LoadingState message="Loading invoices..." />
        ) : filteredInvoices.length === 0 ? (
          <EmptyState message="No invoices recorded yet." />
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="dataTable">
                <thead>
                  <tr>
                    <th>Invoice #</th>
                    <th>Date</th>
                    <th>Patient</th>
                    <th>Doctor</th>
                    <th>Total Items</th>
                    <th>Amount (₹)</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {currentInvoices.map((inv) => (
                    <tr key={inv.id}>
                      <td><strong>#{inv.id}</strong></td>
                      <td>{formatDate(inv.invoice_date)}</td>
                      <td>
                        <strong>{inv.patient_name || 'Walk-in'}</strong>
                        {inv.patient_code && <span className="muted"> ({inv.patient_code})</span>}
                      </td>
                      <td>{inv.doctor_name || DEFAULT_DOCTOR}</td>
                      <td>{inv.items?.length || 0} items</td>
                      <td><strong>₹{Number(inv.total_amount).toFixed(2)}</strong></td>
                      <td>
                        <button
                          className="primaryBtn"
                          style={{ padding: '4px 10px', fontSize: '12px' }}
                          onClick={() => printInvoice(inv)}
                        >
                          Print Bill
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pager
              page={page}
              totalPages={totalPages}
              onPage={setPage}
              total={filteredInvoices.length}
              label="Invoices"
            />
          </>
        )}
      </section>
    </div>
  );
}
