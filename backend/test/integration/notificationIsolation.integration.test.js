'use strict';

// Notification isolation regression suite (P0).
//
// Reported defect: a notification for one patient was received by other
// patients. Root cause (reproduced by these tests before the fix):
// `utils/push.js#tokensForUser` matched the recipient id against
// `patients.id` / `patients.user_id` in addition to
// `patient_push_tokens.user_id` (which references `users.id`). `users.id` and
// `patients.id` are independent sequences, so any drift (walk-in patient,
// deleted account) made one user's notification resolve to another user's
// device tokens.
//
// Everything below runs against the real database engine, the real
// recipient-selection code, and the real Express routes. Only the outbound
// Expo HTTP endpoint is intercepted; no query, authorization check, or
// recipient-selection helper is mocked.
//
// Run: node --test test/integration/notificationIsolation.integration.test.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { splitSql } = require('../helpers/sqlSplit');

const BACKEND_DIR = path.resolve(__dirname, '../..');
const REPO = fs.existsSync(path.join(BACKEND_DIR, '..', 'hepziba_schema.sql')) ? path.resolve(BACKEND_DIR, '..') : BACKEND_DIR;
const SQL_DIR = path.join(BACKEND_DIR, 'sql');

async function applyFile(db, file, { continueOnError = false } = {}) {
  const errors = [];
  for (const stmt of splitSql(fs.readFileSync(file, 'utf8'))) {
    try {
      await db.exec(stmt);
    } catch (e) {
      errors.push({ message: e.message });
      if (!continueOnError) throw new Error(`${path.basename(file)}: ${e.message}`);
    }
  }
  return errors;
}

nodeTest('Notification isolation: recipients and token lists', async (t) => {
  // ------------------------------------------------------------------
  // 1. Disposable database with the full migration chain.
  // ------------------------------------------------------------------
  const db = new PGlite();
  await applyFile(db, path.join(REPO, 'hepziba_schema.sql'));
  await applyFile(db, path.join(SQL_DIR, '001_hospital_alignment.sql'), { continueOnError: true });

  const hash = await bcrypt.hash('Passw0rd!', 4);
  for (const [name, email, role] of [
    ['Admin One', 'admin@example.test', 'admin'],
    ['Doctor One', 'doctor@example.test', 'doctor'],
    ['Doctor Two', 'doctor2@example.test', 'doctor'],
    ['Patient A', 'patient.a@example.test', 'patient'],
    ['Patient B', 'patient.b@example.test', 'patient'],
    ['Patient C', 'patient.c@example.test', 'patient'],
    ['Walk-in One', 'walkin1@example.test', 'patient'],
  ]) {
    await db.query(
      `INSERT INTO users (name, email, password, role, email_verified, active)
       VALUES ($1,$2,$3,$4,TRUE,TRUE)`,
      [name, email, hash, role]
    );
  }

  await applyFile(db, path.join(SQL_DIR, '002_fix_doctors_and_constraints.sql'));
  await applyFile(db, path.join(SQL_DIR, '004_repair_clinic_columns.sql'));
  for (const f of ['005_session_tokens.sql', '006_clinic_settings.sql', '007_inventory_mrp_expiry.sql', '008_billing_fee_push.sql', '009_consistency_hardening.sql', '010_policy_batch.sql']) {
    await applyFile(db, path.join(SQL_DIR, f));
  }

  const userIds = {};
  for (const u of (await db.query('SELECT id, email FROM users')).rows) userIds[u.email] = u.id;
  const doctorProfiles = (await db.query('SELECT id, user_id FROM doctors ORDER BY id')).rows;
  const doctorProfile1 = doctorProfiles.find((d) => d.user_id === userIds['doctor@example.test']).id;

  // Patients are created for both app accounts and walk-ins (which get their
  // own synthetic user row), so `patients.id` and `users.id` drift apart. That
  // drift is exactly what exposed the leak; keep it in the fixture.
  await db.query(`INSERT INTO patients (user_id, patient_code) VALUES ($1, 'WALK-0001')`, [userIds['walkin1@example.test']]);
  const walkinId = (await db.query(`SELECT id FROM patients WHERE patient_code='WALK-0001'`)).rows[0].id;
  for (const [email, code] of [
    ['patient.a@example.test', 'HEP-A0001'],
    ['patient.b@example.test', 'HEP-B0002'],
    ['patient.c@example.test', 'HEP-C0003'],
  ]) {
    await db.query(`INSERT INTO patients (user_id, patient_code) VALUES ($1,$2)`, [userIds[email], code]);
  }
  // Legacy patient record with no linked account (older imports).
  await db.query(`INSERT INTO patients (user_id, patient_code) VALUES (NULL, 'LEGACY-0001')`);
  const legacyPatientId = (await db.query(`SELECT id FROM patients WHERE patient_code='LEGACY-0001'`)).rows[0].id;
  const patientIds = {};
  for (const row of (await db.query('SELECT id, patient_code FROM patients')).rows) patientIds[row.patient_code] = row.id;

  // ------------------------------------------------------------------
  // 2. Provider interception: only https://exp.host is faked.
  // ------------------------------------------------------------------
  const realFetch = global.fetch;
  const expoRequests = [];
  // Per-test provider behaviour: 'ok' | 'throw' | 'error500' | 'ticket-errors'.
  let expoBehavior = 'ok';
  let failingToken = null;
  global.fetch = async (url, opts) => {
    const target = String(url);
    if (target.startsWith('https://exp.host/')) {
      const messages = JSON.parse(opts.body);
      expoRequests.push(messages);
      if (expoBehavior === 'throw') throw new Error('synthetic provider outage');
      if (expoBehavior === 'error500') {
        return { ok: false, status: 500, text: async () => 'synthetic upstream error' };
      }
      if (expoBehavior === 'ticket-errors') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            data: messages.map((m) => (m.to === failingToken
              ? { status: 'error', message: 'Device is not registered', details: { error: 'DeviceNotRegistered' } }
              : { status: 'ok', id: 'stub-ticket' })),
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 'stub-ticket' })) }),
      };
    }
    return realFetch(url, opts);
  };

  // ------------------------------------------------------------------
  // 3. Real app + real push module.
  // ------------------------------------------------------------------
  const socketServer = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 5 });
  await socketServer.start();
  const dbPort = Number(socketServer.getServerConn().split(':').pop());
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${dbPort}/postgres`;
  process.env.JWT_SECRET = 'notification-isolation-test-secret';
  process.env.NODE_ENV = 'test';
  process.env.DB_POOL_MAX = '1';
  process.env.AUTH_LOGIN_MAX = '10000';

  const app = require(path.join(BACKEND_DIR, 'app.js'));
  const push = require(path.join(BACKEND_DIR, 'utils/push.js'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function req(method, urlPath, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await realFetch(baseUrl + urlPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  }

  async function login(email) {
    const r = await req('POST', '/auth/login', { body: { email, password: 'Passw0rd!' } });
    assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.body)}`);
    return r.body;
  }

  const admin = await login('admin@example.test');
  const doctor = await login('doctor@example.test');
  const patientA = await login('patient.a@example.test');
  const patientB = await login('patient.b@example.test');
  const patientC = await login('patient.c@example.test');

  function sentTokens() {
    // Flatten every message sent to the provider into one token list.
    return expoRequests.flatMap((batch) => batch.map((m) => m.to));
  }
  function resetPushes() { expoRequests.length = 0; }

  // ------------------------------------------------------------------
  // 4. Device tokens: A has two devices, B and C one each.
  // ------------------------------------------------------------------
  const devA1 = 'ExponentPushToken[iso-a-device-1]';
  const devA2 = 'ExponentPushToken[iso-a-device-2]';
  const devB1 = 'ExponentPushToken[iso-b-device-1]';
  const devC1 = 'ExponentPushToken[iso-c-device-1]';
  const devShared = 'ExponentPushToken[iso-shared-device]';

  for (const [token, device] of [[devA1, 'android'], [devA2, 'ios']]) {
    const r = await req('POST', '/patients/push-token', { token: patientA.token, body: { token, platform: device } });
    assert.equal(r.status, 200, `register A device: ${JSON.stringify(r.body)}`);
  }
  assert.equal((await req('POST', '/patients/push-token', { token: patientB.token, body: { token: devB1, platform: 'android' } })).status, 200);
  assert.equal((await req('POST', '/patients/push-token', { token: patientC.token, body: { token: devC1, platform: 'ios' } })).status, 200);

  // ------------------------------------------------------------------
  // 5. Recipient selection (direct, real SQL).
  // ------------------------------------------------------------------
  await t.test('tokensForUser returns exactly the owner\'s active devices', async () => {
    assert.deepEqual(
      (await push.tokensForUser(userIds['patient.a@example.test'])).sort(),
      [devA1, devA2].sort(),
      'Patient A token list is not exactly A\'s devices'
    );
    assert.deepEqual(await push.tokensForUser(userIds['patient.b@example.test']), [devB1]);
    assert.deepEqual(await push.tokensForUser(userIds['patient.c@example.test']), [devC1]);
    // A doctor account has no registered devices: it must get nothing, not
    // another user's tokens (the old query returned patient A's devices here).
    assert.deepEqual(await push.tokensForUser(userIds['doctor@example.test']), []);
    assert.deepEqual(await push.tokensForUser(walkinId), [], 'a patient id must not resolve to device tokens');
    assert.deepEqual(await push.tokensForUser(null), []);
    assert.deepEqual(await push.tokensForUser('not-a-number'), []);
  });

  // ------------------------------------------------------------------
  // 6. Appointment notifications end-to-end.
  // ------------------------------------------------------------------
  async function book(patientSession, daysAhead) {
    const r = await req('POST', '/appointments', {
      token: patientSession.token,
      body: { scheduled_at: new Date(Date.now() + daysAhead * 86400000).toISOString(), reason: 'isolation' },
    });
    assert.equal(r.status, 200, `booking failed: ${JSON.stringify(r.body)}`);
    return r.body.appointment;
  }

  const apptA = await book(patientA, 2);
  const apptB = await book(patientB, 3);

  await t.test('notifyAppointmentOwner sends only the owning patient\'s devices', async () => {
    resetPushes();
    const res = await push.notifyAppointmentOwner(apptA.id, 'Visit confirmed', 'synthetic');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(sentTokens().sort(), [devA1, devA2].sort());
    assert.ok(!sentTokens().includes(devB1), 'Patient B received Patient A\'s notification');
    assert.ok(!sentTokens().includes(devC1), 'Patient C received Patient A\'s notification');
    // Payload carries the opaque appointment id only.
    const data = expoRequests[0][0].data;
    assert.deepEqual(Object.keys(data), ['appointmentId']);
    assert.equal(data.appointmentId, apptA.id);
    assert.ok(!JSON.stringify(expoRequests[0][0]).includes('isolation'), 'reason leaked into the payload');
  });

  await t.test('doctor status change notifies only the patient on that appointment', async () => {
    resetPushes();
    const r = await req('PATCH', `/doctors/appointments/${apptA.id}`, { token: doctor.token, body: { status: 'confirmed' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(sentTokens().sort(), [devA1, devA2].sort(), 'doctor notification reached the wrong devices');
  });

  await t.test('admin status change on Patient B notifies only Patient B', async () => {
    resetPushes();
    const r = await req('PATCH', `/admin/appointments/${apptB.id}`, { token: admin.token, body: { status: 'cancelled' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(sentTokens(), [devB1], 'admin notification reached the wrong devices');
  });

  await t.test('appointment for a legacy patient with no linked account sends nothing', async () => {
    const row = await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
       VALUES ($1,$2,NOW(),NOW(),'pending') RETURNING id`,
      [legacyPatientId, doctorProfile1]
    );
    resetPushes();
    const res = await push.notifyAppointmentOwner(row.rows[0].id, 'Visit confirmed', 'synthetic');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'Appointment owner not found');
    assert.deepEqual(sentTokens(), [], 'an appointment without an owner must not notify anyone');
  });

  await t.test('deactivated device is excluded from delivery', async () => {
    const r = await req('DELETE', '/patients/push-token', { token: patientA.token, body: { token: devA2 } });
    assert.equal(r.status, 200);
    assert.deepEqual(await push.tokensForUser(userIds['patient.a@example.test']), [devA1]);
    resetPushes();
    await push.notifyAppointmentOwner(apptA.id, 'Visit completed', 'synthetic');
    assert.deepEqual(sentTokens(), [devA1], 'inactive device still received a push');
    // Re-registering the device reactivates it for the owner.
    assert.equal((await req('POST', '/patients/push-token', { token: patientA.token, body: { token: devA2, platform: 'ios' } })).status, 200);
    assert.deepEqual((await push.tokensForUser(userIds['patient.a@example.test'])).sort(), [devA1, devA2].sort());
  });

  // ------------------------------------------------------------------
  // 7. Account switching on a shared device.
  // ------------------------------------------------------------------
  await t.test('a device token active for A moves to B on account switch', async () => {
    const shared = devShared;
    assert.equal((await req('POST', '/patients/push-token', { token: patientA.token, body: { token: shared, platform: 'android' } })).status, 200);
    resetPushes();
    await push.notifyAppointmentOwner(apptA.id, 'Visit confirmed', 'synthetic');
    assert.ok(sentTokens().includes(shared), 'precondition: shared device should receive A');

    // B logs in on the same phone; the app registers the same device token.
    assert.equal((await req('POST', '/patients/push-token', { token: patientB.token, body: { token: shared, platform: 'android' } })).status, 200);

    resetPushes();
    await push.notifyAppointmentOwner(apptA.id, 'Visit confirmed', 'synthetic');
    assert.ok(!sentTokens().includes(shared), 'previous account still receives pushes on the shared device');

    resetPushes();
    await push.notifyAppointmentOwner(apptB.id, 'Visit cancelled', 'synthetic');
    assert.ok(sentTokens().includes(shared), 'new account does not receive its own pushes');
    assert.ok(!sentTokens().includes(devA1), 'new account push leaked to the previous account\'s other device');
  });

  await t.test('logout deactivation touches only the caller\'s rows', async () => {
    const r = await req('DELETE', '/patients/push-token', { token: patientB.token, body: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(await push.tokensForUser(userIds['patient.b@example.test']), []);
    assert.deepEqual((await push.tokensForUser(userIds['patient.a@example.test'])).sort(), [devA1, devA2].sort(), 'A lost devices on B\'s logout');
    assert.deepEqual(await push.tokensForUser(userIds['patient.c@example.test']), [devC1], 'C lost devices on B\'s logout');
    // Restore B for later tests.
    assert.equal((await req('POST', '/patients/push-token', { token: patientB.token, body: { token: devB1, platform: 'android' } })).status, 200);
  });

  await t.test('client-supplied user id cannot claim another account\'s token', async () => {
    const foreign = 'ExponentPushToken[iso-foreign-claim]';
    const r = await req('POST', '/patients/push-token', {
      token: patientC.token,
      body: { token: foreign, user_id: userIds['patient.a@example.test'], userId: userIds['patient.a@example.test'] },
    });
    assert.equal(r.status, 200);
    const owner = await db.query('SELECT user_id FROM patient_push_tokens WHERE token=$1', [foreign]);
    assert.equal(owner.rows.length, 1);
    assert.equal(owner.rows[0].user_id, userIds['patient.c@example.test'], 'token was stored for a client-supplied user');
  });

  // ------------------------------------------------------------------
  // 8. Concurrency: interleaved events keep their own recipients.
  // ------------------------------------------------------------------
  await t.test('concurrent events for different patients never cross-contaminate', async () => {
    // Snapshot the expected recipient list for each owner right before the
    // burst, so the assertion tracks real state (tokens change earlier).
    const expectedA = (await push.tokensForUser(userIds['patient.a@example.test'])).sort();
    const expectedB = (await push.tokensForUser(userIds['patient.b@example.test'])).sort();
    assert.ok(expectedA.length > 0 && expectedB.length > 0, 'precondition: both owners need devices');
    resetPushes();
    const calls = [];
    for (let i = 0; i < 4; i += 1) {
      calls.push(push.notifyAppointmentOwner(apptA.id, 'A event', 'synthetic'));
      calls.push(push.notifyAppointmentOwner(apptB.id, 'B event', 'synthetic'));
    }
    const results = await Promise.all(calls);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    const aBatches = expoRequests.filter((batch) => batch[0].title === 'A event');
    const bBatches = expoRequests.filter((batch) => batch[0].title === 'B event');
    assert.equal(aBatches.length, 4);
    assert.equal(bBatches.length, 4);
    for (const batch of aBatches) {
      const tos = batch.map((m) => m.to).sort();
      assert.deepEqual(tos, expectedA, 'A event reached a non-A device');
      assert.ok(!tos.some((t2) => expectedB.includes(t2)), 'A event included a B device');
    }
    for (const batch of bBatches) {
      const tos = batch.map((m) => m.to).sort();
      assert.deepEqual(tos, expectedB, 'B event reached a non-B device');
      assert.ok(!tos.some((t2) => expectedA.includes(t2)), 'B event included an A device');
    }
  });

  // ------------------------------------------------------------------
  // 9. Provider failures and dead-device tickets.
  // ------------------------------------------------------------------
  await t.test('provider failure is best-effort and never rewrites tokens', async () => {
    const before = (await push.tokensForUser(userIds['patient.a@example.test'])).sort();
    assert.ok(before.length > 0, 'precondition: A needs a device');
    for (const mode of ['throw', 'error500']) {
      expoBehavior = mode;
      const res = await push.notifyAppointmentOwner(apptA.id, 'A event', 'synthetic');
      assert.equal(res.ok, true, `${mode}: owner resolution should still succeed`);
      assert.equal(res.sendResult.ok, false, `${mode}: provider failure was reported as success`);
      assert.deepEqual(
        (await push.tokensForUser(userIds['patient.a@example.test'])).sort(),
        before,
        `${mode}: a provider failure changed the token list`
      );
    }
    expoBehavior = 'ok';
  });

  await t.test('DeviceNotRegistered removes only that device', async () => {
    const before = (await push.tokensForUser(userIds['patient.a@example.test'])).sort();
    assert.ok(before.length >= 2, `precondition: A needs two devices, got ${JSON.stringify(before)}`);
    failingToken = before[0];
    expoBehavior = 'ticket-errors';
    try {
      const res = await push.sendPush(before, 'A event', 'synthetic');
      assert.equal(res.ok, true);
      // The cleanup DELETE is fire-and-forget; poll briefly for it.
      let after = before;
      for (let i = 0; i < 50; i += 1) {
        after = await push.tokensForUser(userIds['patient.a@example.test']);
        if (!after.includes(failingToken)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(!after.includes(failingToken), 'dead device token was not removed');
      assert.ok(after.includes(before[1]), 'a healthy device was removed with the dead one');
      assert.deepEqual(await push.tokensForUser(userIds['patient.b@example.test']), [devB1], 'B lost a device on A\'s dead token');
      assert.ok((await push.tokensForUser(userIds['patient.c@example.test'])).includes(devC1), 'C lost a device on A\'s dead token');
    } finally {
      failingToken = null;
      expoBehavior = 'ok';
    }
  });

  // ------------------------------------------------------------------
  // 10. No token material in ordinary API responses or logs.
  // ------------------------------------------------------------------
  await t.test('profile and appointment responses never expose device tokens', async () => {
    const me = await req('GET', '/patients/me', { token: patientA.token });
    assert.ok(!JSON.stringify(me.body).includes('ExponentPushToken'));
    const mine = await req('GET', '/appointments/my', { token: patientA.token });
    assert.ok(!JSON.stringify(mine.body).includes('ExponentPushToken'));
    const other = await req('GET', '/patients/me', { token: patientB.token });
    assert.ok(!JSON.stringify(other.body).includes('ExponentPushToken'));
  });

  await t.test('non-admin cannot read the push diagnostics endpoint', async () => {
    assert.equal((await req('GET', '/debug-push', { token: patientA.token })).status, 403);
    assert.equal((await req('GET', '/debug-push', { token: doctor.token })).status, 403);
  });

  // ------------------------------------------------------------------
  // 10. Cleanup (explicit; runs even when a subtest failed).
  // ------------------------------------------------------------------
  t.after(async () => {
    global.fetch = realFetch;
    await new Promise((resolve) => server.close(resolve));
    // Close the pool before the socket server, otherwise the pooled connection
    // is torn down asynchronously after the test and surfaces as an
    // uncaught "Connection terminated unexpectedly".
    try { await require(path.join(BACKEND_DIR, 'db.js')).end(); } catch (_) { /* ignore */ }
    await socketServer.stop();
    await db.close();
  });
});
