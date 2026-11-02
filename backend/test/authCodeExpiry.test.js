'use strict';

// Regression: verification/reset codes are stored in TIMESTAMP (no time zone)
// columns. Comparing them in JavaScript makes freshness depend on the Node
// process timezone, so a freshly issued 15-minute code can look hours old and
// always be rejected. Expiry must be evaluated by Postgres (`code_valid`).
//
// The fake DB deliberately returns an already-past `reset_code_expires_at` /
// `verification_code_expires_at` Date together with `code_valid: true`. That is
// exactly what a non-UTC Node process sees for a fresh code; the controller
// must trust the DB boolean, not the Date.

const test = require('node:test');
const assert = require('node:assert/strict');

const dbPath = require.resolve('../db');
const cryptoPath = require.resolve('../utils/crypto');
const mailerPath = require.resolve('../mailer/mailer');

let queries = [];
let nextRows = [];

const fakePool = {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM users WHERE email=\$1/.test(sql)) return { rows: nextRows, rowCount: nextRows.length };
    return { rows: [], rowCount: 1 };
  },
  connect: async () => {
    throw new Error('connect() is not expected in these unit tests');
  },
};

require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, children: [], paths: [],
  exports: fakePool,
};
require.cache[cryptoPath] = {
  id: cryptoPath, filename: cryptoPath, loaded: true, children: [], paths: [],
  exports: {
    hashPassword: async () => 'stub-hash',
    checkPassword: async () => true,
    generateCode: () => '123456',
    generateSecureToken: () => 'stub-token',
  },
};
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true, children: [], paths: [],
  exports: { sendMail: async () => ({ id: 'stub' }) },
};

const ctrl = require('../auth/authController');

function makeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

test.beforeEach(() => {
  queries = [];
  nextRows = [];
});

test('reset password accepts a fresh code even when the stored TIMESTAMP parses as past', async () => {
  nextRows = [{
    id: 7,
    reset_code: '123456',
    code_valid: true,
    // Simulates pg parsing a UTC timestamp in a UTC+5:30 Node process.
    reset_code_expires_at: new Date('2000-01-01T00:00:00Z'),
  }];
  const res = makeRes();
  await ctrl.resetPassword(
    { body: { email: 'patient@example.test', code: '123456', newPassword: 'longenough' } },
    res,
  );
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.message, /successful/i);
  assert.ok(queries.some((q) => /AS code_valid/.test(q.sql)), 'expiry must be evaluated in SQL');
});

test('reset password still rejects an expired or mismatched code', async () => {
  nextRows = [{ id: 7, reset_code: '123456', code_valid: false }];
  let res = makeRes();
  await ctrl.resetPassword(
    { body: { email: 'patient@example.test', code: '123456', newPassword: 'longenough' } },
    res,
  );
  assert.equal(res.statusCode, 400);

  nextRows = [{ id: 7, reset_code: '123456', code_valid: true }];
  res = makeRes();
  await ctrl.resetPassword(
    { body: { email: 'patient@example.test', code: '000000', newPassword: 'longenough' } },
    res,
  );
  assert.equal(res.statusCode, 400);
});

test('email verification accepts a fresh code even when the stored TIMESTAMP parses as past', async () => {
  nextRows = [{
    id: 7,
    verification_code: '654321',
    email_verified: false,
    code_valid: true,
    verification_code_expires_at: new Date('2000-01-01T00:00:00Z'),
  }];
  const res = makeRes();
  await ctrl.verifyEmail({ body: { email: 'patient@example.test', code: '654321' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.match(res.body.message, /verified/i);
  assert.ok(queries.some((q) => /AS code_valid/.test(q.sql)), 'expiry must be evaluated in SQL');
});

test('email verification still rejects an expired or mismatched code', async () => {
  nextRows = [{ id: 7, verification_code: '654321', email_verified: false, code_valid: false }];
  let res = makeRes();
  await ctrl.verifyEmail({ body: { email: 'patient@example.test', code: '654321' } }, res);
  assert.equal(res.statusCode, 400);

  nextRows = [{ id: 7, verification_code: '654321', email_verified: false, code_valid: true }];
  res = makeRes();
  await ctrl.verifyEmail({ body: { email: 'patient@example.test', code: '111111' } }, res);
  assert.equal(res.statusCode, 400);
});
