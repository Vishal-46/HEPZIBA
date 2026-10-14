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

module.exports = pool;
