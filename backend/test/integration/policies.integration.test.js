// Policy regression suite for the approved business rules:
//   A. Invoice visibility (admin / assigned doctor / owner patient)
//   B. Aadhaar + mobile masking by default, narrow admin/owner/doctor reveal
//   C. Booking notifications (patient + assigned doctor, after COMMIT)
//   D. Patient cancellation notifications (doctor + admins, only on real change)
//   E. Audited admin-only reopening of closed visits
//   F. Prescription / invoice / reminder notifications with durable reminders
//
// Runs the real Express app and the real push recipient-selection code against
// disposable PGlite. Only https://exp.host is intercepted. Synthetic fixtures
// only: no network, no credentials, no production data.
'use strict';

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

async function applyFile(db, file) {
  for (const stmt of splitSql(fs.readFileSync(file, 'utf8'))) {
    await db.exec(stmt);
  }
}

nodeTest('Approved business policies A-F', async (t) => {
  const db = new PGlite();
  await db.exec("SET TIME ZONE 'UTC'");
  await applyFile(db, path.join(REPO, 'hepziba_schema.sql'));
  // 001 is expected to fail twice on a fresh DB (doctors/prescriptions ordering);
  // replay it tolerantly, exactly like the documented operator flow.
  for (const stmt of splitSql(fs.readFileSync(path.join(SQL_DIR, '001_hospital_alignment.sql'), 'utf8'))) {
    try { await db.exec(stmt); } catch (_) { /* known fresh-DB ordering errors */ }
  }

  const hash = await bcrypt.hash('Passw0rd!', 4);
  for (const [name, email, role] of [
    ['Admin One', 'admin@example.test', 'admin'],
    ['Doctor One', 'doctor@example.test', 'doctor'],
    ['Doctor Two', 'doctor2@example.test', 'doctor'],
    ['Patient A', 'patient.a@example.test', 'patient'],
    ['Patient B', 'patient.b@example.test', 'patient'],
  ]) {
    await db.query(
      `INSERT INTO users (name, email, password, role, email_verified, active)
       VALUES ($1,$2,$3,$4,TRUE,TRUE)`,
      [name, email, hash, role]
    );
  }

  for (const f of [
    '002_fix_doctors_and_constraints.sql',
    '004_repair_clinic_columns.sql',
    '005_session_tokens.sql',
    '006_clinic_settings.sql',
    '007_inventory_mrp_expiry.sql',
    '008_billing_fee_push.sql',
    '009_consistency_hardening.sql',
    '010_policy_batch.sql',
  ]) {
    await applyFile(db, path.join(SQL_DIR, f));
  }

  const users = {};
  for (const u of (await db.query('SELECT id, email FROM users')).rows) users[u.email] = u.id;
  const doctorProfiles = (await db.query('SELECT id, user_id FROM doctors')).rows;
  const doctor1 = doctorProfiles.find((d) => d.user_id === users['doctor@example.test']).id;
  const doctor2 = doctorProfiles.find((d) => d.user_id === users['doctor2@example.test']).id;

  const patients = {};
  for (const [email, code, age, sex, mobile, aadhar] of [
    ['patient.a@example.test', 'HEP-A0001', 34, 'F', '9000000001', '111122223333'],
    ['patient.b@example.test', 'HEP-B0002', 41, 'M', '9000000002', '444455556666'],
  ]) {
    const r = await db.query(
      `INSERT INTO patients (user_id, patient_code, age, sex, mobile, aadhar_number)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [users[email], code, age, sex, mobile, aadhar]
    );
    patients[code] = r.rows[0].id;
  }
  const patientA = patients['HEP-A0001'];
  const patientB = patients['HEP-B0002'];

  // One assignment each: doctor1 -> patient A, doctor2 -> patient B.
  const apptA = (await db.query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
     VALUES ($1,$2,NOW() + INTERVAL '2 days',NOW() + INTERVAL '2 days','confirmed') RETURNING id`,
    [patientA, doctor1]
  )).rows[0].id;
  const apptB = (await db.query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
     VALUES ($1,$2,NOW() + INTERVAL '2 days',NOW() + INTERVAL '2 days','confirmed') RETURNING id`,
    [patientB, doctor2]
  )).rows[0].id;

  const invoiceA = (await db.query(
    `INSERT INTO invoices (patient_id, appointment_id, doctor_name, total_amount)
     VALUES ($1,$2,'Doctor One',100.00) RETURNING id`,
    [patientA, apptA]
  )).rows[0].id;
  const invoiceB = (await db.query(
    `INSERT INTO invoices (patient_id, appointment_id, doctor_name, total_amount)
     VALUES ($1,$2,'Doctor Two',200.00) RETURNING id`,
    [patientB, apptB]
  )).rows[0].id;
  for (const [inv, name, amount] of [[invoiceA, 'Synthetic A', 100], [invoiceB, 'Synthetic B', 200]]) {
    await db.query(
      `INSERT INTO invoice_items (invoice_id, medicine_name, unit, mrp, quantity, total)
       VALUES ($1,$2,'strip',$3,1,$3)`,
      [inv, name, amount]
    );
  }

  // ---------- App + socket + push interception ----------
  const socketServer = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1', maxConnections: 5 });
  await socketServer.start();
  const dbPort = Number(socketServer.getServerConn().split(':').pop());
  process.env.DATABASE_URL = `postgresql://postgres@127.0.0.1:${dbPort}/postgres`;
  process.env.JWT_SECRET = 'policies-integration-secret-not-real';
  process.env.NODE_ENV = 'test';
  process.env.DB_POOL_MAX = '1';
  process.env.AUTH_LOGIN_MAX = '10000';
  process.env.APPOINTMENT_REMINDER_OFFSET_MINUTES = '60';

  const realFetch = global.fetch;
  const pushes = [];
  let pushMode = 'ok';
  global.fetch = async (url, opts) => {
    const target = String(url);
    if (target.startsWith('https://exp.host/')) {
      if (pushMode === 'throw') throw new Error('synthetic provider outage');
      const messages = JSON.parse(opts.body);
      pushes.push({
        tokens: messages.map((m) => m.to),
        title: messages[0] && messages[0].title,
        body: messages[0] && messages[0].body,
        data: messages[0] && messages[0].data,
        raw: opts.body,
      });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: 'stub' })) }),
      };
    }
    return realFetch(url, opts);
  };

  const app = require(path.join(BACKEND_DIR, 'app.js'));
  const reminders = require(path.join(BACKEND_DIR, 'utils/reminders.js'));

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
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
  const doc1 = await login('doctor@example.test');
  const doc2 = await login('doctor2@example.test');
  const patA = await login('patient.a@example.test');
  const patB = await login('patient.b@example.test');

  const tokens = {
    admin: 'ExponentPushToken[policy-admin]',
    doctor1: 'ExponentPushToken[policy-doctor1]',
    doctor2: 'ExponentPushToken[policy-doctor2]',
    patientA: 'ExponentPushToken[policy-patientA]',
    patientB: 'ExponentPushToken[policy-patientB]',
  };
  for (const [key, session] of [
    ['admin', admin], ['doctor1', doc1], ['doctor2', doc2],
    ['patientA', patA], ['patientB', patB],
  ]) {
    const r = await req('POST', '/patients/push-token', { token: session.token, body: { token: tokens[key], platform: 'android' } });
    assert.equal(r.status, 200, `register ${key}: ${JSON.stringify(r.body)}`);
  }

  const sentTokens = () => pushes.flatMap((p) => p.tokens);
  const resetPushes = () => { pushes.length = 0; };

  // ================================================================
  // Policy A: invoice visibility
  // ================================================================
  await t.test('A: admin lists all invoices; doctors only their assigned patients', async () => {
    const all = await req('GET', '/billing/invoices?limit=100', { token: admin.token });
    assert.equal(all.status, 200);
    const ids = all.body.map((i) => i.id);
    assert.ok(ids.includes(invoiceA) && ids.includes(invoiceB), 'admin did not see every invoice');

    const d1 = await req('GET', '/billing/invoices?limit=100', { token: doc1.token });
    assert.equal(d1.status, 200);
    assert.deepEqual(d1.body.map((i) => i.id), [invoiceA], 'doctor1 saw a non-assigned invoice');

    const d2 = await req('GET', '/billing/invoices?limit=100', { token: doc2.token });
    assert.equal(d2.status, 200);
    assert.deepEqual(d2.body.map((i) => i.id), [invoiceB], 'doctor2 saw a non-assigned invoice');
  });

  await t.test('A: invoice detail and downloads enforce assignment and ownership', async () => {
    assert.equal((await req('GET', `/billing/invoices/${invoiceA}`, { token: doc1.token })).status, 200);
    assert.equal((await req('GET', `/billing/invoices/${invoiceB}`, { token: doc1.token })).status, 403, 'doctor1 read doctor2 patient invoice');
    assert.equal((await req('GET', `/billing/invoices/${invoiceA}`, { token: doc2.token })).status, 403, 'doctor2 read doctor1 patient invoice');
    assert.equal((await req('GET', `/billing/invoices/${invoiceA}`, { token: patA.token })).status, 200, 'owner lost access');
    assert.equal((await req('GET', `/billing/invoices/${invoiceA}`, { token: patB.token })).status, 403, 'other patient read invoice');
    assert.equal((await req('GET', `/billing/invoices/${invoiceA}`)).status, 401, 'anonymous read invoice');

    const my = await req('GET', '/billing/my', { token: patA.token });
    assert.equal(my.status, 200);
    assert.deepEqual(my.body.map((i) => i.id), [invoiceA]);
    // Unauthorized responses reveal no invoice details.
    const denied = await req('GET', `/billing/invoices/${invoiceB}`, { token: doc1.token });
    assert.ok(!JSON.stringify(denied.body).includes('Synthetic B'));
  });

  await t.test('A: chart-embedded invoices follow the same rules', async () => {
    const d1 = await req('GET', `/patients/${patientA}`, { token: doc1.token });
    assert.equal(d1.status, 200);
    assert.ok(d1.body.invoices.some((i) => i.id === invoiceA), 'assigned doctor lost chart invoices');

    const d2 = await req('GET', `/patients/${patientA}`, { token: doc2.token });
    assert.equal(d2.status, 200, 'clinic-wide EHR access must stay available');
    assert.deepEqual(d2.body.invoices, [], 'unassigned doctor saw chart invoices');

    const adm = await req('GET', `/patients/${patientA}`, { token: admin.token });
    assert.equal(adm.status, 200);
    assert.ok(adm.body.invoices.some((i) => i.id === invoiceA));
  });

  // ================================================================
  // Policy B: masking
  // ================================================================
  await t.test('B: patient list, profile, search and chart are masked by default', async () => {
    const list = await req('GET', '/patients?q=9000000001', { token: admin.token });
    assert.equal(list.status, 200);
    assert.equal(list.body[0].mobile, 'XXXXXX0001');
    assert.equal(list.body[0].aadhar_number, 'XXXX-XXXX-3333');

    const searchAadhaar = await req('GET', '/patients?q=111122223333', { token: admin.token });
    assert.equal(searchAadhaar.status, 200, 'search must still match the stored value');
    assert.equal(searchAadhaar.body[0].aadhar_number, 'XXXX-XXXX-3333');

    const chart = await req('GET', `/patients/${patientA}`, { token: doc1.token });
    assert.equal(chart.body.mobile, 'XXXXXX0001');
    assert.equal(chart.body.aadhar_number, 'XXXX-XXXX-3333');

    const me = await req('GET', '/patients/me', { token: patA.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.mobile, 'XXXXXX0001');
    assert.equal(me.body.aadhar_number, 'XXXX-XXXX-3333');
  });

  await t.test('B: only the documented reveal exception returns originals', async () => {
    const adminReveal = await req('GET', `/patients/${patientA}?reveal=contact`, { token: admin.token });
    assert.equal(adminReveal.status, 200);
    assert.equal(adminReveal.body.mobile, '9000000001');
    assert.equal(adminReveal.body.aadhar_number, '111122223333');

    const ownerReveal = await req('GET', '/patients/me?reveal=contact', { token: patA.token });
    assert.equal(ownerReveal.body.mobile, '9000000001');

    // A doctor may reveal only their own appointment list, not the chart.
    const doctorChartReveal = await req('GET', `/patients/${patientA}?reveal=contact`, { token: doc1.token });
    assert.equal(doctorChartReveal.body.mobile, 'XXXXXX0001', 'doctor chart bypassed masking');
    assert.equal(doctorChartReveal.body.aadhar_number, 'XXXX-XXXX-3333');

    const doctorListReveal = await req('GET', '/appointments/for-me?reveal=contact', { token: doc1.token });
    assert.equal(doctorListReveal.status, 200);
    assert.ok(doctorListReveal.body.every((a) => a.mobile === '9000000001' || a.mobile === null));

    const doctorListMasked = await req('GET', '/appointments/for-me', { token: doc1.token });
    assert.ok(doctorListMasked.body.every((a) => a.mobile === null || String(a.mobile).startsWith('X')));

    const adminAppts = await req('GET', '/admin/appointments?limit=100', { token: admin.token });
    assert.ok(adminAppts.body.every((a) => a.mobile === null || String(a.mobile).startsWith('X')));
    const adminApptsReveal = await req('GET', '/admin/appointments?limit=100&reveal=contact', { token: admin.token });
    assert.ok(adminApptsReveal.body.some((a) => a.mobile === '9000000001'));

    const adminInv = await req('GET', '/billing/invoices?limit=100', { token: admin.token });
    assert.ok(adminInv.body.every((i) => i.patient_mobile === null || String(i.patient_mobile).startsWith('X')));
    const adminInvReveal = await req('GET', '/billing/invoices?limit=100&reveal=contact', { token: admin.token });
    assert.ok(adminInvReveal.body.some((i) => i.patient_mobile === '9000000001'));

    const invDetailReveal = await req('GET', `/billing/invoices/${invoiceA}?reveal=contact`, { token: admin.token });
    assert.equal(invDetailReveal.body.patient_mobile, '9000000001');
    const invDetailDoctor = await req('GET', `/billing/invoices/${invoiceA}?reveal=contact`, { token: doc1.token });
    assert.equal(invDetailDoctor.body.patient_mobile, 'XXXXXX0001', 'doctor invoice bypassed masking');
  });

  await t.test('B: unauthorized roles cannot use reveal, including debug output', async () => {
    assert.equal((await req('GET', `/patients/${patientA}?reveal=contact`, { token: patA.token })).status, 403);
    assert.equal((await req('GET', '/admin/patients?reveal=contact', { token: doc1.token })).status, 403);
    assert.equal((await req('GET', '/admin/patients?reveal=contact', { token: patA.token })).status, 403);

    const debug = await req('GET', `/debug-push/${apptA}`, { token: admin.token });
    assert.equal(debug.status, 200);
    assert.equal(debug.body.patient.mobile, 'XXXXXX0001');
    assert.equal(debug.body.patient.aadhar_number, 'XXXX-XXXX-3333');
  });

  // ================================================================
  // Policy C: booking notifications
  // ================================================================
  let bookedAppointment = null;
  const bookedAt = new Date(Date.now() + 4 * 86400000).toISOString();

  await t.test('C: booking notifies exactly the patient and assigned doctor after persistence', async () => {
    resetPushes();
    const r = await req('POST', '/appointments', {
      token: patA.token,
      body: {
        doctor_id: doctor1,
        scheduled_at: bookedAt,
        reason: 'synthetic',
        // Client-supplied ids must not influence recipient resolution.
        user_id: users['admin@example.test'],
        patient_id: patientB,
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    bookedAppointment = r.body.appointment;
    assert.ok(bookedAppointment.id, 'booking was not persisted');

    const tos = sentTokens();
    assert.deepEqual(tos.sort(), [tokens.doctor1, tokens.patientA].sort(), 'wrong booking recipients');
    assert.ok(!tos.includes(tokens.doctor2), 'unrelated doctor notified');
    assert.ok(!tos.includes(tokens.admin), 'admin notified on ordinary booking');
    for (const p of pushes) {
      assert.deepEqual(Object.keys(p.data), ['appointmentId']);
      assert.equal(p.data.appointmentId, bookedAppointment.id);
      assert.ok(!p.raw.includes('synthetic'), 'reason leaked into push payload');
      assert.ok(!p.raw.includes('9000000001'), 'mobile leaked into push payload');
    }
  });

  await t.test('C: failed and duplicate bookings send nothing', async () => {
    resetPushes();
    const past = await req('POST', '/appointments', {
      token: patA.token,
      body: { doctor_id: doctor1, scheduled_at: new Date(Date.now() - 3600000).toISOString() },
    });
    assert.equal(past.status, 400);
    assert.deepEqual(sentTokens(), [], 'failed booking sent a notification');

    const dup = await req('POST', '/appointments', {
      token: patA.token,
      body: { doctor_id: doctor1, scheduled_at: bookedAt },
    });
    assert.equal(dup.status, 409);
    assert.deepEqual(sentTokens(), [], 'duplicate booking sent a notification');
  });

  await t.test('C: provider outage never fails or rolls back a booking', async () => {
    resetPushes();
    pushMode = 'throw';
    try {
      const r = await req('POST', '/appointments', {
        token: patA.token,
        body: { doctor_id: doctor1, scheduled_at: new Date(Date.now() + 5 * 86400000).toISOString() },
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = await db.query('SELECT id FROM appointments WHERE id=$1', [r.body.appointment.id]);
      assert.equal(row.rows.length, 1, 'booking was rolled back by a provider outage');
    } finally {
      pushMode = 'ok';
    }
  });

  // ================================================================
  // Policy D: cancellation notifications
  // ================================================================
  await t.test('D: a real patient cancellation notifies the doctor and admins only', async () => {
    resetPushes();
    const r = await req('PATCH', `/appointments/${bookedAppointment.id}`, { token: patA.token, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const tos = sentTokens();
    assert.deepEqual(tos.sort(), [tokens.admin, tokens.doctor1].sort(), 'wrong cancellation recipients');
    assert.ok(!tos.includes(tokens.patientA), 'the cancelling patient was notified');
    assert.ok(!tos.includes(tokens.doctor2), 'unrelated doctor notified');
    for (const p of pushes) {
      assert.deepEqual(Object.keys(p.data), ['appointmentId']);
      assert.equal(p.data.appointmentId, bookedAppointment.id);
    }
    const row = await db.query('SELECT status FROM appointments WHERE id=$1', [bookedAppointment.id]);
    assert.equal(row.rows[0].status, 'cancelled');
  });

  await t.test('D: repeated, rejected and completed cancellations send nothing', async () => {
    resetPushes();
    const again = await req('PATCH', `/appointments/${bookedAppointment.id}`, { token: patA.token, body: {} });
    assert.equal(again.status, 400);
    assert.deepEqual(sentTokens(), [], 'repeated cancellation notified');

    const done = (await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
       VALUES ($1,$2,NOW() + INTERVAL '1 day',NOW() + INTERVAL '1 day','done') RETURNING id`,
      [patientA, doctor1]
    )).rows[0].id;
    const completed = await req('PATCH', `/appointments/${done}`, { token: patA.token, body: {} });
    assert.equal(completed.status, 400, 'completed visit was cancellable');
    assert.deepEqual(sentTokens(), [], 'rejected cancellation notified');
  });

  await t.test('D: provider outage does not reverse a successful cancellation', async () => {
    const fresh = (await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
       VALUES ($1,$2,NOW() + INTERVAL '1 day',NOW() + INTERVAL '1 day','confirmed') RETURNING id`,
      [patientA, doctor1]
    )).rows[0].id;
    resetPushes();
    pushMode = 'throw';
    try {
      const r = await req('PATCH', `/appointments/${fresh}`, { token: patA.token, body: {} });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const row = await db.query('SELECT status FROM appointments WHERE id=$1', [fresh]);
      assert.equal(row.rows[0].status, 'cancelled');
    } finally {
      pushMode = 'ok';
    }
  });

  // ================================================================
  // Policy E: audited reopening
  // ================================================================
  const closed = (await db.query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
     VALUES ($1,$2,NOW() + INTERVAL '1 day',NOW() + INTERVAL '1 day','done') RETURNING id`,
    [patientA, doctor1]
  )).rows[0].id;
  const cancelledClosed = (await db.query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
     VALUES ($1,$2,NOW() + INTERVAL '1 day',NOW() + INTERVAL '1 day','cancelled') RETURNING id`,
    [patientA, doctor1]
  )).rows[0].id;

  await t.test('E: ordinary endpoints cannot reopen a closed visit, even for an admin', async () => {
    const adminPatch = await req('PATCH', `/admin/appointments/${closed}`, { token: admin.token, body: { status: 'confirmed' } });
    assert.equal(adminPatch.status, 409, 'admin PATCH reopened a done visit');
    const doctorPatch = await req('PATCH', `/doctors/appointments/${closed}`, { token: doc1.token, body: { status: 'confirmed' } });
    assert.equal(doctorPatch.status, 409, 'doctor PATCH reopened a done visit');
    // Notes-only updates remain allowed on a closed visit.
    const notes = await req('PATCH', `/admin/appointments/${closed}`, { token: admin.token, body: { notes: 'post-visit note' } });
    assert.equal(notes.status, 200, JSON.stringify(notes.body));
    const row = await db.query('SELECT status FROM appointments WHERE id=$1', [closed]);
    assert.equal(row.rows[0].status, 'done');
  });

  await t.test('E: only admins can call the correction workflow, with a valid reason', async () => {
    assert.equal((await req('POST', `/admin/appointments/${closed}/reopen`, { token: doc1.token, body: { reason: 'valid reason' } })).status, 403);
    assert.equal((await req('POST', `/admin/appointments/${closed}/reopen`, { token: patA.token, body: { reason: 'valid reason' } })).status, 403);
    assert.equal((await req('POST', `/admin/appointments/${closed}/reopen`, { token: admin.token, body: {} })).status, 400);
    assert.equal((await req('POST', `/admin/appointments/${closed}/reopen`, { token: admin.token, body: { reason: 'no' } })).status, 400);
    assert.equal((await req('POST', `/admin/appointments/${closed}/reopen`, { token: admin.token, body: { reason: 'valid reason', status: 'done' } })).status, 400);
    assert.equal((await req('POST', '/admin/appointments/999999/reopen', { token: admin.token, body: { reason: 'valid reason' } })).status, 404);
    assert.equal((await req('POST', `/admin/appointments/${apptA}/reopen`, { token: admin.token, body: { reason: 'valid reason' } })).status, 409);
  });

  await t.test('E: a valid correction changes state and writes the full audit record', async () => {
    const r = await req('POST', `/admin/appointments/${closed}/reopen`, {
      token: admin.token,
      body: { reason: 'Visit marked done by mistake at the front desk' },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.appointment.status, 'confirmed');
    const audit = await db.query(
      `SELECT appointment_id, actor_user_id, previous_status, corrected_status, reason, created_at
         FROM appointment_status_corrections WHERE appointment_id=$1`,
      [closed]
    );
    assert.equal(audit.rows.length, 1, 'audit row missing');
    const a = audit.rows[0];
    assert.equal(a.appointment_id, closed);
    assert.equal(a.actor_user_id, users['admin@example.test']);
    assert.equal(a.previous_status, 'done');
    assert.equal(a.corrected_status, 'confirmed');
    assert.match(a.reason, /front desk/);
    assert.ok(a.created_at instanceof Date || !Number.isNaN(new Date(a.created_at).getTime()));
  });

  await t.test('E: concurrent corrections cannot both apply', async () => {
    const before = (await db.query(
      'SELECT COUNT(*)::int AS n FROM appointment_status_corrections WHERE appointment_id=$1',
      [cancelledClosed]
    )).rows[0].n;
    const results = await Promise.all([
      req('POST', `/admin/appointments/${cancelledClosed}/reopen`, { token: admin.token, body: { reason: 'first correction reason' } }),
      req('POST', `/admin/appointments/${cancelledClosed}/reopen`, { token: admin.token, body: { reason: 'second correction reason' } }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409], `unexpected concurrent result: ${JSON.stringify(statuses)}`);
    const after = (await db.query(
      'SELECT COUNT(*)::int AS n FROM appointment_status_corrections WHERE appointment_id=$1',
      [cancelledClosed]
    )).rows[0].n;
    assert.equal(after - before, 1, 'concurrent corrections wrote more than one audit row');
  });

  await t.test('E: an audit write failure rolls the correction back', async () => {
    const target = (await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
       VALUES ($1,$2,NOW() + INTERVAL '1 day',NOW() + INTERVAL '1 day','cancelled') RETURNING id`,
      [patientA, doctor1]
    )).rows[0].id;
    await db.exec(`CREATE OR REPLACE FUNCTION synthetic_fail_audit() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$ LANGUAGE plpgsql`);
    await db.exec(`CREATE TRIGGER synthetic_fail_audit BEFORE INSERT ON appointment_status_corrections
      FOR EACH ROW EXECUTE FUNCTION synthetic_fail_audit()`);
    try {
      const r = await req('POST', `/admin/appointments/${target}/reopen`, {
        token: admin.token,
        body: { reason: 'this audit will fail on purpose' },
      });
      assert.equal(r.status, 500);
      const row = await db.query('SELECT status FROM appointments WHERE id=$1', [target]);
      assert.equal(row.rows[0].status, 'cancelled', 'status changed without an audit record');
      const audit = await db.query('SELECT id FROM appointment_status_corrections WHERE appointment_id=$1', [target]);
      assert.equal(audit.rows.length, 0);
    } finally {
      await db.exec('DROP TRIGGER IF EXISTS synthetic_fail_audit ON appointment_status_corrections');
      await db.exec('DROP FUNCTION IF EXISTS synthetic_fail_audit()');
    }
  });

  // ================================================================
  // Policy F: prescription, invoice and reminder notifications
  // ================================================================
  await t.test('F: prescription creation notifies only the patient, without clinical data', async () => {
    resetPushes();
    const r = await req('POST', '/prescriptions', {
      token: doc1.token,
      body: {
        appointment_id: apptA,
        notes: 'synthetic clinical note',
        items: [{ medicine_name: 'SyntheticMed', quantity: 1, instructions: 'synthetic instructions' }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(sentTokens(), [tokens.patientA], 'prescription notification reached the wrong account');
    assert.deepEqual(Object.keys(pushes[0].data), ['appointmentId']);
    assert.ok(!pushes[0].raw.includes('SyntheticMed'), 'medicine leaked');
    assert.ok(!pushes[0].raw.includes('synthetic clinical note'), 'clinical note leaked');
  });

  await t.test('F: failed prescriptions send nothing', async () => {
    resetPushes();
    const empty = await req('POST', '/prescriptions', { token: doc1.token, body: { appointment_id: apptA, items: [] } });
    assert.equal(empty.status, 400);
    const foreign = await req('POST', '/prescriptions', {
      token: doc1.token,
      body: { appointment_id: apptB, items: [{ medicine_name: 'SyntheticMed' }] },
    });
    assert.equal(foreign.status, 404, 'doctor wrote a prescription for another doctor\'s visit');
    assert.deepEqual(sentTokens(), [], 'failed prescription sent a notification');
  });

  await t.test('F: invoice creation notifies only the invoice owner, without financial data', async () => {
    resetPushes();
    const r = await req('POST', '/billing/invoices', {
      token: admin.token,
      body: {
        patient_code: 'HEP-A0001',
        doctor_name: 'Doctor One',
        items: [{ medicine_name: 'SyntheticCharge', mrp: 10, quantity: 1 }],
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(sentTokens(), [tokens.patientA], 'invoice notification reached the wrong account');
    assert.deepEqual(Object.keys(pushes[0].data), ['invoiceId']);
    assert.ok(!pushes[0].raw.includes('SyntheticCharge'), 'line item leaked');
    assert.ok(!pushes[0].raw.includes('10'), 'amount leaked');
  });

  await t.test('F: failed invoices send nothing', async () => {
    resetPushes();
    const r = await req('POST', '/billing/invoices', {
      token: admin.token,
      body: { patient_code: 'HEP-A0001', items: [] },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(sentTokens(), [], 'failed invoice sent a notification');
  });

  await t.test('F: booking schedules a durable reminder at the configured offset', async () => {
    const r = await req('POST', '/appointments', {
      token: patA.token,
      body: { doctor_id: doctor1, scheduled_at: new Date(Date.now() + 6 * 86400000).toISOString() },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = await db.query(
      `SELECT EXTRACT(EPOCH FROM (
                r.scheduled_for - (COALESCE(a.scheduled_at, a.date_time) AT TIME ZONE 'UTC')
              ))::int AS seconds
         FROM appointment_reminders r JOIN appointments a ON a.id = r.appointment_id
        WHERE r.appointment_id = $1`,
      [r.body.appointment.id]
    );
    assert.equal(row.rows.length, 1, 'no reminder row was persisted with the booking');
    assert.equal(Number(row.rows[0].seconds), -60 * 60, 'reminder was not scheduled exactly 60 minutes before the visit');
  });

  await t.test('F: reminders are delivered once, only to the patient, with a minimal payload', async () => {
    await db.query('DELETE FROM appointment_reminders');
    const appt = (await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
       VALUES ($1,$2,NOW() + INTERVAL '2 hours',NOW() + INTERVAL '2 hours','confirmed') RETURNING id`,
      [patientA, doctor1]
    )).rows[0].id;
    await db.query(
      `INSERT INTO appointment_reminders (appointment_id, scheduled_for) VALUES ($1, NOW() - INTERVAL '1 minute')`,
      [appt]
    );
    resetPushes();
    const first = await reminders.processDueReminders({ max: 5 });
    assert.equal(first.sent, 1, JSON.stringify(first));
    assert.deepEqual(sentTokens(), [tokens.patientA], 'reminder reached the wrong account');
    assert.equal(pushes[0].title, 'Appointment reminder');
    assert.deepEqual(Object.keys(pushes[0].data), ['appointmentId']);
    assert.equal(pushes[0].data.appointmentId, appt);

    resetPushes();
    const second = await reminders.processDueReminders({ max: 5 });
    assert.equal(second.sent, 0, 'a second worker run resent the reminder');
    assert.deepEqual(sentTokens(), []);
  });

  await t.test('F: cancelled and completed visits are never reminded', async () => {
    await db.query('DELETE FROM appointment_reminders');
    for (const status of ['cancelled', 'done']) {
      const appt = (await db.query(
        `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
         VALUES ($1,$2,NOW() + INTERVAL '2 hours',NOW() + INTERVAL '2 hours',$3) RETURNING id`,
        [patientA, doctor1, status]
      )).rows[0].id;
      await db.query(
        `INSERT INTO appointment_reminders (appointment_id, scheduled_for) VALUES ($1, NOW() - INTERVAL '1 minute')`,
        [appt]
      );
    }
    resetPushes();
    const result = await reminders.processDueReminders({ max: 5 });
    assert.equal(result.sent, 0);
    assert.deepEqual(sentTokens(), [], 'a closed visit was reminded');
  });

  await t.test('F: concurrent claims cannot deliver the same reminder twice', async () => {
    await db.query('DELETE FROM appointment_reminders');
    const appt = (await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, date_time, status)
       VALUES ($1,$2,NOW() + INTERVAL '2 hours',NOW() + INTERVAL '2 hours','confirmed') RETURNING id`,
      [patientA, doctor1]
    )).rows[0].id;
    await db.query(
      `INSERT INTO appointment_reminders (appointment_id, scheduled_for) VALUES ($1, NOW() - INTERVAL '1 minute')`,
      [appt]
    );
    const claims = await Promise.all([reminders.claimDueReminder(), reminders.claimDueReminder()]);
    assert.equal(claims.filter(Boolean).length, 1, 'two workers claimed the same reminder');
  });

  await t.test('F: missing reminder configuration fails safe (no row, no send)', async () => {
    await db.query('DELETE FROM appointment_reminders');
    const before = (await db.query('SELECT COUNT(*)::int AS n FROM appointment_reminders')).rows[0].n;
    process.env.APPOINTMENT_REMINDER_OFFSET_MINUTES = '';
    try {
      resetPushes();
      const r = await req('POST', '/appointments', {
        token: patA.token,
        body: { doctor_id: doctor1, scheduled_at: new Date(Date.now() + 7 * 86400000).toISOString() },
      });
      assert.equal(r.status, 200);
      const after = (await db.query('SELECT COUNT(*)::int AS n FROM appointment_reminders')).rows[0].n;
      assert.equal(after, before, 'a reminder was scheduled without configuration');
      const result = await reminders.processDueReminders({ max: 5 });
      assert.equal(result.sent, 0);
    } finally {
      process.env.APPOINTMENT_REMINDER_OFFSET_MINUTES = '60';
    }
  });

  // ---------- cleanup ----------
  await new Promise((r) => server.close(r));
  try { await require(path.join(BACKEND_DIR, 'db.js')).end(); } catch (_) { /* ignore */ }
  await socketServer.stop();
  await db.close();
});
