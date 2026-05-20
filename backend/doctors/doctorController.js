// Doctor controller: profile and appointment actions
const pool = require('../db');

// GET /doctors/me - View doctor profile
exports.getMe = async (req, res) => {
  try {
    // Get user info
    const userQ = await pool.query('SELECT id, name, email, role, created_at, updated_at FROM users WHERE id=$1', [req.user.id]);
    if (!userQ.rows.length || userQ.rows[0].role !== 'doctor')
      return res.status(404).json({ error: 'Not found' });
    // Get doctor info
    const doctorQ = await pool.query('SELECT id AS doctor_id, specialty, phone, bio FROM doctors WHERE user_id=$1', [req.user.id]);
    const profile = { ...userQ.rows[0], ...doctorQ.rows[0] };
    res.json(profile);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

// PUT /doctors/me - Update doctor profile
exports.updateMe = async (req, res) => {
  const { name, email, specialty, phone, bio } = req.body;
  try {
    if (name)
      await pool.query('UPDATE users SET name=$1, updated_at=NOW() WHERE id=$2', [name, req.user.id]);
    if (email)
      await pool.query('UPDATE users SET email=$1, updated_at=NOW() WHERE id=$2', [email, req.user.id]);
    if (specialty || phone || bio) {
      const exists = (await pool.query('SELECT 1 FROM doctors WHERE user_id=$1', [req.user.id])).rowCount > 0;
      if (exists) {
        await pool.query('UPDATE doctors SET specialty=COALESCE($1,specialty), phone=COALESCE($2,phone), bio=COALESCE($3,bio) WHERE user_id=$4', [specialty, phone, bio, req.user.id]);
      } else {
        await pool.query('INSERT INTO doctors (user_id, specialty, phone, bio) VALUES ($1,$2,$3,$4)', [req.user.id, specialty, phone, bio]);
      }
    }
    res.json({ message: 'Profile updated' });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to update profile' });
  }
};

// GET /doctors/appointments/:id - View specific appointment (if assigned)
exports.getAppointment = async (req, res) => {
  try {
    const docQ = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
    if (!docQ.rows.length) return res.status(400).json({ error: 'Doctor profile not found' });
    const doctor_id = docQ.rows[0].id;
    const appQ = await pool.query(
      `SELECT a.*, p.id as patient_id, u.name as patient_name FROM appointments a
        LEFT JOIN patients p ON a.patient_id = p.id
        LEFT JOIN users u ON p.user_id = u.id
        WHERE a.doctor_id=$1 AND a.id=$2`,
      [doctor_id, req.params.id]
    );
    if (!appQ.rows.length) return res.status(404).json({ error: 'Appointment not found or not assigned' });
    res.json(appQ.rows[0]);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to fetch appointment' });
  }
};

// PATCH /doctors/appointments/:id - Update appointment (status/notes)
exports.updateAppointment = async (req, res) => {
  const { status, notes } = req.body;
  try {
    const docQ = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
    if (!docQ.rows.length) return res.status(400).json({ error: 'Doctor profile not found' });
    const doctor_id = docQ.rows[0].id;
    // Only assigned appointments:
    const appQ = await pool.query('SELECT * FROM appointments WHERE id=$1 AND doctor_id=$2', [req.params.id, doctor_id]);
    if (!appQ.rows.length) return res.status(404).json({ error: 'Appointment not found or not assigned' });
    await pool.query('UPDATE appointments SET status=COALESCE($1,status), notes=COALESCE($2,notes) WHERE id=$3', [status, notes, req.params.id]);
    res.json({ message: 'Appointment updated' });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to update appointment' });
  }
};
