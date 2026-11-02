// The startup schema check must work against a real Postgres engine, not just
// a fake query. PGlite is disposable and in-memory; synthetic data only.
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { splitSql } = require('../helpers/sqlSplit');
const { checkRequiredSchema } = require('../../utils/schemaCheck');

const BACKEND_DIR = path.resolve(__dirname, '../..');
const REPO = fs.existsSync(path.join(BACKEND_DIR, '..', 'hepziba_schema.sql')) ? path.resolve(BACKEND_DIR, '..') : BACKEND_DIR;
const SQL_DIR = path.join(BACKEND_DIR, 'sql');

async function apply(db, file) {
  for (const stmt of splitSql(fs.readFileSync(file, 'utf8'))) {
    await db.exec(stmt);
  }
}

// 001 is known to fail twice on a fresh database (doctors, then prescriptions).
// Fail the test if the chain ever produces a different error.
async function apply001Expected(db) {
  const errors = [];
  for (const stmt of splitSql(fs.readFileSync(path.join(SQL_DIR, '001_hospital_alignment.sql'), 'utf8'))) {
    try {
      await db.exec(stmt);
    } catch (e) {
      errors.push(e.message);
    }
  }
  assert.equal(errors.length, 2, `001 errors: ${JSON.stringify(errors)}`);
  assert.match(errors[0], /relation "doctors" does not exist/);
  assert.match(errors[1], /relation "prescriptions" does not exist/);
}

const query = (db) => (sql, params) => db.query(sql, params);

test('reports missing objects on the base schema', async () => {
  const db = new PGlite();
  try {
    await apply(db, path.join(REPO, 'hepziba_schema.sql'));
    const result = await checkRequiredSchema(query(db));
    assert.equal(result.ok, false);
    const objects = result.missing.map((m) => m.object);
    assert.ok(objects.includes('table refresh_tokens'));
    assert.ok(objects.includes('table clinic_settings'));
    assert.ok(objects.includes('column users.password_changed_at'));
    assert.ok(objects.includes('column inventory_items.mrp'));
  } finally {
    await db.close();
  }
});

test('flags the legacy push-token shape before 009', async () => {
  const db = new PGlite();
  try {
    await apply(db, path.join(REPO, 'hepziba_schema.sql'));
    // 001 is expected to fail on a fresh DB; run it statement-by-statement.
    await apply001Expected(db);
    await apply(db, path.join(SQL_DIR, '002_fix_doctors_and_constraints.sql'));
    await apply(db, path.join(SQL_DIR, '004_repair_clinic_columns.sql'));
    for (const f of ['005_session_tokens.sql', '006_clinic_settings.sql', '007_inventory_mrp_expiry.sql', '008_billing_fee_push.sql']) {
      await apply(db, path.join(SQL_DIR, f));
    }
    const result = await checkRequiredSchema(query(db));
    assert.equal(result.ok, false);
    const objects = result.missing.map((m) => m.object);
    assert.ok(objects.includes('column patient_push_tokens.id'), `got ${JSON.stringify(objects)}`);
    assert.ok(objects.includes('column patient_push_tokens.platform'));
    assert.ok(objects.includes('column users.password_changed_at'));
  } finally {
    await db.close();
  }
});

test('passes after 010', async () => {
  const db = new PGlite();
  try {
    await apply(db, path.join(REPO, 'hepziba_schema.sql'));
    await apply001Expected(db);
    for (const f of ['002_fix_doctors_and_constraints.sql', '004_repair_clinic_columns.sql', '005_session_tokens.sql', '006_clinic_settings.sql', '007_inventory_mrp_expiry.sql', '008_billing_fee_push.sql', '009_consistency_hardening.sql', '010_policy_batch.sql']) {
      await apply(db, path.join(SQL_DIR, f));
    }
    const result = await checkRequiredSchema(query(db));
    assert.equal(result.ok, true, `missing: ${JSON.stringify(result.missing)}`);
  } finally {
    await db.close();
  }
});
