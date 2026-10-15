const pool = require('../db');

function parsePagination(req, defaultLimit = 20, maxLimit = 100) {
  let limit = Number(req.query.limit ?? defaultLimit);
  let offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

// Decimal-safe money parser: "19.99" -> 1999 cents. Returns NaN on invalid.
function moneyToCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [rs, ps = ''] = s.split('.');
  return Number(rs) * 100 + Number((ps + '00').slice(0, 2));
}

exports.createInvoice = async (req, res) => {
  const { patient_id, patient_code, appointment_id, doctor_name, items } = req.body;

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
  const cleanDoctorName = doctor_name !== undefined && doctor_name !== null
    ? String(doctor_name).trim() || null
    : null;

  const client = await pool.connect();
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
      const appQ = await client.query('SELECT id FROM appointments WHERE id=$1', [appointmentIdNum]);
      if (!appQ.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Appointment not found' });
      }
    }

    const invoiceQ = await client.query(
      `INSERT INTO invoices (patient_id, appointment_id, doctor_name, total_amount)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [patientIdNum, appointmentIdNum, cleanDoctorName, totalAmount]
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
        'SELECT id, stock FROM inventory_items WHERE LOWER(name) = LOWER($1)',
        [item.medicine_name]
      );
      if (!invQ.rows.length) continue;
      const inv = invQ.rows[0];
      if (inv.stock < item.quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient stock for ${item.medicine_name} — have ${inv.stock}, need ${item.quantity}. Restock first.`,
        });
      }
      await client.query('UPDATE inventory_items SET stock = stock - $1, updated_at = NOW() WHERE id = $2', [
        item.quantity,
        inv.id,
      ]);
    }

    await client.query('COMMIT');
    return res.json({ message: 'Invoice created', invoice_id: invoice.id, total_amount: Number(totalAmount) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create invoice' });
  } finally {
    client.release();
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

    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
};

exports.getInvoiceById = async (req, res) => {
  try {
    const invoiceId = Number(req.params.id);
    if (!Number.isInteger(invoiceId)) return res.status(400).json({ error: 'Invalid invoice id' });

    const invoiceQ = await pool.query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
    if (!invoiceQ.rows.length) return res.status(404).json({ error: 'Invoice not found' });

    const invoice = invoiceQ.rows[0];
    // Ownership: patient owns invoice; admin bypass.
    if (req.user.role === 'patient') {
      const patientQ = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
      if (!patientQ.rows.length || patientQ.rows[0].id !== invoice.patient_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const itemsQ = await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY id ASC', [invoiceId]);
    return res.json({ ...invoice, items: itemsQ.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch invoice' });
  }
};
exports.listInvoices = async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req, 50);

    const q = req.query.q ? String(req.query.q).trim() : '';

    let whereClause = '';
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      whereClause = `WHERE (pu.name ILIKE $1 OR p.patient_code ILIKE $1 OR inv.doctor_name ILIKE $1)`;
    }

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
      JOIN users pu ON pu.id = p.user_id
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

    return res.json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
};
