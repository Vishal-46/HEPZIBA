const pool = require('../db');
const { APPOINTMENT_STATUSES, normalizeAppointmentStatus } = require('../utils/appointmentStatus');
const { maskPatientContacts, shouldRevealContact } = require('../utils/pii');

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
  // doctor_id is optional (single-doctor clinic): when missing/invalid the
  // first active doctor is assigned inside the transaction below.
  const rawScheduled = req.body.scheduled_at ?? req.body.date_time;
  let doctorIdNum = Number(req.body.doctor_id);
  const doctorIdProvided = Number.isInteger(doctorIdNum) && doctorIdNum >= 1;
  if (rawScheduled === undefined || rawScheduled === null || String(rawScheduled).trim() === '') {
    return res.status(400).json({ error: 'scheduled_at required' });
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
    let released = false;
    const releaseClient = () => {
      if (!released) { released = true; client.release(); }
    };
    try {
      await client.query('BEGIN');

      let patient_id;
      if (req.user.role === 'admin' || req.user.role === 'doctor') {
        const pid = Number(req.body.patient_id);
        if (!Number.isInteger(pid) || pid < 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Valid patient_id is required for admin booking' });
        }
        const chk = await client.query('SELECT id FROM patients WHERE id=$1', [pid]);
        if (!chk.rows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Patient not found' });
        }
        patient_id = pid;
      } else {
        const q = await client.query('SELECT id FROM patients WHERE user_id=$1', [req.user.id]);
        if (!q.rows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Patient profile not found' });
        }
        patient_id = q.rows[0].id;
      }

      // Default doctor: first active doctor profile; else first active
      // doctor user (creating its profile row); else fail loudly.
      if (!doctorIdProvided) {
        const firstDoc = await client.query(
          `SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id
           WHERE COALESCE(u.active, TRUE) = TRUE AND u.role='doctor'
           ORDER BY d.id LIMIT 1`
        );
        if (firstDoc.rows.length) {
          doctorIdNum = firstDoc.rows[0].id;
        } else {
          const firstUser = await client.query(
            `SELECT id FROM users WHERE role='doctor' AND COALESCE(active, TRUE) = TRUE ORDER BY id LIMIT 1`
          );
          if (!firstUser.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'No doctors available right now' });
          }
          const du = firstUser.rows[0].id;
          const hasProfile = await client.query('SELECT id FROM doctors WHERE user_id=$1', [du]);
          if (hasProfile.rows.length) doctorIdNum = hasProfile.rows[0].id;
          else {
            const created = await client.query(
              'INSERT INTO doctors (user_id) VALUES ($1) RETURNING id', [du]
            );
            doctorIdNum = created.rows[0].id;
          }
        }
      }

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

      // A deactivated doctor (or a profile whose user no longer has the doctor
      // role) must not receive new bookings: nobody would ever see the visit.
      // The default-doctor path already filters on active, so this closes the
      // gap for an explicitly supplied doctor_id.
      const availableQ = await client.query(
        `SELECT 1 FROM doctors d JOIN users u ON u.id = d.user_id
         WHERE d.id=$1 AND u.role='doctor' AND COALESCE(u.active, TRUE) = TRUE`,
        [doctorProfileId]
      );
      if (!availableQ.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Selected doctor is not available for booking' });
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

      // Durable reminder row (policy F) commits with the booking. A SAVEPOINT
      // keeps a broken/missing reminder table from aborting a valid booking;
      // scheduling is a no-op unless APPOINTMENT_REMINDER_OFFSET_MINUTES is set.
      await client.query('SAVEPOINT reminder_schedule');
      try {
        const { scheduleReminder } = require('../utils/reminders');
        await scheduleReminder(client, result.rows[0]);
        await client.query('RELEASE SAVEPOINT reminder_schedule');
      } catch (remErr) {
        await client.query('ROLLBACK TO SAVEPOINT reminder_schedule');
        console.error('Reminder scheduling failed:', remErr.message);
      }

      await client.query('COMMIT');

      // Release the connection before the provider call: notifications are
      // network I/O and must not pin a pooled DB connection (a single-connection
      // pool would otherwise time out waiting for itself).
      releaseClient();

      // Notify only after the booking is durably persisted. Best-effort: a
      // provider outage must never fail or roll back a successful booking.
      // Payload carries only the opaque appointment id.
      try {
        const { notifyAppointmentBooked } = require('../utils/push');
        await notifyAppointmentBooked(result.rows[0]);
      } catch (pushErr) {
        console.error('Booking notification failed:', pushErr.message);
      }

      return res.json({ message: 'Appointment booked', appointment: result.rows[0] });
    } catch (e) {
      if (!released) {
        try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
      }
      // Retry only on token unique-violation races (requires UNIQUE(doctor_id, date, token)
      // constraint where present); otherwise fail.
      if (e && e.code === '23505' && attempt < MAX_ATTEMPTS) {
        continue;
      }
      console.error(e);
      return res.status(500).json({ error: 'Failed to book appointment' });
    } finally {
      releaseClient();
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
    const currentStatus = normalizeAppointmentStatus(appQ.rows[0].status);
    if (currentStatus === 'done' || currentStatus === 'cancelled') {
      return res.status(400).json({ error: `Cannot cancel appointment with status '${appQ.rows[0].status}'` });
    }
    // Conditional write: the check above is only a friendly error. The status
    // guard on the UPDATE itself is what makes it safe, so a doctor completing
    // the visit between the read and the write cannot be overwritten by a
    // stale patient cancel.
    const upd = await pool.query(
      `UPDATE appointments SET status='cancelled'
        WHERE id=$1 AND patient_id=$2
          AND status NOT IN ('cancelled','done','completed')
        RETURNING id`,
      [appointmentId, patient_id]
    );
    if (!upd.rows.length) {
      return res.status(400).json({ error: 'Appointment is already closed and cannot be cancelled' });
    }

    // Only the request that actually changed the row reaches this point, so
    // rejected, repeated, or race-losing cancellations never notify. The
    // doctor is resolved through the appointment's doctor profile, admins
    // through users.role; both are best-effort.
    try {
      const { notifyUser, notifyAdmins } = require('../utils/push');
      const info = await pool.query(
        `SELECT d.user_id AS doctor_user_id
           FROM appointments a
           LEFT JOIN doctors d ON d.id = a.doctor_id
          WHERE a.id = $1`,
        [appointmentId]
      );
      const doctorUserId = info.rows[0] ? info.rows[0].doctor_user_id : null;
      const data = { appointmentId };
      if (doctorUserId) {
        await notifyUser(
          doctorUserId,
          'Appointment cancelled',
          'A patient cancelled an appointment. Open the app to view your schedule.',
          data
        );
      }
      await notifyAdmins(
        'Appointment cancelled',
        'A patient cancelled an appointment. Open the app to view the schedule.',
        data
      );
    } catch (pushErr) {
      console.error('Cancellation notification failed:', pushErr.message);
    }

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
    // Contact details are masked by default. The assigned doctor may request
    // the originals (`?reveal=contact`) because this list is already scoped to
    // their own appointments and calling the patient is a legitimate workflow.
    res.json(shouldRevealContact(req, ['doctor']) ? apps.rows : maskPatientContacts(apps.rows));
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
       WHERE COALESCE(u.active, TRUE) = TRUE AND u.role = 'doctor'
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
