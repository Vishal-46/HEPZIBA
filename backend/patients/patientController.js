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
