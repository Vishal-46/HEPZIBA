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
    res.json(profile);
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
  } = req.body;
  try {
    if (email) {
      const duplicateEmail = await pool.query(
        'SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id <> $2',
        [email, req.user.id]
      );
      if (duplicateEmail.rows.length) {
        return res.status(400).json({ error: 'Email already in use.' });
      }
    }

    if (mobile && !/^\d{10,15}$/.test(String(mobile))) {
      return res.status(400).json({ error: 'Mobile must be 10-15 digits.' });
    }

    if (aadhar_number && !/^\d{12}$/.test(String(aadhar_number))) {
      return res.status(400).json({ error: 'Aadhar number must be 12 digits.' });
    }

    if (spo2 !== undefined && (Number(spo2) < 0 || Number(spo2) > 100)) {
      return res.status(400).json({ error: 'SpO2 must be between 0 and 100.' });
    }

    if (name)
      await pool.query('UPDATE users SET name=$1, updated_at=NOW() WHERE id=$2', [name, req.user.id]);
    if (email)
      await pool.query('UPDATE users SET email=$1, updated_at=NOW() WHERE id=$2', [email, req.user.id]);
    if (
      dob ||
      address ||
      age !== undefined ||
      sex ||
      mobile ||
      photo_url ||
      aadhar_number ||
      height_cm !== undefined ||
      weight_kg !== undefined ||
      bp ||
      spo2 !== undefined
    ) {
      // Upsert to patients
      const exists = (await pool.query('SELECT 1 FROM patients WHERE user_id=$1', [req.user.id])).rowCount > 0;
      if (exists) {
        await pool.query(
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
          [
            dob,
            address,
            age,
            sex,
            mobile,
            photo_url,
            aadhar_number,
            height_cm,
            weight_kg,
            bp,
            spo2,
            req.user.id,
          ]
        );
      } else {
        await pool.query(
          `INSERT INTO patients
          (user_id, dob, address, age, sex, mobile, photo_url, aadhar_number, height_cm, weight_kg, bp, spo2)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [req.user.id, dob, address, age, sex, mobile, photo_url, aadhar_number, height_cm, weight_kg, bp, spo2]
        );
      }
    }
    res.json({ message: 'Profile updated' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to update profile' });
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
        u.name,
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
      JOIN users u ON u.id = p.user_id
      ${whereClause}
      ORDER BY p.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list patients' });
  }
};

// Get full patient profile + EHR history (Admin & Doctor)
exports.getPatientById = async (req, res) => {
  try {
    const patientId = Number(req.params.id);
    if (!Number.isInteger(patientId)) return res.status(400).json({ error: 'Invalid patient ID' });

    const patientQ = await pool.query(
      `SELECT 
        p.id AS patient_id,
        p.id,
        p.user_id,
        p.patient_code,
        u.name,
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
      JOIN users u ON u.id = p.user_id
      WHERE p.id=$1`,
      [patientId]
    );

    if (!patientQ.rows.length) return res.status(404).json({ error: 'Patient not found' });
    const patient = patientQ.rows[0];

    // Recent appointments
    const appQ = await pool.query(
      `SELECT a.*, COALESCE(a.scheduled_at, a.date_time) AS scheduled_at_effective, du.name AS doctor_name
       FROM appointments a
       LEFT JOIN doctors d ON d.id = a.doctor_id
       LEFT JOIN users du ON du.id = d.user_id
       WHERE a.patient_id=$1
       ORDER BY COALESCE(a.scheduled_at, a.date_time) DESC
       LIMIT 15`,
      [patientId]
    );

    // Recent prescriptions
    const rxQ = await pool.query(
      `SELECT pr.*, json_agg(pi.*) AS items
       FROM prescriptions pr
       LEFT JOIN prescription_items pi ON pi.prescription_id = pr.id
       WHERE pr.patient_id=$1
       GROUP BY pr.id
       ORDER BY pr.prescribed_on DESC
       LIMIT 15`,
      [patientId]
    );

    // Recent invoices
    const invQ = await pool.query(
      `SELECT inv.*, json_agg(ii.*) AS items
       FROM invoices inv
       LEFT JOIN invoice_items ii ON ii.invoice_id = inv.id
       WHERE inv.patient_id=$1
       GROUP BY inv.id
       ORDER BY inv.invoice_date DESC
       LIMIT 15`,
      [patientId]
    );

    res.json({
      ...patient,
      appointments: appQ.rows,
      prescriptions: rxQ.rows.map(r => ({ ...r, items: (r.items && r.items[0] !== null) ? r.items : [] })),
      invoices: invQ.rows.map(r => ({ ...r, items: (r.items && r.items[0] !== null) ? r.items : [] }))
    });
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
    const pwdHash = await hashPassword(randomPwd);

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
    return res.status(201).json({
      message: 'Patient registered successfully',
      patient: {
        ...userQ.rows[0],
        ...patientQ.rows[0],
        patient_id: patientQ.rows[0].id,
      },
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

  if (mobile && !/^\d{10,15}$/.test(String(mobile).trim())) {
    return res.status(400).json({ error: 'Mobile must be 10-15 digits' });
  }
  if (aadhar_number && !/^\d{12}$/.test(String(aadhar_number).trim())) {
    return res.status(400).json({ error: 'Aadhar number must be 12 digits' });
  }
  if (spo2 !== undefined && spo2 !== null && spo2 !== '' && (Number(spo2) < 0 || Number(spo2) > 100)) {
    return res.status(400).json({ error: 'SpO2 must be between 0 and 100' });
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

