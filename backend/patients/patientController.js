const pool = require('../db');

// Get profile of the logged-in patient
exports.getMe = async (req, res) => {
  // req.user is set by roleAuth middleware
  try {
    // Get user info
    const userQ = await pool.query('SELECT id, name, email, role, created_at, updated_at FROM users WHERE id=$1', [req.user.id]);
    if (!userQ.rows.length || userQ.rows[0].role !== 'patient')
      return res.status(404).json({ error: 'Not found' });

    // Get patient info
    const patientQ = await pool.query('SELECT id AS patient_id, dob, address FROM patients WHERE user_id=$1', [req.user.id]);
    const profile = { ...userQ.rows[0], ...patientQ.rows[0] };
    res.json(profile);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

// Update profile of the logged-in patient
exports.updateMe = async (req, res) => {
  const { name, email, dob, address } = req.body;
  try {
    if (name)
      await pool.query('UPDATE users SET name=$1, updated_at=NOW() WHERE id=$2', [name, req.user.id]);
    if (email)
      await pool.query('UPDATE users SET email=$1, updated_at=NOW() WHERE id=$2', [email, req.user.id]);
    if (dob || address) {
      // Upsert to patients
      const exists = (await pool.query('SELECT 1 FROM patients WHERE user_id=$1', [req.user.id])).rowCount > 0;
      if (exists) {
        await pool.query('UPDATE patients SET dob=COALESCE($1,dob), address=COALESCE($2,address) WHERE user_id=$3', [dob, address, req.user.id]);
      } else {
        await pool.query('INSERT INTO patients (user_id, dob, address) VALUES ($1,$2,$3)', [req.user.id, dob, address]);
      }
    }
    res.json({ message: 'Profile updated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update profile' });
  }
};
