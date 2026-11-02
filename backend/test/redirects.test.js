'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedMobileRedirect } = require('../utils/redirects');

const prod = { nodeEnv: 'production', allowlist: '' };
const dev = { nodeEnv: 'development', allowlist: '' };

test('production allows the app deep-link scheme', () => {
  assert.equal(isAllowedMobileRedirect('patient-mobile://auth/callback', prod), true);
});

test('production rejects Expo Go, localhost and LAN redirects', () => {
  assert.equal(isAllowedMobileRedirect('exp://192.168.1.5:8081/--/auth', prod), false);
  assert.equal(isAllowedMobileRedirect('http://localhost:8081/auth', prod), false);
  assert.equal(isAllowedMobileRedirect('http://127.0.0.1:19000', prod), false);
  assert.equal(isAllowedMobileRedirect('http://192.168.0.10:8081/auth', prod), false);
  assert.equal(isAllowedMobileRedirect('http://10.0.0.4:8081/auth', prod), false);
});

test('operator allow-list works in production', () => {
  const options = { nodeEnv: 'production', allowlist: 'https://app.hepziba.com/, exp://trusted' };
  assert.equal(isAllowedMobileRedirect('https://app.hepziba.com/auth', options), true);
  assert.equal(isAllowedMobileRedirect('exp://trusted/--/auth', options), true);
  assert.equal(isAllowedMobileRedirect('https://evil.example/auth', options), false);
});

test('development keeps the Expo Go conveniences', () => {
  assert.equal(isAllowedMobileRedirect('exp://192.168.1.5:8081/--/auth', dev), true);
  assert.equal(isAllowedMobileRedirect('http://localhost:8081/auth', dev), true);
  assert.equal(isAllowedMobileRedirect('http://192.168.1.5:8081/auth', dev), true);
});

test('rejects empty and non-string input', () => {
  assert.equal(isAllowedMobileRedirect('', prod), false);
  assert.equal(isAllowedMobileRedirect('   ', prod), false);
  assert.equal(isAllowedMobileRedirect(null, prod), false);
  assert.equal(isAllowedMobileRedirect(undefined, prod), false);
  assert.equal(isAllowedMobileRedirect(42, prod), false);
});
