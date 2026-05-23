const pool = require('../db');

// Patient books an appointment
exports.createAppointment = async (req, res) => {
  const { doctor_id, scheduled_at, reason, notes } = req.body;
  if (!doctor_id || !scheduled_at) {
    return res.status(400).json({ error: 'doctor_id and scheduled_at required' });
  }

  const scheduledAtDate = new Date(scheduled_at);
  if (Number.isNaN(scheduledAtDate.getTime())) {
    return res.status(400).json({ error: 'Invalid scheduled_at datetime' });
  }
  if (scheduledAtDate.getTime() < Date.now()) {
    return res.status(400).json({ error: 'Appointment must be in the future' });
  }

  try {
    // Get patient's patient_id
    const q = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
    if (!q.rows.length) return res.status(400).json({ error: 'Patient profile not found' });
    const patient_id = q.rows[0].id;

    // Resolve doctor profile id from either doctors.id or users.id
    let doctorProfileId = Number(doctor_id);
    let doctorQ = await pool.query('SELECT id FROM doctors WHERE id=$1', [doctorProfileId]);
    if (!doctorQ.rows.length) {
      doctorQ = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [doctorProfileId]);
      if (!doctorQ.rows.length) {
        return res.status(400).json({ error: 'Doctor profile not found' });
      }
      doctorProfileId = doctorQ.rows[0].id;
    }

    const duplicateQ = await pool.query(
      `SELECT id FROM appointments
       WHERE patient_id=$1 AND doctor_id=$2
         AND DATE_TRUNC('minute', COALESCE(scheduled_at, date_time)) = DATE_TRUNC('minute', $3::timestamp)
         AND status <> 'cancelled'`,
      [patient_id, doctorProfileId, scheduled_at]
    );
    if (duplicateQ.rows.length) {
      return res.status(409).json({ error: 'You already have an appointment at this time with this doctor.' });
    }

    const tokenQ = await pool.query(
      `SELECT COALESCE(MAX(token_number), 0) + 1 AS next_token
       FROM appointments
       WHERE doctor_id=$1
       AND DATE(COALESCE(scheduled_at, date_time)) = DATE($2)`,
      [doctorProfileId, scheduled_at]
    );

    const tokenNumber = tokenQ.rows[0].next_token;

    let result;
    try {
      // Legacy-compatible insert when date_time column still exists and is NOT NULL.
      result = await pool.query(
        `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, reason, notes, token_number)
         VALUES ($1, $2, $3, $3, $4, $5, $6)
         RETURNING *`,
        [patient_id, doctorProfileId, scheduled_at, reason || null, notes || null, tokenNumber]
      );
    } catch (legacyError) {
      if (legacyError.code !== '42703') throw legacyError;
      result = await pool.query(
        `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, reason, notes, token_number)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [patient_id, doctorProfileId, scheduled_at, reason || null, notes || null, tokenNumber]
      );
    }

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
      `SELECT a.*, COALESCE(a.scheduled_at, a.date_time) AS scheduled_at_effective,
       d.id as doctor_user_id, u.name as doctor_name FROM appointments a
      LEFT JOIN doctors d ON a.doctor_id = d.id
      LEFT JOIN users u ON d.user_id = u.id
      WHERE a.patient_id=$1 ORDER BY COALESCE(a.scheduled_at, a.date_time) DESC`,
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
      `SELECT a.*, COALESCE(a.scheduled_at, a.date_time) AS scheduled_at_effective,
       p.id as patient_id, p.patient_code, p.age, p.sex, p.mobile, p.bp, p.spo2,
       u.name as patient_name FROM appointments a
      LEFT JOIN patients p ON a.patient_id = p.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE a.doctor_id=$1 ORDER BY COALESCE(a.scheduled_at, a.date_time) DESC`,
      [doctor_id]
    );
    res.json(apps.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
};

// Patient-visible doctor catalog for booking UI
exports.listDoctorsForPatients = async (req, res) => {
  try {
    // First try normalized doctor profile table.
    const doctorsQ = await pool.query(
      `SELECT d.id AS doctor_id, u.name, d.specialty, d.phone, d.bio
       FROM doctors d
       INNER JOIN users u ON u.id = d.user_id
       WHERE u.active = TRUE
       ORDER BY u.name ASC`
    );

    if (doctorsQ.rows.length) {
      return res.json(doctorsQ.rows);
    }

    // Fallback: if doctor profiles are not yet created, expose doctor users
    // so patient booking still works by user id.
    const fallbackQ = await pool.query(
      `SELECT u.id AS doctor_id, u.name, NULL::text AS specialty, NULL::text AS phone, NULL::text AS bio
       FROM users u
       WHERE u.role='doctor' AND COALESCE(u.active, TRUE) = TRUE
       ORDER BY u.name ASC`
    );

    return res.json(fallbackQ.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to fetch doctor list' });
  }
};
