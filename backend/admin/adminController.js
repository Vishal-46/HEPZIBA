// Admin controller: user and appointment management
const pool = require('../db');

// GET /admin/users?role=...
exports.listUsers = async (req, res) => {
  const { role } = req.query;
  try {
    const q = await pool.query('SELECT id, name, email, role, email_verified, created_at FROM users' + (role ? ' WHERE role=$1' : ''), role ? [role] : []);
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
  const { name, email, role, email_verified } = req.body;
  try {
    const updates = [];
    const values = [];
    if (name) { updates.push('name=$'+(values.length+1)); values.push(name); }
    if (email) { updates.push('email=$'+(values.length+1)); values.push(email); }
    if (role) { updates.push('role=$'+(values.length+1)); values.push(role); }
    if (email_verified!==undefined) { updates.push('email_verified=$'+(values.length+1)); values.push(email_verified); }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(req.params.id);
    await pool.query('UPDATE users SET '+updates.join(', ')+', updated_at=NOW() WHERE id=$'+values.length, values);
    res.json({ message: 'User updated' });
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
// GET /admin/appointments
exports.listAppointments = async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT a.*, COALESCE(a.scheduled_at, a.date_time) AS scheduled_at_effective,
       pu.name AS patient_name, p.patient_code, p.age, p.sex, p.mobile, p.bp, p.spo2,
       du.name AS doctor_name
       FROM appointments a
       LEFT JOIN patients p ON p.id = a.patient_id
       LEFT JOIN users pu ON pu.id = p.user_id
       LEFT JOIN doctors d ON d.id = a.doctor_id
       LEFT JOIN users du ON du.id = d.user_id
       ORDER BY COALESCE(a.scheduled_at, a.date_time) DESC`
    );
    res.json(q.rows);
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Failed to list appointments' });
  }
};
