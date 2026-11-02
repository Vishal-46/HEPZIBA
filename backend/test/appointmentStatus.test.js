'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  APPOINTMENT_STATUSES,
  ALLOWED_TRANSITIONS,
  normalizeAppointmentStatus,
  isAppointmentStatus,
  canTransition,
  allowedFromStatuses,
} = require('../utils/appointmentStatus');

test('canonical statuses exclude the legacy value', () => {
  assert.deepEqual(APPOINTMENT_STATUSES, ['pending', 'confirmed', 'done', 'cancelled']);
  assert.equal(APPOINTMENT_STATUSES.includes('completed'), false);
});

test('normalizeAppointmentStatus maps legacy completed to done', () => {
  assert.equal(normalizeAppointmentStatus('completed'), 'done');
  assert.equal(normalizeAppointmentStatus('COMPLETED'), 'done');
  assert.equal(normalizeAppointmentStatus('  Completed  '), 'done');
});

test('normalizeAppointmentStatus accepts every canonical status', () => {
  for (const status of APPOINTMENT_STATUSES) {
    assert.equal(normalizeAppointmentStatus(status), status);
    assert.equal(normalizeAppointmentStatus(status.toUpperCase()), status);
  }
});

test('normalizeAppointmentStatus rejects unknown/empty values', () => {
  assert.equal(normalizeAppointmentStatus('approved'), null);
  assert.equal(normalizeAppointmentStatus(''), null);
  assert.equal(normalizeAppointmentStatus('   '), null);
  assert.equal(normalizeAppointmentStatus(null), null);
  assert.equal(normalizeAppointmentStatus(undefined), null);
});

test('isAppointmentStatus mirrors the normaliser', () => {
  assert.equal(isAppointmentStatus('done'), true);
  assert.equal(isAppointmentStatus('completed'), true);
  assert.equal(isAppointmentStatus('nope'), false);
  assert.equal(isAppointmentStatus(null), false);
});

test('transition table: pending can be confirmed, done or cancelled', () => {
  for (const next of ['pending', 'confirmed', 'done', 'cancelled']) {
    assert.equal(canTransition('pending', next), true, `pending -> ${next}`);
  }
});

test('transition table: confirmed can only finish or be cancelled', () => {
  assert.equal(canTransition('confirmed', 'done'), true);
  assert.equal(canTransition('confirmed', 'cancelled'), true);
  assert.equal(canTransition('confirmed', 'confirmed'), true);
  assert.equal(canTransition('confirmed', 'pending'), false, 'confirmed must not go back to pending');
});

test('transition table: done and cancelled are terminal', () => {
  assert.equal(canTransition('done', 'done'), true, 'idempotent re-submit');
  assert.equal(canTransition('done', 'pending'), false);
  assert.equal(canTransition('done', 'confirmed'), false);
  assert.equal(canTransition('done', 'cancelled'), false, 'a finished visit must not be cancelled afterwards');
  assert.equal(canTransition('cancelled', 'cancelled'), true, 'idempotent re-submit');
  assert.equal(canTransition('cancelled', 'pending'), false);
  assert.equal(canTransition('cancelled', 'confirmed'), false);
  assert.equal(canTransition('cancelled', 'done'), false, 'a cancelled visit must not be completed later');
});

test('transition table: legacy completed is treated as done', () => {
  assert.equal(canTransition('completed', 'done'), true);
  assert.equal(canTransition('completed', 'cancelled'), false);
  assert.equal(canTransition('pending', 'completed'), true, 'normalised before the check');
  assert.equal(canTransition('completed', 'completed'), true);
});

test('transition table: unknown values never transition', () => {
  assert.equal(canTransition('no-show', 'done'), false);
  assert.equal(canTransition('pending', 'no-show'), false);
  assert.equal(canTransition(null, 'done'), false);
  assert.equal(canTransition('pending', undefined), false);
});

test('allowedFromStatuses lists the sources accepted by the SQL guard', () => {
  assert.deepEqual(allowedFromStatuses('confirmed'), ['pending', 'confirmed']);
  assert.deepEqual(allowedFromStatuses('done'), ['pending', 'confirmed', 'done']);
  assert.deepEqual(allowedFromStatuses('cancelled'), ['pending', 'confirmed', 'cancelled']);
  assert.deepEqual(allowedFromStatuses('completed'), ['pending', 'confirmed', 'done']);
  assert.deepEqual(allowedFromStatuses('pending'), ['pending']);
  assert.equal(allowedFromStatuses('bogus'), null);
});

test('every transition in ALLOWED_TRANSITIONS agrees with canTransition', () => {
  for (const from of APPOINTMENT_STATUSES) {
    for (const to of APPOINTMENT_STATUSES) {
      const expected = ALLOWED_TRANSITIONS[from].includes(to);
      assert.equal(canTransition(from, to), expected, `${from} -> ${to}`);
    }
  }
});
