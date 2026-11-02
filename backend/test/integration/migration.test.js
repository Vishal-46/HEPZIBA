// Migration chain validation against disposable PGlite (Postgres WASM).
//
// Replays hepziba_schema.sql + migrations 001-010 statement-by-statement,
// mimicking `psql -f` (autocommit per statement, continue on error). Synthetic
// fixtures only: no production connection, no .env, no network.
//
// Run with: npm run test:integration
// Prerequisite: @electric-sql/pglite (declared in devDependencies).
const fs = require('fs');
const path = require('path');
const { test: nodeTest } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const { splitSql } = require('../helpers/sqlSplit');

const BACKEND_DIR = path.resolve(__dirname, '../..');
const REPO = fs.existsSync(path.join(BACKEND_DIR, '..', 'hepziba_schema.sql')) ? path.resolve(BACKEND_DIR, '..') : BACKEND_DIR;
const SQL_DIR = path.join(BACKEND_DIR, 'sql');
const BASE = path.join(REPO, 'hepziba_schema.sql');

// Each scenario registers its checks as node:test subtests, so a failure is
// reported individually and makes `npm test` exit non-zero.
function scenarioCheck(t) {
  return (name, fn) => t.test(name, fn);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function applyFile(db, file, { continueOnError = false } = {}) {
  const sql = fs.readFileSync(file, 'utf8');
  const stmts = splitSql(sql);
  const errors = [];
  for (const s of stmts) {
    try {
      await db.exec(s);
    } catch (e) {
      errors.push({ snippet: s.slice(0, 70).replace(/\s+/g, ' '), message: e.message });
      if (!continueOnError) throw new Error(`${path.basename(file)} failed: ${e.message}\n  SQL: ${s.slice(0, 200)}`);
    }
  }
  return errors;
}

async function count(db, table, where = '', params = []) {
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM ${table} ${where}`, params);
  return r.rows[0].n;
}

async function constraintDef(db, table, name) {
  const r = await db.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = $2`,
    [table, name]
  );
  return r.rows[0] ? r.rows[0].def : null;
}

async function columnInfo(db, table, column) {
  const r = await db.query(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return r.rows[0] || null;
}

// Seed a realistic pre-009 state. `statuses` are appointment statuses to insert.
// IDs are read back from the inserted rows: real databases may have advanced
// sequences, so fixtures must never assume user/patient ids start at 1.
async function seedLegacy(db, statuses) {
  const doctorUser = await db.query(
    `INSERT INTO users (name, email, password, role)
     VALUES ('Doctor One', 'doctor1@example.test', 'x', 'doctor') RETURNING id`
  );
  const patientUser1 = await db.query(
    `INSERT INTO users (name, email, password, role)
     VALUES ('Patient One', 'patient1@example.test', 'x', 'patient') RETURNING id`
  );
  const patientUser2 = await db.query(
    `INSERT INTO users (name, email, password, role)
     VALUES ('Patient Two', 'patient2@example.test', 'x', 'patient') RETURNING id`
  );
  const patient1 = await db.query(
    'INSERT INTO patients (user_id) VALUES ($1) RETURNING id',
    [patientUser1.rows[0].id]
  );
  const patient2 = await db.query(
    'INSERT INTO patients (user_id) VALUES ($1) RETURNING id',
    [patientUser2.rows[0].id]
  );

  const doctorUserId = doctorUser.rows[0].id;
  const patientUserIds = [patientUser1.rows[0].id, patientUser2.rows[0].id];
  const patientIds = [patient1.rows[0].id, patient2.rows[0].id];

  for (let i = 0; i < statuses.length; i += 1) {
    // Before 002 retargets the FK, appointments.doctor_id references users(id),
    // so the seeded value is the doctor *user* id (002 remaps it).
    await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, date_time, status)
       VALUES ($1, $2, NOW(), $3)`,
      [patientIds[i % patientIds.length], doctorUserId, statuses[i]]
    );
  }

  return { doctorUserId, patientUserIds, patientIds };
}

async function baseAnd001(db) {
  await applyFile(db, BASE);
  const errs001 = await applyFile(db, path.join(SQL_DIR, '001_hospital_alignment.sql'), { continueOnError: true });
  // Expected on a fresh DB, in this order:
  //   1. prescriptions references doctors before 002 creates it;
  //   2. prescription_items then references the missing prescriptions table.
  // Anything else means the chain is no longer in the state this harness models.
  const expected = [
    /relation "doctors" does not exist/,
    /relation "prescriptions" does not exist/,
  ];
  assert(
    errs001.length === expected.length,
    `001 produced ${errs001.length} error(s), expected ${expected.length}: ${JSON.stringify(errs001)}`
  );
  expected.forEach((re, i) => {
    assert(re.test(errs001[i].message), `001 error ${i + 1} unexpected: ${errs001[i].message}`);
  });
  return errs001;
}

async function runRest(db, { run002 = true } = {}) {
  if (run002) {
    await applyFile(db, path.join(SQL_DIR, '002_fix_doctors_and_constraints.sql'));
    // 004 is a no-op on a fresh DB but is part of the documented order; running
    // it here keeps the harness honest about the sequence operators are told to use.
    await applyFile(db, path.join(SQL_DIR, '004_repair_clinic_columns.sql'));
  }
  for (const f of ['005_session_tokens.sql', '006_clinic_settings.sql', '007_inventory_mrp_expiry.sql', '008_billing_fee_push.sql']) {
    await applyFile(db, path.join(SQL_DIR, f));
  }
}

async function run009(db) {
  return applyFile(db, path.join(SQL_DIR, '009_consistency_hardening.sql'));
}

// Simulates the recommended `psql --single-transaction -f`: every statement in
// one transaction, rolled back on the first error.
async function run009InTransaction(db) {
  const stmts = splitSql(fs.readFileSync(path.join(SQL_DIR, '009_consistency_hardening.sql'), 'utf8'));
  await db.exec('BEGIN');
  try {
    for (const s of stmts) await db.exec(s);
    await db.exec('COMMIT');
    return null;
  } catch (e) {
    await db.exec('ROLLBACK');
    return e;
  }
}

async function scenarioA(t) {
  const check = scenarioCheck(t);
  const db = new PGlite();
  await baseAnd001(db);
  const ids = await seedLegacy(db, ['completed', 'pending']);
  await runRest(db); // 002 must skip canonical CHECK because `completed` exists
  assert((await constraintDef(db, 'appointments', 'appointments_status_check')) === null,
    'precondition: 002 should not add CHECK while completed rows exist');

  const tokenUserId = ids.patientUserIds[0];
  await db.query(
    `INSERT INTO patient_push_tokens (user_id, token) VALUES ($1, 'ExponentPushToken[legacyA]')`,
    [tokenUserId]
  );
  await run009(db);

  await check('A1 legacy completed migrated to done', async () => {
    assert(await count(db, 'appointments', `WHERE status = 'completed'`) === 0, 'completed rows remain');
    assert(await count(db, 'appointments', `WHERE status = 'done'`) === 1, 'done row missing');
    assert(await count(db, 'appointments', `WHERE status = 'pending'`) === 1, 'pending row changed');
  });

  await check('A2 canonical CHECK rebuilt and rejects completed', async () => {
    const def = await constraintDef(db, 'appointments', 'appointments_status_check');
    assert(def && /done/.test(def), `CHECK missing or wrong: ${def}`);
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO appointments (patient_id, date_time, status) VALUES ($1, NOW(), 'completed')`,
        [ids.patientIds[0]]
      );
    } catch { rejected = true; }
    assert(rejected, 'CHECK did not reject legacy completed');
  });

  await check('A3 password_changed_at added (timestamptz, nullable)', async () => {
    const c = await columnInfo(db, 'users', 'password_changed_at');
    assert(c, 'column missing');
    assert(/timestamp with time zone/.test(c.data_type), `wrong type: ${c.data_type}`);
  });

  await check('A4 push token legacy row preserved + multi-device insert works', async () => {
    assert(await count(db, 'patient_push_tokens') === 1, 'legacy token lost');
    const before = await db.query(`SELECT id, token FROM patient_push_tokens WHERE user_id = $1`, [tokenUserId]);
    assert(before.rows[0].id != null, 'legacy row has no id');
    await db.query(
      `INSERT INTO patient_push_tokens (user_id, token) VALUES ($1, 'ExponentPushToken[deviceB]')`,
      [tokenUserId]
    );
    assert(await count(db, 'patient_push_tokens', 'WHERE user_id = $1', [tokenUserId]) === 2, 'second device rejected');
  });

  await check('A5 push token (user_id, token) unique enforced', async () => {
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO patient_push_tokens (user_id, token) VALUES ($1, 'ExponentPushToken[legacyA]')`,
        [tokenUserId]
      );
    } catch { rejected = true; }
    assert(rejected, 'duplicate (user_id, token) accepted');
  });

  await check('A6 patient_push_tokens has id PK and no user_id PK', async () => {
    const pk = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'patient_push_tokens'::regclass AND contype = 'p'`
    );
    assert(pk.rows.length === 1, `expected one PK, got ${pk.rows.length}`);
    assert(/\(id\)/.test(pk.rows[0].def), `PK is not id: ${pk.rows[0].def}`);
  });

  await check('A7 009 is idempotent on re-run', async () => {
    const errs = await run009(db);
    assert(errs.length === 0, `errors on re-run: ${JSON.stringify(errs)}`);
    assert(await count(db, 'appointments', `WHERE status = 'done'`) === 1, 'data changed on re-run');
    assert(await count(db, 'patient_push_tokens', 'WHERE user_id = $1', [tokenUserId]) === 2, 'tokens changed on re-run');
  });

  await db.close();
}

async function scenarioB(t) {
  const check = scenarioCheck(t);
  const db = new PGlite();
  await baseAnd001(db);
  await seedLegacy(db, ['completed']);
  // Simulate the old deployed constraint.
  await db.exec(`ALTER TABLE appointments ADD CONSTRAINT appointments_status_check CHECK (status IN ('completed'))`);
  await runRest(db); // 002 sees the constraint name and skips
  assert((await constraintDef(db, 'appointments', 'appointments_status_check')) !== null,
    'precondition: old CHECK should exist');

  await run009(db);

  await check('B1 009 drops old CHECK before migrating, then rebuilds canonical', async () => {
    assert(await count(db, 'appointments', `WHERE status = 'completed'`) === 0, 'completed remains');
    const def = await constraintDef(db, 'appointments', 'appointments_status_check');
    assert(def && /done/.test(def), `CHECK not rebuilt: ${def}`);
  });

  await check('B2 re-run still idempotent', async () => {
    const errs = await run009(db);
    assert(errs.length === 0, `errors: ${JSON.stringify(errs)}`);
  });

  await db.close();
}

async function scenarioC(t) {
  const check = scenarioCheck(t);
  const db = new PGlite();
  await baseAnd001(db);
  const ids = await seedLegacy(db, ['completed', 'no-show']);
  await runRest(db);
  assert((await constraintDef(db, 'appointments', 'appointments_status_check')) === null,
    'precondition: no CHECK should exist while unexpected values are present');

  // psql continues after an error by default; capture the abort instead of
  // letting the harness throw, so the follow-up assertions still run.
  const errs = await applyFile(db, path.join(SQL_DIR, '009_consistency_hardening.sql'), { continueOnError: true });

  await check('C1 009 aborts before schema changes on an unsupported status', async () => {
    assert(errs.length === 1, `expected exactly one error, got ${JSON.stringify(errs)}`);
    assert(/unsupported status/i.test(errs[0].message), `unclear error: ${errs[0].message}`);
    assert(/no-show/.test(errs[0].message), `error does not name the value: ${errs[0].message}`);
  });

  await check('C2 no destructive change: completed NOT migrated, no CHECK added', async () => {
    assert(await count(db, 'appointments', `WHERE status = 'completed'`) === 1, 'completed was migrated despite abort');
    assert(await count(db, 'appointments', `WHERE status = 'done'`) === 0, 'done row appeared despite abort');
    const def = await constraintDef(db, 'appointments', 'appointments_status_check');
    assert(def === null, `CHECK should not be added on abort, got: ${def}`);
  });

  await check('C3 all records preserved (no deletion)', async () => {
    assert(await count(db, 'appointments') === 2, 'appointment rows were lost');
  });

  await check('C4 after mapping the value, a re-run migrates and enforces the CHECK', async () => {
    await db.exec(`UPDATE appointments SET status = 'cancelled' WHERE status = 'no-show'`);
    const rerun = await run009(db);
    assert(rerun.length === 0, `re-run failed: ${JSON.stringify(rerun)}`);
    assert(await count(db, 'appointments', `WHERE status = 'completed'`) === 0, 'completed remains');
    assert(await count(db, 'appointments', `WHERE status = 'done'`) === 1, 'done missing');
    assert(await count(db, 'appointments', `WHERE status = 'cancelled'`) === 1, 'mapped row lost');
    assert(await count(db, 'appointments') === 2, 'rows lost during re-run');
    const def = await constraintDef(db, 'appointments', 'appointments_status_check');
    assert(def && /done/.test(def), `canonical CHECK missing: ${def}`);
  });

  await check('C5 garbage is rejected after the recovered migration', async () => {
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO appointments (patient_id, date_time, status) VALUES ($1, NOW(), 'totally-invalid')`,
        [ids.patientIds[0]]
      );
    } catch { rejected = true; }
    assert(rejected, 'CHECK did not reject garbage after recovery');
  });

  await db.close();
}

async function scenarioC2(t) {
  const check = scenarioCheck(t);
  const db = new PGlite();
  await baseAnd001(db);
  await seedLegacy(db, ['completed', 'no-show']);
  await runRest(db);
  // A NOT VALID constraint can coexist with rows it would reject. Add it after
  // 002's backfills, which would otherwise re-validate it.
  await db.exec(`ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
    CHECK (status IN ('completed')) NOT VALID`);
  const before = await constraintDef(db, 'appointments', 'appointments_status_check');
  assert(before !== null, 'precondition: old CHECK should exist');

  const errs = await applyFile(db, path.join(SQL_DIR, '009_consistency_hardening.sql'), { continueOnError: true });

  await check('C2.1 abort leaves the existing CHECK in place', async () => {
    assert(errs.length === 1, `expected one error, got ${JSON.stringify(errs)}`);
    const after = await constraintDef(db, 'appointments', 'appointments_status_check');
    assert(after === before, `CHECK changed on abort: before=${before} after=${after}`);
  });

  await check('C2.2 abort preserves both rows and their statuses', async () => {
    assert(await count(db, 'appointments', `WHERE status = 'completed'`) === 1, 'completed row changed');
    assert(await count(db, 'appointments', `WHERE status = 'no-show'`) === 1, 'no-show row changed');
  });

  await check('C2.3 recovery replaces the old CHECK atomically', async () => {
    // The old (NOT VALID) CHECK still enforces new writes, so it must be
    // dropped before mapping — exactly what the abort message says.
    await db.exec(`ALTER TABLE appointments DROP CONSTRAINT appointments_status_check`);
    await db.exec(`UPDATE appointments SET status = 'cancelled' WHERE status = 'no-show'`);
    const rerun = await run009(db);
    assert(rerun.length === 0, `re-run failed: ${JSON.stringify(rerun)}`);
    const def = await constraintDef(db, 'appointments', 'appointments_status_check');
    assert(def && /done/.test(def), `old CHECK not replaced: ${def}`);
    assert(await count(db, 'appointments') === 2, 'rows lost during recovery');
  });

  await db.close();
}

async function scenarioF(t) {
  const check = scenarioCheck(t);
  const db = new PGlite();
  await baseAnd001(db);
  await seedLegacy(db, ['completed', 'no-show']);
  await runRest(db);
  const tokenCountBefore = await count(db, 'patient_push_tokens');

  const err = await run009InTransaction(db);
  await check('F1 transactional run aborts with a clear error', async () => {
    assert(err, 'expected the transaction to abort');
    assert(/unsupported status/i.test(err.message), `unclear error: ${err.message}`);
  });

  await check('F2 nothing from 009 is applied after rollback', async () => {
    // Section 2/3 columns must not exist because the whole file rolled back.
    const pw = await columnInfo(db, 'users', 'password_changed_at');
    assert(pw === null, 'password_changed_at leaked despite rollback');
    const platform = await columnInfo(db, 'patient_push_tokens', 'platform');
    assert(platform === null, 'push-token column leaked despite rollback');
    assert(await count(db, 'patient_push_tokens') === tokenCountBefore, 'push-token rows changed');
    assert(await count(db, 'appointments', `WHERE status = 'completed'`) === 1, 'status rows changed');
    const def = await constraintDef(db, 'appointments', 'appointments_status_check');
    assert(def === null, 'status CHECK unexpectedly added');
  });

  await check('F3 after mapping, the transactional run applies cleanly', async () => {
    await db.exec(`UPDATE appointments SET status = 'cancelled' WHERE status = 'no-show'`);
    const ok = await run009InTransaction(db);
    assert(ok === null, `transaction failed: ${ok && ok.message}`);
    assert((await columnInfo(db, 'users', 'password_changed_at')) !== null, 'password_changed_at missing');
    assert(await count(db, 'appointments', `WHERE status = 'done'`) === 1, 'completed not migrated');
    const def = await constraintDef(db, 'appointments', 'appointments_status_check');
    assert(def && /done/.test(def), `canonical CHECK missing: ${def}`);
  });

  await db.close();
}

async function scenarioD(t) {
  const check = scenarioCheck(t);
  const db = new PGlite();
  await baseAnd001(db);
  await seedLegacy(db, ['pending']);
  await runRest(db);
  // 008 creates the legacy shape; emulate a DB provisioned by db.js's new-shape DDL instead.
  await db.exec(`DROP TABLE patient_push_tokens`);
  await db.exec(`CREATE TABLE patient_push_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    platform TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ,
    UNIQUE (user_id, token)
  )`);
  const errs = await run009(db);
  await check('D1 009 works on already-new-shape push table', async () => {
    assert(errs.length === 0, `errors: ${JSON.stringify(errs)}`);
    const pk = await db.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid='patient_push_tokens'::regclass AND contype='p'`);
    assert(pk.rows.length === 1 && /\(id\)/.test(pk.rows[0].def), `bad PK: ${JSON.stringify(pk.rows)}`);
  });
  await check('D2 no duplicate unique indexes/constraints for (user_id, token)', async () => {
    const r = await db.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='patient_push_tokens' AND indexdef LIKE '%(user_id, token)%'`
    );
    assert(r.rows.length === 1, `expected 1 unique index, got ${r.rows.length}: ${JSON.stringify(r.rows)}`);
  });
  await db.close();
}

async function scenarioE(t) {
  const check = scenarioCheck(t);
  const db = new PGlite();
  await baseAnd001(db);
  const ids = await seedLegacy(db, ['pending']);
  await runRest(db);
  const tokenUserId = ids.patientUserIds[0];
  await db.exec(`DROP TABLE patient_push_tokens`);
  await db.exec(`CREATE TABLE patient_push_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL,
    platform TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ
  )`);
  await db.exec(`CREATE UNIQUE INDEX push_partial ON patient_push_tokens (user_id, token) WHERE is_active`);
  const errs = await run009(db);
  await check('E1 009 adds a full unique index when only a partial one exists', async () => {
    assert(errs.length === 0, `errors: ${JSON.stringify(errs)}`);
    const r = await db.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename='patient_push_tokens'
          AND indexdef LIKE 'CREATE UNIQUE INDEX%'
          AND indexdef LIKE '%(user_id, token)%'`
    );
    const full = r.rows.filter((row) => !/WHERE/.test(row.indexdef));
    assert(full.length >= 1, `no full unique index: ${JSON.stringify(r.rows)}`);
  });
  await check('E2 ON CONFLICT (user_id, token) upsert works after 009', async () => {
    await db.query(
      `INSERT INTO patient_push_tokens (user_id, token, platform, is_active, created_at, updated_at, last_seen_at)
       VALUES ($1, 'ExponentPushToken[partial]', 'android', TRUE, NOW(), NOW(), NOW())
       ON CONFLICT (user_id, token) DO UPDATE SET is_active = TRUE, updated_at = NOW()`,
      [tokenUserId]
    );
    await db.query(
      `INSERT INTO patient_push_tokens (user_id, token, platform, is_active, created_at, updated_at, last_seen_at)
       VALUES ($1, 'ExponentPushToken[partial]', 'ios', TRUE, NOW(), NOW(), NOW())
       ON CONFLICT (user_id, token) DO UPDATE SET platform = EXCLUDED.platform, updated_at = NOW()`,
      [tokenUserId]
    );
    const n = await count(db, 'patient_push_tokens', 'WHERE user_id = $1', [tokenUserId]);
    assert(n === 1, `expected one upserted row, got ${n}`);
    const p = await db.query('SELECT platform FROM patient_push_tokens WHERE user_id = $1', [tokenUserId]);
    assert(p.rows[0].platform === 'ios', `platform not updated: ${p.rows[0].platform}`);
  });
  await db.close();
}

async function scenarioG(t) {
  const check = scenarioCheck(t);
  const db = new PGlite();
  await baseAnd001(db);
  await seedLegacy(db, ['completed']);
  await runRest(db);
  await db.exec(`ALTER TABLE appointments ADD CONSTRAINT appointments_status_check_legacy
    CHECK (status IN ('completed'))`);

  const errs = await applyFile(db, path.join(SQL_DIR, '009_consistency_hardening.sql'), { continueOnError: true });

  await check('G1 conflicting CHECK produces an actionable abort', async () => {
    assert(errs.length === 1, `expected one error, got ${JSON.stringify(errs)}`);
    assert(/blocked the status migration/i.test(errs[0].message), `unclear error: ${errs[0].message}`);
    assert(/No changes were applied/i.test(errs[0].message), `missing recovery hint: ${errs[0].message}`);
  });

  await check('G2 nothing changed on abort', async () => {
    assert(await count(db, 'appointments', `WHERE status = 'completed'`) === 1, 'completed row changed');
    assert(await count(db, 'appointments', `WHERE status = 'done'`) === 0, 'done row appeared');
    const legacy = await constraintDef(db, 'appointments', 'appointments_status_check_legacy');
    assert(legacy !== null, 'conflicting CHECK was dropped');
    const canonical = await constraintDef(db, 'appointments', 'appointments_status_check');
    assert(canonical === null, 'canonical CHECK added despite abort');
  });

  await check('G3 dropping the conflicting CHECK lets a re-run succeed', async () => {
    await db.exec(`ALTER TABLE appointments DROP CONSTRAINT appointments_status_check_legacy`);
    const rerun = await run009(db);
    assert(rerun.length === 0, `re-run failed: ${JSON.stringify(rerun)}`);
    assert(await count(db, 'appointments', `WHERE status = 'done'`) === 1, 'completed not migrated');
    const def = await constraintDef(db, 'appointments', 'appointments_status_check');
    assert(def && /done/.test(def), `canonical CHECK missing: ${def}`);
  });

  await db.close();
}

nodeTest('Scenario A: legacy `completed` rows, no old CHECK', async (t) => {
  await scenarioA(t);
});
nodeTest('Scenario B: deployed DB with old CHECK allowing only `completed`', async (t) => {
  await scenarioB(t);
});
nodeTest('Scenario C: unexpected legacy status value', async (t) => {
  await scenarioC(t);
});
nodeTest('Scenario C2: unexpected value with an old NOT VALID CHECK', async (t) => {
  await scenarioC2(t);
});
nodeTest('Scenario D: already-new-shape push table', async (t) => {
  await scenarioD(t);
});
nodeTest('Scenario E: only a partial unique index', async (t) => {
  await scenarioE(t);
});
nodeTest('Scenario F: --single-transaction abort rolls back everything', async (t) => {
  await scenarioF(t);
});
nodeTest('Scenario G: differently-named CHECK blocks the status migration', async (t) => {
  await scenarioG(t);
});

// ---------------------------------------------------------------------------
// 010: audited corrections + durable reminders.
// ---------------------------------------------------------------------------
async function run010(db) {
  return applyFile(db, path.join(SQL_DIR, '010_policy_batch.sql'));
}

nodeTest('010: audited corrections and reminders are idempotent and constrained', async (t) => {
  const check = scenarioCheck(t);
  const db = new PGlite();
  await baseAnd001(db);
  const seeded = await seedLegacy(db, ['done', 'cancelled']);
  await runRest(db);
  await run009(db);

  const first = await run010(db);
  const second = await run010(db);

  await check('applies cleanly and re-runs without error', async () => {
    assert(first.length === 0, `first apply failed: ${JSON.stringify(first)}`);
    assert(second.length === 0, `re-run failed: ${JSON.stringify(second)}`);
    assert(await count(db, 'appointment_status_corrections') === 0, 'audit table not empty');
    assert(await count(db, 'appointment_reminders') === 0, 'reminder table not empty');
  });

  const appts = (await db.query('SELECT id, status FROM appointments ORDER BY id')).rows;
  const doneId = appts.find((a) => a.status === 'done').id;
  const cancelledId = appts.find((a) => a.status === 'cancelled').id;
  const actorId = seeded.doctorUserId;

  await check('audit accepts a valid closed -> active correction', async () => {
    await db.query(
      `INSERT INTO appointment_status_corrections
         (appointment_id, actor_user_id, previous_status, corrected_status, reason)
       VALUES ($1,$2,'done','confirmed','Wrong patient marked done at the desk')`,
      [doneId, actorId]
    );
    assert(await count(db, 'appointment_status_corrections') === 1, 'audit row missing');
  });

  await check('audit rejects a short reason and invalid states', async () => {
    const cases = [
      [`INSERT INTO appointment_status_corrections (appointment_id, previous_status, corrected_status, reason)
        VALUES ($1,'done','confirmed','no')`, [doneId]],
      [`INSERT INTO appointment_status_corrections (appointment_id, previous_status, corrected_status, reason)
        VALUES ($1,'pending','confirmed','valid reason text')`, [doneId]],
      [`INSERT INTO appointment_status_corrections (appointment_id, previous_status, corrected_status, reason)
        VALUES ($1,'done','done','valid reason text')`, [doneId]],
    ];
    for (const [sql, params] of cases) {
      let failed = false;
      try { await db.query(sql, params); } catch (e) { failed = e.code === '23514'; }
      assert(failed, `constraint did not reject: ${sql}`);
    }
    assert(await count(db, 'appointment_status_corrections') === 1, 'invalid rows were inserted');
  });

  await check('audit survives appointment deletion (target becomes NULL)', async () => {
    await db.query('DELETE FROM appointments WHERE id=$1', [doneId]);
    const r = await db.query('SELECT appointment_id FROM appointment_status_corrections');
    assert(r.rows.length === 1, 'audit row disappeared with the appointment');
    assert(r.rows[0].appointment_id === null, 'audit target was not nulled');
  });

  await check('reminders are unique per appointment and cascade on delete', async () => {
    await db.query(
      `INSERT INTO appointment_reminders (appointment_id, scheduled_for) VALUES ($1, NOW())`,
      [cancelledId]
    );
    let duplicate = false;
    try {
      await db.query(
        `INSERT INTO appointment_reminders (appointment_id, scheduled_for) VALUES ($1, NOW())`,
        [cancelledId]
      );
    } catch (e) { duplicate = e.code === '23505'; }
    assert(duplicate, 'a second reminder for the same appointment was accepted');
    await db.query('DELETE FROM appointments WHERE id=$1', [cancelledId]);
    assert(await count(db, 'appointment_reminders') === 0, 'reminder outlived its appointment');
  });

  await db.close();
});
