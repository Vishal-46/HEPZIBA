const pool = require('../db');
const jwt = require('jsonwebtoken');
const https = require('https');
const { hashPassword, checkPassword, generateCode, generateSecureToken } = require('../utils/crypto');
const { sendMail } = require('../mailer/mailer');
const { generatePatientCode } = require('../utils/patientCode');

// Helper to sign JWTs — throws when JWT_SECRET is missing so callers
// fail closed (500) instead of issuing unsigned/unverifiable tokens.
function signToken(user) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET, { expiresIn: '4h' }
  );
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

async function verifyGoogleIdToken(idToken) {
  const payload = await fetchJson(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );

  if (!payload || payload.error) {
    throw new Error(payload?.error_description || 'Invalid Google token');
  }

  if (process.env.GOOGLE_CLIENT_ID && payload.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new Error('Google token audience mismatch');
  }

  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    throw new Error('Google email not verified');
  }

  return payload;
}

// --------- PATIENT REGISTRATION ----------
exports.registerPatient = async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Missing required field.' });

  const normalizedEmail = String(email).trim().toLowerCase();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
    if (found.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email already in use.' });
    }

    const hash = await hashPassword(password);

    // M1: email verification is optional/deferred. Accounts are usable
    // immediately for both password and OAuth login; email_verified stays
    // as informational metadata, not a login gate.
    const inserted = await client.query(`
      INSERT INTO users (name, email, password, role, email_verified)
      VALUES ($1,$2,$3,'patient',TRUE)
      RETURNING id
    `, [name, normalizedEmail, hash]);

    const userId = inserted.rows[0].id;
    const patientCode = generatePatientCode(userId);

    // Plain INSERT: userId is brand-new so no patient row can exist yet.
    // Avoids ON CONFLICT(user_id) which requires UNIQUE(patients.user_id)
    // (added by 002 migration; older DBs without it throw 42P10).
    await client.query(
      `INSERT INTO patients (user_id, patient_code)
       VALUES ($1, $2)`,
      [userId, patientCode]
    );

    await client.query('COMMIT');

    // Verification email intentionally not sent (verification deferred).
    // See deprecated verifyEmail handler below.

    res.json({ message: 'Registration successful.', patient_code: patientCode });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (e && e.code === '23505') {
      return res.status(400).json({ error: 'Email already in use.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Registration failed.' });
  } finally {
    client.release();
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
    if (found.rows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email already in use.' });
    }

    const hash = await hashPassword(password);
    // Doctor is immediately verified
    const userInsert = await client.query(`
      INSERT INTO users (name, email, password, role, email_verified)
      VALUES ($1, $2, $3, 'doctor', TRUE)
      RETURNING id
    `, [name, normalizedEmail, hash]);

    const userId = userInsert.rows[0].id;
    const doctorExists = (await client.query('SELECT 1 FROM doctors WHERE user_id=$1', [userId])).rowCount > 0;
    if (doctorExists) {
      await client.query(
        `UPDATE doctors
         SET specialty=COALESCE($1,specialty), phone=COALESCE($2,phone), bio=COALESCE($3,bio)
         WHERE user_id=$4`,
        [specialty || null, phone || null, bio || null, userId]
      );
    } else {
      await client.query(
        `INSERT INTO doctors (user_id, specialty, phone, bio)
         VALUES ($1, $2, $3, $4)`,
        [userId, specialty || null, phone || null, bio || null]
      );
    }

    await client.query('COMMIT');

    res.json({ message: 'Doctor registration successful.' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (e && e.code === '23505') {
      return res.status(400).json({ error: 'Email already in use.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Doctor registration failed.' });
  } finally {
    client.release();
  }
};

// --------- VERIFY EMAIL (DEPRECATED) ----------
// Email verification is deferred: registrations mark email_verified=TRUE and
// no codes are issued, so this path is dead. Kept as a 410 stub so old
// clients get a clear message instead of a confusing "invalid code" error.
exports.verifyEmail = async (req, res) => {
  return res.status(410).json({
    error: 'Email verification is no longer required. Your account is active — please log in.',
  });
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
    // M1: email_verified is optional — do NOT block login on it, so OAuth-
    // created and legacy-unverified accounts can sign in with a password.
    if (!user.password) return res.status(401).json({ error: 'Invalid credentials.' });
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
    // Generic response either way to avoid account-enumeration.
    const genericMsg = { message: 'If the account exists, you will receive instructions.' };
    const q = await pool.query('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
    if (!q.rows.length) return res.json(genericMsg);
    const user = q.rows[0];

    // M1: no email_verified gate — any existing account may reset.
    // Persist the code BEFORE sending mail so a crash between the two
    // cannot leave an emailed-but-unknown code.
    const code = generateCode();
    await pool.query(
      `UPDATE users SET reset_code=$1, reset_code_expires_at=NOW() + INTERVAL '15 minutes' WHERE id=$2`,
      [code, user.id]
    );
    try {
      await sendMail({
        to: normalizedEmail,
        from: process.env.FROM_EMAIL,
        subject: `[Hepziba] Password Reset`,
        text: `Your password reset code is: ${code}\nValid for 15 minutes.`
      });
    } catch (mailErr) {
      // Compensating rollback: clear the code the user never received so a
      // stale code cannot linger, then surface a retryable 500.
      console.error('forgotPassword mailer failure:', mailErr.message);
      await pool.query(
        `UPDATE users SET reset_code=NULL, reset_code_expires_at=NULL WHERE id=$1`,
        [user.id]
      );
      return res.status(500).json({ error: 'Could not send reset email, please try again.' });
    }
    res.json(genericMsg);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Reset initiation failed.' });
  }
};

// --------- RESET PASSWORD ----------
exports.resetPassword = async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) return res.status(400).json({ error: 'Missing field.' });
  if (String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  const normalizedEmail = String(email).trim().toLowerCase();

  try {
    // M1: no email_verified gate — reset works for any existing account.
    const q = await pool.query(
      `SELECT id, reset_code, reset_code_expires_at FROM users WHERE email=$1`,
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

// --------- GOOGLE LOGIN ----------
exports.googleLogin = async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'Missing id token.' });

  try {
    const googlePayload = await verifyGoogleIdToken(idToken);
    const normalizedEmail = String(googlePayload.email || '').trim().toLowerCase();
    if (!normalizedEmail) return res.status(400).json({ error: 'Email not found in Google token.' });

    const existing = await pool.query('SELECT * FROM users WHERE email=$1', [normalizedEmail]);

    if (existing.rows.length) {
      const user = existing.rows[0];
      if (!user.active) return res.status(401).json({ error: 'Account deactivated.' });
      if (user.role !== 'patient') return res.status(403).json({ error: 'Account role not allowed.' });

      if (!user.email_verified) {
        await pool.query(
          `UPDATE users
           SET email_verified=TRUE, verification_code=NULL, verification_code_expires_at=NULL
           WHERE id=$1`,
          [user.id]
        );
      }

      const patientExists = (await pool.query('SELECT 1 FROM patients WHERE user_id=$1', [user.id])).rowCount > 0;
      if (!patientExists) {
        const patientCode = generatePatientCode(user.id);
        await pool.query(
          `INSERT INTO patients (user_id, patient_code)
           VALUES ($1, $2)`,
          [user.id, patientCode]
        );
      }

      const token = signToken(user);
      return res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
    }

    const name = String(googlePayload.name || googlePayload.given_name || 'Patient').trim();
    // Throwaway secret — never emailed or shown; only to satisfy NOT NULL.
    const tempPassword = generateSecureToken(24);
    const hash = await hashPassword(tempPassword);

    const inserted = await pool.query(
      `INSERT INTO users (name, email, password, role, email_verified)
       VALUES ($1, $2, $3, 'patient', TRUE)
       RETURNING id, name, email, role`,
      [name, normalizedEmail, hash]
    );

    const user = inserted.rows[0];
    const patientCode = generatePatientCode(user.id);
    await pool.query(
      `INSERT INTO patients (user_id, patient_code)
       VALUES ($1, $2)`,
      [user.id, patientCode]
    );

    const token = signToken(user);
    return res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) {
    console.error(e);
    return res.status(401).json({ error: e instanceof Error ? e.message : 'Google login failed.' });
  }
};
