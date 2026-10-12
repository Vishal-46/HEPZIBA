require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors')
const app = express();
const port = process.env.PORT || 3000;

// Low-risk default headers for a JSON API. crossOriginResourcePolicy is
// disabled so a separately-hosted frontend (allowed via CORS below) can
// still read API responses; all other helmet defaults stay on.
app.use(require('helmet')({ crossOriginResourcePolicy: false }));

// Tightened CORS: explicit env allowlist, localhost fallback for dev.
// CORS_ORIGIN is a comma-separated list, e.g.
// CORS_ORIGIN=https://app.example.com,https://admin.example.com
// FRONTEND_URL is also honored when set.
const corsAllowlist = [
  ...(process.env.CORS_ORIGIN || '').split(','),
  process.env.FRONTEND_URL || '',
].map((s) => s.trim()).filter(Boolean);
const localhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // non-browser clients (curl, health checks)
    if (corsAllowlist.includes(origin)) return cb(null, true);
    if (corsAllowlist.length === 0 && localhostOrigin.test(origin)) return cb(null, true);
    // Deny by omitting CORS headers (browser blocks the response) rather
    // than erroring, so a disallowed origin never surfaces a 500.
    return cb(null, false);
  },
  credentials: true,
}));

// DB pool setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const errorHandler = require('./middleware/errorHandler');
app.use(express.json());

// Mount authentication endpoints
app.use('/auth', require('./auth/authRoutes'));
// Mount patient endpoints
app.use('/patients', require('./patients/patientRoutes'));
// Mount appointment endpoints
app.use('/appointments', require('./appointments/appointmentRoutes'));
// Mount doctor endpoints
app.use('/doctors', require('./doctors/doctorRoutes'));
// Mount admin endpoints
app.use('/admin', require('./admin/adminRoutes'));
// Mount prescription endpoints
app.use('/prescriptions', require('./prescriptions/prescriptionRoutes'));
// Mount billing endpoints
app.use('/billing', require('./billing/billingRoutes'));
// Mount inventory endpoints
app.use('/inventory', require('./inventory/inventoryRoutes'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Centralized Error Handling MUST be last
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Backend API running on port ${port}`);
  pool.connect().then(async (client) => {
    console.log('Connected to Postgres!');
    try {
      const res1 = await client.query('SELECT current_database(), current_schema(), current_user;');
      console.log('DB Debug Info:', res1.rows[0]);
      const res2 = await client.query("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema');");
      console.log('Visible Tables:', res2.rows);
      client.release();
    } catch (e) {
      console.error('Debug query error:', e.message);
      client.release();
    }
  }).catch(e => console.error('Postgres connection error:', e));
});

