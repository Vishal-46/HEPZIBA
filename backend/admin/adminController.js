// Admin controller: user and appointment management
const pool = require('../db');
const {
  normalizeAppointmentStatus,
  APPOINTMENT_STATUSES,
  allowedFromStatuses,
  canonicalStatusSql,
} = require('../utils/appointmentStatus');
const { maskPatientContact, maskPatientContacts, shouldRevealContact } = require('../utils/pii');


// GET /admin/users?role=...
exports.listUsers = async (req, res) => {
  const { role } = req.query;
  try {
    const q = await pool.query('SELECT id, name, email, role, active, email_verified, created_at FROM users' + (role ? ' WHERE role=$1' : '') + ' ORDER BY id ASC', role ? [role] : []);
    res.json(q.rows);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to list users' });
  }
};
// GET /admin/users/:id
exports.getUser = async (req, res) => {
  try {
    const q = await pool.query('SELECT id, name, email, role, email_verified, created_at FROM users WHERE id=$1', [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(q.rows[0]);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to get user' });
  }
};
// PUT /admin/users/:id
exports.updateUser = async (req, res) => {
  const { name, email, role, email_verified, active } = req.body || {};
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });

  const cleanName = name !== undefined && name !== null ? String(name).trim() : '';
  if (name !== undefined && name !== null && !cleanName) {
    return res.status(400).json({ error: 'Name cannot be empty.' });
  }
  const cleanEmail = email !== undefined && email !== null ? String(email).trim().toLowerCase() : '';
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  const nextRole = role !== undefined && role !== null ? String(role).trim() : '';
  if (nextRole && !['patient', 'doctor', 'admin'].includes(nextRole)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingQ = await client.query('SELECT id, role, active FROM users WHERE id=$1', [userId]);
    if (!existingQ.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    const existing = existingQ.rows[0];

    if (cleanEmail) {
      const dup = await client.query(
        'SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2',
        [cleanEmail, userId]
      );
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Email already in use.' });
      }
    }

    if (active === false) {
      if (userId === req.user.id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You cannot deactivate your own account.' });
      }
      if (existing.role === 'admin') {
        const admins = await client.query(
          "SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND COALESCE(active, TRUE) = TRUE AND id<>$1",
          [userId]
        );
        if (admins.rows[0].n === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'At least one active admin is required.' });
        }
      }
    }

    const updates = [];
    const values = [];
    if (cleanName) { updates.push(`name=$${values.length + 1}`); values.push(cleanName); }
    if (cleanEmail) { updates.push(`email=$${values.length + 1}`); values.push(cleanEmail); }
    if (nextRole) { updates.push(`role=$${values.length + 1}`); values.push(nextRole); }
    if (email_verified !== undefined) {
      updates.push(`email_verified=$${values.length + 1}`);
      values.push(!!email_verified);
    }
    if (active !== undefined) { updates.push(`active=$${values.length + 1}`); values.push(!!active); }
    if (!updates.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Role lifecycle: a user promoted to doctor needs a doctor profile so
    // bookings/prescriptions can reference doctors.id. Demotion keeps the
    // profile for historical records (appointments FK) but the role check
    // blocks all doctor endpoints.
    if (nextRole === 'doctor' && existing.role !== 'doctor') {
      await client.query(
        `INSERT INTO doctors (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );
    }

    values.push(userId);
    const q = await client.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at=NOW()
       WHERE id=$${values.length}
       RETURNING id, name, email, role, active, email_verified`,
      values
    );

    await client.query('COMMIT');
    res.json({ message: 'User updated', user: q.rows[0] });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (e && e.code === '23505') {
      return res.status(400).json({ error: 'Email already in use.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Failed to update user' });
  } finally {
    client.release();
  }
};
// DELETE /admin/users/:id (soft delete)
exports.deleteUser = async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid user id' });
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'You cannot deactivate your own account.' });
  }
  try {
    const target = await pool.query('SELECT role FROM users WHERE id=$1', [userId]);
    if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
    if (target.rows[0].role === 'admin') {
      const admins = await pool.query(
        "SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND COALESCE(active, TRUE) = TRUE AND id<>$1",
        [userId]
      );
      if (admins.rows[0].n === 0) {
        return res.status(400).json({ error: 'At least one active admin is required.' });
      }
    }
    await pool.query('UPDATE users SET active=FALSE, updated_at=NOW() WHERE id=$1', [userId]);
    res.json({ message: 'User deactivated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
};
// GET /admin/appointments?status=&date=YYYY-MM-DD&search=&limit=&offset=
exports.listAppointments = async (req, res) => {
  try {
    let limit = Number(req.query.limit ?? 100);
    let offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1) limit = 100;
    if (limit > 200) limit = 200;
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    const status = req.query.status ? String(req.query.status).trim() : '';
    const date = req.query.date ? String(req.query.date).trim() : '';
    const search = req.query.search ? String(req.query.search).trim() : '';
    const conds = [];
    const vals = [];
    const normalizedStatus = normalizeAppointmentStatus(status);
    if (normalizedStatus) {
      conds.push(`a.status = $${vals.length + 1}`);
      vals.push(normalizedStatus);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      conds.push(`DATE(COALESCE(a.scheduled_at, a.date_time)) = $${vals.length + 1}`);
      vals.push(date);
    }
    if (search) {
      conds.push(`(pu.name ILIKE $${vals.length + 1} OR du.name ILIKE $${vals.length + 1} OR CAST(a.id AS TEXT) = $${vals.length + 2} OR COALESCE(p.patient_code,'') ILIKE $${vals.length + 1})`);
      vals.push(`%${search}%`, String(search));
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    vals.push(limit, offset);
    const q = await pool.query(
      `SELECT a.*, COALESCE(a.scheduled_at, a.date_time) AS scheduled_at_effective,
       pu.name AS patient_name, p.patient_code, p.age, p.sex, p.mobile, p.bp, p.spo2,
       du.name AS doctor_name
       FROM appointments a
       LEFT JOIN patients p ON p.id = a.patient_id
       LEFT JOIN users pu ON pu.id = p.user_id
       LEFT JOIN doctors d ON d.id = a.doctor_id
       LEFT JOIN users du ON du.id = d.user_id
       ${where}
       ORDER BY COALESCE(a.scheduled_at, a.date_time) DESC
       LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals
    );
    res.json(shouldRevealContact(req, ['admin']) ? q.rows : maskPatientContacts(q.rows));
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to list appointments' });
  }
};
// PATCH /admin/appointments/:id - Admin may set any whitelisted status (bypass ownership)
exports.updateAppointmentStatus = async (req, res) => {
  try {
    const appointmentId = Number(req.params.id);
    if (!Number.isInteger(appointmentId)) return res.status(400).json({ error: 'Invalid appointment id' });
    const { status, notes } = req.body || {};

    let nextStatus = null;
    if (status !== undefined && status !== null) {
      nextStatus = normalizeAppointmentStatus(status);
      if (!nextStatus) {
        return res.status(400).json({ error: `status must be one of ${APPOINTMENT_STATUSES.join('|')}` });
      }
    }
    const notesProvided = notes !== undefined;
    const cleanNotes = notes === undefined || notes === null ? null : String(notes).trim() || null;
    if (!nextStatus && !notesProvided) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // One statement, canonical status only. `notes` is replaced when the
    // caller sent the field (an explicit empty string clears the note). The
    // CTE locks the row and captures its current status, so the transition
    // guard and the write see the same row version: a concurrent request that
    // already moved the visit cannot be overwritten. `done` and `cancelled`
    // are terminal unless the clinic adopts an explicit reopening policy.
    const fromStatuses = nextStatus ? allowedFromStatuses(nextStatus) : null;
    const transitionGuard = fromStatuses
      ? `AND ${canonicalStatusSql('prev.status')} IN (${fromStatuses.map((s) => `'${s}'`).join(', ')})`
      : '';

    const q = await pool.query(
      `WITH prev AS (
         SELECT id, status FROM appointments WHERE id=$4 FOR UPDATE
       )
       UPDATE appointments a
       SET status = COALESCE($1, a.status),
           notes = CASE WHEN $2 THEN $3 ELSE a.notes END
       FROM prev
       WHERE a.id = prev.id ${transitionGuard}
       RETURNING a.*, prev.status AS previous_status`,
      [nextStatus, notesProvided, cleanNotes, appointmentId]
    );
    if (!q.rows.length) {
      const curQ = await pool.query(
        `SELECT ${canonicalStatusSql('status')} AS status FROM appointments WHERE id=$1`,
        [appointmentId]
      );
      if (!curQ.rows.length) return res.status(404).json({ error: 'Appointment not found' });
      return res.status(409).json({
        error: `Cannot change appointment from '${curQ.rows[0].status}' to '${nextStatus}'`,
      });
    }
    const previousStatus = normalizeAppointmentStatus(q.rows[0].previous_status);
    const statusChanged = Boolean(nextStatus) && nextStatus !== previousStatus;

    // Best-effort patient notification (never fails the update).
    try {
      const { notifyAppointmentOwner } = require('../utils/push');
      const msg = cleanNotes || '';
      // Do not re-notify when the status was already the requested one.
      if (!statusChanged) {
        // no status change — nothing to announce
      } else if (nextStatus === 'confirmed') {
        await notifyAppointmentOwner(appointmentId, 'Visit confirmed', msg || 'Your visit request was accepted. Please arrive 10 minutes early.');
      } else if (nextStatus === 'cancelled') {
        await notifyAppointmentOwner(appointmentId, 'Visit cancelled', msg || 'Your visit request was declined. Contact the clinic for another slot.');
      } else if (nextStatus === 'done') {
        await notifyAppointmentOwner(appointmentId, 'Visit completed', msg || 'Your visit is marked done. Check your prescriptions and bills in the app.');
      } else if (notesProvided && cleanNotes) {
        // "Send message" without a status change: tell the patient a note is waiting.
        await notifyAppointmentOwner(appointmentId, 'Message from Hepziba Clinic', cleanNotes);
      }
    } catch (pushErr) {
      console.error('Push notification failed:', pushErr.message);
    }

    // `previous_status` is internal bookkeeping for the notification decision.
    const { previous_status: _previousStatus, ...updatedAppointment } = q.rows[0];
    res.json({ message: 'Appointment updated', appointment: updatedAppointment });
  } catch (e) {
    console.error('Unexpected error in updateAppointmentStatus:', e);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
};

// POST /admin/appointments/:id/reopen — audited correction for closed visits.
//
// Ordinary PATCH /admin/appointments/:id cannot leave `done` or `cancelled`
// (the transition table is terminal). Reopening is a deliberate clinic
// correction: it requires a reason, writes an audit row, and commits both in
// one transaction. If the audit insert fails the status change rolls back, so
// there is never an untracked correction.
exports.reopenAppointment = async (req, res) => {
  const appointmentId = Number(req.params.id);
  if (!Number.isInteger(appointmentId) || appointmentId < 1) {
    return res.status(400).json({ error: 'Invalid appointment id' });
  }

  const { reason, status } = req.body || {};
  const cleanReason = reason === undefined || reason === null ? '' : String(reason).trim();
  if (cleanReason.length < 5 || cleanReason.length > 500) {
    return res.status(400).json({ error: 'A correction reason of 5-500 characters is required' });
  }

  // Reopening only returns a visit to an active queue state; `done` and
  // `cancelled` are not valid targets (that would just re-close the row).
  const targetStatus = status === undefined || status === null ? 'confirmed' : normalizeAppointmentStatus(status);
  if (!targetStatus || !['pending', 'confirmed'].includes(targetStatus)) {
    return res.status(400).json({ error: 'status must be pending or confirmed when reopening' });
  }

  const client = await pool.connect();
  let released = false;
  const releaseClient = () => {
    if (!released) { released = true; client.release(); }
  };
  try {
    await client.query('BEGIN');

    const curQ = await client.query(
      `SELECT id, status FROM appointments WHERE id = $1 FOR UPDATE`,
      [appointmentId]
    );
    if (!curQ.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Appointment not found' });
    }
    const previousStatus = normalizeAppointmentStatus(curQ.rows[0].status);
    if (!previousStatus || !['done', 'cancelled'].includes(previousStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only completed or cancelled visits can be reopened' });
    }

    // The conditional UPDATE re-checks the closed state under the same lock so
    // a concurrent correction cannot slip between the SELECT and the write.
    const updQ = await client.query(
      `UPDATE appointments
          SET status = $1
        WHERE id = $2
          AND ${canonicalStatusSql('status')} IN ('done', 'cancelled')
        RETURNING *`,
      [targetStatus, appointmentId]
    );
    if (!updQ.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Visit was changed concurrently; refresh and retry' });
    }

    const auditQ = await client.query(
      `INSERT INTO appointment_status_corrections
         (appointment_id, actor_user_id, previous_status, corrected_status, reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, appointment_id, actor_user_id, previous_status, corrected_status, reason, created_at`,
      [appointmentId, req.user.id, previousStatus, targetStatus, cleanReason]
    );

    await client.query('COMMIT');

    // Release before the provider call so a single-connection pool cannot
    // deadlock against itself while the notification is in flight.
    releaseClient();

    // Best-effort: tell the patient their visit was reopened. No clinical data.
    try {
      const { notifyAppointmentOwner } = require('../utils/push');
      await notifyAppointmentOwner(
        appointmentId,
        'Visit reopened',
        'Your visit was reopened by the clinic. Check the app for the updated status.'
      );
    } catch (pushErr) {
      console.error('Reopen notification failed:', pushErr.message);
    }

    return res.json({
      message: 'Appointment reopened',
      appointment: updQ.rows[0],
      correction: auditQ.rows[0],
    });
  } catch (e) {
    if (!released) {
      try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    }
    console.error('Unexpected error in reopenAppointment:', e);
    return res.status(500).json({ error: 'Failed to reopen appointment' });
  } finally {
    releaseClient();
  }
};

// GET /admin/patients?search= — every registered patient with chart + contact
exports.listPatients = async (req, res) => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : '';
    let limit = Number(req.query.limit ?? 100);
    let offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1) limit = 100;
    if (limit > 200) limit = 200;
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    const conds = [`u.role = 'patient'`];
    const vals = [];
    if (search) {
      conds.push(`(u.name ILIKE $${vals.length + 1} OR u.email ILIKE $${vals.length + 1} OR COALESCE(p.patient_code,'') ILIKE $${vals.length + 1} OR COALESCE(p.mobile,'') ILIKE $${vals.length + 1})`);
      vals.push(`%${search}%`);
    }
    vals.push(limit, offset);
    const q = await pool.query(
      `SELECT u.id AS user_id, u.name, u.email, u.active, u.email_verified, u.created_at,
       p.id AS patient_id, p.patient_code, p.age, p.sex, p.mobile, p.bp, p.spo2
       FROM users u LEFT JOIN patients p ON p.user_id = u.id
       WHERE ${conds.join(' AND ')}
       ORDER BY u.id DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals
    );
    res.json(shouldRevealContact(req, ['admin']) ? q.rows : maskPatientContacts(q.rows));
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to list patients' });
  }
};

const CLINIC_HOURS_DEFAULTS = { openTime: '09:00', closeTime: '18:00', days: 'Mon-Sat', slotMinutes: '15' };

function cleanClinicHours(input) {
  const src = (input && typeof input === 'object' && (input.clinicHours || input)) || {};
  const openTime = String(src.openTime ?? CLINIC_HOURS_DEFAULTS.openTime).trim();
  const closeTime = String(src.closeTime ?? CLINIC_HOURS_DEFAULTS.closeTime).trim();
  const days = String(src.days ?? CLINIC_HOURS_DEFAULTS.days).trim().slice(0, 60) || CLINIC_HOURS_DEFAULTS.days;
  const slotRaw = String(src.slotMinutes ?? CLINIC_HOURS_DEFAULTS.slotMinutes).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(openTime)) return { error: 'openTime must be HH:MM (24h)' };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(closeTime)) return { error: 'closeTime must be HH:MM (24h)' };
  const slotMinutes = Number(slotRaw);
  if (!Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 120) {
    return { error: 'slotMinutes must be 5-120' };
  }
  if (!days) return { error: 'days is required' };
  return { value: { openTime, closeTime, days, slotMinutes: String(slotMinutes) } };
}

// GET /admin/settings — current clinic hours (doctor + admin)
exports.getSettings = async (_req, res) => {
  try {
    const q = await pool.query(`SELECT value FROM clinic_settings WHERE key = 'clinicHours'`);
    res.json(q.rows[0]?.value || CLINIC_HOURS_DEFAULTS);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to load settings' });
  }
};

// POST /admin/settings — save clinic hours (admin only)
exports.updateSettings = async (req, res) => {
  const cleaned = cleanClinicHours(req.body);
  if (cleaned.error) return res.status(400).json({ error: cleaned.error });
  try {
    const q = await pool.query(
      `INSERT INTO clinic_settings (key, value, updated_at) VALUES ('clinicHours', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       RETURNING value`,
      [JSON.stringify(cleaned.value)]
    );
    res.json({ message: 'Clinic hours saved.', clinicHours: q.rows[0].value });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to save settings' });
  }
};
