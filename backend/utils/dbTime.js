// Timezone-independent handling for PostgreSQL date/time columns.
//
// TIMESTAMP (OID 1114) columns hold UTC wall-clock values. This API writes
// absolute instants: appointment times are inserted as ISO 8601 UTC strings
// (`toISOString()`), and every other TIMESTAMP column is written by Postgres
// `NOW()` while the database session runs in UTC. The stored wall clock is
// therefore UTC.
//
// node-postgres, however, parses TIMESTAMP values in the *Node process*
// timezone. On a host that is not UTC (e.g. UTC+05:30) every returned
// appointment time shifts by the offset, so a 19:18 booking reads back as
// 13:48. Registering this parser makes reads behave the same on every host as
// they already do on a UTC deployment.
//
// DATE (OID 1082) columns are date-only values (`patients.dob`,
// `inventory_items.expiry_date`, `invoice_items.expiry_date`). The driver
// would otherwise turn them into a JS Date at local midnight, which makes the
// JSON representation depend on the host timezone: a 1990-05-15 DOB can be
// serialized as 1990-05-14T18:30:00Z and display as the previous day. Keeping
// the `YYYY-MM-DD` text makes the API contract explicit and host-independent.
//
// TIMESTAMPTZ (OID 1184, e.g. refresh_tokens.expires_at /
// password_changed_at) already carries an absolute instant and is left to the
// driver default.
const TIMESTAMP_OID = 1114;
const DATE_OID = 1082;

// PostgreSQL reports the UTC zone as `UTC` or `Etc/UTC` depending on how the
// server was configured. Both (and the GMT aliases) are the same zero offset.
const UTC_ZONE_NAMES = new Set(['utc', 'etc/utc', 'gmt', 'etc/gmt']);

/** True when `SHOW TimeZone` names a zero-offset UTC session. */
function isUtcZoneName(zone) {
  return UTC_ZONE_NAMES.has(String(zone || '').trim().toLowerCase());
}

/**
 * Parse a `timestamp without time zone` value as UTC.
 * node-postgres passes strings shaped `YYYY-MM-DD HH:mm:ss[.SSS]`.
 */
function parseTimestampAsUtc(value) {
  if (value === null || value === undefined) return value;
  if (value === 'infinity') return Infinity;
  if (value === '-infinity') return -Infinity;
  // `replace` only affects the date/time separator; a TIMESTAMP never carries
  // an offset, so appending `Z` cannot create an invalid or double-zoned date.
  return new Date(`${String(value).replace(' ', 'T')}Z`);
}

/**
 * Return a DATE column as its `YYYY-MM-DD` text instead of a local-midnight
 * Date. `infinity` / `-infinity` are passed through unchanged.
 */
function parseDateOnly(value) {
  if (value === null || value === undefined) return value;
  return String(value);
}

function registerDbTypeParsers(types) {
  types.setTypeParser(TIMESTAMP_OID, parseTimestampAsUtc);
  types.setTypeParser(DATE_OID, parseDateOnly);
}

module.exports = {
  TIMESTAMP_OID,
  DATE_OID,
  isUtcZoneName,
  parseTimestampAsUtc,
  parseDateOnly,
  registerDbTypeParsers,
};
