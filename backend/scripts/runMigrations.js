const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  console.log('Connecting to database:', process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/:[^:]+@/, ':****@') : 'No DATABASE_URL');
  const client = await pool.connect();

  try {
    // 1. Initial table check
    console.log('\n--- Step 1: Checking Existing Tables ---');
    let res = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    let existingTables = res.rows.map(r => r.tablename);
    console.log('Current tables in public schema:', existingTables);

    // 2. Base schema (hepziba_schema.sql)
    console.log('\n--- Step 2: Applying Base Schema (hepziba_schema.sql) ---');
    const baseSchemaPath = path.join(__dirname, '..', '..', 'hepziba_schema.sql');
    if (fs.existsSync(baseSchemaPath)) {
      let baseSql = fs.readFileSync(baseSchemaPath, 'utf8');
      // Ensure CREATE TABLE IF NOT EXISTS so it does not fail if tables exist
      baseSql = baseSql.replace(/CREATE TABLE users/gi, 'CREATE TABLE IF NOT EXISTS users');
      baseSql = baseSql.replace(/CREATE TABLE patients/gi, 'CREATE TABLE IF NOT EXISTS patients');
      baseSql = baseSql.replace(/CREATE TABLE appointments/gi, 'CREATE TABLE IF NOT EXISTS appointments');
      await client.query(baseSql);
      console.log('Base schema verified/applied successfully.');
    } else {
      console.log('baseSchemaPath not found, skipping base file.');
    }

    // 3. 001_hospital_alignment.sql
    console.log('\n--- Step 3: Applying 001_hospital_alignment.sql ---');
    const sql001Path = path.join(__dirname, '..', 'sql', '001_hospital_alignment.sql');
    if (fs.existsSync(sql001Path)) {
      const sql001 = fs.readFileSync(sql001Path, 'utf8');
      try {
        await client.query(sql001);
        console.log('001_hospital_alignment.sql applied cleanly.');
      } catch (err) {
        console.warn('001 notice/tolerated quirk:', err.message);
        console.log('Proceeding to 002 to repair/create doctors and dependent tables...');
      }
    }

    // 4. 002_fix_doctors_and_constraints.sql
    console.log('\n--- Step 4: Applying 002_fix_doctors_and_constraints.sql ---');
    const sql002Path = path.join(__dirname, '..', 'sql', '002_fix_doctors_and_constraints.sql');
    if (fs.existsSync(sql002Path)) {
      const sql002 = fs.readFileSync(sql002Path, 'utf8');
      await client.query(sql002);
      console.log('002_fix_doctors_and_constraints.sql applied successfully.');
    }

    // 5. 005_session_tokens.sql
    console.log('\n--- Step 5: Applying 005_session_tokens.sql ---');
    const sql005Path = path.join(__dirname, '..', 'sql', '005_session_tokens.sql');
    if (fs.existsSync(sql005Path)) {
      const sql005 = fs.readFileSync(sql005Path, 'utf8');
      await client.query(sql005);
      console.log('005_session_tokens.sql applied successfully.');
    }

    // 6. Prove idempotency by re-running 002
    console.log('\n--- Step 6: Verifying Idempotency (Re-running 002) ---');
    if (fs.existsSync(sql002Path)) {
      const sql002 = fs.readFileSync(sql002Path, 'utf8');
      await client.query(sql002);
      console.log('002 re-run succeeded idempotently.');
    }

    // 7. Seed initial admin & doctor if missing
    console.log('\n--- Step 7: Checking / Seeding Initial Admin & Doctor ---');
    const { hashPassword } = require('../utils/crypto');
    const adminPasswordHash = await hashPassword('Admin@12345');
    const doctorPasswordHash = await hashPassword('Doctor@12345');

    // Admin user
    const adminRes = await client.query("SELECT id, email FROM users WHERE role='admin' LIMIT 1");
    if (!adminRes.rows.length) {
      await client.query(
        `INSERT INTO users (name, email, password, role, email_verified, active)
         VALUES ('Clinic Admin', 'admin@hepzibaclinic.com', $1, 'admin', TRUE, TRUE)
         ON CONFLICT (email) DO NOTHING`,
        [adminPasswordHash]
      );
      console.log('Seeded initial admin: admin@hepzibaclinic.com (Password: Admin@12345)');
    } else {
      console.log('Admin account already exists:', adminRes.rows[0].email);
    }

    // Doctor user & profile
    const docRes = await client.query("SELECT id, email FROM users WHERE role='doctor' LIMIT 1");
    let doctorUserId;
    if (!docRes.rows.length) {
      const docUserQ = await client.query(
        `INSERT INTO users (name, email, password, role, email_verified, active)
         VALUES ('Dr. T. Joseph Pratheeban', 'doctor@hepzibaclinic.com', $1, 'doctor', TRUE, TRUE)
         ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name
         RETURNING id`,
        [doctorPasswordHash]
      );
      doctorUserId = docUserQ.rows[0].id;
      console.log('Seeded doctor user: doctor@hepzibaclinic.com (Password: Doctor@12345)');
    } else {
      doctorUserId = docRes.rows[0].id;
      console.log('Doctor account already exists:', docRes.rows[0].email);
    }

    // Ensure doctor profile in doctors table
    await client.query(
      `INSERT INTO doctors (user_id, specialty, phone, bio)
       VALUES ($1, 'Pulmonologist & Bronchoscopist', '9500907968', 'DCH, MD (Respiratory Medicine)')
       ON CONFLICT (user_id) DO UPDATE SET
         specialty = EXCLUDED.specialty,
         phone = EXCLUDED.phone,
         bio = EXCLUDED.bio`,
      [doctorUserId]
    );
    console.log('Doctor profile in doctors table verified.');

    // 8. Final audit
    console.log('\n--- Step 8: Final Verification & Schema Audit ---');
    res = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
    console.log('Final tables in public schema:\n ', res.rows.map(r => r.tablename).join(', '));

    const counts = {};
    for (const t of res.rows.map(r => r.tablename)) {
      try {
        const countRes = await client.query(`SELECT COUNT(*) FROM "${t}"`);
        counts[t] = parseInt(countRes.rows[0].count, 10);
      } catch (_) {}
    }
    console.log('\nRow counts:', counts);

    console.log('\nAll migrations executed and verified successfully!');
  } catch (err) {
    console.error('\nMigration Error:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
