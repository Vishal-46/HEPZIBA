'use strict';

// Regression: TIMESTAMP columns are stored as UTC wall clock and DATE columns
// are date-only. node-postgres parses both in the Node process timezone by
// default, which shifted returned appointment times and could move date-only
// fields to the previous/next day. The registered parsers must be
// host-timezone independent, including across DST transitions.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const {
  TIMESTAMP_OID,
  DATE_OID,
  isUtcZoneName,
  parseTimestampAsUtc,
  parseDateOnly,
  registerDbTypeParsers,
} = require('../utils/dbTime');

const DBTIME_PATH = require.resolve('../utils/dbTime');

function parseInTimezone(tz, value) {
  const script = `
    const { parseTimestampAsUtc, parseDateOnly } = require(${JSON.stringify(DBTIME_PATH)});
    const shifted = new Date(${JSON.stringify(value)}).toISOString();
    process.stdout.write(JSON.stringify({
      ts: parseTimestampAsUtc(${JSON.stringify(value)}).toISOString(),
      date: parseDateOnly('1990-05-15'),
      shifted,
    }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('parses a pg TIMESTAMP string as UTC, independent of host timezone', () => {
  const parsed = parseTimestampAsUtc('2026-10-29 13:48:09.57');
  assert.equal(parsed.toISOString(), '2026-10-29T13:48:09.570Z');
  assert.equal(parsed.getTime(), Date.parse('2026-10-29T13:48:09.570Z'));
});

test('keeps sub-second precision and midnight boundaries', () => {
  assert.equal(
    parseTimestampAsUtc('2026-01-01 00:00:00').toISOString(),
    '2026-01-01T00:00:00.000Z',
  );
  assert.equal(
    parseTimestampAsUtc('2026-12-31 23:59:59.999').toISOString(),
    '2026-12-31T23:59:59.999Z',
  );
});

test('handles NULL and infinite timestamps like the driver default', () => {
  assert.equal(parseTimestampAsUtc(null), null);
  assert.equal(parseTimestampAsUtc(undefined), undefined);
  assert.equal(parseTimestampAsUtc('infinity'), Infinity);
  assert.equal(parseTimestampAsUtc('-infinity'), -Infinity);
});

test('DATE values stay YYYY-MM-DD text and never become a local-midnight Date', () => {
  assert.equal(parseDateOnly('1990-05-15'), '1990-05-15');
  assert.equal(parseDateOnly('2027-03-31'), '2027-03-31');
  assert.equal(parseDateOnly(null), null);
  assert.equal(parseDateOnly(undefined), undefined);
  assert.equal(typeof parseDateOnly('1990-05-15'), 'string');
});

test('a DATE serialized as a UTC datetime renders as the previous day west of UTC', () => {
  // This is the off-by-one hazard the date-only contract avoids: a client in
  // New York receiving 1990-05-15T00:00:00Z displays 14 May.
  const rendered = new Date('1990-05-15T00:00:00.000Z').toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
  });
  assert.equal(rendered, '5/14/1990');
  // The API now sends the calendar date as text, so no zone is applied.
  assert.equal(parseDateOnly('1990-05-15'), '1990-05-15');
});

test('UTC parsing is identical in positive, negative and DST-observing zones', () => {
  const zones = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Australia/Lord_Howe'];
  for (const tz of zones) {
    const out = parseInTimezone(tz, '2026-10-29 13:48:09.57');
    assert.equal(out.ts, '2026-10-29T13:48:09.570Z', `timestamp shifted in ${tz}`);
    assert.equal(out.date, '1990-05-15', `date shifted in ${tz}`);
  }
});

test('DST spring-forward and fall-back times are unambiguous UTC', () => {
  // 02:30 does not exist in New York on 2026-03-08; 01:30 is ambiguous on
  // 2026-11-01. Both must round-trip as the same UTC wall clock.
  assert.equal(
    parseInTimezone('America/New_York', '2026-03-08 02:30:00').ts,
    '2026-03-08T02:30:00.000Z',
  );
  assert.equal(
    parseInTimezone('America/New_York', '2026-11-01 01:30:00').ts,
    '2026-11-01T01:30:00.000Z',
  );
  // Control: the naive `new Date(value)` path *does* shift, which is exactly
  // what the parser avoids.
  assert.notEqual(
    parseInTimezone('America/New_York', '2026-03-08 02:30:00').shifted,
    '2026-03-08T02:30:00.000Z',
  );
});

test('registers TIMESTAMP and DATE only, leaving TIMESTAMPTZ untouched', () => {
  const registered = [];
  registerDbTypeParsers({
    setTypeParser(oid, fn) {
      registered.push({ oid, fn });
    },
  });
  assert.equal(TIMESTAMP_OID, 1114);
  assert.equal(DATE_OID, 1082);
  assert.deepEqual(registered.map((r) => r.oid), [1114, 1082]);
  assert.equal(registered.some((r) => r.oid === 1184), false, 'TIMESTAMPTZ parser must not be overridden');
  assert.equal(registered[0].fn('2026-10-29 13:48:09.57').toISOString(), '2026-10-29T13:48:09.570Z');
  assert.equal(registered[1].fn('1990-05-15'), '1990-05-15');
});

test('accepts UTC zone names and rejects any offset zone', () => {
  for (const zone of ['UTC', 'utc', 'Etc/UTC', 'GMT', 'Etc/GMT', ' UTC ']) {
    assert.equal(isUtcZoneName(zone), true, `${zone} should be accepted`);
  }
  for (const zone of ['Asia/Kolkata', 'America/New_York', 'Europe/London', '', null, undefined, 'UTC+05:30']) {
    assert.equal(isUtcZoneName(zone), false, `${zone} should be rejected`);
  }
});
