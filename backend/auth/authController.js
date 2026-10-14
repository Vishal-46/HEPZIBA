const pool = require('../db');
const jwt = require('jsonwebtoken');
const https = require('https');
const crypto = require('crypto');
const { hashPassword, checkPassword, generateCode, generateSecureToken } = require('../utils/crypto');
const { sendMail } = require('../mailer/mailer');
const { verificationEmail, passwordResetEmail } = require('../mailer/templates');
const { generateUniquePatientCode } = require('../utils/patientCode');

// True when a 23505 unique violation concerns patients.patient_code.
// Inspects the constraint/detail when the driver provides them; a bare
// 23505 with no identifiable constraint is treated as a code collision by
// callers that insert for a brand-new user (their user_id cannot collide),
// while the existing-user googleLogin path disambiguates with a SELECT.
function isPatientCodeConflict(e) {
  if (!e || e.code !== '23505') return false;
  const hay = `${e.constraint || ''} ${e.detail || ''} ${e.message || ''}`;
  if (/patient_code/i.test(hay)) return true;
  if (/user_id/i.test(hay)) return false;
  return true;
}

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

  // The id_token audience equals the client ID of the platform that signed
  // in (web/android/ios/expo), so accept any configured ID. Empty list =
  // accept any Google-verified token (dev only; set IDs in production).
  const googleAudiences = [
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_ANDROID_CLIENT_ID,
    process.env.GOOGLE_IOS_CLIENT_ID,
    process.env.GOOGLE_EXPO_CLIENT_ID,
  ]
    .map((s) => (s || '').trim())
    .filter(Boolean);
  if (googleAudiences.length && !googleAudiences.includes(payload.aud)) {
    throw new Error('Google token audience mismatch');
  }

  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    throw new Error('Google email not verified');
  }

  return payload;
}

// --------- PATIENT REGISTRATION (with real email verification) ----------
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
    const code = generateCode();
    const inserted = await client.query(`
      INSERT INTO users (name, email, password, role, email_verified, verification_code, verification_code_expires_at)
      VALUES ($1,$2,$3,'patient',FALSE,$4,NOW() + INTERVAL '15 minutes')
      RETURNING id
    `, [name, normalizedEmail, hash, code]);

    const userId = inserted.rows[0].id;
    // Random non-sequential code; pre-checked for uniqueness via the txn client
    // so the check sees uncommitted rows from concurrent txns consistently.
    let patientCode = await generateUniquePatientCode(
      (sql, params) => client.query(sql, params)
    );

    // Plain INSERT: userId is brand-new so no patient row can exist yet.
    // Avoids ON CONFLICT(user_id) which requires UNIQUE(patients.user_id)
    // (added by 002 migration; older DBs without it throw 42P10).
    // Residual race: two concurrent registrations may pass the pre-check with
    // the same code; the loser gets 23505 on patient_code. Regenerate once
    // and retry. (user_id cannot collide here, so 23505 means patient_code.)
    try {
      await client.query(
        `INSERT INTO patients (user_id, patient_code)
         VALUES ($1, $2)`,
        [userId, patientCode]
      );
    } catch (patientInsertErr) {
      if (patientInsertErr && patientInsertErr.code === '23505') {
        patientCode = await generateUniquePatientCode(
          (sql, params) => client.query(sql, params)
        );
        await client.query(
          `INSERT INTO patients (user_id, patient_code)
           VALUES ($1, $2)`,
          [userId, patientCode]
        );
      } else {
        throw patientInsertErr;
      }
    }

    await client.query('COMMIT');

    try {
      const tpl = verificationEmail(code, { patientCode });
      await sendMail({
        to: normalizedEmail,
        from: process.env.FROM_EMAIL,
        subject: tpl.subject,
        text: tpl.text,
        html: tpl.html,
      });
    } catch (mailErr) {
      console.error('registerPatient mailer failure:', mailErr.message);
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[dev] verification code for ${normalizedEmail}: ${code} (valid 15 min)`);
      }
      // Account exists but email never arrived — client can resend.
      return res.status(201).json({
        message: 'Account created but verification email could not be sent. Please resend the code.',
        patient_code: patientCode,
        requiresVerification: true,
        mailSent: false,
      });
    }

    res.status(201).json({
      message: 'Account created. Verification code sent to your email.',
      patient_code: patientCode,
      requiresVerification: true,
      mailSent: true,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (e && e.code === '23505') {
      // Email conflicts come from the users INSERT above. A patient_code
      // collision surviving the regenerate-and-retry is vanishingly unlikely;
      // surface it as a 500 rather than misreporting "email in use".
      if (isPatientCodeConflict(e)) {
        console.error('registerPatient patient_code collision after retry:', e.detail || e.message);
        return res.status(500).json({ error: 'Registration failed.' });
      }
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

// --------- VERIFY EMAIL (real) ----------
exports.verifyEmail = async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Missing field.' });
  const normalizedEmail = String(email).trim().toLowerCase();
  const trimmedCode = String(code).trim();
  try {
    const q = await pool.query(
      `SELECT id, verification_code, verification_code_expires_at, email_verified FROM users WHERE email=$1`,
      [normalizedEmail]
    );
    if (!q.rows.length) return res.status(400).json({ error: 'Invalid code.' });
    const user = q.rows[0];
    if (user.email_verified) return res.json({ message: 'Email already verified. Please log in.' });
    if (!user.verification_code || user.verification_code !== trimmedCode ||
        !user.verification_code_expires_at || new Date(user.verification_code_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired code.' });
    }
    await pool.query(
      `UPDATE users SET email_verified=TRUE, verification_code=NULL, verification_code_expires_at=NULL WHERE id=$1`,
      [user.id]
    );
    res.json({ message: 'Email verified. Please log in.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Verification failed.' });
  }
};

// --------- RESEND VERIFICATION CODE ----------
exports.resendVerification = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing field.' });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const q = await pool.query(`SELECT id, email_verified FROM users WHERE email=$1`, [normalizedEmail]);
    if (!q.rows.length) return res.status(400).json({ error: 'Account not found. Please register.' });
    const user = q.rows[0];
    if (user.email_verified) return res.json({ message: 'Email already verified. Please log in.' });
    const code = generateCode();
    await pool.query(
      `UPDATE users SET verification_code=$1, verification_code_expires_at=NOW() + INTERVAL '15 minutes' WHERE id=$2`,
      [code, user.id]
    );
    try {
      const tpl = verificationEmail(code);
      await sendMail({
        to: normalizedEmail,
        from: process.env.FROM_EMAIL,
        subject: tpl.subject,
        text: tpl.text,
        html: tpl.html,
      });
    } catch (mailErr) {
      console.error('resendVerification mailer failure:', mailErr.message);
      if (process.env.NODE_ENV === 'production') {
        return res.status(500).json({ error: 'Could not send verification email, please try again.' });
      }
      console.log(`[dev] verification code for ${normalizedEmail}: ${code} (valid 15 min)`);
    }
    res.json({ message: 'Verification code resent to your email.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Resend failed.' });
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
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Email not verified. Please verify your email.', code: 'EMAIL_NOT_VERIFIED' });
    }
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
      const tpl = passwordResetEmail(code);
      await sendMail({
        to: normalizedEmail,
        from: process.env.FROM_EMAIL,
        subject: tpl.subject,
        text: tpl.text,
        html: tpl.html,
      });
    } catch (mailErr) {
      console.error('forgotPassword mailer failure:', mailErr.message);
      if (process.env.NODE_ENV === 'production') {
        // Prod: do not leave a code the user never received.
        await pool.query(
          `UPDATE users SET reset_code=NULL, reset_code_expires_at=NULL WHERE id=$1`,
          [user.id]
        );
        return res.status(500).json({ error: 'Could not send reset email, please try again.' });
      }
      // Dev: local networks often block outbound SMTP. Keep the stored code so
      // testing can continue, and print it to the backend console (dev only).
      console.log(`[dev] password-reset code for ${normalizedEmail}: ${code} (valid 15 min)`);
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

// --------- GOOGLE LOGIN (shared user find/create) ----------
// Takes a verified Google tokeninfo payload, finds or creates the patient,
// and returns { token, user }. Throws with .status for HTTP mapping.
async function findOrCreatePatientFromGooglePayload(googlePayload) {
  const normalizedEmail = String(googlePayload.email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    const err = new Error('Email not found in Google token.');
    err.status = 400;
    throw err;
  }

  const existing = await pool.query('SELECT * FROM users WHERE email=$1', [normalizedEmail]);

  if (existing.rows.length) {
    const user = existing.rows[0];
    if (!user.active) {
      const err = new Error('Account deactivated.');
      err.status = 401;
      throw err;
    }
    if (user.role !== 'patient') {
      const err = new Error('Account role not allowed.');
      err.status = 403;
      throw err;
    }

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
      const queryViaPool = (sql, params) => pool.query(sql, params);
      const patientCode = await generateUniquePatientCode(queryViaPool);
      try {
        await pool.query(
          `INSERT INTO patients (user_id, patient_code)
           VALUES ($1, $2)`,
          [user.id, patientCode]
        );
      } catch (patientInsertErr) {
        if (!patientInsertErr || patientInsertErr.code !== '23505') throw patientInsertErr;
        // Residual race — re-check before retrying:
        // - user_id conflict (concurrent login created the row first):
        //   the record now exists, so continue login without retrying.
        // - patient_code conflict: regenerate once and retry the insert.
        const nowExists =
          (await pool.query('SELECT 1 FROM patients WHERE user_id=$1', [user.id])).rowCount > 0;
        if (nowExists) {
          // Concurrent creation won — nothing more to do.
        } else if (isPatientCodeConflict(patientInsertErr)) {
          const retryCode = await generateUniquePatientCode(queryViaPool);
          await pool.query(
            `INSERT INTO patients (user_id, patient_code)
             VALUES ($1, $2)`,
            [user.id, retryCode]
          );
        } else {
          throw patientInsertErr;
        }
      }
    }

    const token = signToken(user);
    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
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
  // Random non-sequential code, pre-checked for uniqueness via pool.
  const queryViaPool = (sql, params) => pool.query(sql, params);
  let patientCode = await generateUniquePatientCode(queryViaPool);
  // Residual race: same-code concurrent insert yields 23505 on
  // patient_code (user_id is brand-new, so it cannot collide here).
  // Regenerate once and retry.
  try {
    await pool.query(
      `INSERT INTO patients (user_id, patient_code)
       VALUES ($1, $2)`,
      [user.id, patientCode]
    );
  } catch (patientInsertErr) {
    if (patientInsertErr && patientInsertErr.code === '23505') {
      patientCode = await generateUniquePatientCode(queryViaPool);
      await pool.query(
        `INSERT INTO patients (user_id, patient_code)
         VALUES ($1, $2)`,
        [user.id, patientCode]
      );
    } else {
      throw patientInsertErr;
    }
  }

  const token = signToken(user);
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
}

// --------- GOOGLE LOGIN (legacy direct idToken POST; kept for compat) ----------
exports.googleLogin = async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'Missing id token.' });

  try {
    const googlePayload = await verifyGoogleIdToken(idToken);
    const session = await findOrCreatePatientFromGooglePayload(googlePayload);
    return res.json(session);
  } catch (e) {
    console.error(e);
    const status = e && e.status ? e.status : 401;
    return res.status(status).json({ error: e instanceof Error ? e.message : 'Google login failed.' });
  }
};

// --------- GOOGLE OAUTH VIA BACKEND (no Expo proxy) ----------
// Google only ever sees the backend redirect URI, so the mobile app never
// needs frontend client IDs or an expo-auth-session redirect like
// exp://192.168.x.x:8081 (which Google blocks with 400 invalid_request).
function getGoogleOAuthConfig() {
  return {
    clientId: (process.env.GOOGLE_CLIENT_ID || '').trim(),
    clientSecret: (process.env.GOOGLE_CLIENT_SECRET || '').trim(),
    redirectUri: (process.env.GOOGLE_REDIRECT_URI || '').trim(),
    defaultReturnTo: (process.env.MOBILE_GOOGLE_REDIRECT || 'patient-mobile://auth').trim(),
  };
}

// Only allow returning the JWT to our own app schemes — prevents open-redirect.
function isAllowedMobileRedirect(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  return (
    u.startsWith('patient-mobile://') ||
    u.startsWith('exp://') ||
    u.startsWith('http://localhost') ||
    u.startsWith('http://127.0.0.1') ||
    u.startsWith('http://192.168.') ||
    u.startsWith('http://10.')
  );
}

// Stateless OAuth state (Vercel-safe): no in-memory Map, since serverless
// invocations may hit different lambdas. state = base64url(payload).sig where
// payload = { r: returnTo, n: nonce, iat } and sig = HMAC-SHA256(JWT_SECRET).
// 10-min TTL, single-use is best-effort (no server store on serverless).
function b64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function b64urlDecode(str) {
  return JSON.parse(Buffer.from(String(str), 'base64url').toString('utf8'));
}
function createOAuthState(returnTo) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  const payload = b64urlEncode({
    r: returnTo,
    n: crypto.randomBytes(16).toString('hex'),
    iat: Date.now(),
  });
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function consumeOAuthState(state) {
  try {
    if (!state || typeof state !== 'string' || !process.env.JWT_SECRET) return null;
    const [payload, sig] = state.split('.');
    if (!payload || !sig) return null;
    const expected = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = b64urlDecode(payload);
    if (!data || typeof data.r !== 'string') return null;
    if (Date.now() - Number(data.iat || 0) > 10 * 60 * 1000) return null;
    if (!isAllowedMobileRedirect(data.r)) return null;
    return data.r;
  } catch {
    return null;
  }
}

async function exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && (data.error_description || data.error)) || 'Google code exchange failed');
  }
  if (!data || !data.id_token) throw new Error('Google did not return an ID token');
  return data;
}

function redirectWithError(res, returnTo, message) {
  const sep = returnTo.includes('?') ? '&' : '?';
  return res.redirect(`${returnTo}${sep}error=${encodeURIComponent(message)}`);
}

// GET /auth/google/start?redirect=<mobile-deep-link>
// e.g. redirect=patient-mobile://auth  (prod) or exp://192.168.x.x:8081/--/auth (Expo Go dev)
exports.startGoogleOAuth = async (req, res) => {
  const { clientId, clientSecret, redirectUri, defaultReturnTo } = getGoogleOAuthConfig();
  const requested = typeof req.query.redirect === 'string' ? req.query.redirect : '';
  const returnTo = isAllowedMobileRedirect(requested) ? requested : defaultReturnTo;

  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(500).json({
      error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI on the backend.',
    });
  }

  let state;
  try {
    state = createOAuthState(returnTo);
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : 'OAuth state failed.' });
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    access_type: 'online',
    state,
  });
  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
};

// GET /auth/google/callback?code=...&state=...
exports.googleOAuthCallback = async (req, res) => {
  const { clientId, clientSecret, redirectUri, defaultReturnTo } = getGoogleOAuthConfig();
  const { code, state, error } = req.query;

  // State is single-use; fall back to the default scheme when unknown.
  const returnTo = (typeof state === 'string' && consumeOAuthState(state)) || defaultReturnTo;

  if (error) return redirectWithError(res, returnTo, String(error));
  if (!code || typeof code !== 'string') return redirectWithError(res, returnTo, 'Google login was cancelled.');
  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(500).json({ error: 'Google OAuth is not configured on the backend.' });
  }

  try {
    const tokens = await exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri });
    const googlePayload = await verifyGoogleIdToken(tokens.id_token);
    const session = await findOrCreatePatientFromGooglePayload(googlePayload);

    const params = new URLSearchParams({
      token: session.token,
      id: String(session.user.id),
      name: session.user.name,
      email: session.user.email,
      role: session.user.role,
    });
    const sep = returnTo.includes('?') ? '&' : '?';
    return res.redirect(`${returnTo}${sep}${params.toString()}`);
  } catch (e) {
    console.error('googleOAuthCallback:', e && e.message);
    return redirectWithError(res, returnTo, (e instanceof Error ? e.message : 'Google login failed.'));
  }
};
