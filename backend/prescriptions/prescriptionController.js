const pool = require('../db');

function parsePagination(req, defaultLimit = 20, maxLimit = 100) {
  let limit = Number(req.query.limit ?? defaultLimit);
  let offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

exports.createPrescription = async (req, res) => {
  const { appointment_id, notes, items } = req.body;

  if (!appointment_id || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'appointment_id and items[] required' });
  }
  const appointmentIdNum = Number(appointment_id);
  if (!Number.isInteger(appointmentIdNum)) {
    return res.status(400).json({ error: 'Invalid appointment_id' });
  }

  // Validate items up-front (fail fast, before opening a transaction).
  const cleanItems = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const medicineName = item.medicine_name !== undefined && item.medicine_name !== null
      ? String(item.medicine_name).trim()
      : '';
    if (!medicineName) {
      return res.status(400).json({ error: `items[${i}].medicine_name is required` });
    }
    let quantity = null;
    if (item.quantity !== undefined && item.quantity !== null && item.quantity !== '') {
      quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({ error: `items[${i}].quantity must be a positive integer` });
      }
    }
    cleanItems.push({
      medicine_name: medicineName,
      dosage_morning: !!item.dosage_morning,
      dosage_afternoon: !!item.dosage_afternoon,
      dosage_evening: !!item.dosage_evening,
      dosage_night: !!item.dosage_night,
      before_food: !!item.before_food,
      after_food: !!item.after_food,
      quantity,
      instructions: item.instructions !== undefined && item.instructions !== null
        ? String(item.instructions).trim() || null
        : null,
    });
  }
  const cleanNotes = notes !== undefined && notes !== null ? String(notes).trim() || null : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const doctorQ = await client.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
    if (!doctorQ.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Doctor profile not found' });
    }
    const doctor_id = doctorQ.rows[0].id;

    // Doctor owns appointment (ownership check inside txn).
    const appQ = await client.query(
      'SELECT id, patient_id FROM appointments WHERE id=$1 AND doctor_id=$2',
      [appointmentIdNum, doctor_id]
    );
    if (!appQ.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Appointment not found or not assigned' });
    }

    const doctorNameQ = await client.query('SELECT name FROM users WHERE id=$1', [req.user.id]);
    const doctor_name = doctorNameQ.rows[0]?.name || null;

    const insertPrescription = await client.query(
      `INSERT INTO prescriptions (appointment_id, doctor_id, patient_id, doctor_name, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [appointmentIdNum, doctor_id, appQ.rows[0].patient_id, doctor_name, cleanNotes]
    );

    const prescription = insertPrescription.rows[0];

    for (const item of cleanItems) {
      await client.query(
        `INSERT INTO prescription_items
        (prescription_id, medicine_name, dosage_morning, dosage_afternoon, dosage_evening, dosage_night, before_food, after_food, quantity, instructions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          prescription.id,
          item.medicine_name,
          item.dosage_morning,
          item.dosage_afternoon,
          item.dosage_evening,
          item.dosage_night,
          item.before_food,
          item.after_food,
          item.quantity,
          item.instructions,
        ]
      );
    }

    await client.query('COMMIT');
    return res.json({ message: 'Prescription created', prescription_id: prescription.id });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error(error);
    return res.status(500).json({ error: 'Failed to create prescription' });
  } finally {
    client.release();
  }
};

exports.getMyPrescriptions = async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req);
    const patientQ = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
    if (!patientQ.rows.length) return res.status(400).json({ error: 'Patient profile not found' });
    const patient_id = patientQ.rows[0].id;

    const prescriptionsQ = await pool.query(
      `SELECT p.*
       FROM prescriptions p
       WHERE p.patient_id=$1
       ORDER BY p.prescribed_on DESC
       LIMIT $2 OFFSET $3`,
      [patient_id, limit, offset]
    );

    if (!prescriptionsQ.rows.length) return res.json([]);

    // Single batched query (fixes N+1).
    const ids = prescriptionsQ.rows.map((r) => r.id);
    const itemsQ = await pool.query(
      'SELECT * FROM prescription_items WHERE prescription_id = ANY($1::int[]) ORDER BY prescription_id ASC, id ASC',
      [ids]
    );
    const byPrescription = new Map();
    for (const it of itemsQ.rows) {
      if (!byPrescription.has(it.prescription_id)) byPrescription.set(it.prescription_id, []);
      byPrescription.get(it.prescription_id).push(it);
    }

    const output = prescriptionsQ.rows.map((row) => ({
      ...row,
      items: byPrescription.get(row.id) || [],
    }));

    return res.json(output);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch prescriptions' });
  }
};

exports.getByAppointment = async (req, res) => {
  try {
    const appointmentId = Number(req.params.appointmentId);
    if (!Number.isInteger(appointmentId)) return res.status(400).json({ error: 'Invalid appointment id' });

    const prescriptionQ = await pool.query(
      'SELECT * FROM prescriptions WHERE appointment_id=$1 ORDER BY prescribed_on DESC LIMIT 1',
      [appointmentId]
    );

    if (!prescriptionQ.rows.length) return res.status(404).json({ error: 'Prescription not found' });

    const prescription = prescriptionQ.rows[0];

    // Ownership checks: patient owns prescription, doctor owns appointment; admin bypass.
    if (req.user.role !== 'admin') {
      if (req.user.role === 'patient') {
        const patientQ = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
        if (!patientQ.rows.length || patientQ.rows[0].id !== prescription.patient_id) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }

      if (req.user.role === 'doctor') {
        const doctorQ = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
        if (!doctorQ.rows.length || doctorQ.rows[0].id !== prescription.doctor_id) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
    }

    const itemsQ = await pool.query('SELECT * FROM prescription_items WHERE prescription_id=$1 ORDER BY id ASC', [prescription.id]);
    return res.json({ ...prescription, items: itemsQ.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch prescription' });
  }
};
