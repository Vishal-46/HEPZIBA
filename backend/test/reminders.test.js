'use strict';

// Policy F: reminder configuration and scheduling semantics.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  reminderOffsetMinutes,
  remindersEnabled,
  scheduleReminder,
  claimDueReminder,
  startReminderWorker,
  stopReminderWorker,
  MAX_OFFSET_MINUTES,
} = require('../utils/reminders');

test('reminder offset is disabled unless a valid positive integer is configured', () => {
  assert.equal(reminderOffsetMinutes({}), null);
  assert.equal(reminderOffsetMinutes({ APPOINTMENT_REMINDER_OFFSET_MINUTES: '' }), null);
  assert.equal(reminderOffsetMinutes({ APPOINTMENT_REMINDER_OFFSET_MINUTES: '   ' }), null);
  assert.equal(reminderOffsetMinutes({ APPOINTMENT_REMINDER_OFFSET_MINUTES: '0' }), null);
  assert.equal(reminderOffsetMinutes({ APPOINTMENT_REMINDER_OFFSET_MINUTES: '-15' }), null);
  assert.equal(reminderOffsetMinutes({ APPOINTMENT_REMINDER_OFFSET_MINUTES: 'abc' }), null);
  assert.equal(reminderOffsetMinutes({ APPOINTMENT_REMINDER_OFFSET_MINUTES: '1.5' }), null);
  assert.equal(
    reminderOffsetMinutes({ APPOINTMENT_REMINDER_OFFSET_MINUTES: String(MAX_OFFSET_MINUTES + 1) }),
    null
  );
  assert.equal(reminderOffsetMinutes({ APPOINTMENT_REMINDER_OFFSET_MINUTES: '60' }), 60);
  assert.equal(remindersEnabled({ APPOINTMENT_REMINDER_OFFSET_MINUTES: '60' }), true);
  assert.equal(remindersEnabled({}), false);
});

test('scheduling is a no-op when reminders are disabled (no DB access)', async () => {
  let queried = false;
  const client = { query: async () => { queried = true; return { rows: [] }; } };
  const result = await scheduleReminder(client, { id: 1, scheduled_at: new Date(Date.now() + 86400000).toISOString() }, {});
  assert.equal(result, null);
  assert.equal(queried, false, 'disabled reminders must not touch the database');
});

test('scheduling inserts one durable row at appointment time minus the offset', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ id: 9, appointment_id: params[0], scheduled_for: params[1] }] };
    },
  };
  const when = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const row = await scheduleReminder(
    client,
    { id: 42, scheduled_at: when },
    { APPOINTMENT_REMINDER_OFFSET_MINUTES: '60' }
  );
  assert.equal(row.id, 9);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT \(appointment_id\) DO NOTHING/);
  assert.equal(calls[0].params[0], 42);
  const delta = new Date(calls[0].params[1]).getTime() - new Date(when).getTime();
  assert.equal(delta, -60 * 60 * 1000, 'scheduled_for must be exactly offset minutes before the visit');
});

test('scheduling skips reminders that would already be in the past', async () => {
  let queried = false;
  const client = { query: async () => { queried = true; return { rows: [] }; } };
  const when = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // inside a 60-min window
  const result = await scheduleReminder(
    client,
    { id: 42, scheduled_at: when },
    { APPOINTMENT_REMINDER_OFFSET_MINUTES: '60' }
  );
  assert.equal(result, null);
  assert.equal(queried, false);
});

test('scheduling ignores appointments without an id or a usable time', async () => {
  const client = { query: async () => { throw new Error('should not query'); } };
  const env = { APPOINTMENT_REMINDER_OFFSET_MINUTES: '60' };
  assert.equal(await scheduleReminder(client, { scheduled_at: new Date(Date.now() + 86400000).toISOString() }, env), null);
  assert.equal(await scheduleReminder(client, { id: 1 }, env), null);
  assert.equal(await scheduleReminder(client, { id: 1, scheduled_at: 'not-a-date' }, env), null);
});

test('claim re-checks status/timing atomically and uses SKIP LOCKED', async () => {
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [{ id: 1, appointment_id: 2, scheduled_for: '2026-01-01T00:00:00Z' }] };
    },
  };
  const claimed = await claimDueReminder(client);
  assert.equal(claimed.appointment_id, 2);
  assert.equal(calls.length, 1);
  const sql = calls[0];
  assert.match(sql, /FOR UPDATE OF r SKIP LOCKED/);
  assert.match(sql, /sent_at = NOW\(\)/, 'claim must mark the row in the same statement');
  assert.match(sql, /IN \('pending', 'confirmed'\)/, 'cancelled/done visits must not be reminded');
  assert.match(sql, /COALESCE\(a\.scheduled_at, a\.date_time\) > NOW\(\)/, 'past visits must not be reminded');
});

test('worker stays off without configuration', () => {
  stopReminderWorker();
  const handle = startReminderWorker({ intervalMs: 10, env: {} });
  assert.equal(handle, null);
  stopReminderWorker();
});
