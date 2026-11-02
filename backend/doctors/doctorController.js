// Doctor controller: profile and appointment actions
const pool = require('../db');
const {
  normalizeAppointmentStatus,
  allowedFromStatuses,
  canonicalStatusSql,
} = require('../utils/appointmentStatus');

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
  const { name, email, specialty, phone, bio } = req.body || {};

  const cleanName = name !== undefined && name !== null ? String(name).trim() : '';
  if (name !== undefined && name !== null && !cleanName) {
    return res.status(400).json({ error: 'Name cannot be empty.' });
  }
  const cleanEmail = email !== undefined && email !== null ? String(email).trim().toLowerCase() : '';
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (cleanEmail) {
      const dup = await client.query(
        'SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2',
        [cleanEmail, req.user.id]
      );
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Email already in use.' });
      }
    }

    if (cleanName) {
      await client.query('UPDATE users SET name=$1, updated_at=NOW() WHERE id=$2', [cleanName, req.user.id]);
    }
    if (cleanEmail) {
      await client.query('UPDATE users SET email=$1, updated_at=NOW() WHERE id=$2', [cleanEmail, req.user.id]);
    }
    if (specialty !== undefined || phone !== undefined || bio !== undefined) {
      const exists = (await client.query('SELECT 1 FROM doctors WHERE user_id=$1', [req.user.id])).rowCount > 0;
      const values = [
        specialty !== undefined && specialty !== null ? String(specialty).trim() : null,
        phone !== undefined && phone !== null ? String(phone).trim() : null,
        bio !== undefined && bio !== null ? String(bio).trim() : null,
        req.user.id,
      ];
      if (exists) {
        await client.query(
          `UPDATE doctors
           SET specialty=COALESCE($1,specialty), phone=COALESCE($2,phone), bio=COALESCE($3,bio)
           WHERE user_id=$4`,
          values
        );
      } else {
        await client.query(
          'INSERT INTO doctors (user_id, specialty, phone, bio) VALUES ($4,$1,$2,$3)',
          values
        );
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Profile updated' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (e && e.code === '23505') {
      return res.status(400).json({ error: 'Email already in use.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Failed to update profile' });
  } finally {
    client.release();
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
  const { status, notes } = req.body || {};
  // Canonical statuses only: DB/API/docs use `done` (legacy `completed` is
  // normalised, never written).
  const DOCTOR_STATUSES = ['confirmed', 'done', 'cancelled'];
  try {
    const appointmentId = Number(req.params.id);
    if (!Number.isInteger(appointmentId)) {
      return res.status(400).json({ error: 'Invalid appointment id' });
    }
    const docQ = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
    if (!docQ.rows.length) return res.status(400).json({ error: 'Doctor profile not found' });
    const doctor_id = docQ.rows[0].id;

    let nextStatus = null;
    if (status !== undefined && status !== null) {
      nextStatus = normalizeAppointmentStatus(status);
      if (!nextStatus || !DOCTOR_STATUSES.includes(nextStatus)) {
        return res.status(400).json({ error: `status must be one of ${DOCTOR_STATUSES.join('|')}` });
      }
    }
    const notesProvided = notes !== undefined;
    const cleanNotes = notes === undefined || notes === null ? null : String(notes).trim() || null;
    if (!nextStatus && !notesProvided) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Only assigned appointments (doctor owns appointment). The CTE locks the
    // row and captures its current status, so the transition guard, the write,
    // and the "did it actually change?" check all see the same row version.
    // A concurrent request that already moved the visit is therefore rejected
    // (or treated as an idempotent no-op) instead of overwriting it.
    const fromStatuses = nextStatus ? allowedFromStatuses(nextStatus) : null;
    const transitionGuard = fromStatuses
      ? `AND ${canonicalStatusSql('prev.status')} IN (${fromStatuses.map((s) => `'${s}'`).join(', ')})`
      : '';

    // One statement: `notes` is only replaced when the caller sent the field,
    // so an explicit empty string can clear a previous visit note.
    const q = await pool.query(
      `WITH prev AS (
         SELECT id, status FROM appointments WHERE id=$4 AND doctor_id=$5 FOR UPDATE
       )
       UPDATE appointments a
       SET status = COALESCE($1, a.status),
           notes = CASE WHEN $2 THEN $3 ELSE a.notes END
       FROM prev
       WHERE a.id = prev.id ${transitionGuard}
       RETURNING a.status AS status, prev.status AS previous_status`,
      [nextStatus, notesProvided, cleanNotes, appointmentId, doctor_id]
    );
    if (!q.rows.length) {
      const curQ = await pool.query(
        `SELECT ${canonicalStatusSql('status')} AS status FROM appointments WHERE id=$1 AND doctor_id=$2`,
        [appointmentId, doctor_id]
      );
      if (!curQ.rows.length) return res.status(404).json({ error: 'Appointment not found or not assigned' });
      return res.status(409).json({
        error: `Cannot change appointment from '${curQ.rows[0].status}' to '${nextStatus}'`,
      });
    }
    const previousStatus = normalizeAppointmentStatus(q.rows[0].previous_status);
    const statusChanged = Boolean(nextStatus) && nextStatus !== previousStatus;

    try {
      const { notifyAppointmentOwner } = require('../utils/push');
      const msg = cleanNotes || '';
      // Do not re-notify when the status was already the requested one
      // (idempotent re-submit / retry).
      if (!statusChanged) {
        // no status change — nothing to announce
      } else if (nextStatus === 'confirmed') {
        await notifyAppointmentOwner(appointmentId, 'Visit confirmed', msg || 'Your visit request was accepted. Please arrive 10 minutes early.');
      } else if (nextStatus === 'cancelled') {
        await notifyAppointmentOwner(appointmentId, 'Visit cancelled', msg || 'Your visit request was declined. Contact the clinic for another slot.');
      } else if (nextStatus === 'done') {
        await notifyAppointmentOwner(appointmentId, 'Visit completed', msg || 'Your visit is marked done. Check your prescriptions and bills in the app.');
      }
    } catch (pushErr) {
      console.error('Doctor push notification failed:', pushErr.message);
    }
    res.json({ message: 'Appointment updated', appointment: { id: appointmentId, status: q.rows[0].status } });
  } catch (e) {
    console.error('Unexpected error in doctor updateAppointment:', e);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
};
