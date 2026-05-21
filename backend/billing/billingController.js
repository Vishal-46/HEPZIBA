const pool = require('../db');

exports.createInvoice = async (req, res) => {
  const { patient_id, appointment_id, doctor_name, items } = req.body;

  if (!patient_id || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'patient_id and invoice items are required' });
  }

  try {
    const totalAmount = items.reduce((sum, item) => {
      const mrp = Number(item.mrp || 0);
      const quantity = Number(item.quantity || 1);
      return sum + mrp * quantity;
    }, 0);

    const invoiceQ = await pool.query(
      `INSERT INTO invoices (patient_id, appointment_id, doctor_name, total_amount)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [patient_id, appointment_id || null, doctor_name || null, totalAmount]
    );
    const invoice = invoiceQ.rows[0];

    for (const item of items) {
      const quantity = Number(item.quantity || 1);
      const mrp = Number(item.mrp || 0);
      await pool.query(
        `INSERT INTO invoice_items (invoice_id, medicine_name, expiry_date, unit, mrp, quantity, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          invoice.id,
          item.medicine_name,
          item.expiry_date || null,
          item.unit || null,
          mrp,
          quantity,
          mrp * quantity,
        ]
      );
    }

    return res.json({ message: 'Invoice created', invoice_id: invoice.id, total_amount: totalAmount });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to create invoice' });
  }
};

exports.getMyInvoices = async (req, res) => {
  try {
    const patientQ = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
    if (!patientQ.rows.length) return res.status(400).json({ error: 'Patient profile not found' });
    const patient_id = patientQ.rows[0].id;

    const invoicesQ = await pool.query(
      'SELECT * FROM invoices WHERE patient_id=$1 ORDER BY invoice_date DESC',
      [patient_id]
    );

    const result = [];
    for (const invoice of invoicesQ.rows) {
      const itemsQ = await pool.query('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY id ASC', [invoice.id]);
      result.push({ ...invoice, items: itemsQ.rows });
    }

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
