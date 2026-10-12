const pool = require('../db');

const APPOINTMENT_STATUSES = ['pending', 'confirmed', 'done', 'cancelled'];

function parsePagination(req, defaultLimit = 20, maxLimit = 100) {
  let limit = Number(req.query.limit ?? defaultLimit);
  let offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

// Patient books an appointment
exports.createAppointment = async (req, res) => {
  // Backward compat: accept scheduled_at (preferred) or legacy date_time.
  const rawScheduled = req.body.scheduled_at ?? req.body.date_time;
  const doctorIdNum = Number(req.body.doctor_id);
  if (!Number.isInteger(doctorIdNum) || doctorIdNum < 1) {
    return res.status(400).json({ error: 'doctor_id must be an integer' });
  }
  if (rawScheduled === undefined || rawScheduled === null || String(rawScheduled).trim() === '') {
    return res.status(400).json({ error: 'doctor_id and scheduled_at required' });
  }

  const scheduledAtDate = new Date(rawScheduled);
  if (Number.isNaN(scheduledAtDate.getTime())) {
    return res.status(400).json({ error: 'Invalid scheduled_at datetime' });
  }
  if (scheduledAtDate.getTime() < Date.now()) {
    return res.status(400).json({ error: 'Appointment must be in the future' });
  }
  const scheduledAtISO = scheduledAtDate.toISOString();

  const reason = req.body.reason !== undefined && req.body.reason !== null
    ? String(req.body.reason).trim() || null
    : null;
  const notes = req.body.notes !== undefined && req.body.notes !== null
    ? String(req.body.notes).trim() || null
    : null;

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const q = await client.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
      if (!q.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Patient profile not found' });
      }
      const patient_id = q.rows[0].id;

      // Resolve doctor profile id from either doctors.id or users.id
      let doctorProfileId = doctorIdNum;
      let doctorQ = await client.query('SELECT id FROM doctors WHERE id=$1', [doctorProfileId]);
      if (!doctorQ.rows.length) {
        doctorQ = await client.query('SELECT id FROM doctors WHERE user_id=$1', [doctorProfileId]);
        if (!doctorQ.rows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Doctor profile not found' });
        }
        doctorProfileId = doctorQ.rows[0].id;
      }

      // Concurrency-safe token allocation: serialize per doctor+day with a
      // transaction-scoped advisory lock. No DDL/migration required.
      const dayStr = scheduledAtISO.slice(0, 10); // YYYY-MM-DD (UTC)
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `appt:${doctorProfileId}:${dayStr}`,
      ]);

      // Duplicate-booking guard (preserved 409 semantics).
      const duplicateQ = await client.query(
        `SELECT id FROM appointments
         WHERE patient_id=$1 AND doctor_id=$2
           AND DATE_TRUNC('minute', COALESCE(scheduled_at, date_time)) = DATE_TRUNC('minute', $3::timestamp)
           AND status <> 'cancelled'`,
        [patient_id, doctorProfileId, scheduledAtISO]
      );
      if (duplicateQ.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'You already have an appointment at this time with this doctor.' });
      }

      const tokenQ = await client.query(
        `SELECT COALESCE(MAX(token_number), 0) + 1 AS next_token
         FROM appointments
         WHERE doctor_id=$1
         AND DATE(COALESCE(scheduled_at, date_time)) = DATE($2)`,
        [doctorProfileId, scheduledAtISO]
      );
      const tokenNumber = tokenQ.rows[0].next_token;

      // Detect legacy date_time column once (avoids aborted-txn fallback).
      const colQ = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='appointments' AND column_name IN ('scheduled_at','date_time')`
      );
      const cols = new Set(colQ.rows.map((r) => r.column_name));
      const hasDateTime = cols.has('date_time');

      let result;
      if (hasDateTime) {
        // Legacy-compatible insert when date_time column still exists.
        result = await client.query(
          `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, reason, notes, token_number)
           VALUES ($1, $2, $3, $3, $4, $5, $6)
           RETURNING *`,
          [patient_id, doctorProfileId, scheduledAtISO, reason, notes, tokenNumber]
        );
      } else {
        result = await client.query(
          `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, reason, notes, token_number)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [patient_id, doctorProfileId, scheduledAtISO, reason, notes, tokenNumber]
        );
      }

      await client.query('COMMIT');
      return res.json({ message: 'Appointment booked', appointment: result.rows[0] });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      // Retry only on token unique-violation races (requires UNIQUE(doctor_id, date, token)
      // constraint where present); otherwise fail.
      if (e && e.code === '23505' && attempt < MAX_ATTEMPTS) {
        continue;
      }
      console.error(e);
      return res.status(500).json({ error: 'Failed to book appointment' });
    } finally {
      client.release();
    }
  }
  return res.status(409).json({ error: 'Could not allocate token, please retry' });
};

// Patient gets all their appointments (paginated)
exports.getMyAppointments = async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req);
    const q = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
    if (!q.rows.length) return res.status(400).json({ error: 'Patient profile not found' });
    const patient_id = q.rows[0].id;
    const apps = await pool.query(
      `SELECT a.*, COALESCE(a.scheduled_at, a.date_time) AS scheduled_at_effective,
       d.id as doctor_user_id, u.name as doctor_name FROM appointments a
       LEFT JOIN doctors d ON a.doctor_id = d.id
       LEFT JOIN users u ON d.user_id = u.id
       WHERE a.patient_id=$1 ORDER BY COALESCE(a.scheduled_at, a.date_time) DESC
       LIMIT $2 OFFSET $3`,
      [patient_id, limit, offset]
    );
    res.json(apps.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch appointments' });
  }
};

// Patient: view single own appointment (ownership check)
exports.getMyAppointmentById = async (req, res) => {
  try {
    const appointmentId = Number(req.params.id);
    if (!Number.isInteger(appointmentId)) return res.status(400).json({ error: 'Invalid appointment id' });
    const q = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
    if (!q.rows.length) return res.status(400).json({ error: 'Patient profile not found' });
    const patient_id = q.rows[0].id;
    const appQ = await pool.query(
      `SELECT a.*, COALESCE(a.scheduled_at, a.date_time) AS scheduled_at_effective
       FROM appointments a WHERE a.id=$1 AND a.patient_id=$2`,
      [appointmentId, patient_id]
    );
    if (!appQ.rows.length) return res.status(404).json({ error: 'Appointment not found' });
    res.json(appQ.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch appointment' });
  }
};

// Patient: cancel own appointment (only transition allowed for patients)
exports.cancelMyAppointment = async (req, res) => {
  try {
    const appointmentId = Number(req.params.id);
    if (!Number.isInteger(appointmentId)) return res.status(400).json({ error: 'Invalid appointment id' });
    const { status } = req.body || {};
    // Patients may only cancel; default to cancelled when body omits status.
    const nextStatus = status === undefined ? 'cancelled' : String(status).trim();
    if (nextStatus !== 'cancelled') {
      return res.status(403).json({ error: 'Patients may only cancel their own appointments' });
    }
    const q = await pool.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
    if (!q.rows.length) return res.status(400).json({ error: 'Patient profile not found' });
    const patient_id = q.rows[0].id;
    const appQ = await pool.query('SELECT id, status FROM appointments WHERE id=$1 AND patient_id=$2', [appointmentId, patient_id]);
    if (!appQ.rows.length) return res.status(404).json({ error: 'Appointment not found' });
    if (appQ.rows[0].status === 'done' || appQ.rows[0].status === 'cancelled') {
      return res.status(400).json({ error: `Cannot cancel appointment with status '${appQ.rows[0].status}'` });
    }
    await pool.query('UPDATE appointments SET status=$1 WHERE id=$2', ['cancelled', appointmentId]);
    res.json({ message: 'Appointment cancelled' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to cancel appointment' });
  }
};

// Doctor gets all their assigned appointments (paginated)
exports.getForMe = async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req);
    const q = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
    if (!q.rows.length) return res.status(400).json({ error: 'Doctor profile not found' });
    const doctor_id = q.rows[0].id;
    const apps = await pool.query(
      `SELECT a.*, COALESCE(a.scheduled_at, a.date_time) AS scheduled_at_effective,
       p.id as patient_id, p.patient_code, p.age, p.sex, p.mobile, p.bp, p.spo2,
       u.name as patient_name FROM appointments a
       LEFT JOIN patients p ON a.patient_id = p.id
       LEFT JOIN users u ON p.user_id = u.id
       WHERE a.doctor_id=$1 ORDER BY COALESCE(a.scheduled_at, a.date_time) DESC
       LIMIT $2 OFFSET $3`,
      [doctor_id, limit, offset]
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

exports.APPOINTMENT_STATUSES = APPOINTMENT_STATUSES;
