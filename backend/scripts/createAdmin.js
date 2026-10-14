const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { hashPassword } = require('../utils/crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function createAdmin() {
  const args = process.argv.slice(2);
  const name = args[0] || 'Clinic Admin';
  const email = (args[1] || 'admin@hepzibaclinic.com').toLowerCase().trim();
  const password = args[2] || 'Admin@12345';

  if (!email || !password) {
    console.error('Usage: node scripts/createAdmin.js "<Name>" "<Email>" "<Password>"');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const passwordHash = await hashPassword(password);
    const res = await client.query(
      `INSERT INTO users (name, email, password, role, email_verified, active)
       VALUES ($1, $2, $3, 'admin', TRUE, TRUE)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         password = EXCLUDED.password,
         role = 'admin',
         active = TRUE
       RETURNING id, name, email, role, created_at`,
      [name, email, passwordHash]
    );

    console.log('\nAdmin account ready:');
    console.log('  ID:      ', res.rows[0].id);
    console.log('  Name:    ', res.rows[0].name);
    console.log('  Email:   ', res.rows[0].email);
    console.log('  Password:', password);
    console.log('  Role:    ', res.rows[0].role);
    console.log('\nYou can now log in at http://localhost:5173 with these credentials.\n');
  } catch (err) {
    console.error('Failed to create admin:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

createAdmin();
