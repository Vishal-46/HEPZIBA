'use strict';

// The startup schema check must distinguish a fully migrated database from a
// partially migrated one, and its failure message must name the migration that
// provides each missing object. No database is needed: `query` is injected.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_SCHEMA,
  checkRequiredSchema,
  formatMissingSchema,
} = require('../utils/schemaCheck');

function fakeQuery({ tables = [], columns = [], statusCheck = null } = {}) {
  return async (sql, params) => {
    if (sql.includes('to_regclass($1) IS NOT NULL')) {
      return { rows: [{ ok: tables.includes(params[0]) }] };
    }
    if (sql.includes('FROM pg_attribute')) {
      return { rows: [{ ok: columns.includes(`${params[0]}.${params[1]}`) }] };
    }
    if (sql.includes('FROM pg_constraint')) {
      return { rows: statusCheck === null ? [] : [{ def: statusCheck }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
}

const ALL_TABLES = REQUIRED_SCHEMA.filter((i) => i.kind === 'table').map((i) => i.name);
const ALL_COLUMNS = REQUIRED_SCHEMA.filter((i) => i.kind === 'column').map((i) => `${i.table}.${i.name}`);
const CANONICAL_CHECK = "CHECK (((status IS NULL) OR (status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'done'::text, 'cancelled'::text]))))";

test('reports ok when every required object exists', async () => {
  const result = await checkRequiredSchema(fakeQuery({
    tables: ALL_TABLES,
    columns: ALL_COLUMNS,
    statusCheck: CANONICAL_CHECK,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('reports a missing table with the migration that creates it', async () => {
  const result = await checkRequiredSchema(fakeQuery({
    tables: ALL_TABLES.filter((t) => t !== 'refresh_tokens'),
    columns: ALL_COLUMNS,
    statusCheck: CANONICAL_CHECK,
  }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [
    { object: 'table refresh_tokens', migration: '005_session_tokens.sql' },
  ]);
});

test('reports every missing column, not just the first', async () => {
  const missingColumns = ['users.password_changed_at', 'patient_push_tokens.is_active'];
  const result = await checkRequiredSchema(fakeQuery({
    tables: ALL_TABLES,
    columns: ALL_COLUMNS.filter((c) => !missingColumns.includes(c)),
    statusCheck: CANONICAL_CHECK,
  }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.map((m) => m.object), [
    'column users.password_changed_at',
    'column patient_push_tokens.is_active',
  ]);
});

test('rejects the legacy status CHECK (allows completed, not done)', async () => {
  const legacy = "CHECK ((status = ANY (ARRAY['completed'::text, 'pending'::text])))";
  const result = await checkRequiredSchema(fakeQuery({
    tables: ALL_TABLES,
    columns: ALL_COLUMNS,
    statusCheck: legacy,
  }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [{
    object: 'constraint appointments.appointments_status_check',
    migration: '009_consistency_hardening.sql',
  }]);
});

test('treats a missing table as missing rather than throwing', async () => {
  // A real database raises "relation does not exist" for the column probe once
  // the table is gone; the checker must continue and report the table.
  const query = async (sql, params) => {
    if (sql.includes('FROM pg_attribute')) {
      if (params[0] === 'patient_push_tokens') throw new Error('relation "patient_push_tokens" does not exist');
      return { rows: [{ ok: true }] };
    }
    if (sql.includes('to_regclass($1) IS NOT NULL')) {
      return { rows: [{ ok: params[0] !== 'clinic_settings' }] };
    }
    return { rows: [{ def: CANONICAL_CHECK }] };
  };
  const result = await checkRequiredSchema(query);
  assert.equal(result.ok, false);
  assert.ok(result.missing.some((m) => m.object === 'table clinic_settings'));
  assert.ok(result.missing.some((m) => m.object === 'column patient_push_tokens.id'));
});

test('failure text names each migration and the required order', () => {
  const message = formatMissingSchema([
    { object: 'column users.password_changed_at', migration: '009_consistency_hardening.sql' },
  ]);
  assert.match(message, /partially migrated/);
  assert.match(message, /column users\.password_changed_at/);
  assert.match(message, /009_consistency_hardening\.sql/);
  assert.match(message, /001-010/);
});
