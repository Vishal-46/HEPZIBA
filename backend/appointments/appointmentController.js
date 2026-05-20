const pool = require('../db');

// Patient books an appointment
exports.createAppointment = async (req, res) => {
  const { doctor_id, scheduled_at, reason } = req.body;
  if (!doctor_id || !scheduled_at) {
    return res.status(400).json({ error: 'doctor_id and scheduled_at required' });
  }
  try {
    // Get patient's patient_id
    const q = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
    if (!q.rows.length) return res.status(400).json({ error: 'Patient profile not found' });
    const patient_id = q.rows[0].id;
    const result = await pool.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, reason) VALUES ($1, $2, $3, $4) RETURNING *`,
      [patient_id, doctor_id, scheduled_at, reason]
    );
    res.json({ message: 'Appointment booked', appointment: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to book appointment' });
  }
};

// Patient gets all their appointments
exports.getMyAppointments = async (req, res) => {
  try {
    // Get patient's patient_id
    const q = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
    if (!q.rows.length) return res.status(400).json({ error: 'Patient profile not found' });
    const patient_id = q.rows[0].id;
    const apps = await pool.query(
      `SELECT a.*, d.id as doctor_user_id, u.name as doctor_name FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      LEFT JOIN users u ON d.user_id = u.id
      WHERE a.patient_id=$1 ORDER BY a.scheduled_at DESC`,
      [patient_id]
    );
    res.json(apps.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
};

// Doctor gets all their assigned appointments
exports.getForMe = async (req, res) => {
  try {
    // Get doctor's doctor_id
    const q = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
    if (!q.rows.length) return res.status(400).json({ error: 'Doctor profile not found' });
    const doctor_id = q.rows[0].id;
    const apps = await pool.query(
      `SELECT a.*, p.id as patient_id, u.name as patient_name FROM appointments a
      LEFT JOIN patients p ON a.patient_id = p.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE a.doctor_id=$1 ORDER BY a.scheduled_at DESC`,
      [doctor_id]
    );
    res.json(apps.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
};
