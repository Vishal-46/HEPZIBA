// API integration test: the real Express app against disposable PGlite
// (Postgres WASM) over TCP. Only outbound email and Expo push are stubbed, so
// no network, credentials, or patient data are involved. Synthetic fixtures.
//
// Run with: npm run test:integration
// Prerequisites: @electric-sql/pglite, @electric-sql/pglite-socket (devDeps).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { test: nodeTest } = require('node:test');
const bcrypt = require('bcrypt');
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
const { splitSql } = require('../helpers/sqlSplit');
const { isUtcZoneName } = require('../../utils/dbTime');
const { checkRequiredSchema } = require('../../utils/schemaCheck');

const BACKEND_DIR = path.resolve(__dirname, '../..');
const REPO = fs.existsSync(path.join(BACKEND_DIR, '..', 'hepziba_schema.sql')) ? path.resolve(BACKEND_DIR, '..') : BACKEND_DIR;
const SQL_DIR = path.join(BACKEND_DIR, 'sql');
const BASE = path.join(REPO, 'hepziba_schema.sql');

let currentGroup = '';
function group(name) { currentGroup = name; }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function applyFile(db, file, { continueOnError = false } = {}) {
  const stmts = splitSql(fs.readFileSync(file, 'utf8'));
  const errors = [];
  for (const s of stmts) {
    try { await db.exec(s); }
    catch (e) {
      errors.push({ sql: s.slice(0, 60).replace(/\s+/g, ' '), message: e.message });
      if (!continueOnError) throw new Error(`${path.basename(file)}: ${e.message}\n  ${s.slice(0, 160)}`);
    }
  }
  return errors;
}

nodeTest('API integration: Express + PGlite', async (t) => {
  const test = (name, fn) => t.test(currentGroup ? `${currentGroup} — ${name}` : name, fn);

  // ---------- 1. Disposable DB + real migration chain ----------
  const db = new PGlite();
  await applyFile(db, BASE);
  await applyFile(db, path.join(SQL_DIR, '001_hospital_alignment.sql'), { continueOnError: true });

  const hash = await bcrypt.hash('Passw0rd!', 4);
  const seedUsers = [
    ['Admin One', 'admin@example.test', 'admin'],
    ['Doctor One', 'doctor@example.test', 'doctor'],
    ['Doctor Two', 'doctor2@example.test', 'doctor'],
    ['Patient A', 'patient.a@example.test', 'patient'],
    ['Patient B', 'patient.b@example.test', 'patient'],
    ['Patient C', 'patient.c@example.test', 'patient'],
    ['Patient D', 'patient.d@example.test', 'patient'],
    ['Walk-in One', 'walkin1@example.test', 'patient'],
  ];
  for (const [name, email, role] of seedUsers) {
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

  const ids = {};
  for (const u of (await db.query('SELECT id, email, role FROM users')).rows) ids[u.email] = u.id;
  const doctorProfiles = (await db.query('SELECT id, user_id FROM doctors ORDER BY id')).rows;
  ids.doctorProfile1 = doctorProfiles.find((d) => d.user_id === ids['doctor@example.test']).id;
  ids.doctorProfile2 = doctorProfiles.find((d) => d.user_id === ids['doctor2@example.test']).id;

  const patientSeed = [
    [ids['patient.a@example.test'], 'HEP-A0001', 34, 'F', '9000000001'],
    [ids['patient.b@example.test'], 'HEP-B0002', 41, 'M', '9000000002'],
    [ids['patient.c@example.test'], 'HEP-C0003', 29, 'F', '9000000003'],
    [ids['patient.d@example.test'], 'HEP-D0004', 52, 'M', '9000000004'],
  ];
  // Patients are created for app accounts and walk-ins alike, so patients.id
  // and users.id drift apart. That drift is what exposed the cross-user push
  // leak; keep a walk-in in the fixture so the suite stays honest.
  await db.query(`INSERT INTO patients (user_id, patient_code) VALUES ($1, 'HEP-WALKIN')`, [ids['walkin1@example.test']]);
  // Legacy imported patient with no login account at all. The admin billing
  // list, patient picker, and chart must still show this record.
  await db.query(`INSERT INTO patients (patient_code, age, sex, mobile) VALUES ('HEP-LEGACY', 63, 'M', '9000000009')`);
  for (const [uid, code, age, sex, mobile] of patientSeed) {
    await db.query(
      `INSERT INTO patients (user_id, patient_code, age, sex, mobile) VALUES ($1,$2,$3,$4,$5)`,
      [uid, code, age, sex, mobile]
    );
  }
  ids.patientA = (await db.query('SELECT id FROM patients WHERE patient_code=$1', ['HEP-A0001'])).rows[0].id;
  ids.patientB = (await db.query('SELECT id FROM patients WHERE patient_code=$1', ['HEP-B0002'])).rows[0].id;

  await db.query(`INSERT INTO inventory_items (name, stock, unit, mrp) VALUES ('Amoxicillin 500', 10, 'strip', 5.00)`);
  await db.query(`INSERT INTO inventory_items (name, stock, unit, mrp) VALUES ('LowStock', 1, 'strip', 2.00)`);

  // ---------- 2. Socket server + env ----------
  const socketServer = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 5 });
  await socketServer.start();
  const dbPort = Number(socketServer.getServerConn().split(':').pop());
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${dbPort}/postgres`;
  process.env.JWT_SECRET = 'integration-test-secret-not-a-real-key';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_LOGIN_MAX = '10000';
  process.env.AUTH_FORGOT_MAX = '10000';
  process.env.AUTH_RESET_MAX = '10000';
  process.env.AUTH_VERIFY_MAX = '10000';
  process.env.DB_POOL_MAX = '1';

  // ---------- 3. Stub outbound mail (module is destructured at load) ----------
  const sentMails = [];
  const mailerPath = require.resolve(path.join(BACKEND_DIR, 'mailer/mailer.js'));
  require.cache[mailerPath] = {
    id: mailerPath, filename: mailerPath, loaded: true, children: [], paths: [],
    exports: { sendMail: async (opts) => { sentMails.push(opts); return { id: 'stub' }; } },
  };

  // ---------- 4. Boot the real app ----------
  const app = require(path.join(BACKEND_DIR, 'app.js'));

  // Intercept ONLY the outbound Expo endpoint. The real recipient-selection
  // code (utils/push.js) must execute, so that a wrong token list fails here
  // rather than being hidden behind a stub.
  const realFetch = global.fetch;
  const sentPushes = [];
  global.fetch = async (url, opts) => {
    const target = String(url);
    if (target.startsWith('https://exp.host/')) {
      const messages = JSON.parse(opts.body);
      sentPushes.push({
        tokens: messages.map((m) => m.to),
        title: messages[0] && messages[0].title,
        body: messages[0] && messages[0].body,
        data: messages[0] && messages[0].data,
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 'stub-ticket' })) }),
      };
    }
    return realFetch(url, opts);
  };
  const push = require(path.join(BACKEND_DIR, 'utils/push.js'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function req(method, urlPath, { token, body, headers } = {}) {
    const h = { ...(headers || {}) };
    if (token) h.Authorization = `Bearer ${token}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  async function login(email, password = 'Passw0rd!') {
    const r = await req('POST', '/auth/login', { body: { email, password } });
    eq(r.status, 200, `login ${email}`);
    assert(r.body && r.body.token && r.body.refreshToken, 'login missing tokens');
    return r.body;
  }

  const admin = await login('admin@example.test');
  const doctor = await login('doctor@example.test');
  const doctor2 = await login('doctor2@example.test');
  const patientB = await login('patient.b@example.test');
  const patientC = await login('patient.c@example.test');
  let patientA = await login('patient.a@example.test');

  // ================================================================
  group('Auth: login / refresh / logout / reset invalidation');
  // ================================================================
  await test('login rejects wrong password (401) and unknown email (401)', async () => {
    eq((await req('POST', '/auth/login', { body: { email: 'patient.a@example.test', password: 'wrong' } })).status, 401);
    eq((await req('POST', '/auth/login', { body: { email: 'nobody@example.test', password: 'whatever' } })).status, 401);
  });

  await test('login rejects unverified email (403 EMAIL_NOT_VERIFIED)', async () => {
    await db.query(`UPDATE users SET email_verified=FALSE WHERE id=$1`, [ids['patient.c@example.test']]);
    const r = await req('POST', '/auth/login', { body: { email: 'patient.c@example.test', password: 'Passw0rd!' } });
    eq(r.status, 403);
    eq(r.body.code, 'EMAIL_NOT_VERIFIED');
    await db.query(`UPDATE users SET email_verified=TRUE WHERE id=$1`, [ids['patient.c@example.test']]);
  });

  await test('refresh rotates token and old token reuse revokes the family', async () => {
    const s = await login('patient.a@example.test');
    const r1 = await req('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken } });
    eq(r1.status, 200);
    assert(r1.body.token && r1.body.refreshToken, 'refresh did not return pair');
    assert(r1.body.user && r1.body.user.role === 'patient', 'refresh missing user (mobile requires it)');
    assert(r1.body.refreshExpiresAt, 'refresh missing refreshExpiresAt');
    assert(r1.body.refreshToken !== s.refreshToken, 'refresh token not rotated');
    const reuse = await req('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken } });
    eq(reuse.status, 401, 'reuse of rotated token should be rejected');
    const family = await req('POST', '/auth/refresh', { body: { refreshToken: r1.body.refreshToken } });
    eq(family.status, 401, 'family should be revoked after reuse detection');
  });

  await test('logout denylists access token and revokes refresh token', async () => {
    const s = await login('patient.a@example.test');
    eq((await req('GET', '/patients/me', { token: s.token })).status, 200);
    eq((await req('POST', '/auth/logout', { token: s.token, body: { refreshToken: s.refreshToken } })).status, 200);
    eq((await req('GET', '/patients/me', { token: s.token })).status, 401, 'access token still valid after logout');
    eq((await req('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken } })).status, 401, 'refresh token still valid after logout');
  });

  await test('logout-all kills every device session', async () => {
    const s1 = await login('patient.a@example.test');
    const s2 = await login('patient.a@example.test');
    eq((await req('POST', '/auth/logout-all', { token: s1.token })).status, 200);
    eq((await req('GET', '/patients/me', { token: s1.token })).status, 401);
    eq((await req('POST', '/auth/refresh', { body: { refreshToken: s2.refreshToken } })).status, 401);
  });

  await test('password reset revokes old access + refresh and changes password', async () => {
    const s = await login('patient.a@example.test');
    await new Promise((r) => setTimeout(r, 1100)); // cross the 1s iat boundary
    const forgot = await req('POST', '/auth/forgot-password', { body: { email: 'patient.a@example.test' } });
    eq(forgot.status, 200, `forgot-password: ${JSON.stringify(forgot.body)}`);
    const codeRow = await db.query('SELECT reset_code, reset_code_expires_at, NOW() AS now FROM users WHERE id=$1', [ids['patient.a@example.test']]);
    const code = codeRow.rows[0].reset_code;
    assert(/^\d{6}$/.test(code), 'reset code not stored');
    const reset = await req('POST', '/auth/reset-password', { body: { email: 'patient.a@example.test', code, newPassword: 'NewPassw0rd!' } });
    eq(reset.status, 200, `reset-password: ${JSON.stringify(reset.body)}`);
    eq((await req('GET', '/patients/me', { token: s.token })).status, 401, 'old access token still valid');
    eq((await req('POST', '/auth/refresh', { body: { refreshToken: s.refreshToken } })).status, 401, 'old refresh token still valid');
    const oldLogin = await req('POST', '/auth/login', { body: { email: 'patient.a@example.test', password: 'Passw0rd!' } });
    eq(oldLogin.status, 401, `old password still works: ${JSON.stringify(oldLogin.body)}`);
    const fresh = await req('POST', '/auth/login', { body: { email: 'patient.a@example.test', password: 'NewPassw0rd!' } });
    eq(fresh.status, 200, `new password login failed: ${JSON.stringify(fresh.body)}`);
    eq((await req('GET', '/patients/me', { token: fresh.body.token })).status, 200, 'fresh token rejected after reset');
    // restore known password for the rest of the suite
    await req('POST', '/auth/forgot-password', { body: { email: 'patient.a@example.test' } });
    const code2 = (await db.query('SELECT reset_code FROM users WHERE id=$1', [ids['patient.a@example.test']])).rows[0].reset_code;
    await req('POST', '/auth/reset-password', { body: { email: 'patient.a@example.test', code: code2, newPassword: 'Passw0rd!' } });
    patientA = await login('patient.a@example.test');
  });

  await test('invalid reset code / short password rejected', async () => {
    await req('POST', '/auth/forgot-password', { body: { email: 'patient.b@example.test' } });
    const code = (await db.query('SELECT reset_code FROM users WHERE id=$1', [ids['patient.b@example.test']])).rows[0].reset_code;
    eq((await req('POST', '/auth/reset-password', { body: { email: 'patient.b@example.test', code: '000000', newPassword: 'AnotherPass1!' } })).status, 400);
    eq((await req('POST', '/auth/reset-password', { body: { email: 'patient.b@example.test', code, newPassword: 'short' } })).status, 400);
    await db.query(`UPDATE users SET reset_code_expires_at = NOW() - INTERVAL '1 minute' WHERE id=$1`, [ids['patient.b@example.test']]);
    eq((await req('POST', '/auth/reset-password', { body: { email: 'patient.b@example.test', code, newPassword: 'AnotherPass1!' } })).status, 400, 'expired reset code accepted');
  });

  await test('forgot-password does not enumerate accounts', async () => {
    const r = await req('POST', '/auth/forgot-password', { body: { email: 'nobody@example.test' } });
    eq(r.status, 200);
    assert(/If the account exists/.test(r.body.message), 'non-generic response');
  });

  await test('registration -> email verification -> login (non-UTC process)', async () => {
    const email = 'new.patient@example.test';
    const reg = await req('POST', '/auth/register/patient', { body: { name: 'New Patient', email, password: 'Passw0rd!' } });
    eq(reg.status, 201, JSON.stringify(reg.body));
    const row = await db.query('SELECT verification_code, email_verified FROM users WHERE email=$1', [email]);
    const code = row.rows[0].verification_code;
    assert(/^\d{6}$/.test(code), 'verification code not stored');
    eq(row.rows[0].email_verified, false);
    eq((await req('POST', '/auth/login', { body: { email, password: 'Passw0rd!' } })).status, 403, 'unverified user could log in');
    eq((await req('POST', '/auth/verify-email', { body: { email, code } })).status, 200, 'fresh verification code rejected');
    eq((await req('POST', '/auth/login', { body: { email, password: 'Passw0rd!' } })).status, 200);
    // Expired code must still be rejected.
    const email2 = 'expired.patient@example.test';
    await req('POST', '/auth/register/patient', { body: { name: 'Expired Patient', email: email2, password: 'Passw0rd!' } });
    const code2 = (await db.query('SELECT verification_code FROM users WHERE email=$1', [email2])).rows[0].verification_code;
    await db.query(`UPDATE users SET verification_code_expires_at = NOW() - INTERVAL '1 minute' WHERE email=$1`, [email2]);
    eq((await req('POST', '/auth/verify-email', { body: { email: email2, code: code2 } })).status, 400, 'expired code accepted');
  });

  await test('missing/malformed bearer rejected; wrong role forbidden', async () => {
    eq((await req('GET', '/patients/me')).status, 401);
    eq((await req('GET', '/patients/me', { token: 'not-a-jwt' })).status, 401);
    eq((await req('GET', '/patients/me', { token: admin.token })).status, 403);
    eq((await req('GET', '/admin/users', { token: patientA.token })).status, 403);
  });

  // ================================================================
  group('RBAC across admin / doctor / patient routes');
  // ================================================================
  await test('admin can read admin, patient and billing lists', async () => {
    eq((await req('GET', '/admin/users', { token: admin.token })).status, 200);
    eq((await req('GET', '/patients/', { token: admin.token })).status, 200);
    eq((await req('GET', '/billing/invoices', { token: admin.token })).status, 200);
  });

  await test('doctor can read own profile + patient list, not admin routes', async () => {
    eq((await req('GET', '/doctors/me', { token: doctor.token })).status, 200);
    eq((await req('GET', '/patients/', { token: doctor.token })).status, 200);
    eq((await req('GET', '/appointments/for-me', { token: doctor.token })).status, 200);
    eq((await req('GET', '/admin/users', { token: doctor.token })).status, 403);
    // Doctors and admins must be able to register a device to receive the
    // booking/cancellation notifications introduced by policy C/D. Clean up
    // immediately so later recipient-isolation assertions start from zero.
    const doctorDevice = 'ExponentPushToken[d]';
    eq((await req('POST', '/patients/push-token', { token: doctor.token, body: { token: doctorDevice } })).status, 200);
    eq((await req('DELETE', '/patients/push-token', { token: doctor.token, body: { token: doctorDevice } })).status, 200);
    const adminDevice = 'ExponentPushToken[a]';
    eq((await req('POST', '/patients/push-token', { token: admin.token, body: { token: adminDevice } })).status, 200);
    eq((await req('DELETE', '/patients/push-token', { token: admin.token, body: { token: adminDevice } })).status, 200);
  });

  await test('patient can read own data, not staff routes', async () => {
    eq((await req('GET', '/appointments/my', { token: patientA.token })).status, 200);
    eq((await req('GET', '/billing/my', { token: patientA.token })).status, 200);
    eq((await req('GET', '/prescriptions/my', { token: patientA.token })).status, 200);
    eq((await req('GET', '/doctors/me', { token: patientA.token })).status, 403);
    eq((await req('GET', '/admin/users', { token: patientA.token })).status, 403);
    eq((await req('GET', '/billing/invoices', { token: patientA.token })).status, 403);
  });

  await test('debug-push is admin-only (privacy of device tokens)', async () => {
    eq((await req('GET', '/debug-push')).status, 401);
    eq((await req('GET', '/debug-push', { token: patientA.token })).status, 403);
    eq((await req('GET', '/debug-push', { token: doctor.token })).status, 403);
    eq((await req('GET', '/debug-push', { token: admin.token })).status, 200);
  });

  // ================================================================
  group('Patient profile + cross-patient isolation');
  // ================================================================
  await test('patient profile update persists and partial update preserves fields', async () => {
    const r = await req('PUT', '/patients/me', { token: patientA.token, body: { age: 35, spo2: 98, mobile: '9111111111', address: 'Synthetic Street' } });
    eq(r.status, 200);
    const me = await req('GET', '/patients/me', { token: patientA.token });
    eq(me.status, 200);
    eq(me.body.age, 35);
    eq(me.body.spo2, 98);
    eq(me.body.mobile, 'XXXXXX1111', 'profile must be masked by default');
    const r2 = await req('PUT', '/patients/me', { token: patientA.token, body: { bp: '120/80' } });
    eq(r2.status, 200);
    const me2 = await req('GET', '/patients/me', { token: patientA.token });
    eq(me2.body.address, 'Synthetic Street', 'partial update erased address');
    eq(me2.body.bp, '120/80');
  });

  await test('DATE-only dob is returned as exact YYYY-MM-DD (no timezone shift)', async () => {
    const put = await req('PUT', '/patients/me', { token: patientA.token, body: { dob: '1990-05-15' } });
    eq(put.status, 200, JSON.stringify(put.body));
    const me = await req('GET', '/patients/me', { token: patientA.token });
    eq(me.status, 200);
    eq(me.body.dob, '1990-05-15', 'dob shifted or serialized as a datetime');
    // Also exercise the staff-facing read path.
    const staff = await req('GET', `/patients/${ids.patientA}`, { token: admin.token });
    eq(staff.status, 200);
    eq(staff.body.dob, '1990-05-15', 'staff dob read shifted');
  });

  await test('profile validation rejects bad spo2/mobile/aadhaar/age/name', async () => {
    eq((await req('PUT', '/patients/me', { token: patientA.token, body: { spo2: 150 } })).status, 400);
    eq((await req('PUT', '/patients/me', { token: patientA.token, body: { mobile: 'abc' } })).status, 400);
    eq((await req('PUT', '/patients/me', { token: patientA.token, body: { aadhar_number: '123' } })).status, 400);
    eq((await req('PUT', '/patients/me', { token: patientA.token, body: { age: -1 } })).status, 400);
    eq((await req('PUT', '/patients/me', { token: patientA.token, body: { name: '   ' } })).status, 400);
  });

  await test('duplicate email update rejected', async () => {
    eq((await req('PUT', '/patients/me', { token: patientA.token, body: { email: 'patient.b@example.test' } })).status, 400);
  });

  await test('patient B cannot read patient A appointment / invoice / prescription', async () => {
    const appt = await req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: new Date(Date.now() + 86400000).toISOString(), reason: 'isolation-check' } });
    eq(appt.status, 200);
    const apptId = appt.body.appointment.id;
    eq((await req('GET', `/appointments/${apptId}`, { token: patientB.token })).status, 404);
    eq((await req('PATCH', `/appointments/${apptId}`, { token: patientB.token, body: { status: 'cancelled' } })).status, 404);
    const inv = await req('POST', '/billing/invoices', { token: admin.token, body: { patient_id: ids.patientA, items: [{ medicine_name: 'IsolationItem', quantity: 1, mrp: '1.00' }] } });
    eq(inv.status, 200);
    eq((await req('GET', `/billing/invoices/${inv.body.invoice_id}`, { token: patientB.token })).status, 403);
    eq((await req('GET', `/billing/invoices/${inv.body.invoice_id}`, { token: patientA.token })).status, 200);
  });

  // ================================================================
  group('Appointments: creation, transitions, legacy status');
  // ================================================================
  let apptA;
  await test('patient books future appointment (pending + token number)', async () => {
    const when = new Date(Date.now() + 2 * 86400000).toISOString();
    const r = await req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: when, reason: 'checkup' } });
    eq(r.status, 200);
    eq(r.body.appointment.status, 'pending');
    assert(r.body.appointment.token_number >= 1, 'no token number');
    const returned = new Date(r.body.appointment.scheduled_at);
    assert(
      Math.abs(returned.getTime() - new Date(when).getTime()) < 60000,
      `appointment time shifted: sent ${when}, returned ${returned.toISOString()}`
    );
    apptA = r.body.appointment;
    const mine = await req('GET', '/appointments/my', { token: patientA.token });
    eq(mine.status, 200);
    const listed = mine.body.find((a) => a.id === apptA.id);
    assert(listed && listed.scheduled_at_effective, 'appointment missing effective time');
    // Separate read query: the list endpoint must return the same instant.
    assert(
      Math.abs(new Date(listed.scheduled_at_effective).getTime() - new Date(when).getTime()) < 60000,
      `list time shifted: sent ${when}, got ${listed.scheduled_at_effective}`
    );
  });

  await test('past appointment rejected (400)', async () => {
    eq((await req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: new Date(Date.now() - 3600000).toISOString() } })).status, 400);
  });

  await test('mobile contract: POST /appointments/ (trailing slash) is accepted', async () => {
    const when = new Date(Date.now() + 8 * 86400000).toISOString();
    const r = await req('POST', '/appointments/', { token: patientA.token, body: { scheduled_at: when, reason: 'trailing-slash' } });
    eq(r.status, 200, JSON.stringify(r.body));
  });

  await test('duplicate booking same doctor/minute rejected (409)', async () => {
    const when = new Date(Date.now() + 3 * 86400000).toISOString();
    eq((await req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: when } })).status, 200);
    eq((await req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: when } })).status, 409);
  });

  await test('patient may only cancel, cannot set confirmed/done', async () => {
    const when = new Date(Date.now() + 4 * 86400000).toISOString();
    const r = await req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: when } });
    const id = r.body.appointment.id;
    eq((await req('PATCH', `/appointments/${id}`, { token: patientA.token, body: { status: 'confirmed' } })).status, 403);
    eq((await req('PATCH', `/appointments/${id}`, { token: patientA.token, body: { status: 'cancelled' } })).status, 200);
    eq((await req('PATCH', `/appointments/${id}`, { token: patientA.token, body: { status: 'cancelled' } })).status, 400);
  });

  await test('doctor normalises legacy `completed` to `done` and never writes completed', async () => {
    const r = await req('PATCH', `/doctors/appointments/${apptA.id}`, { token: doctor.token, body: { status: 'completed' } });
    eq(r.status, 200);
    eq(r.body.appointment.status, 'done');
    const row = await db.query('SELECT status FROM appointments WHERE id=$1', [apptA.id]);
    eq(row.rows[0].status, 'done');
  });

  await test('doctor rejects unknown status and non-assigned appointment', async () => {
    eq((await req('PATCH', `/doctors/appointments/${apptA.id}`, { token: doctor.token, body: { status: 'no-show' } })).status, 400);
    eq((await req('PATCH', `/doctors/appointments/${apptA.id}`, { token: doctor2.token, body: { status: 'confirmed' } })).status, 404);
  });

  await test('doctor can update notes only, and clear notes', async () => {
    const r = await req('PATCH', `/doctors/appointments/${apptA.id}`, { token: doctor.token, body: { notes: 'Synthetic note' } });
    eq(r.status, 200);
    eq((await db.query('SELECT notes FROM appointments WHERE id=$1', [apptA.id])).rows[0].notes, 'Synthetic note');
    eq((await req('PATCH', `/doctors/appointments/${apptA.id}`, { token: doctor.token, body: { notes: '' } })).status, 200);
    eq((await db.query('SELECT notes FROM appointments WHERE id=$1', [apptA.id])).rows[0].notes, null);
  });

  await test('admin normalises legacy status and filters by legacy value', async () => {
    const when = new Date(Date.now() + 5 * 86400000).toISOString();
    const r = await req('POST', '/appointments', { token: patientB.token, body: { scheduled_at: when } });
    const id = r.body.appointment.id;
    eq((await req('PATCH', `/admin/appointments/${id}`, { token: admin.token, body: { status: 'completed' } })).status, 200);
    eq((await db.query('SELECT status FROM appointments WHERE id=$1', [id])).rows[0].status, 'done');
    const filtered = await req('GET', '/admin/appointments?status=completed', { token: admin.token });
    eq(filtered.status, 200);
    assert(filtered.body.some((a) => a.id === id), 'status=completed filter did not map to done');
    eq((await req('PATCH', `/admin/appointments/${id}`, { token: admin.token, body: { status: 'bogus' } })).status, 400);
  });

  // ================================================================
  group('Appointments: transition table (terminal done/cancelled)');
  // ================================================================
  // Inserts the row directly so every from-state is reachable; the API can no
  // longer produce a `done`/`cancelled` row it would then be asked to reopen.
  const makeAppt = async (patientId, doctorId, status) => {
    const r = await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status)
       VALUES ($1,$2, NOW() + INTERVAL '2 days', $3) RETURNING id`,
      [patientId, doctorId, status]
    );
    return r.rows[0].id;
  };
  const apptStatus = async (id) =>
    (await db.query('SELECT status FROM appointments WHERE id=$1', [id])).rows[0].status;

  await test('pending → confirmed / done / cancelled are allowed', async () => {
    const confirmed = await makeAppt(ids.patientA, ids.doctorProfile1, 'pending');
    eq((await req('PATCH', `/doctors/appointments/${confirmed}`, { token: doctor.token, body: { status: 'confirmed' } })).status, 200);
    eq(await apptStatus(confirmed), 'confirmed');

    const done = await makeAppt(ids.patientA, ids.doctorProfile1, 'pending');
    eq((await req('PATCH', `/admin/appointments/${done}`, { token: admin.token, body: { status: 'done' } })).status, 200);
    eq(await apptStatus(done), 'done');

    const cancelled = await makeAppt(ids.patientA, ids.doctorProfile1, 'pending');
    eq((await req('PATCH', `/doctors/appointments/${cancelled}`, { token: doctor.token, body: { status: 'cancelled' } })).status, 200);
    eq(await apptStatus(cancelled), 'cancelled');
  });

  await test('confirmed → done / cancelled are allowed, confirmed → pending is not', async () => {
    const done = await makeAppt(ids.patientA, ids.doctorProfile1, 'confirmed');
    eq((await req('PATCH', `/doctors/appointments/${done}`, { token: doctor.token, body: { status: 'done' } })).status, 200);
    eq(await apptStatus(done), 'done');

    const cancelled = await makeAppt(ids.patientA, ids.doctorProfile1, 'confirmed');
    eq((await req('PATCH', `/doctors/appointments/${cancelled}`, { token: doctor.token, body: { status: 'cancelled' } })).status, 200);
    eq(await apptStatus(cancelled), 'cancelled');

    const reopen = await makeAppt(ids.patientA, ids.doctorProfile1, 'confirmed');
    eq((await req('PATCH', `/admin/appointments/${reopen}`, { token: admin.token, body: { status: 'pending' } })).status, 409);
    eq(await apptStatus(reopen), 'confirmed', 'rejected transition still wrote the row');
  });

  await test('done is terminal: no cancel, no reopen (doctor and admin)', async () => {
    const id = await makeAppt(ids.patientA, ids.doctorProfile1, 'done');
    eq((await req('PATCH', `/doctors/appointments/${id}`, { token: doctor.token, body: { status: 'cancelled' } })).status, 409);
    eq((await req('PATCH', `/admin/appointments/${id}`, { token: admin.token, body: { status: 'cancelled' } })).status, 409);
    eq((await req('PATCH', `/admin/appointments/${id}`, { token: admin.token, body: { status: 'confirmed' } })).status, 409);
    eq((await req('PATCH', `/admin/appointments/${id}`, { token: admin.token, body: { status: 'pending' } })).status, 409);
    eq(await apptStatus(id), 'done');
    // Idempotent re-submit of the current status is accepted (no write churn).
    eq((await req('PATCH', `/doctors/appointments/${id}`, { token: doctor.token, body: { status: 'done' } })).status, 200);
    eq(await apptStatus(id), 'done');
  });

  await test('cancelled is terminal: no complete, no reopen (doctor and admin)', async () => {
    const id = await makeAppt(ids.patientA, ids.doctorProfile1, 'cancelled');
    eq((await req('PATCH', `/doctors/appointments/${id}`, { token: doctor.token, body: { status: 'done' } })).status, 409);
    eq((await req('PATCH', `/doctors/appointments/${id}`, { token: doctor.token, body: { status: 'confirmed' } })).status, 409);
    eq((await req('PATCH', `/admin/appointments/${id}`, { token: admin.token, body: { status: 'done' } })).status, 409);
    eq((await req('PATCH', `/admin/appointments/${id}`, { token: admin.token, body: { status: 'confirmed' } })).status, 409);
    eq(await apptStatus(id), 'cancelled');
  });

  await test('notes remain editable on closed visits (no status change)', async () => {
    for (const state of ['done', 'cancelled']) {
      const id = await makeAppt(ids.patientA, ids.doctorProfile1, state);
      const r = await req('PATCH', `/doctors/appointments/${id}`, { token: doctor.token, body: { notes: `note on ${state}` } });
      eq(r.status, 200, `${state}: ${JSON.stringify(r.body)}`);
      eq(await apptStatus(id), state, `${state} status changed by a notes-only update`);
      eq((await db.query('SELECT notes FROM appointments WHERE id=$1', [id])).rows[0].notes, `note on ${state}`);
      eq((await req('PATCH', `/admin/appointments/${id}`, { token: admin.token, body: { notes: `admin note on ${state}` } })).status, 200);
      eq(await apptStatus(id), state, `${state} status changed by an admin notes-only update`);
    }
  });

  await test('concurrent requests cannot bypass the transition table', async () => {
    // PGlite shares a single connection (DB_POOL_MAX=1), so this proves the
    // guard rejects every request that is invalid against the committed state,
    // not that multi-connection races are safe. Real-PostgreSQL verification is
    // still pending (see test/REAL_POSTGRES.md).
    const closed = await makeAppt(ids.patientA, ids.doctorProfile1, 'cancelled');
    const out = await Promise.all([
      req('PATCH', `/doctors/appointments/${closed}`, { token: doctor.token, body: { status: 'done' } }),
      req('PATCH', `/doctors/appointments/${closed}`, { token: doctor.token, body: { status: 'confirmed' } }),
      req('PATCH', `/admin/appointments/${closed}`, { token: admin.token, body: { status: 'done' } }),
    ]);
    eq(out.filter((r) => r.status === 409).length, 3, `statuses: ${JSON.stringify(out.map((r) => r.status))}`);
    eq(await apptStatus(closed), 'cancelled');

    const finished = await makeAppt(ids.patientA, ids.doctorProfile1, 'done');
    const out2 = await Promise.all([
      req('PATCH', `/doctors/appointments/${finished}`, { token: doctor.token, body: { status: 'cancelled' } }),
      req('PATCH', `/admin/appointments/${finished}`, { token: admin.token, body: { status: 'confirmed' } }),
    ]);
    eq(out2.filter((r) => r.status === 409).length, 2);
    eq(await apptStatus(finished), 'done');
  });

  // ================================================================
  group('Billing: ownership, itemisation, stock, status');
  // ================================================================
  let invoiceA;
  await test('admin creates itemised invoice with doctor fee (cents-safe total)', async () => {
    const r = await req('POST', '/billing/invoices', {
      token: admin.token,
      body: {
        patient_code: 'HEP-A0001',
        doctor_name: 'Doctor One',
        doctor_fee: '150.50',
        items: [
          { medicine_name: 'Amoxicillin 500', quantity: 2, mrp: '5.00', unit: 'strip', expiry_date: '2027-04-30' },
          { medicine_name: 'Consultation', quantity: 1, mrp: '0.10' },
        ],
      },
    });
    eq(r.status, 200);
    eq(r.body.medicines_amount, 10.1);
    eq(r.body.doctor_fee, 150.5);
    eq(r.body.total_amount, 160.6);
    invoiceA = r.body.invoice_id;
    const inv = await req('GET', `/billing/invoices/${invoiceA}`, { token: admin.token });
    eq(inv.status, 200);
    eq(inv.body.items.length, 2);
    const expiryItem = inv.body.items.find((it) => it.medicine_name === 'Amoxicillin 500');
    eq(expiryItem && expiryItem.expiry_date, '2027-04-30', 'invoice item expiry_date shifted');
    // Server-generated TIMESTAMP (NOW()) must also read back as the current
    // instant, not shifted by the host timezone.
    assert(
      Math.abs(new Date(inv.body.invoice_date).getTime() - Date.now()) < 5 * 60 * 1000,
      `invoice_date shifted: ${inv.body.invoice_date}`
    );
    eq(await db.query(`SELECT stock FROM inventory_items WHERE name='Amoxicillin 500'`).then((q) => q.rows[0].stock), 8, 'stock not decremented');
  });

  await test('invoice rejects appointment belonging to another patient', async () => {
    const r = await req('POST', '/billing/invoices', {
      token: admin.token,
      body: { patient_id: ids.patientA, appointment_id: (await db.query('SELECT id FROM appointments WHERE patient_id=$1 LIMIT 1', [ids.patientB])).rows[0].id, items: [{ medicine_name: 'X', quantity: 1, mrp: '1.00' }] },
    });
    eq(r.status, 400);
  });

  await test('insufficient stock rolls the whole invoice back', async () => {
    const before = await db.query('SELECT COUNT(*)::int AS n FROM invoices');
    const r = await req('POST', '/billing/invoices', {
      token: admin.token,
      body: { patient_id: ids.patientA, items: [{ medicine_name: 'LowStock', quantity: 5, mrp: '2.00' }] },
    });
    eq(r.status, 400);
    assert(/Insufficient stock/.test(r.body.error), 'unexpected error');
    const after = await db.query('SELECT COUNT(*)::int AS n FROM invoices');
    eq(after.rows[0].n, before.rows[0].n, 'invoice row leaked despite rollback');
    eq((await db.query(`SELECT stock FROM inventory_items WHERE name='LowStock'`)).rows[0].stock, 1, 'stock changed on rollback');
  });

  await test('invalid money (3 decimals) rejected', async () => {
    eq((await req('POST', '/billing/invoices', { token: admin.token, body: { patient_id: ids.patientA, items: [{ medicine_name: 'X', quantity: 1, mrp: '1.001' }] } })).status, 400);
    eq((await req('POST', '/billing/invoices', { token: admin.token, body: { patient_id: ids.patientA, items: [{ medicine_name: 'X', quantity: 0, mrp: '1.00' }] } })).status, 400);
  });

  await test('patient sees only own invoices; admin can mark paid', async () => {
    const mine = await req('GET', '/billing/my', { token: patientA.token });
    eq(mine.status, 200);
    assert(mine.body.some((i) => i.id === invoiceA && i.items.length === 2), 'own invoice/items missing');
    const bMine = await req('GET', '/billing/my', { token: patientB.token });
    assert(!bMine.body.some((i) => i.id === invoiceA), 'patient B sees patient A invoice');
    eq((await req('PATCH', `/billing/invoices/${invoiceA}`, { token: admin.token, body: { status: 'paid' } })).status, 200);
    eq((await req('PATCH', `/billing/invoices/${invoiceA}`, { token: admin.token, body: { status: 'void' } })).status, 400);
  });

  // ================================================================
  group('Prescriptions: ownership + reprint data');
  // ================================================================
  let prescriptionId;
  await test('doctor saves prescription for own appointment', async () => {
    const r = await req('POST', '/prescriptions', {
      token: doctor.token,
      body: {
        appointment_id: apptA.id,
        notes: 'Synthetic Rx',
        items: [{ medicine_name: 'Amoxicillin 500', dosage_morning: true, dosage_night: true, after_food: true, quantity: 5, instructions: 'Finish the course' }],
      },
    });
    eq(r.status, 200);
    prescriptionId = r.body.prescription_id;
    const mine = await req('GET', '/prescriptions/my', { token: patientA.token });
    eq(mine.status, 200);
    const rx = mine.body.find((x) => x.id === prescriptionId);
    assert(rx, 'created prescription missing from list');
    assert(
      Math.abs(new Date(rx.prescribed_on).getTime() - Date.now()) < 5 * 60 * 1000,
      `prescribed_on shifted: ${rx.prescribed_on}`
    );
  });

  await test('other doctor cannot prescribe on unassigned appointment', async () => {
    eq((await req('POST', '/prescriptions', { token: doctor2.token, body: { appointment_id: apptA.id, items: [{ medicine_name: 'X' }] } })).status, 404);
  });

  await test('invalid prescription item rejected before transaction', async () => {
    eq((await req('POST', '/prescriptions', { token: doctor.token, body: { appointment_id: apptA.id, items: [{ medicine_name: '   ' }] } })).status, 400);
    eq((await req('POST', '/prescriptions', { token: doctor.token, body: { appointment_id: apptA.id, items: [{ medicine_name: 'X', quantity: 0 }] } })).status, 400);
  });

  await test('patient reprints own prescription with items; other patient forbidden', async () => {
    const mine = await req('GET', '/prescriptions/my', { token: patientA.token });
    eq(mine.status, 200);
    const p = mine.body.find((x) => x.id === prescriptionId);
    assert(p && p.items.length === 1 && p.items[0].instructions === 'Finish the course', 'reprint items missing');
    eq((await req('GET', `/prescriptions/appointment/${apptA.id}`, { token: patientA.token })).status, 200);
    eq((await req('GET', `/prescriptions/appointment/${apptA.id}`, { token: patientB.token })).status, 403);
    eq((await req('GET', `/prescriptions/appointment/${apptA.id}`, { token: doctor2.token })).status, 403);
    eq((await req('GET', `/prescriptions/appointment/${apptA.id}`, { token: doctor.token })).status, 200);
    eq((await req('GET', `/prescriptions/appointment/${apptA.id}`, { token: admin.token })).status, 200);
  });

  // ================================================================
  group('Authorization: charts, own records, cross-patient access');
  // ================================================================
  await test('patient reads own records through the patient endpoints only', async () => {
    eq((await req('GET', '/patients/me', { token: patientA.token })).status, 200);
    eq((await req('GET', '/appointments/my', { token: patientA.token })).status, 200);
    eq((await req('GET', '/billing/my', { token: patientA.token })).status, 200);
    eq((await req('GET', '/prescriptions/my', { token: patientA.token })).status, 200);
    // `/patients/:id` is the admin/doctor chart endpoint; a patient must use
    // `/patients/me` + the owner-scoped lists above, never a raw chart read.
    eq((await req('GET', `/patients/${ids.patientA}`, { token: patientA.token })).status, 403);
  });

  await test('patient cannot read another patient chart', async () => {
    eq((await req('GET', `/patients/${ids.patientB}`, { token: patientA.token })).status, 403);
    eq((await req('GET', `/patients/${ids.patientA}`, { token: patientB.token })).status, 403);
    // Cross-patient history is also blocked on the appointment-scoped routes.
    eq((await req('GET', `/prescriptions/appointment/${apptA.id}`, { token: patientB.token })).status, 403);
    eq((await req('GET', `/appointments/${apptA.id}`, { token: patientB.token })).status, 404);
  });

  await test('assigned doctor can open the chart with full history', async () => {
    const r = await req('GET', `/patients/${ids.patientA}`, { token: doctor.token });
    eq(r.status, 200, JSON.stringify(r.body));
    assert(Array.isArray(r.body.appointments), 'chart is missing appointments');
    assert(Array.isArray(r.body.prescriptions), 'chart is missing prescriptions');
    assert(Array.isArray(r.body.invoices), 'chart is missing invoices');
    // The chart returns the 15 most recent rows; earlier transition tests add
    // appointments for the same patient, so compare against the DB's own top-15.
    const expected = await db.query(
      `SELECT id FROM appointments WHERE patient_id=$1
       ORDER BY COALESCE(scheduled_at, date_time) DESC LIMIT 15`,
      [ids.patientA]
    );
    assert(expected.rows.length > 0, 'fixture has no appointments for patient A');
    assert(
      r.body.appointments.length === expected.rows.length &&
        r.body.appointments.every((a) => expected.rows.some((e) => e.id === a.id)),
      'chart appointments do not match the patient history'
    );
    assert(r.body.prescriptions.some((p) => p.id === prescriptionId), 'chart lost the prescription');
    eq((await req('GET', `/patients/${ids.patientA}`, { token: admin.token })).status, 200);
  });

  await test('unrelated doctor can open any chart (documented clinic-wide EHR access)', async () => {
    // docs/Hospital Details.md grants doctors access to patient EHRs, and the
    // doctor UI only reaches charts through its own appointments. This asserts
    // the current, documented policy. Narrowing it to assigned patients is a
    // clinic decision: change the controller and this assertion together.
    eq((await req('GET', `/patients/${ids.patientA}`, { token: doctor2.token })).status, 200);
    eq((await req('GET', '/patients/', { token: doctor2.token })).status, 200);
  });

  await test('chart endpoint is role-gated, validated, and 404s unknown ids', async () => {
    eq((await req('GET', `/patients/${ids.patientA}`)).status, 401);
    eq((await req('GET', `/patients/${ids.patientA}`, { token: 'not-a-jwt' })).status, 401);
    eq((await req('GET', `/patients/${ids.patientA}`, { token: patientC.token })).status, 403);
    eq((await req('GET', '/patients/999999', { token: admin.token })).status, 404);
    eq((await req('GET', '/patients/not-a-number', { token: admin.token })).status, 400);
  });

  // ================================================================
  group('Push tokens: multi-device, idempotency, privacy');
  // ================================================================
  const token1 = 'ExponentPushToken[integration-device-1]';
  const token2 = 'ExponentPushToken[integration-device-2]';
  const tokenB = 'ExponentPushToken[integration-device-b]';
  const tokenC = 'ExponentPushToken[integration-device-c]';
  await test('patient registers two devices; re-register is idempotent', async () => {
    eq((await req('POST', '/patients/push-token', { token: patientA.token, body: { token: token1, platform: 'android' } })).status, 200);
    eq((await req('POST', '/patients/push-token', { token: patientA.token, body: { token: token1, platform: 'android' } })).status, 200);
    eq((await req('POST', '/patients/push-token', { token: patientA.token, body: { token: token2, platform: 'ios' } })).status, 200);
    eq((await req('POST', '/patients/push-token', { token: patientB.token, body: { token: tokenB, platform: 'android' } })).status, 200);
    eq((await req('POST', '/patients/push-token', { token: patientC.token, body: { token: tokenC, platform: 'ios' } })).status, 200);
    const rows = await db.query('SELECT token FROM patient_push_tokens WHERE user_id=$1 ORDER BY token', [ids['patient.a@example.test']]);
    eq(rows.rows.length, 2, 'expected exactly two device tokens');
    eq(rows.rows.filter((r) => r.token === token1).length, 1, 'duplicate token stored');
  });

  await test('recipient selection is an exact users.id match (no patient-id drift)', async () => {
    // Regression: `users.id` and `patients.id` are independent sequences. The
    // walk-in patient in the fixture shifts them apart, and the old query
    // resolved one user's notification to another user's device tokens.
    const a = await push.tokensForUser(ids['patient.a@example.test']);
    eq(a.length, 2, `Patient A token list: ${JSON.stringify(a)}`);
    assert(a.every((t) => t === token1 || t === token2), `Patient A list contains a foreign device: ${JSON.stringify(a)}`);
    eq((await push.tokensForUser(ids['patient.b@example.test'])).join(','), tokenB);
    eq((await push.tokensForUser(ids['patient.c@example.test'])).join(','), tokenC);
    eq((await push.tokensForUser(ids['doctor@example.test'])).length, 0, 'a doctor account must not inherit patient devices');
  });

  await test('invalid push token rejected; login/profile never leak tokens', async () => {
    eq((await req('POST', '/patients/push-token', { token: patientA.token, body: { token: 'not-a-token' } })).status, 400);
    const s = await login('patient.a@example.test');
    assert(!JSON.stringify(s).includes('ExponentPushToken'), 'login response leaks push token');
    const me = await req('GET', '/patients/me', { token: patientA.token });
    assert(!JSON.stringify(me.body).includes('ExponentPushToken'), 'profile leaks push token');
  });

  await test('test-push sends only the caller\'s devices; empty account gets 400', async () => {
    sentPushes.length = 0;
    const r = await req('POST', '/patients/test-push', { token: patientA.token });
    eq(r.status, 200);
    const call = sentPushes.find((p) => Array.isArray(p.tokens));
    assert(call, 'sendPush not called');
    eq(call.tokens.length, 2);
    assert(call.tokens.every((t) => t === token1 || t === token2), `unexpected tokens sent: ${JSON.stringify(call.tokens)}`);
    assert(!call.tokens.includes(tokenB) && !call.tokens.includes(tokenC), 'test push leaked to another patient');
    eq((await req('POST', '/patients/test-push', { token: patientB.token })).status, 200);
    eq(sentPushes[sentPushes.length - 1].tokens.join(','), tokenB, 'Patient B test push reached the wrong devices');
    // An account with no registered device is told so, and nothing is sent.
    const patientD = await login('patient.d@example.test');
    const before = sentPushes.length;
    eq((await req('POST', '/patients/test-push', { token: patientD.token })).status, 400);
    eq(sentPushes.length, before, 'empty account still triggered a provider call');
  });

  await test('appointment notification reaches only the appointment owner', async () => {
    const when = new Date(Date.now() + 9 * 86400000).toISOString();
    const booked = await req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: when, reason: 'push-isolation' } });
    eq(booked.status, 200, JSON.stringify(booked.body));
    sentPushes.length = 0;
    const upd = await req('PATCH', `/admin/appointments/${booked.body.appointment.id}`, { token: admin.token, body: { status: 'confirmed' } });
    eq(upd.status, 200, JSON.stringify(upd.body));
    const call = sentPushes.find((p) => Array.isArray(p.tokens));
    assert(call, 'no push sent for the confirmation');
    assert(call.tokens.every((t) => t === token1 || t === token2), `notification leaked: ${JSON.stringify(call.tokens)}`);
    eq(call.data && call.data.appointmentId, booked.body.appointment.id);
  });

  await test('re-saving the same status is idempotent and does not re-notify', async () => {
    const when = new Date(Date.now() + 10 * 86400000).toISOString();
    const booked = await req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: when, reason: 'idempotent-push' } });
    eq(booked.status, 200, JSON.stringify(booked.body));
    const id = booked.body.appointment.id;
    eq((await req('PATCH', `/doctors/appointments/${id}`, { token: doctor.token, body: { status: 'done' } })).status, 200);
    assert(sentPushes.length > 0, 'the first done transition did not notify');
    sentPushes.length = 0;
    eq((await req('PATCH', `/doctors/appointments/${id}`, { token: doctor.token, body: { status: 'done' } })).status, 200);
    eq(sentPushes.length, 0, 'an idempotent done re-submit sent a duplicate notification');
    eq((await db.query('SELECT status FROM appointments WHERE id=$1', [id])).rows[0].status, 'done');
  });

  await test('account switch on a shared device revokes the previous account', async () => {
    const shared = 'ExponentPushToken[integration-shared]';
    eq((await req('POST', '/patients/push-token', { token: patientA.token, body: { token: shared } })).status, 200);
    eq((await req('POST', '/patients/push-token', { token: patientC.token, body: { token: shared } })).status, 200);
    assert(!(await push.tokensForUser(ids['patient.a@example.test'])).includes(shared), 'previous account still owns the shared device');
    assert((await push.tokensForUser(ids['patient.c@example.test'])).includes(shared), 'new account did not claim the shared device');
    // Clean up C's shared registration so later assertions stay simple.
    eq((await req('DELETE', '/patients/push-token', { token: patientC.token, body: { token: shared } })).status, 200);
  });

  await test('admin debug-push exposes tokens only to admin', async () => {
    const r = await req('GET', '/debug-push', { token: admin.token });
    eq(r.status, 200);
    assert(Array.isArray(r.body.allTokensInDb), 'admin debug payload missing tokens');
  });

  // ================================================================
  group('Admin: staff lifecycle, search, settings');
  // ================================================================
  await test('admin registers doctor + admin, both can log in', async () => {
    eq((await req('POST', '/auth/register/doctor', { token: admin.token, body: { name: 'Doctor Three', email: 'doctor3@example.test', password: 'Passw0rd!', specialty: 'Pulmonology' } })).status, 200);
    eq((await req('POST', '/auth/register/admin', { token: admin.token, body: { name: 'Admin Two', email: 'admin2@example.test', password: 'Passw0rd!' } })).status, 200);
    await login('doctor3@example.test');
    await login('admin2@example.test');
    const d3 = await db.query('SELECT d.id FROM doctors d JOIN users u ON u.id=d.user_id WHERE u.email=$1', ['doctor3@example.test']);
    eq(d3.rows.length, 1, 'doctor profile not created');
  });

  await test('non-admin cannot register staff', async () => {
    eq((await req('POST', '/auth/register/doctor', { token: doctor.token, body: { name: 'X', email: 'x@example.test', password: 'Passw0rd!' } })).status, 403);
  });

  await test('admin user validation + self/last-admin protection', async () => {
    eq((await req('PUT', `/admin/users/${ids['patient.c@example.test']}`, { token: admin.token, body: { role: 'superuser' } })).status, 400);
    eq((await req('PUT', `/admin/users/${ids['patient.c@example.test']}`, { token: admin.token, body: { email: 'patient.a@example.test' } })).status, 400);
    eq((await req('PUT', `/admin/users/${ids['admin@example.test']}`, { token: admin.token, body: { active: false } })).status, 400);
    eq((await req('DELETE', `/admin/users/${ids['admin@example.test']}`, { token: admin.token })).status, 400);
  });

  await test('admin promotes patient to doctor (profile created) then demotes', async () => {
    eq((await req('PUT', `/admin/users/${ids['patient.c@example.test']}`, { token: admin.token, body: { role: 'doctor' } })).status, 200);
    eq((await db.query('SELECT COUNT(*)::int AS n FROM doctors WHERE user_id=$1', [ids['patient.c@example.test']])).rows[0].n, 1);
    eq((await req('PUT', `/admin/users/${ids['patient.c@example.test']}`, { token: admin.token, body: { role: 'patient' } })).status, 200);
  });

  await test('admin appointment search matches patient name, code and id', async () => {
    const byName = await req('GET', '/admin/appointments?search=Patient%20A', { token: admin.token });
    eq(byName.status, 200);
    assert(byName.body.length >= 1, 'name search returned nothing');
    const byCode = await req('GET', '/admin/appointments?search=HEP-A0001', { token: admin.token });
    assert(byCode.body.length >= 1, 'code search returned nothing');
    const byId = await req('GET', `/admin/appointments?search=${apptA.id}`, { token: admin.token });
    const adminRow = byId.body.find((a) => a.id === apptA.id);
    assert(adminRow, 'id search missed appointment');
    // Admin list is yet another read path; it must not shift the instant either.
    assert(
      Math.abs(new Date(adminRow.scheduled_at_effective).getTime() - new Date(apptA.scheduled_at).getTime()) < 1000,
      `admin list time shifted: ${adminRow.scheduled_at_effective} vs ${apptA.scheduled_at}`
    );
    const byDate = await req('GET', `/admin/appointments?date=${new Date(apptA.scheduled_at || apptA.date_time).toISOString().slice(0, 10)}`, { token: admin.token });
    eq(byDate.status, 200);
  });

  await test('admin patient search matches code/mobile/name', async () => {
    const r = await req('GET', '/admin/patients?search=HEP-B0002', { token: admin.token });
    eq(r.status, 200);
    eq(r.body.length, 1);
    eq(r.body[0].patient_code, 'HEP-B0002');
    const byMobile = await req('GET', '/admin/patients?search=9000000002', { token: admin.token });
    assert(byMobile.body.some((p) => p.patient_code === 'HEP-B0002'), 'mobile search failed');
  });

  await test('doctor patient search matches name/code', async () => {
    const r = await req('GET', '/patients/?q=HEP-A0001', { token: doctor.token });
    eq(r.status, 200);
    assert(r.body.some((p) => p.patient_code === 'HEP-A0001'), 'doctor search failed');
  });

  await test('clinic settings read/update validation', async () => {
    const g = await req('GET', '/admin/settings', { token: doctor.token });
    eq(g.status, 200);
    assert(g.body.openTime, 'default settings missing');
    eq((await req('POST', '/admin/settings', { token: admin.token, body: { clinicHours: { openTime: '25:00', closeTime: '18:00', days: 'Mon-Sat', slotMinutes: '15' } } })).status, 400);
    const ok = await req('POST', '/admin/settings', { token: admin.token, body: { clinicHours: { openTime: '08:30', closeTime: '17:30', days: 'Mon-Fri', slotMinutes: '20' } } });
    eq(ok.status, 200);
    eq(ok.body.clinicHours.openTime, '08:30');
    eq((await req('POST', '/admin/settings', { token: doctor.token, body: { openTime: '09:00' } })).status, 403);
  });

  // ================================================================
  group('Inventory: DATE-only expiry round trip');
  // ================================================================
  await test('inventory expiry_date is returned as exact YYYY-MM-DD', async () => {
    const created = await req('POST', '/inventory', {
      token: admin.token,
      body: { name: 'DateProbe Syrup', stock: 4, unit: 'bottle', mrp: '12.50', expiry_date: '2027-03-31' },
    });
    eq(created.status, 200, JSON.stringify(created.body));
    eq(created.body.item.expiry_date, '2027-03-31', 'create response shifted expiry_date');
    const id = created.body.item.id;

    const list = await req('GET', '/inventory?limit=100', { token: admin.token });
    eq(list.status, 200);
    const row = list.body.find((i) => i.id === id);
    eq(row && row.expiry_date, '2027-03-31', 'list shifted expiry_date');

    const updated = await req('PUT', `/inventory/${id}`, { token: admin.token, body: { expiry_date: '2027-04-30' } });
    eq(updated.status, 200, JSON.stringify(updated.body));
    eq(updated.body.item.expiry_date, '2027-04-30', 'update response shifted expiry_date');
  });

  // ================================================================
  group('Concurrency: appointment token allocation');
  // ================================================================
  await test('parallel bookings allocate distinct token numbers', async () => {
    const when = new Date(Date.now() + 6 * 86400000).toISOString();
    const calls = Array.from({ length: 5 }, () => req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: when } }));
    const out = await Promise.all(calls);
    const ok = out.filter((r) => r.status === 200);
    eq(ok.length, 1, 'duplicate guard should allow exactly one booking per patient/minute');
    // Different patients, same slot: tokens must differ.
    const when2 = new Date(Date.now() + 7 * 86400000).toISOString();
    const multi = await Promise.all([
      req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: when2 } }),
      req('POST', '/appointments', { token: patientB.token, body: { scheduled_at: when2 } }),
    ]);
    eq(multi.filter((r) => r.status === 200).length, 2, 'parallel different-patient bookings failed');
    const tokens = multi.map((r) => r.body.appointment.token_number);
    assert(new Set(tokens).size === 2, `duplicate token numbers: ${tokens}`);
  });

  await test('token day is the UTC calendar day (local-day boundary at the UTC offset)', async () => {
    // Token numbers are allocated per doctor per UTC date. For a UTC+05:30
    // clinic that means a local day boundary at 05:30, not local midnight.
    // This pins the current, documented behavior (changing it requires an
    // explicit clinic-timezone decision).
    const base = new Date(Date.now() + 60 * 86400000);
    const day = base.toISOString().slice(0, 10);
    const nextDay = new Date(Date.UTC(
      base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1
    )).toISOString().slice(0, 10);

    const book = (iso) => req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: iso } });
    const a = await book(`${day}T03:30:00.000Z`); // 09:00 IST on `day`
    const b = await book(`${day}T12:30:00.000Z`); // 18:00 IST on `day`
    const c = await book(`${day}T18:45:00.000Z`); // 00:15 IST on nextDay, still `day` in UTC
    const d = await book(`${nextDay}T00:00:00.000Z`); // 05:30 IST on nextDay (new UTC day)
    for (const [label, r] of [['a', a], ['b', b], ['c', c], ['d', d]]) {
      eq(r.status, 200, `${label}: ${JSON.stringify(r.body)}`);
    }

    // Round trips preserve the instant.
    for (const [label, r, iso] of [['a', a, `${day}T03:30:00.000Z`], ['d', d, `${nextDay}T00:00:00.000Z`]]) {
      assert(
        Math.abs(new Date(r.body.appointment.scheduled_at).getTime() - new Date(iso).getTime()) < 1000,
        `${label} time shifted: ${r.body.appointment.scheduled_at}`
      );
    }

    // Local (IST) dates: c is the next clinic day, but shares the UTC day with a/b.
    const istDate = (iso) => new Date(new Date(iso).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
    eq(istDate(a.body.appointment.scheduled_at), day);
    eq(istDate(c.body.appointment.scheduled_at), nextDay);
    eq(a.body.appointment.token_number, 1, 'first token of the UTC day');
    eq(b.body.appointment.token_number, 2, 'second token of the UTC day');
    eq(c.body.appointment.token_number, 3, 'local next-day booking still grouped into the UTC day');
    eq(d.body.appointment.token_number, 1, 'token counter must reset on the new UTC day');
  });

  // ================================================================
  group('Batch C: legacy patients, booking + cancel guards');
  // ================================================================

  await test('a legacy patient without a login account stays visible end to end', async () => {
    // Regression: the admin billing list and patient pickers inner-joined
    // users, so a patient row with user_id NULL (legacy import) and every
    // invoice belonging to it silently disappeared from the UI.
    const created = await req('POST', '/billing/invoices', {
      token: admin.token,
      body: { patient_code: 'HEP-LEGACY', items: [{ medicine_name: 'LegacyCharge', quantity: 1, mrp: '10.00' }] },
    });
    eq(created.status, 200, JSON.stringify(created.body));

    const list = await req('GET', '/billing/invoices?limit=100', { token: admin.token });
    eq(list.status, 200);
    const row = list.body.find((r) => r.id === created.body.invoice_id);
    assert(row, 'legacy patient invoice is missing from the admin billing list');
    eq(row.patient_code, 'HEP-LEGACY');

    const picker = await req('GET', '/patients?q=HEP-LEGACY', { token: admin.token });
    eq(picker.status, 200);
    const legacy = picker.body.find((p) => p.patient_code === 'HEP-LEGACY');
    assert(legacy, 'legacy patient is missing from the admin/doctor patient list');
    eq(legacy.name, 'HEP-LEGACY', 'missing display name fallback for an account-less patient');

    const chart = await req('GET', `/patients/${legacy.id}`, { token: admin.token });
    eq(chart.status, 200, JSON.stringify(chart.body));
    eq(chart.body.patient_code, 'HEP-LEGACY');
    assert(Array.isArray(chart.body.invoices), 'chart is missing the invoice history');
    assert(chart.body.invoices.some((i) => i.id === created.body.invoice_id), 'chart lost the legacy invoice');
  });

  await test('a deactivated doctor cannot receive new bookings', async () => {
    eq((await req('PUT', `/admin/users/${ids['doctor2@example.test']}`, { token: admin.token, body: { active: false } })).status, 200);
    try {
      const when = new Date(Date.now() + 11 * 86400000).toISOString();
      const blocked = await req('POST', '/appointments', {
        token: patientA.token,
        body: { scheduled_at: when, doctor_id: ids.doctorProfile2 },
      });
      eq(blocked.status, 400, JSON.stringify(blocked.body));
      assert(/not available/i.test(blocked.body.error), 'unexpected error for inactive doctor');
      // Nothing was persisted for the refused booking.
      const rows = await db.query('SELECT COUNT(*)::int AS n FROM appointments WHERE doctor_id=$1', [ids.doctorProfile2]);
      eq(rows.rows[0].n, 0, 'appointment persisted for an inactive doctor');
    } finally {
      eq((await req('PUT', `/admin/users/${ids['doctor2@example.test']}`, { token: admin.token, body: { active: true } })).status, 200);
    }
  });

  await test('doctor assignment: honors explicit doctor_id across multiple doctors', async () => {
    const targetDay = new Date(Date.now() + 15 * 86400000);
    targetDay.setUTCHours(9, 0, 0, 0);

    // 1. Explicit doctor assignment assigns to Doctor 2
    const explicitTime1 = new Date(targetDay.getTime() + 1800000).toISOString();
    const explicitBooking1 = await req('POST', '/appointments', {
      token: patientA.token,
      body: { scheduled_at: explicitTime1, doctor_id: ids.doctorProfile2, reason: 'consult Doctor 2' },
    });
    eq(explicitBooking1.status, 200, JSON.stringify(explicitBooking1.body));
    eq(explicitBooking1.body.appointment.doctor_id, ids.doctorProfile2, 'explicit doctor_id 2 was not honored');

    // 2. Explicit doctor assignment assigns to Doctor 1
    const explicitTime2 = new Date(targetDay.getTime() + 3600000).toISOString();
    const explicitBooking2 = await req('POST', '/appointments', {
      token: patientB.token,
      body: { scheduled_at: explicitTime2, doctor_id: ids.doctorProfile1, reason: 'consult Doctor 1' },
    });
    eq(explicitBooking2.status, 200, JSON.stringify(explicitBooking2.body));
    eq(explicitBooking2.body.appointment.doctor_id, ids.doctorProfile1, 'explicit doctor_id 1 was not honored');

    // 3. Default assignment when doctor_id is omitted falls back to primary doctor
    const defaultTime = new Date(targetDay.getTime() + 5400000).toISOString();
    const defaultBooking = await req('POST', '/appointments', {
      token: patientA.token,
      body: { scheduled_at: defaultTime, reason: 'default doctor' },
    });
    eq(defaultBooking.status, 200, JSON.stringify(defaultBooking.body));
    eq(defaultBooking.body.appointment.doctor_id, ids.doctorProfile1, 'default doctor was not assigned');
  });

  await test('a completed visit cannot be cancelled by the patient afterwards', async () => {
    const when = new Date(Date.now() + 12 * 86400000).toISOString();
    const booked = await req('POST', '/appointments', { token: patientA.token, body: { scheduled_at: when } });
    eq(booked.status, 200, JSON.stringify(booked.body));
    const id = booked.body.appointment.id;
    eq((await req('PATCH', `/doctors/appointments/${id}`, { token: doctor.token, body: { status: 'done' } })).status, 200);
    const cancelled = await req('PATCH', `/appointments/${id}`, { token: patientA.token, body: { status: 'cancelled' } });
    eq(cancelled.status, 400, JSON.stringify(cancelled.body));
    eq((await db.query('SELECT status FROM appointments WHERE id=$1', [id])).rows[0].status, 'done', 'completed visit was overwritten by a cancel');
  });

  // ================================================================
  // DB session timezone + startup schema validation
  // ================================================================
  group('DB session invariants');

  await test('pool session reports UTC in this environment', async () => {
    // PGlite ignores libpq startup `options` and shares one session, so this
    // only proves the session is UTC here. The pool startup option itself must
    // be verified against real PostgreSQL in staging (see test/REAL_POSTGRES.md).
    const pool = require(path.join(BACKEND_DIR, 'db.js'));
    const r = await pool.query('SHOW TimeZone');
    eq(r.rows[0].TimeZone, 'UTC', 'pool session is not UTC');
    assert(isUtcZoneName(r.rows[0].TimeZone), 'UTC zone was not recognized');
  });

  await test('a non-UTC session is detectable (guards against pooler override)', async () => {
    const pool = require(path.join(BACKEND_DIR, 'db.js'));
    try {
      await pool.query("SET TIME ZONE 'Asia/Kolkata'");
      const r = await pool.query('SHOW TimeZone');
      eq(r.rows[0].TimeZone, 'Asia/Kolkata');
      eq(isUtcZoneName(r.rows[0].TimeZone), false, 'non-UTC zone was accepted');
    } finally {
      // PGlite shares one session across clients; restore it for later tests.
      await pool.query("SET TIME ZONE 'UTC'");
    }
  });

  await test('required-schema check passes on the fully migrated database', async () => {
    const pool = require(path.join(BACKEND_DIR, 'db.js'));
    const result = await checkRequiredSchema((sql, params) => pool.query(sql, params));
    assert(result.ok, `missing: ${JSON.stringify(result.missing)}`);
  });

  await test('startup readiness resolved before serving requests', async () => {
    const pool = require(path.join(BACKEND_DIR, 'db.js'));
    const state = await pool.ready;
    eq(state.utcZone, 'UTC');
    eq(state.schema.ok, true);
    eq(state.ensureFailures.length, 0, `ensure failures: ${JSON.stringify(state.ensureFailures)}`);
  });

  // ================================================================
  // Cleanup (always reached: a failed subtest does not throw here)
  // ================================================================
  await new Promise((r) => server.close(r));
  try { await require(path.join(BACKEND_DIR, 'db.js')).end(); } catch (_) { /* ignore */ }
  await socketServer.stop();
  await db.close();
});
