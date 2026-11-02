const pool = require('../db');
const { moneyToCents } = require('../utils/money');
const { maskPatientContact, maskPatientContacts, shouldRevealContact } = require('../utils/pii');

function parsePagination(req, defaultLimit = 20, maxLimit = 100) {
  let limit = Number(req.query.limit ?? defaultLimit);
  let offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

exports.createInvoice = async (req, res) => {
  const { patient_id, patient_code, appointment_id, doctor_name, doctor_fee, items } = req.body;

  if ((!patient_id && !patient_code) || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'patient (select from the picker) and invoice items are required' });
  }
  // Resolve the patient flexibly: patients.id, patient_code (HEP-XXXXX), or users.id.
  // The old UI asked for a raw numeric id, so entering a login/user id failed
  // with "Patient not found" — now every form resolves the code automatically.
  let patientIdNum = Number(patient_id);
  const codeRef = patient_code !== undefined && patient_code !== null ? String(patient_code).trim() : '';
  if (!Number.isInteger(patientIdNum) && !codeRef) {
    return res.status(400).json({ error: 'Invalid patient — pick a patient from the list, not a typed id.' });
  }
  let appointmentIdNum = null;
  if (appointment_id !== undefined && appointment_id !== null && appointment_id !== '') {
    appointmentIdNum = Number(appointment_id);
    if (!Number.isInteger(appointmentIdNum)) {
      return res.status(400).json({ error: 'Invalid appointment_id' });
    }
  }

  // Validate + compute server-side in cents (prevents NaN / float drift).
  const cleanItems = [];
  let totalCents = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const medicineName = item.medicine_name !== undefined && item.medicine_name !== null
      ? String(item.medicine_name).trim()
      : '';
    if (!medicineName) {
      return res.status(400).json({ error: `items[${i}].medicine_name is required` });
    }
    const quantity = item.quantity === undefined || item.quantity === null || item.quantity === ''
      ? 1
      : Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: `items[${i}].quantity must be a positive integer` });
    }
    const mrpCents = moneyToCents(item.mrp ?? 0);
    if (!Number.isInteger(mrpCents) || mrpCents < 0) {
      return res.status(400).json({ error: `items[${i}].mrp must be a non-negative amount with at most 2 decimals` });
    }
    let expiryDate = null;
    if (item.expiry_date !== undefined && item.expiry_date !== null && String(item.expiry_date).trim() !== '') {
      const d = new Date(item.expiry_date);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: `items[${i}].expiry_date must be a valid date` });
      }
      expiryDate = d.toISOString().slice(0, 10);
    }
    const lineCents = mrpCents * quantity;
    totalCents += lineCents;
    cleanItems.push({
      medicine_name: medicineName,
      expiry_date: expiryDate,
      unit: item.unit !== undefined && item.unit !== null ? String(item.unit).trim() || null : null,
      mrp: (mrpCents / 100).toFixed(2),
      quantity,
      total: (lineCents / 100).toFixed(2),
    });
  }
  const totalAmount = (totalCents / 100).toFixed(2);
  // Doctor consultation charge, billed separately from medicines.
  let doctorFeeCents = 0;
  if (doctor_fee !== undefined && doctor_fee !== null && String(doctor_fee).trim() !== '') {
    doctorFeeCents = moneyToCents(doctor_fee);
    if (!Number.isInteger(doctorFeeCents) || doctorFeeCents < 0) {
      return res.status(400).json({ error: 'doctor_fee must be a non-negative amount with at most 2 decimals' });
    }
  }
  const grandCents = totalCents + doctorFeeCents;
  const grandAmount = (grandCents / 100).toFixed(2);
  const cleanDoctorName = doctor_name !== undefined && doctor_name !== null
    ? String(doctor_name).trim() || null
    : null;

  const client = await pool.connect();
  let released = false;
  const releaseClient = () => {
    if (!released) { released = true; client.release(); }
  };
  try {
    await client.query('BEGIN');

    // Resolve order: patients.id → patient_code → users.id (login id).
    let resolved = null;
    if (Number.isInteger(patientIdNum)) {
      const byId = await client.query('SELECT id FROM patients WHERE id=$1', [patientIdNum]);
      if (byId.rows.length) resolved = byId.rows[0].id;
    }
    if (resolved === null && codeRef) {
      const byCode = await client.query('SELECT id FROM patients WHERE patient_code=$1', [codeRef]);
      if (byCode.rows.length) resolved = byCode.rows[0].id;
    }
    if (resolved === null && Number.isInteger(patientIdNum)) {
      const byUser = await client.query('SELECT id FROM patients WHERE user_id=$1', [patientIdNum]);
      if (byUser.rows.length) resolved = byUser.rows[0].id;
    }
    if (resolved === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Patient not found — pick the patient from the search list (code like HEP-XXXXX).' });
    }
    patientIdNum = resolved;
    if (appointmentIdNum !== null) {
      // The visit must belong to the same patient being billed, otherwise a
      // typo/malicious id would link an invoice to another patient's visit.
      const appQ = await client.query(
        'SELECT id FROM appointments WHERE id=$1 AND patient_id=$2',
        [appointmentIdNum, patientIdNum]
      );
      if (!appQ.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Appointment not found for this patient' });
      }
    }

    // `doctor_fee` is added by migration 008. Fall back to the legacy invoice
    // shape when that migration has not been applied yet, so billing keeps
    // working during a rolling deploy.
    const feeColQ = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name='invoices' AND column_name='doctor_fee'`
    );
    const hasDoctorFee = feeColQ.rowCount > 0;
    const invoiceQ = hasDoctorFee
      ? await client.query(
        `INSERT INTO invoices (patient_id, appointment_id, doctor_name, doctor_fee, total_amount)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [patientIdNum, appointmentIdNum, cleanDoctorName, (doctorFeeCents / 100).toFixed(2), grandAmount]
      )
      : await client.query(
        `INSERT INTO invoices (patient_id, appointment_id, doctor_name, total_amount)
         VALUES ($1,$2,$3,$4)
         RETURNING *`,
        [patientIdNum, appointmentIdNum, cleanDoctorName, grandAmount]
      );
    const invoice = invoiceQ.rows[0];

    for (const item of cleanItems) {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, medicine_name, expiry_date, unit, mrp, quantity, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          invoice.id,
          item.medicine_name,
          item.expiry_date,
          item.unit,
          item.mrp,
          item.quantity,
          item.total,
        ]
      );
    }

    // Real-time stock: dispensing on an invoice consumes inventory.
    // Matches by medicine name (case-insensitive); untracked charges
    // (e.g. consultation fee) are left alone. Insufficient stock aborts
    // the whole invoice so shelves never go negative silently.
    for (const item of cleanItems) {
      const invQ = await client.query(
        'SELECT id FROM inventory_items WHERE LOWER(name) = LOWER($1) ORDER BY id LIMIT 1',
        [item.medicine_name]
      );
      if (!invQ.rows.length) continue;
      const invId = invQ.rows[0].id;
      // Atomic check-and-decrement: a separate read-then-write let two
      // concurrent invoices both pass a stale stock check and drive the shelf
      // negative. The `stock >= $1` guard makes the deduction all-or-nothing.
      const dec = await client.query(
        `UPDATE inventory_items
            SET stock = stock - $1, updated_at = NOW()
          WHERE id = $2 AND stock >= $1
          RETURNING stock`,
        [item.quantity, invId]
      );
      if (!dec.rows.length) {
        const cur = await client.query('SELECT stock FROM inventory_items WHERE id=$1', [invId]);
        const have = cur.rows.length ? cur.rows[0].stock : 0;
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient stock for ${item.medicine_name} — have ${have}, need ${item.quantity}. Restock first.`,
        });
      }
    }

    await client.query('COMMIT');

    // Release before the provider call so a single-connection pool cannot
    // deadlock against itself while the notification is in flight.
    releaseClient();

    // Notify the invoice's patient only after it is persisted. No amounts,
    // line items, or contact details are included in the payload.
    try {
      const { notifyInvoiceOwner } = require('../utils/push');
      await notifyInvoiceOwner(
        invoice.id,
        'Invoice ready',
        'A new invoice is available in the app.'
      );
    } catch (pushErr) {
      console.error('Invoice notification failed:', pushErr.message);
    }

    return res.json({
      message: 'Invoice created',
      invoice_id: invoice.id,
      medicines_amount: Number(totalAmount),
      doctor_fee: Number((doctorFeeCents / 100).toFixed(2)),
      total_amount: Number(grandAmount),
    });
  } catch (error) {
    if (!released) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create invoice' });
  } finally {
    releaseClient();
  }
};

exports.getMyInvoices = async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req);
    const patientQ = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
    if (!patientQ.rows.length) return res.status(400).json({ error: 'Patient profile not found' });
    const patient_id = patientQ.rows[0].id;

    const invoicesQ = await pool.query(
      'SELECT * FROM invoices WHERE patient_id=$1 ORDER BY invoice_date DESC LIMIT $2 OFFSET $3',
      [patient_id, limit, offset]
    );

    if (!invoicesQ.rows.length) return res.json([]);

    // Single batched query (fixes N+1).
    const ids = invoicesQ.rows.map((r) => r.id);
    const itemsQ = await pool.query(
      'SELECT * FROM invoice_items WHERE invoice_id = ANY($1::int[]) ORDER BY invoice_id ASC, id ASC',
      [ids]
    );
    const byInvoice = new Map();
    for (const it of itemsQ.rows) {
      if (!byInvoice.has(it.invoice_id)) byInvoice.set(it.invoice_id, []);
      byInvoice.get(it.invoice_id).push(it);
    }

    const result = invoicesQ.rows.map((invoice) => ({
      ...invoice,
      items: byInvoice.get(invoice.id) || [],
    }));

    // A patient's own invoice list is always masked; only the owner can read
    // it, and the UI never needs the stored full contact value here.
    return res.json(maskPatientContacts(result));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
};

exports.getInvoiceById = async (req, res) => {
  try {
    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId)) return res.status(400).json({ error: 'Invalid invoice id' });

    const invoiceQ = await pool.query(
      `SELECT inv.*,
              p.patient_code,
              p.age AS patient_age,
              p.sex AS patient_sex,
              p.mobile AS patient_mobile,
              p.address AS patient_address,
              p.aadhar_number AS patient_aadhar,
              pu.name AS patient_name
         FROM invoices inv
         JOIN patients p ON p.id = inv.patient_id
         LEFT JOIN users pu ON pu.id = p.user_id
        WHERE inv.id = $1`,
      [invoiceId]
    );
    if (!invoiceQ.rows.length) return res.status(404).json({ error: 'Invoice not found' });

    const invoice = invoiceQ.rows[0];
    // Ownership: patient owns the invoice; admin bypass; a doctor must be
    // assigned to the patient through an appointment.
    if (req.user.role === 'patient') {
      const patientQ = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
      if (!patientQ.rows.length || patientQ.rows[0].id !== invoice.patient_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else if (req.user.role === 'doctor') {
      const docQ = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
      if (!docQ.rows.length) return res.status(403).json({ error: 'Forbidden' });
      const assignedQ = await pool.query(
        'SELECT 1 FROM appointments WHERE patient_id=$1 AND doctor_id=$2 LIMIT 1',
        [invoice.patient_id, docQ.rows[0].id]
      );
      if (!assignedQ.rows.length) return res.status(403).json({ error: 'Forbidden' });
    }

    const itemsQ = await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY id ASC', [invoiceId]);
    const detail = { ...invoice, items: itemsQ.rows };
    // Masked by default; admins may request originals for the printed bill.
    return res.json(shouldRevealContact(req, ['admin']) ? detail : maskPatientContact(detail));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch invoice' });
  }
};

// PATCH /billing/invoices/:id — mark paid/unpaid (admin). Paid invoices are
// treatment history: they stay readable but represent closed billing.
exports.updateInvoiceStatus = async (req, res) => {
  const invoiceId = Number(req.params.id);
  const status = req.body && req.body.status !== undefined && req.body.status !== null
    ? String(req.body.status).trim().toLowerCase()
    : '';
  if (!Number.isInteger(invoiceId)) return res.status(400).json({ error: 'Invalid invoice id' });
  if (!['paid', 'unpaid'].includes(status)) {
    return res.status(400).json({ error: "status must be 'paid' or 'unpaid'" });
  }
  try {
    const q = await pool.query('UPDATE invoices SET status=$1 WHERE id=$2 RETURNING *', [status, invoiceId]);
    if (!q.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    return res.json({ message: `Invoice marked ${status}.`, invoice: q.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to update invoice' });
  }
};
exports.listInvoices = async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req, 50);

    const q = req.query.q ? String(req.query.q).trim() : '';

    // Doctors may list invoices only for patients assigned to them. The
    // assignment is the authoritative appointment relationship; a
    // client-supplied patient_id/doctor_id is never used as proof.
    let doctorId = null;
    if (req.user.role === 'doctor') {
      const docQ = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
      if (!docQ.rows.length) return res.status(403).json({ error: 'Forbidden' });
      doctorId = docQ.rows[0].id;
    }

    const conds = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      conds.push(`(pu.name ILIKE $${params.length} OR p.patient_code ILIKE $${params.length} OR inv.doctor_name ILIKE $${params.length})`);
    }
    if (doctorId !== null) {
      params.push(doctorId);
      conds.push(`EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.patient_id = p.id AND a.doctor_id = $${params.length}
      )`);
    }
    const whereClause = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const query = `
      SELECT 
        inv.*,
        p.patient_code,
        p.age AS patient_age,
        p.sex AS patient_sex,
        p.mobile AS patient_mobile,
        p.address AS patient_address,
        p.aadhar_number AS patient_aadhar,
        pu.name AS patient_name
      FROM invoices inv
      JOIN patients p ON p.id = inv.patient_id
      -- LEFT JOIN: a patient record can exist without a login account (legacy
      -- imports, no user_id). An inner join silently dropped their invoices
      -- from the admin billing list, so the money disappeared from the books.
      LEFT JOIN users pu ON pu.id = p.user_id
      ${whereClause}
      ORDER BY inv.invoice_date DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit, offset);
    const invoicesQ = await pool.query(query, params);

    if (!invoicesQ.rows.length) return res.json([]);

    const ids = invoicesQ.rows.map((r) => r.id);
    const itemsQ = await pool.query(
      'SELECT * FROM invoice_items WHERE invoice_id = ANY($1::int[]) ORDER BY invoice_id ASC, id ASC',
      [ids]
    );
    const byInvoice = new Map();
    for (const it of itemsQ.rows) {
      if (!byInvoice.has(it.invoice_id)) byInvoice.set(it.invoice_id, []);
      byInvoice.get(it.invoice_id).push(it);
    }

    const result = invoicesQ.rows.map((invoice) => ({
      ...invoice,
      items: byInvoice.get(invoice.id) || [],
    }));

    // Contact columns are masked by default. Admins may request originals for
    // the printed invoice (`?reveal=contact`); doctors always get masked.
    return res.json(shouldRevealContact(req, ['admin']) ? result : maskPatientContacts(result));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
};
