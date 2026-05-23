const pool = require('../db');
const jwt = require('jsonwebtoken');
const { hashPassword, checkPassword, generateCode } = require('../utils/crypto');
const { sendMail } = require('../mailer/mailer');
const { generatePatientCode } = require('../utils/patientCode');

// Helper to sign JWTs
function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET, { expiresIn: '4h' }
  );
}

// --------- PATIENT REGISTRATION ----------
exports.registerPatient = async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Missing required field.' });

  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const found = await pool.query('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
    if (found.rows.length) return res.status(400).json({ error: 'Email already in use.' });

    const hash = await hashPassword(password);
    const code = generateCode();

    const inserted = await pool.query(`
      INSERT INTO users (name, email, password, role, email_verified, verification_code, verification_code_expires_at)
      VALUES ($1,$2,$3,'patient',FALSE,$4,NOW() + INTERVAL '15 minutes')
      RETURNING id
    `, [name, normalizedEmail, hash, code]);

    const userId = inserted.rows[0].id;
    const patientCode = generatePatientCode(userId);

    await pool.query(
      `INSERT INTO patients (user_id, patient_code)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET patient_code = EXCLUDED.patient_code`,
      [userId, patientCode]
    );

    // Send code via email
    await sendMail({
      to: normalizedEmail,
      from: process.env.FROM_EMAIL,
      subject: `[Hepziba] Verify your email`,
      text: `Your verification code is: ${code}\nValid for 15 minutes.`
    });

    res.json({ message: 'Registration successful, check your email for code.', patient_code: patientCode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed.' });
  }
};

// --------- ADMIN REGISTRATION (ADMIN ONLY) ----------
exports.registerAdmin = async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing required field.' });
  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const found = await pool.query('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
    if (found.rows.length) return res.status(400).json({ error: 'Email already in use.' });

    const hash = await hashPassword(password);
    // Admin is immediately verified
    await pool.query(`
      INSERT INTO users (name, email, password, role, email_verified)
      VALUES ($1, $2, $3, 'admin', TRUE)
    `, [name, normalizedEmail, hash]);

    res.json({ message: 'Admin registration successful.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Admin registration failed.' });
  }
};

// --------- DOCTOR REGISTRATION (ADMIN ONLY) ----------
exports.registerDoctor = async (req, res) => {
  const { name, email, password, specialty, phone, bio } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing required field.' });
  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const found = await pool.query('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
    if (found.rows.length) return res.status(400).json({ error: 'Email already in use.' });

    const hash = await hashPassword(password);
    // Doctor is immediately verified
    const userInsert = await pool.query(`
      INSERT INTO users (name, email, password, role, email_verified)
      VALUES ($1, $2, $3, 'doctor', TRUE)
      RETURNING id
    `, [name, normalizedEmail, hash]);

    const userId = userInsert.rows[0].id;
    const doctorExists = (await pool.query('SELECT 1 FROM doctors WHERE user_id=$1', [userId])).rowCount > 0;
    if (doctorExists) {
      await pool.query(
        `UPDATE doctors
         SET specialty=COALESCE($1,specialty), phone=COALESCE($2,phone), bio=COALESCE($3,bio)
         WHERE user_id=$4`,
        [specialty || null, phone || null, bio || null, userId]
      );
    } else {
      await pool.query(
        `INSERT INTO doctors (user_id, specialty, phone, bio)
         VALUES ($1, $2, $3, $4)`,
        [userId, specialty || null, phone || null, bio || null]
      );
    }

    res.json({ message: 'Doctor registration successful.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Doctor registration failed.' });
  }
};

// --------- VERIFY EMAIL ----------
exports.verifyEmail = async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Missing field.' });
  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const userQ = await pool.query(
      `SELECT id, verification_code, verification_code_expires_at FROM users WHERE email=$1 AND email_verified=FALSE`,
      [normalizedEmail]
    );
    if (!userQ.rows.length) return res.status(400).json({ error: 'User not found or already verified.' });
    const user = userQ.rows[0];
    if (user.verification_code !== code ||
        new Date(user.verification_code_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired code.' });
    }
    // Mark verified, clear code
    await pool.query(
      `UPDATE users SET email_verified=TRUE, verification_code=NULL, verification_code_expires_at=NULL WHERE id=$1`,
      [user.id]
    );
    res.json({ message: 'Email verified, you can now login.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Verification failed.' });
  }
};

// --------- LOGIN ----------
exports.login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing field.' });

  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const q = await pool.query(`SELECT * FROM users WHERE email=$1`, [normalizedEmail]);
    if (q.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials.' });
    const user = q.rows[0];
    if (!user.active) return res.status(401).json({ error: 'Account deactivated.' });
    if (!user.email_verified) return res.status(401).json({ error: 'Email not verified.' });
    const ok = await checkPassword(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = signToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed.' });
  }
};

// --------- INITIATE PASSWORD RESET ----------
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing field.' });
  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const q = await pool.query('SELECT id, email_verified FROM users WHERE email=$1', [normalizedEmail]);
    if (!q.rows.length) return res.json({ message: 'If the account exists and is verified, you will receive instructions.' });
    const user = q.rows[0];
    if (!user.email_verified) return res.json({ message: 'If the account exists and is verified, you will receive instructions.' });

    const code = generateCode();
    await pool.query(
      `UPDATE users SET reset_code=$1, reset_code_expires_at=NOW() + INTERVAL '15 minutes' WHERE id=$2`,
      [code, user.id]
    );
    await sendMail({
      to: normalizedEmail,
      from: process.env.FROM_EMAIL,
      subject: `[Hepziba] Password Reset`,
      text: `Your password reset code is: ${code}\nValid for 15 minutes.`
    });
    res.json({ message: 'If the account exists and is verified, you will receive instructions.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Reset initiation failed.' });
  }
};

// --------- RESET PASSWORD ----------
exports.resetPassword = async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'Missing field.' });
  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    const q = await pool.query(
      `SELECT id, reset_code, reset_code_expires_at FROM users WHERE email=$1 AND email_verified=TRUE`,
      [normalizedEmail]
    );
    if (!q.rows.length) return res.status(400).json({ error: 'Invalid code.' });
    const user = q.rows[0];
    if (user.reset_code !== code ||
        new Date(user.reset_code_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired code.' });
    }
    const hashed = await hashPassword(newPassword);
    await pool.query(
      `UPDATE users SET password=$1, reset_code=NULL, reset_code_expires_at=NULL WHERE id=$2`,
      [hashed, user.id]
    );
    res.json({ message: 'Password reset successful, you may now log in.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Reset failed.' });
  }
};
