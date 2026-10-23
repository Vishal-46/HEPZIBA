// Admin controller: user and appointment management
const pool = require('../db');


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
  const { name, email, role, email_verified, active } = req.body;
  try {
    const updates = [];
    const values = [];
    if (name) { updates.push('name=$'+(values.length+1)); values.push(name); }
    if (email) { updates.push('email=$'+(values.length+1)); values.push(email); }
    if (role) {
      if (!['patient', 'doctor', 'admin'].includes(String(role))) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      updates.push('role=$'+(values.length+1)); values.push(role);
    }
    if (email_verified!==undefined) { updates.push('email_verified=$'+(values.length+1)); values.push(!!email_verified); }
    if (active!==undefined) { updates.push('active=$'+(values.length+1)); values.push(!!active); }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    const q = await pool.query('UPDATE users SET '+updates.join(', ')+', updated_at=NOW() WHERE id=$'+values.length + ' RETURNING id, name, email, role, active', values);
    if (!q.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User updated', user: q.rows[0] });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to update user' });
  }
};
// DELETE /admin/users/:id (soft delete)
exports.deleteUser = async (req, res) => {
  try {
    await pool.query('UPDATE users SET active=FALSE, updated_at=NOW() WHERE id=$1', [req.params.id]);
    res.json({ message: 'User deactivated' });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to deactivate user' });
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
    if (status && ['pending', 'confirmed', 'done', 'cancelled'].includes(status)) {
      conds.push(`a.status = $${vals.length + 1}`);
      vals.push(status);
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
    res.json(q.rows);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to list appointments' });
  }
};
// PATCH /admin/appointments/:id - Admin may set any whitelisted status (bypass ownership)
exports.updateAppointmentStatus = async (req, res) => {
  const ADMIN_STATUSES = ['pending', 'confirmed', 'done', 'completed', 'cancelled'];
  try {
    const appointmentId = Number(req.params.id);
    if (!Number.isInteger(appointmentId)) return res.status(400).json({ error: 'Invalid appointment id' });
    const { status, notes } = req.body || {};
    let nextStatus = null;
    if (status !== undefined && status !== null) {
      nextStatus = String(status).trim();
      if (!ADMIN_STATUSES.includes(nextStatus)) {
        return res.status(400).json({ error: `status must be one of ${ADMIN_STATUSES.join('|')}` });
      }
    }
    const cleanNotes = notes !== undefined && notes !== null ? String(notes).trim() || null : null;
    if (nextStatus === null && notes === undefined) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Try updating status. If the DB constraint requires 'done' vs 'completed', fallback smoothly.
    const statusesToTry = [];
    if (nextStatus === 'done') statusesToTry.push('done', 'completed');
    else if (nextStatus === 'completed') statusesToTry.push('completed', 'done');
    else if (nextStatus) statusesToTry.push(nextStatus);
    else statusesToTry.push(null);

    let q = null;
    let lastError = null;

    for (const targetStatus of statusesToTry) {
      try {
        q = await pool.query(
          'UPDATE appointments SET status=COALESCE($1,status), notes=COALESCE($2,notes) WHERE id=$3 RETURNING *',
          [targetStatus, cleanNotes, appointmentId]
        );
        break;
      } catch (err) {
        lastError = err;
        // If column 'notes' does not exist in appointments table:
        if (err.code === '42703' && String(err.message).includes('notes')) {
          await pool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes TEXT').catch(() => {});
          try {
            q = await pool.query(
              'UPDATE appointments SET status=COALESCE($1,status), notes=COALESCE($2,notes) WHERE id=$3 RETURNING *',
              [targetStatus, cleanNotes, appointmentId]
            );
            break;
          } catch (retryErr) {
            try {
              q = await pool.query(
                'UPDATE appointments SET status=COALESCE($1,status) WHERE id=$2 RETURNING *',
                [targetStatus, appointmentId]
              );
              break;
            } catch (fallbackErr) {
              lastError = fallbackErr;
            }
          }
        }
      }
    }

    if (!q) {
      console.error('Update appointment DB error:', lastError);
      return res.status(500).json({
        error: 'Failed to update appointment',
        details: lastError ? lastError.message : undefined,
      });
    }

    if (!q.rows.length) return res.status(404).json({ error: 'Appointment not found' });
    const finalStatus = q.rows[0].status === 'completed' ? 'done' : q.rows[0].status;

    // Best-effort patient notification (never fails the update).
    try {
      const { notifyAppointmentOwner } = require('../utils/push');
      const msg = cleanNotes || '';
      if (finalStatus === 'confirmed') {
        void notifyAppointmentOwner(appointmentId, 'Visit confirmed', msg || 'Your visit request was accepted. Please arrive 10 minutes early.');
      } else if (finalStatus === 'cancelled') {
        void notifyAppointmentOwner(appointmentId, 'Visit cancelled', msg || 'Your visit request was declined. Contact the clinic for another slot.');
      } else if (finalStatus === 'done') {
        void notifyAppointmentOwner(appointmentId, 'Visit completed', msg || 'Your visit is marked done. Check your prescriptions and bills in the app.');
      }
    } catch (_) { /* ignore */ }

    res.json({ message: 'Appointment updated', appointment: q.rows[0] });
  } catch (e) {
    console.error('Unexpected error in updateAppointmentStatus:', e);
    res.status(500).json({ error: 'Failed to update appointment', details: e.message });
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
    res.json(q.rows);
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
