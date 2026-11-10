const pool = require('../db');
const { maskPatientContact, maskPatientContacts, shouldRevealContact } = require('../utils/pii');

// Register/update this patient's Expo push token for visit notifications.
exports.savePushToken = async (req, res) => {
  const token = req.body && req.body.token !== undefined && req.body.token !== null
    ? String(req.body.token).trim()
    : '';
  const isExpoToken =
    /^ExponentPushToken\[[^\]]+\]$/.test(token) ||
    /^ExpoPushToken\[[^\]]+\]$/.test(token) ||
    /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(token);
  if (!token || !isExpoToken) {
    return res.status(400).json({ error: 'Invalid push token' });
  }
  const platform = req.body && typeof req.body.platform === 'string'
    ? req.body.platform.trim().slice(0, 20) || null
    : null;
  const client = await pool.connect().catch(() => null);
  if (!client) {
    return res.status(500).json({ error: 'Failed to save push token' });
  }
  try {
    await client.query('BEGIN');
    // A physical device token can be active for exactly one account. Without
    // this, logging in as a second user on the same phone leaves the first
    // user's row active, and the device receives both accounts' notifications.
    await client.query(
      `UPDATE patient_push_tokens
          SET is_active = FALSE,
              updated_at = NOW()
        WHERE token = $1
          AND user_id <> $2
          AND is_active IS TRUE`,
      [token, req.user.id]
    );
    // Single upsert: UNIQUE (user_id, token) is created by migration 009 /
    // the startup schema ensure. Multiple devices per patient are supported.
    await client.query(
      `INSERT INTO patient_push_tokens (user_id, token, platform, is_active, created_at, updated_at, last_seen_at)
       VALUES ($1, $2, $3, TRUE, NOW(), NOW(), NOW())
       ON CONFLICT (user_id, token) DO UPDATE
       SET is_active = TRUE,
           platform = COALESCE(EXCLUDED.platform, patient_push_tokens.platform),
           updated_at = NOW(),
           last_seen_at = NOW()`,
      [req.user.id, token, platform]
    );
    await client.query('COMMIT');
    return res.json({ message: 'Push token saved.' });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Failed to save push token:', e.message);
    return res.status(500).json({ error: 'Failed to save push token' });
  } finally {
    client.release();
  }
};

// Deactivate this account's push token(s), e.g. on logout or account switch.
// Only the caller's own rows can be touched; other users' tokens are never
// deleted or reassigned. Rows are kept (is_active = FALSE) for auditability.
exports.removePushToken = async (req, res) => {
  const raw = req.body && req.body.token !== undefined && req.body.token !== null
    ? String(req.body.token).trim()
    : '';
  try {
    const q = raw
      ? await pool.query(
          `UPDATE patient_push_tokens
              SET is_active = FALSE, updated_at = NOW()
            WHERE user_id = $1 AND token = $2 AND is_active IS TRUE`,
          [req.user.id, raw]
        )
      : await pool.query(
          `UPDATE patient_push_tokens
              SET is_active = FALSE, updated_at = NOW()
            WHERE user_id = $1 AND is_active IS TRUE`,
          [req.user.id]
        );
    return res.json({ message: 'Push token deactivated.', deactivated: q.rowCount });
  } catch (e) {
    console.error('Failed to remove push token:', e.message);
    return res.status(500).json({ error: 'Failed to remove push token' });
  }
};

// Send a test push notification to this patient's registered device(s)
exports.testPush = async (req, res) => {
  try {
    const { tokensForUser, sendPush } = require('../utils/push');
    const tokens = await tokensForUser(req.user.id);
    if (!tokens.length) {
      return res.status(400).json({
        error: 'No push tokens found for your account. Please open the mobile app on a physical device and ensure notifications are enabled.',
      });
    }
    await sendPush(tokens, 'Hepziba Clinic', 'Test Notification: Push notifications are working properly!');
    return res.json({ message: 'Test notification sent successfully.' });
  } catch (e) {
    console.error('testPush error:', e.message);
    return res.status(500).json({ error: 'Failed to send test push' });
  }
};

// Get profile of the logged-in patient
exports.getMe = async (req, res) => {
  // req.user is set by roleAuth middleware
  try {
    // Get user info
    const userQ = await pool.query('SELECT id, name, email, role, created_at, updated_at FROM users WHERE id=$1', [req.user.id]);
    if (!userQ.rows.length || userQ.rows[0].role !== 'patient')
      return res.status(404).json({ error: 'Not found' });

    // Get patient info
    const patientQ = await pool.query(
      `SELECT
        id AS patient_id,
        patient_code,
        age,
        sex,
        dob,
        address,
        mobile,
        photo_url,
        aadhar_number,
        height_cm,
        weight_kg,
        bp,
        spo2
       FROM patients
       WHERE user_id=$1`,
      [req.user.id]
    );
    const profile = { ...userQ.rows[0], ...patientQ.rows[0] };
    // Aadhaar/mobile are masked by default. The owner may request the original
    // values for the profile editor via `?reveal=contact` (role: patient only).
    res.json(shouldRevealContact(req, ['patient']) ? profile : maskPatientContact(profile));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
};

// Update profile of the logged-in patient
exports.updateMe = async (req, res) => {
  const {
    name,
    email,
    age,
    sex,
    dob,
    address,
    mobile,
    photo_url,
    aadhar_number,
    height_cm,
    weight_kg,
    bp,
    spo2,
  } = req.body || {};

  const cleanName = name !== undefined && name !== null ? String(name).trim() : '';
  if (name !== undefined && name !== null && !cleanName) {
    return res.status(400).json({ error: 'Name cannot be empty.' });
  }
  const cleanEmail = email !== undefined && email !== null ? String(email).trim().toLowerCase() : '';
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  const cleanMobile = mobile !== undefined && mobile !== null ? String(mobile).trim() : '';
  if (cleanMobile && !/^\d{10,15}$/.test(cleanMobile)) {
    return res.status(400).json({ error: 'Mobile must be 10-15 digits.' });
  }
  const cleanAadhaar = aadhar_number !== undefined && aadhar_number !== null
    ? String(aadhar_number).trim()
    : '';
  if (cleanAadhaar && !/^\d{12}$/.test(cleanAadhaar)) {
    return res.status(400).json({ error: 'Aadhar number must be 12 digits.' });
  }
  if (spo2 !== undefined && spo2 !== null && String(spo2).trim() !== '') {
    const n = Number(spo2);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return res.status(400).json({ error: 'SpO2 must be a whole number between 0 and 100.' });
    }
  }
  if (age !== undefined && age !== null && String(age).trim() !== '') {
    const n = Number(age);
    if (!Number.isInteger(n) || n < 0 || n > 150) {
      return res.status(400).json({ error: 'Age must be a whole number between 0 and 150.' });
    }
  }
  for (const [label, value] of [['Height', height_cm], ['Weight', weight_kg]]) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: `${label} must be a positive number.` });
      }
    }
  }

  const nullableNumber = (value) =>
    value === undefined || value === null || String(value).trim() === '' ? null : Number(value);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (cleanEmail) {
      const duplicateEmail = await client.query(
        'SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id <> $2',
        [cleanEmail, req.user.id]
      );
      if (duplicateEmail.rows.length) {
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

    // Keep the patient row in sync. COALESCE preserves existing values when a
    // field was not supplied, so partial profile saves never erase data.
    const exists = (await client.query('SELECT 1 FROM patients WHERE user_id=$1', [req.user.id])).rowCount > 0;
    const patientValues = [
      dob || null,
      address !== undefined && address !== null ? String(address).trim() : null,
      nullableNumber(age),
      sex !== undefined && sex !== null ? String(sex).trim() : null,
      cleanMobile || null,
      photo_url !== undefined && photo_url !== null ? String(photo_url).trim() : null,
      cleanAadhaar || null,
      nullableNumber(height_cm),
      nullableNumber(weight_kg),
      bp !== undefined && bp !== null ? String(bp).trim() : null,
      nullableNumber(spo2),
      req.user.id,
    ];
    if (exists) {
      await client.query(
        `UPDATE patients
         SET dob=COALESCE($1,dob),
             address=COALESCE($2,address),
             age=COALESCE($3,age),
             sex=COALESCE($4,sex),
             mobile=COALESCE($5,mobile),
             photo_url=COALESCE($6,photo_url),
             aadhar_number=COALESCE($7,aadhar_number),
             height_cm=COALESCE($8,height_cm),
             weight_kg=COALESCE($9,weight_kg),
             bp=COALESCE($10,bp),
             spo2=COALESCE($11,spo2)
         WHERE user_id=$12`,
        patientValues
      );
    } else {
      await client.query(
        `INSERT INTO patients
         (dob, address, age, sex, mobile, photo_url, aadhar_number, height_cm, weight_kg, bp, spo2, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        patientValues
      );
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

// List/search patients (Admin & Doctor)
exports.listPatients = async (req, res) => {
  try {
    let limit = Number(req.query.limit ?? 50);
    let offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1) limit = 50;
    if (limit > 100) limit = 100;
    if (!Number.isInteger(offset) || offset < 0) offset = 0;
    const q = req.query.q ? String(req.query.q).trim() : '';

    let whereClause = '';
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      whereClause = `WHERE (u.name ILIKE $1 OR p.patient_code ILIKE $1 OR p.mobile ILIKE $1 OR p.aadhar_number ILIKE $1)`;
    }

    const query = `
      SELECT 
        p.id AS patient_id,
        p.id,
        p.user_id,
        p.patient_code,
        COALESCE(u.name, p.patient_code, 'Patient #' || p.id) AS name,
        u.email,
        p.age,
        p.sex,
        p.dob,
        p.address,
        p.mobile,
        p.photo_url,
        p.aadhar_number,
        p.height_cm,
        p.weight_kg,
        p.bp,
        p.spo2,
        u.created_at
      FROM patients p
      -- LEFT JOIN: legacy/imported patient rows may have no linked user
      -- account. An inner join hid them from the admin + doctor lists.
      LEFT JOIN users u ON u.id = p.user_id
      ${whereClause}
      ORDER BY p.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    // Search still matches the stored mobile/Aadhaar values, but the response
    // never carries them unless an admin explicitly asks (`?reveal=contact`).
    res.json(shouldRevealContact(req, ['admin']) ? result.rows : maskPatientContacts(result.rows));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list patients' });
  }
};

function parseEhrWindow(req, prefix, defaultLimit = 15, maxLimit = 50) {
  let limit = Number(req.query[`${prefix}_limit`] ?? req.query.limit ?? defaultLimit);
  let offset = Number(req.query[`${prefix}_offset`] ?? req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  if (!Number.isInteger(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

// Get full patient profile + EHR history (Admin & Doctor)
exports.getPatientById = async (req, res) => {
  try {
    const patientId = Number(req.params.id);
    if (!Number.isInteger(patientId)) return res.status(400).json({ error: 'Invalid patient ID' });

    const only = typeof req.query.only === 'string' ? req.query.only.trim().toLowerCase() : '';
    const apptWin = parseEhrWindow(req, 'appt');
    const rxWin = parseEhrWindow(req, 'rx');
    const invWin = parseEhrWindow(req, 'inv');

    const patientQ = await pool.query(
      `SELECT 
        p.id AS patient_id,
        p.id,
        p.user_id,
        p.patient_code,
        COALESCE(u.name, p.patient_code, 'Patient #' || p.id) AS name,
        u.email,
        p.age,
        p.sex,
        p.dob,
        p.address,
        p.mobile,
        p.photo_url,
        p.aadhar_number,
        p.height_cm,
        p.weight_kg,
        p.bp,
        p.spo2,
        u.created_at
      FROM patients p
      -- LEFT JOIN: a legacy patient without a login account must still open in
      -- the chart (EHR), otherwise the history is unreachable.
      LEFT JOIN users u ON u.id = p.user_id
      WHERE p.id=$1`,
      [patientId]
    );

    if (!patientQ.rows.length) return res.status(404).json({ error: 'Patient not found' });
    const patient = patientQ.rows[0];

    // Policy: doctors only see invoices for patients assigned to them (an
    // appointment row links the two). The rest of the chart stays clinic-wide
    // as documented in docs/Hospital Details.md. Admin sees all invoices.
    let canSeeInvoices = req.user.role === 'admin';
    if (req.user.role === 'doctor') {
      const docQ = await pool.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
      if (!docQ.rows.length) return res.status(403).json({ error: 'Forbidden' });
      const assignedQ = await pool.query(
        'SELECT 1 FROM appointments WHERE patient_id=$1 AND doctor_id=$2 LIMIT 1',
        [patientId, docQ.rows[0].id]
      );
      canSeeInvoices = assignedQ.rows.length > 0;
    }

    // Batched appointments (fetch limit + 1 to detect whether more exist)
    let appointments = [];
    let appointmentsHasMore = false;
    if (!only || only === 'appointments') {
      const appQ = await pool.query(
        `SELECT a.*, COALESCE(a.scheduled_at, a.date_time) AS scheduled_at_effective, du.name AS doctor_name
         FROM appointments a
         LEFT JOIN doctors d ON d.id = a.doctor_id
         LEFT JOIN users du ON du.id = d.user_id
         WHERE a.patient_id=$1
         ORDER BY COALESCE(a.scheduled_at, a.date_time) DESC, a.id DESC
         LIMIT $2 OFFSET $3`,
        [patientId, apptWin.limit + 1, apptWin.offset]
      );
      appointmentsHasMore = appQ.rows.length > apptWin.limit;
      appointments = appQ.rows.slice(0, apptWin.limit);
    }

    // Batched prescriptions with joined doctor_name and ordered items
    let prescriptions = [];
    let prescriptionsHasMore = false;
    if (!only || only === 'prescriptions') {
      const rxQ = await pool.query(
        `SELECT pr.*,
                COALESCE(pr.doctor_name, du.name) AS doctor_name,
                COALESCE(json_agg(pi.* ORDER BY pi.id ASC) FILTER (WHERE pi.id IS NOT NULL), '[]'::json) AS items
         FROM prescriptions pr
         LEFT JOIN doctors d ON d.id = pr.doctor_id
         LEFT JOIN users du ON du.id = d.user_id
         LEFT JOIN prescription_items pi ON pi.prescription_id = pr.id
         WHERE pr.patient_id=$1
         GROUP BY pr.id, du.name
         ORDER BY pr.prescribed_on DESC, pr.id DESC
         LIMIT $2 OFFSET $3`,
        [patientId, rxWin.limit + 1, rxWin.offset]
      );
      prescriptionsHasMore = rxQ.rows.length > rxWin.limit;
      prescriptions = rxQ.rows.slice(0, rxWin.limit).map((r) => ({
        ...r,
        items: Array.isArray(r.items) ? r.items : [],
      }));
    }

    // Batched invoices (skipped entirely when the caller is not allowed to see
    // them, so an unrelated doctor cannot read billing data from the chart).
    let invoiceRows = [];
    let invoicesHasMore = false;
    if (canSeeInvoices && (!only || only === 'invoices')) {
      const invQ = await pool.query(
        `SELECT inv.*,
                COALESCE(json_agg(ii.* ORDER BY ii.id ASC) FILTER (WHERE ii.id IS NOT NULL), '[]'::json) AS items
         FROM invoices inv
         LEFT JOIN invoice_items ii ON ii.invoice_id = inv.id
         WHERE inv.patient_id=$1
         GROUP BY inv.id
         ORDER BY inv.invoice_date DESC, inv.id DESC
         LIMIT $2 OFFSET $3`,
        [patientId, invWin.limit + 1, invWin.offset]
      );
      invoicesHasMore = invQ.rows.length > invWin.limit;
      invoiceRows = invQ.rows.slice(0, invWin.limit).map((r) => ({
        ...r,
        items: Array.isArray(r.items) ? r.items : [],
      }));
    }

    const chart = {
      ...patient,
      appointments,
      appointments_has_more: appointmentsHasMore,
      prescriptions,
      prescriptions_has_more: prescriptionsHasMore,
      invoices: invoiceRows,
      invoices_has_more: invoicesHasMore,
    };
    // Aadhaar/mobile masked by default; admins may ask for originals when
    // editing demographics (`?reveal=contact`). Doctors always get masked.
    res.json(shouldRevealContact(req, ['admin']) ? chart : maskPatientContact(chart));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch patient details' });
  }
};

// Register walk-in patient by Admin (Full demographic & clinical vitals)
exports.registerWalkin = async (req, res) => {
  const crypto = require('crypto');
  const { hashPassword } = require('../utils/crypto');
  const { generateUniquePatientCode } = require('../utils/patientCode');

  const {
    name,
    email,
    password,
    age,
    sex,
    dob,
    address,
    mobile,
    photo_url,
    aadhar_number,
    height_cm,
    weight_kg,
    bp,
    spo2,
  } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Patient name is required' });
  }

  if (mobile && !/^\d{10,15}$/.test(String(mobile).trim())) {
    return res.status(400).json({ error: 'Mobile must be 10-15 digits' });
  }

  if (aadhar_number && !/^\d{12}$/.test(String(aadhar_number).trim())) {
    return res.status(400).json({ error: 'Aadhar number must be 12 digits' });
  }

  if (spo2 !== undefined && spo2 !== null && spo2 !== '' && (Number(spo2) < 0 || Number(spo2) > 100)) {
    return res.status(400).json({ error: 'SpO2 must be between 0 and 100' });
  }

  if (email !== undefined && email !== null && String(email).trim() !== '' &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  if (age !== undefined && age !== null && age !== '' &&
      (!Number.isInteger(Number(age)) || Number(age) < 0 || Number(age) > 150)) {
    return res.status(400).json({ error: 'Age must be a whole number between 0 and 150' });
  }

  for (const [label, value] of [['Height', height_cm], ['Weight', weight_kg]]) {
    if (value !== undefined && value !== null && value !== '' &&
        (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
      return res.status(400).json({ error: `${label} must be a positive number` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let cleanEmail = email && String(email).trim() ? String(email).trim().toLowerCase() : null;
    if (cleanEmail) {
      const dup = await client.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [cleanEmail]);
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Email already in use' });
      }
    } else {
      cleanEmail = `walkin_${Date.now()}_${crypto.randomInt(1000, 9999)}@hepzibaclinic.local`;
    }

    const randomPwd = crypto.randomBytes(16).toString('hex');
    // Optional app password set by reception: patient signs into the mobile
    // app with this + the email above. Without it, the patient uses Google
    // sign-in (same email) or Forgot password to set one.
    let appPasswordSet = false;
    let pwdHash;
    if (password !== undefined && password !== null && String(password).trim() !== '') {
      if (String(password).length < 8) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'App password must be at least 8 characters.' });
      }
      pwdHash = await hashPassword(String(password));
      appPasswordSet = true;
    } else {
      pwdHash = await hashPassword(randomPwd);
    }

    const userQ = await client.query(
      `INSERT INTO users (name, email, password, role, active, email_verified)
       VALUES ($1, $2, $3, 'patient', TRUE, TRUE)
       RETURNING id, name, email, role, created_at`,
      [String(name).trim(), cleanEmail, pwdHash]
    );
    const userId = userQ.rows[0].id;

    const patientCode = await generateUniquePatientCode((sql, params) => client.query(sql, params));

    const patientQ = await client.query(
      `INSERT INTO patients
       (user_id, patient_code, dob, address, age, sex, mobile, photo_url, aadhar_number, height_cm, weight_kg, bp, spo2)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        userId,
        patientCode,
        dob || null,
        address ? String(address).trim() : null,
        age !== undefined && age !== null && age !== '' ? Number(age) : null,
        sex ? String(sex).trim() : null,
        mobile ? String(mobile).trim() : null,
        photo_url ? String(photo_url).trim() : null,
        aadhar_number ? String(aadhar_number).trim() : null,
        height_cm !== undefined && height_cm !== null && height_cm !== '' ? Number(height_cm) : null,
        weight_kg !== undefined && weight_kg !== null && weight_kg !== '' ? Number(weight_kg) : null,
        bp ? String(bp).trim() : null,
        spo2 !== undefined && spo2 !== null && spo2 !== '' ? Number(spo2) : null,
      ]
    );

    await client.query('COMMIT');
    const realEmail = !cleanEmail.includes('@hepzibaclinic.local');
    return res.status(201).json({
      message: realEmail
        ? (appPasswordSet
          ? 'Patient registered. They sign into the app with this email + the password you set (Google sign-in with the same email also works).'
          : 'Patient registered. They sign into the app with Google using this email, or Forgot password to set one.')
        : 'Patient registered with a placeholder email — add their real email later so they can sign into the app.',
      patient: maskPatientContact({
        ...userQ.rows[0],
        ...patientQ.rows[0],
        patient_id: patientQ.rows[0].id,
      }),
      login: { email: userQ.rows[0].email, hasPassword: appPasswordSet, googleReady: realEmail },
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(e);
    return res.status(500).json({ error: 'Failed to register patient' });
  } finally {
    client.release();
  }
};

// Update patient by ID (Admin)
exports.updatePatientById = async (req, res) => {
  const patientId = Number(req.params.id);
  if (!Number.isInteger(patientId)) return res.status(400).json({ error: 'Invalid patient ID' });

  const {
    name,
    email,
    age,
    sex,
    dob,
    address,
    mobile,
    photo_url,
    aadhar_number,
    height_cm,
    weight_kg,
    bp,
    spo2,
  } = req.body;

  if (email !== undefined && email !== null && String(email).trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  if (mobile && !/^\d{10,15}$/.test(String(mobile).trim())) {
    return res.status(400).json({ error: 'Mobile must be 10-15 digits' });
  }
  if (aadhar_number && !/^\d{12}$/.test(String(aadhar_number).trim())) {
    return res.status(400).json({ error: 'Aadhar number must be 12 digits' });
  }
  if (spo2 !== undefined && spo2 !== null && spo2 !== '' && (Number(spo2) < 0 || Number(spo2) > 100)) {
    return res.status(400).json({ error: 'SpO2 must be between 0 and 100' });
  }
  if (age !== undefined && age !== null && age !== '' &&
      (!Number.isInteger(Number(age)) || Number(age) < 0 || Number(age) > 150)) {
    return res.status(400).json({ error: 'Age must be a whole number between 0 and 150' });
  }
  for (const [label, value] of [['Height', height_cm], ['Weight', weight_kg]]) {
    if (value !== undefined && value !== null && value !== '' &&
        (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
      return res.status(400).json({ error: `${label} must be a positive number` });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pQ = await client.query('SELECT user_id FROM patients WHERE id=$1', [patientId]);
    if (!pQ.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Patient not found' });
    }
    const userId = pQ.rows[0].user_id;

    if (name) {
      await client.query('UPDATE users SET name=$1, updated_at=NOW() WHERE id=$2', [String(name).trim(), userId]);
    }

    // Attach a real email later so a placeholder walk-in account can sign
    // into the app (Google with the same email, or password login).
    if (email !== undefined && email !== null && String(email).trim() !== '') {
      const cleanEmail = String(email).trim().toLowerCase();
      const dup = await client.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2', [cleanEmail, userId]);
      if (dup.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Email already in use' });
      }
      await client.query('UPDATE users SET email=$1, updated_at=NOW() WHERE id=$2', [cleanEmail, userId]);
    }

    await client.query(
      `UPDATE patients
       SET dob=COALESCE($1,dob),
           address=COALESCE($2,address),
           age=COALESCE($3,age),
           sex=COALESCE($4,sex),
           mobile=COALESCE($5,mobile),
           photo_url=COALESCE($6,photo_url),
           aadhar_number=COALESCE($7,aadhar_number),
           height_cm=COALESCE($8,height_cm),
           weight_kg=COALESCE($9,weight_kg),
           bp=COALESCE($10,bp),
           spo2=COALESCE($11,spo2)
       WHERE id=$12`,
      [
        dob || null,
        address !== undefined ? String(address).trim() : null,
        age !== undefined && age !== '' ? Number(age) : null,
        sex !== undefined ? String(sex).trim() : null,
        mobile !== undefined ? String(mobile).trim() : null,
        photo_url !== undefined ? String(photo_url).trim() : null,
        aadhar_number !== undefined ? String(aadhar_number).trim() : null,
        height_cm !== undefined && height_cm !== '' ? Number(height_cm) : null,
        weight_kg !== undefined && weight_kg !== '' ? Number(weight_kg) : null,
        bp !== undefined ? String(bp).trim() : null,
        spo2 !== undefined && spo2 !== '' ? Number(spo2) : null,
        patientId,
      ]
    );

    await client.query('COMMIT');
    res.json({ message: 'Patient updated successfully' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(e);
    res.status(500).json({ error: 'Failed to update patient' });
  } finally {
    client.release();
  }
};

