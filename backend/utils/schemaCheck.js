// Minimal required-schema validation for startup.
//
// The application historically ran best-effort DDL on boot (see db.js) and
// ignored failures, so it could serve traffic against a partially migrated
// database. This module checks for the objects that the running controllers
// actually require. It does not migrate anything and does not inspect data.
//
// The list is intentionally small and tied to the migration that introduces
// each object, so a failure message can tell the operator exactly what to run.
const REQUIRED_SCHEMA = [
  { kind: 'table', name: 'refresh_tokens', migration: '005_session_tokens.sql' },
  { kind: 'table', name: 'revoked_access_tokens', migration: '005_session_tokens.sql' },
  { kind: 'table', name: 'clinic_settings', migration: '006_clinic_settings.sql' },
  { kind: 'column', table: 'inventory_items', name: 'mrp', migration: '007_inventory_mrp_expiry.sql' },
  { kind: 'column', table: 'inventory_items', name: 'expiry_date', migration: '007_inventory_mrp_expiry.sql' },
  { kind: 'column', table: 'invoices', name: 'doctor_fee', migration: '008_billing_fee_push.sql' },
  { kind: 'column', table: 'users', name: 'password_changed_at', migration: '009_consistency_hardening.sql' },
  { kind: 'column', table: 'patient_push_tokens', name: 'id', migration: '009_consistency_hardening.sql' },
  { kind: 'column', table: 'patient_push_tokens', name: 'platform', migration: '009_consistency_hardening.sql' },
  { kind: 'column', table: 'patient_push_tokens', name: 'is_active', migration: '009_consistency_hardening.sql' },
  { kind: 'column', table: 'patient_push_tokens', name: 'last_seen_at', migration: '009_consistency_hardening.sql' },
  { kind: 'canonical_status_check', table: 'appointments', name: 'appointments_status_check', migration: '009_consistency_hardening.sql' },
  { kind: 'table', name: 'appointment_status_corrections', migration: '010_policy_batch.sql' },
  { kind: 'table', name: 'appointment_reminders', migration: '010_policy_batch.sql' },
];

const TABLE_SQL = 'SELECT to_regclass($1) IS NOT NULL AS ok';
const COLUMN_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped
) AS ok`;
const STATUS_CHECK_SQL = `SELECT pg_get_constraintdef(oid) AS def
  FROM pg_constraint
  WHERE conrelid = to_regclass($1) AND conname = $2`;

function describe(item) {
  if (item.kind === 'table') return `table ${item.name}`;
  if (item.kind === 'column') return `column ${item.table}.${item.name}`;
  return `constraint ${item.table}.${item.name}`;
}

/**
 * Check every required object. `query(sql, params)` must return `{ rows }`,
 * which lets tests supply a fake without a database.
 * @returns {Promise<{ok: boolean, missing: Array<{object: string, migration: string}>}>}
 */
async function checkRequiredSchema(query) {
  const missing = [];
  for (const item of REQUIRED_SCHEMA) {
    let present = false;
    try {
      if (item.kind === 'table') {
        const r = await query(TABLE_SQL, [item.name]);
        present = r.rows[0]?.ok === true;
      } else if (item.kind === 'column') {
        const r = await query(COLUMN_SQL, [item.table, item.name]);
        present = r.rows[0]?.ok === true;
      } else if (item.kind === 'canonical_status_check') {
        const r = await query(STATUS_CHECK_SQL, [item.table, item.name]);
        const def = r.rows[0]?.def || '';
        // Canonical CHECK allows `done` and rejects legacy `completed`.
        present = /done/.test(def) && !/'completed'/.test(def);
      }
    } catch (_err) {
      // A missing table makes the column/constraint query fail; treat it as
      // missing rather than crashing the checker.
      present = false;
    }
    if (!present) missing.push({ object: describe(item), migration: item.migration });
  }
  return { ok: missing.length === 0, missing };
}

function formatMissingSchema(missing) {
  const lines = missing.map((m) => `  - ${m.object} (required by ${m.migration})`);
  return [
    'Database schema is incomplete; the API would run against a partially migrated database.',
    'Missing:',
    ...lines,
    'Apply migrations in order: hepziba_schema.sql, then backend/sql/001-010',
    '(see backend/sql/README.md). Do not start the API until this check passes.',
  ].join('\n');
}

module.exports = {
  REQUIRED_SCHEMA,
  checkRequiredSchema,
  formatMissingSchema,
};
