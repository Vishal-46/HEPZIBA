import type { Appointment, MedicineRow } from '../types';
import { formatDate, maskAadhaar } from '../utils/format';

/** Open a print-friendly prescription sheet. No edge function required. */
export function printPrescription(
  appointment: Appointment,
  medicines: MedicineRow[],
  notes: string,
  clinicName = 'Hepziba Chest Clinic',
): void {
  const rows = medicines
    .map((m, i) => {
      const timing = [
        m.m ? 'M' : '',
        m.a ? 'A' : '',
        m.e ? 'E' : '',
        m.n ? 'N' : '',
      ]
        .filter(Boolean)
        .join('–') || '—';
      const food = m.bf ? 'Before food' : m.af ? 'After food' : '—';
      return `<tr><td>${i + 1}</td><td>${escapeHtml(m.name)}</td><td>${timing}</td><td>${food}</td></tr>`;
    })
    .join('');

  const win = window.open('', '_blank', 'width=800,height=900');
  const html = `<!doctype html><html><head><title>Prescription #${appointment.id}</title>
<style>
body{font-family:Arial,sans-serif;padding:32px;color:#1c242b}
h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin-top:16px}
td,th{border:1px solid #999;padding:8px;font-size:14px;text-align:left}
.muted{color:#555;font-size:13px}
@media print{button{display:none}}
</style></head><body>
<h1>${escapeHtml(clinicName)} — Prescription</h1>
<p class="muted">Appointment #${appointment.id} · ${escapeHtml(formatDate(appointment.scheduled_at))}</p>
<p><strong>Patient:</strong> ${escapeHtml(String(appointment.patient_name ?? 'Patient'))} · Aadhaar: ${escapeHtml(maskAadhaar(appointment.patient_aadhaar ?? appointment.aadhaar))}</p>
<p><strong>Notes:</strong> ${escapeHtml(notes || appointment.notes || '—')}</p>
<table><thead><tr><th>#</th><th>Medicine</th><th>Dosage</th><th>Food</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Generated locally via window.print — no edge function required.</p>
<button onclick="window.print()">Print / Save PDF</button>
</body></html>`;

  if (!win) {
    // Popup blocked: fall back to printing the current page.
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
