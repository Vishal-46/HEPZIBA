import type { Invoice } from '../types';
import { formatDate, maskAadhaar } from './format';

export function printInvoice(
  invoice: Invoice,
  options?: {
    clinicName?: string;
    doctorName?: string;
    specialty?: string;
    address?: string;
    mobile?: string;
  },
): void {
  const clinic = options?.clinicName || 'HEPZIBA CHEST CLINIC';
  const doctor = options?.doctorName || invoice.doctor_name || 'Dr. T. Joseph Pratheeban, DCH, MD (Respiratory Medicine)';
  const specialty = options?.specialty || 'Pulmonologist & Bronchoscopist';
  const address = options?.address || 'Opposite to WCC Entrance, White House Street, Nagercoil';
  const phone = options?.mobile || '9500907968';

  const rows = (invoice.items || [])
    .map((item, idx) => {
      const exp = item.expiry_date ? formatDate(item.expiry_date).slice(0, 10) : '—';
      const mrp = Number(item.mrp || 0).toFixed(2);
      const total = Number(item.total || 0).toFixed(2);
      return `<tr>
        <td style="text-align:center;">${idx + 1}</td>
        <td><strong>${escapeHtml(item.medicine_name)}</strong></td>
        <td style="text-align:center;">${escapeHtml(exp)}</td>
        <td style="text-align:center;">${escapeHtml(item.unit || 'pcs')}</td>
        <td style="text-align:right;">₹${mrp}</td>
        <td style="text-align:center;">${item.quantity || 1}</td>
        <td style="text-align:right;"><strong>₹${total}</strong></td>
      </tr>`;
    })
    .join('');

  const grandTotal = Number(invoice.total_amount || 0).toFixed(2);
  const win = window.open('', '_blank', 'width=850,height=950');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Invoice #${invoice.id} — ${escapeHtml(clinic)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; padding: 36px; color: #1c242b; line-height: 1.4; }
    .header { border-bottom: 2px solid #0056b3; padding-bottom: 16px; margin-bottom: 20px; }
    .clinic-title { font-size: 24px; font-weight: bold; color: #0056b3; margin: 0 0 4px 0; letter-spacing: 0.5px; }
    .doctor-name { font-size: 16px; font-weight: 600; color: #222; margin: 0 0 2px 0; }
    .specialty { font-size: 14px; color: #555; margin: 0 0 4px 0; }
    .contact-info { font-size: 13px; color: #666; margin: 0; }
    
    .meta-box { display: flex; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    .meta-col { flex: 1; }
    .meta-col p { margin: 4px 0; font-size: 14px; }
    
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th { background: #0056b3; color: #ffffff; border: 1px solid #0056b3; padding: 10px 8px; font-size: 13px; text-transform: uppercase; }
    td { border: 1px solid #cbd5e1; padding: 10px 8px; font-size: 13px; }
    tr:nth-child(even) { background-color: #f8fafc; }
    
    .total-section { margin-top: 20px; display: flex; justify-content: flex-end; }
    .total-box { min-width: 260px; border-top: 2px solid #0056b3; padding-top: 8px; text-align: right; }
    .grand-total { font-size: 20px; font-weight: bold; color: #0056b3; }
    
    .footer { margin-top: 48px; display: flex; justify-content: space-between; align-items: flex-end; font-size: 12px; color: #64748b; }
    .signature { text-align: right; }
    .sig-line { width: 180px; border-top: 1px dashed #64748b; margin-bottom: 6px; }
    
    .btn-container { margin-top: 24px; text-align: center; }
    .print-btn { background: #0056b3; color: white; border: none; padding: 10px 24px; font-size: 15px; border-radius: 6px; cursor: pointer; font-weight: 600; }
    .print-btn:hover { background: #004494; }
    
    @media print {
      .btn-container { display: none; }
      body { padding: 16px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1 class="clinic-title">${escapeHtml(clinic)}</h1>
    <p class="doctor-name">${escapeHtml(doctor)}</p>
    <p class="specialty">${escapeHtml(specialty)}</p>
    <p class="contact-info">Address: ${escapeHtml(address)} | Mobile: ${escapeHtml(phone)}</p>
  </div>

  <div class="meta-box">
    <div class="meta-col">
      <p><strong>Patient Name:</strong> ${escapeHtml(invoice.patient_name || 'Walk-in Patient')}</p>
      <p><strong>Patient ID:</strong> ${escapeHtml(invoice.patient_code || String(invoice.patient_id))}</p>
      <p><strong>Age / Sex:</strong> ${invoice.patient_age ? `${invoice.patient_age} yrs` : '—'} / ${escapeHtml(invoice.patient_sex || '—')}</p>
      ${invoice.patient_mobile ? `<p><strong>Mobile:</strong> ${escapeHtml(invoice.patient_mobile)}</p>` : ''}
      ${invoice.patient_aadhar ? `<p><strong>Aadhaar:</strong> ${escapeHtml(maskAadhaar(invoice.patient_aadhar))}</p>` : ''}
    </div>
    <div class="meta-col" style="text-align: right;">
      <p><strong>Invoice #:</strong> ${invoice.id}</p>
      <p><strong>Date:</strong> ${escapeHtml(formatDate(invoice.invoice_date || new Date().toISOString()))}</p>
      <p><strong>Prescribing Doctor:</strong> ${escapeHtml(doctor)}</p>
      ${invoice.appointment_id ? `<p><strong>Appointment #:</strong> ${invoice.appointment_id}</p>` : ''}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 40px; text-align: center;">Sl.No</th>
        <th>Medicine / Service</th>
        <th style="width: 90px; text-align: center;">Exp. Date</th>
        <th style="width: 60px; text-align: center;">Unit</th>
        <th style="width: 90px; text-align: right;">MRP</th>
        <th style="width: 50px; text-align: center;">Qty</th>
        <th style="width: 100px; text-align: right;">Total</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="7" style="text-align:center; color:#64748b;">No items on this invoice.</td></tr>'}
    </tbody>
  </table>

  <div class="total-section">
    <div class="total-box">
      <p style="margin: 4px 0; font-size: 14px; color: #475569;">Subtotal: ₹${grandTotal}</p>
      <p class="grand-total" style="margin: 6px 0;">Grand Total: ₹${grandTotal}</p>
    </div>
  </div>

  <div class="footer">
    <div>
      <p style="margin: 0;">Thank you for visiting ${escapeHtml(clinic)}.</p>
      <p style="margin: 2px 0;">Get well soon!</p>
    </div>
    <div class="signature">
      <div class="sig-line"></div>
      <p style="margin: 0;">Authorized Signatory</p>
    </div>
  </div>

  <div class="btn-container">
    <button class="print-btn" onclick="window.print()">Print / Save PDF</button>
  </div>
</body>
</html>`;

  if (!win) {
    window.print();
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
