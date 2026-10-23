require('dotenv').config();
const { Pool } = require('pg');

// Serverless-friendly pooling:
// - Vercel reuses the module across warm invocations, so a single global
//   pool is correct (never create a pool per request).
// - max:1 avoids exhausting Supabase/pooler connections under concurrency.
// - Supabase pooler requires SSL; enabled automatically for non-local hosts.
const connectionString = process.env.DATABASE_URL || '';
const isLocalhost = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  max: process.env.DB_POOL_MAX ? Number(process.env.DB_POOL_MAX) : 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ...(isLocalhost ? {} : { ssl: { rejectUnauthorized: false } }),
});

// Non-blocking self-healing schema check on startup (ensures notes column and push tokens table exist)
pool.query(`
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes TEXT;
  CREATE TABLE IF NOT EXISTS patient_push_tokens (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`).catch((err) => {
  console.warn('Initial schema ensure notice:', err.message);
});

module.exports = pool;
