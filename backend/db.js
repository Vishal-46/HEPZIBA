require('dotenv').config();
const { Pool, types } = require('pg');
const { registerDbTypeParsers, isUtcZoneName } = require('./utils/dbTime');
const { checkRequiredSchema, formatMissingSchema } = require('./utils/schemaCheck');

// TIMESTAMP columns hold UTC wall-clock values and DATE columns are date-only;
// register both parsers so API responses do not shift with the host timezone.
registerDbTypeParsers(types);

// Serverless-friendly pooling:
// - Vercel reuses the module across warm invocations, so a single global
//   pool is correct (never create a pool per request).
// - max:1 avoids exhausting Supabase/pooler connections under concurrency.
// - Supabase pooler requires SSL; enabled automatically for non-local hosts.
const connectionString = process.env.DATABASE_URL || '';
const isLocalhost = /localhost|127\.0\.0\.1/.test(connectionString);

// Every connection must run in UTC: TIMESTAMP (without time zone) columns are
// written by `NOW()` and are interpreted as UTC by utils/dbTime.js. A session
// in another zone would store local wall-clock values and silently shift every
// timestamp. `options` is a libpq startup parameter supported by PostgreSQL and
// by PgBouncer >= 1.21 (Supabase session mode / direct connections).
//
// Some transaction-mode poolers reject startup `options`. For those, set
// DB_DISABLE_UTC_OPTIONS=1 and configure the default at the role/database
// level instead:
//   ALTER ROLE <app_user> SET timezone = 'UTC';
//   ALTER DATABASE <db> SET timezone = 'UTC';
// Startup verification below still enforces the invariant.
const utcOptionsDisabled = process.env.DB_DISABLE_UTC_OPTIONS === '1';

const pool = new Pool({
  connectionString,
  max: process.env.DB_POOL_MAX ? Number(process.env.DB_POOL_MAX) : 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ...(utcOptionsDisabled ? {} : { options: '-c timezone=UTC' }),
  ...(isLocalhost ? {} : { ssl: { rejectUnauthorized: false } }),
});

/**
 * Assert that a pooled session actually runs in UTC. Throws an actionable
 * error when the server default (or a pooler) overrides the startup option.
 */
async function verifyUtcSession() {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    if (!utcOptionsDisabled && /options|startup parameter/i.test(err.message || '')) {
      throw new Error(
        `could not open a UTC session (${err.message}). ` +
        'If your pooler rejects startup options, set DB_DISABLE_UTC_OPTIONS=1 and configure ' +
        "ALTER ROLE <app_user> SET timezone = 'UTC'; ALTER DATABASE <db> SET timezone = 'UTC';"
      );
    }
    throw err;
  }
  try {
    const { rows } = await client.query('SHOW TimeZone');
    const zone = rows[0] ? rows[0].TimeZone : '';
    if (!isUtcZoneName(zone)) {
      throw new Error(
        `database session TimeZone is "${zone}", expected UTC. ` +
        (utcOptionsDisabled
          ? 'DB_DISABLE_UTC_OPTIONS=1 is set, so configure the default instead: ' +
            "ALTER ROLE <app_user> SET timezone = 'UTC'; ALTER DATABASE <db> SET timezone = 'UTC';"
          : 'The pool startup option was overridden; remove DB_DISABLE_UTC_OPTIONS or fix the server default.')
      );
    }
    return zone;
  } finally {
    client.release();
  }
}

// Non-blocking, best-effort schema ensure for deployments that have not run
// the SQL migrations yet. Each statement is independent: a missing table in
// one statement must not prevent the others from being applied.
const ensureStatements = [
  `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS patient_push_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    platform TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ,
    UNIQUE (user_id, token)
  )`,
  // Upgrade the legacy one-token-per-user table (user_id PRIMARY KEY).
  `ALTER TABLE patient_push_tokens ADD COLUMN IF NOT EXISTS id BIGSERIAL`,
  `ALTER TABLE patient_push_tokens ADD COLUMN IF NOT EXISTS platform TEXT`,
  `ALTER TABLE patient_push_tokens ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE patient_push_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
  `ALTER TABLE patient_push_tokens ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`,
  `DO $$
   DECLARE pk_name text; pk_def text;
   BEGIN
     SELECT conname, pg_get_constraintdef(oid) INTO pk_name, pk_def
     FROM pg_constraint
     WHERE conrelid = 'patient_push_tokens'::regclass AND contype = 'p';
     IF pk_def LIKE '%(user_id)%' THEN
       EXECUTE format('ALTER TABLE patient_push_tokens DROP CONSTRAINT %I', pk_name);
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1
       FROM pg_index i
       JOIN pg_attribute a
         ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'patient_push_tokens'::regclass
         AND i.indisunique
         AND i.indisvalid
         AND i.indpred IS NULL
         AND i.indnkeyatts = 2
       GROUP BY i.indexrelid
       HAVING COUNT(*) = 2
          AND BOOL_AND(a.attname IN ('user_id', 'token'))
     ) THEN
       CREATE UNIQUE INDEX patient_push_tokens_user_token_key
         ON patient_push_tokens (user_id, token);
     END IF;
   END $$`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = 'patient_push_tokens'::regclass AND contype = 'p'
     ) THEN
       ALTER TABLE patient_push_tokens ADD PRIMARY KEY (id);
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS clinic_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `INSERT INTO clinic_settings (key, value)
   VALUES ('clinicHours', '{"openTime":"09:00","closeTime":"18:00","days":"Mon-Sat","slotMinutes":"15"}'::jsonb)
   ON CONFLICT (key) DO NOTHING`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS mrp NUMERIC(10,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE`,
  `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS doctor_fee NUMERIC(10,2) NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS appointment_status_corrections (
    id BIGSERIAL PRIMARY KEY,
    appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    previous_status TEXT NOT NULL,
    corrected_status TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT appointment_status_corrections_previous_check
      CHECK (previous_status IN ('done', 'cancelled')),
    CONSTRAINT appointment_status_corrections_corrected_check
      CHECK (corrected_status IN ('pending', 'confirmed')),
    CONSTRAINT appointment_status_corrections_reason_check
      CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500)
  )`,
  `CREATE INDEX IF NOT EXISTS appointment_status_corrections_appointment_idx
     ON appointment_status_corrections (appointment_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS appointment_reminders (
    id BIGSERIAL PRIMARY KEY,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    scheduled_for TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT appointment_reminders_appointment_unique UNIQUE (appointment_id)
  )`,
  `CREATE INDEX IF NOT EXISTS appointment_reminders_due_idx
     ON appointment_reminders (scheduled_for)
     WHERE sent_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS appointment_reminders_sent_idx
     ON appointment_reminders (sent_at)`,
  `CREATE INDEX IF NOT EXISTS idx_appointments_doctor_sched
     ON appointments (doctor_id, COALESCE(scheduled_at, date_time) DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_appointments_patient_sched
     ON appointments (patient_id, COALESCE(scheduled_at, date_time) DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_date
     ON prescriptions (patient_id, prescribed_on DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_patient_date
     ON invoices (patient_id, invoice_date DESC)`,
];

// In production, a partial schema is fatal. Outside production it is a loud
// warning so existing local workflows keep working; set SCHEMA_STRICT=1 to
// enforce it anywhere, or SCHEMA_STRICT=0 to downgrade in production.
function schemaStrictEnabled() {
  if (process.env.SCHEMA_STRICT === '1') return true;
  if (process.env.SCHEMA_STRICT === '0') return false;
  return process.env.NODE_ENV === 'production';
}

// Startup sequence:
//   1. prove the session is UTC (fatal unless DB_REQUIRE_UTC=0);
//   2. run the compatibility DDL (best effort, failures collected);
//   3. verify the objects the controllers need actually exist.
// `pool.ready` resolves only when the API is safe to serve traffic.
const ready = (async () => {
  let utcZone = null;
  try {
    utcZone = await verifyUtcSession();
  } catch (err) {
    if (process.env.DB_REQUIRE_UTC !== '0') throw err;
    console.error(`[db] WARNING: UTC session check failed (DB_REQUIRE_UTC=0): ${err.message}`);
  }

  const ensureFailures = [];
  for (let i = 0; i < ensureStatements.length; i += 1) {
    try {
      await pool.query(ensureStatements[i]);
    } catch (err) {
      ensureFailures.push({ index: i + 1, message: err?.message || String(err) });
      console.warn(`Schema ensure statement ${i + 1} skipped:`, err?.message);
    }
  }

  const schema = await checkRequiredSchema((sql, params) => pool.query(sql, params));
  if (!schema.ok) {
    const message = formatMissingSchema(schema.missing);
    if (schemaStrictEnabled()) throw new Error(message);
    console.warn(`[db] ${message}`);
  }

  return { utcZone, ensureFailures, schema };
})();

// Exposed so index.js / app.js can gate startup and requests on validation.
pool.ready = ready;
ready.catch((err) => {
  console.error(`[db] Startup validation failed: ${err.message}`);
  process.exitCode = 1;
});

module.exports = pool;
