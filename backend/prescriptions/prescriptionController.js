const pool = require('../db');

exports.createPrescription = async (req, res) => {
  const { appointment_id, notes, items } = req.body;

  if (!appointment_id || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'appointment_id and items[] required' });
  }

  try {
    const doctorQ = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
    if (!doctorQ.rows.length) return res.status(400).json({ error: 'Doctor profile not found' });
    const doctor_id = doctorQ.rows[0].id;

    const appQ = await pool.query(
      'SELECT id, patient_id FROM appointments WHERE id=$1 AND doctor_id=$2',
      [appointment_id, doctor_id]
    );
    if (!appQ.rows.length) return res.status(404).json({ error: 'Appointment not found or not assigned' });

    const doctorNameQ = await pool.query('SELECT name FROM users WHERE id=$1', [req.user.id]);
    const doctor_name = doctorNameQ.rows[0]?.name || null;

    const insertPrescription = await pool.query(
      `INSERT INTO prescriptions (appointment_id, doctor_id, patient_id, doctor_name, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [appointment_id, doctor_id, appQ.rows[0].patient_id, doctor_name, notes || null]
    );

    const prescription = insertPrescription.rows[0];

    for (const item of items) {
      await pool.query(
        `INSERT INTO prescription_items
        (prescription_id, medicine_name, dosage_morning, dosage_afternoon, dosage_evening, dosage_night, before_food, after_food, quantity, instructions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          prescription.id,
          item.medicine_name,
          !!item.dosage_morning,
          !!item.dosage_afternoon,
          !!item.dosage_evening,
          !!item.dosage_night,
          !!item.before_food,
          !!item.after_food,
          item.quantity || null,
          item.instructions || null,
        ]
      );
    }

    return res.json({ message: 'Prescription created', prescription_id: prescription.id });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to create prescription' });
  }
};

exports.getMyPrescriptions = async (req, res) => {
  try {
    const patientQ = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
    if (!patientQ.rows.length) return res.status(400).json({ error: 'Patient profile not found' });
    const patient_id = patientQ.rows[0].id;

    const prescriptionsQ = await pool.query(
      `SELECT p.*
       FROM prescriptions p
       WHERE p.patient_id=$1
       ORDER BY p.prescribed_on DESC`,
      [patient_id]
    );

    const output = [];
    for (const row of prescriptionsQ.rows) {
      const itemsQ = await pool.query(
        'SELECT * FROM prescription_items WHERE prescription_id=$1 ORDER BY id ASC',
        [row.id]
      );
      output.push({ ...row, items: itemsQ.rows });
    }

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

    const itemsQ = await pool.query('SELECT * FROM prescription_items WHERE prescription_id=$1 ORDER BY id ASC', [prescription.id]);
    return res.json({ ...prescription, items: itemsQ.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch prescription' });
  }
};
