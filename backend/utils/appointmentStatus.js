// Canonical appointment statuses. The database/docs use `done`; older code
// also wrote `completed`, which made queue filters hide finished visits and
// caused the update controllers to retry against a second value. All writes
// now go through this single normaliser.
const APPOINTMENT_STATUSES = ['pending', 'confirmed', 'done', 'cancelled'];

// Allowed status transitions. A visit may move forward (pending → confirmed →
// done) or be cancelled before it is finished, but `done` and `cancelled` are
// terminal: reopening a closed visit is a clinic policy decision, not something
// the API should do implicitly. Re-sending the current status is a harmless
// no-op so retries and UI re-submits stay idempotent.
const ALLOWED_TRANSITIONS = {
  pending: ['pending', 'confirmed', 'done', 'cancelled'],
  confirmed: ['confirmed', 'done', 'cancelled'],
  done: ['done'],
  cancelled: ['cancelled'],
};

/** Map legacy `completed` to `done`. Returns null for unknown values. */
function normalizeAppointmentStatus(value) {
  if (value === undefined || value === null) return null;
  const status = String(value).trim().toLowerCase();
  if (!status) return null;
  if (status === 'completed') return 'done';
  return APPOINTMENT_STATUSES.includes(status) ? status : null;
}

function isAppointmentStatus(value) {
  return normalizeAppointmentStatus(value) !== null;
}

/**
 * Can `from` move to `to`? Both sides are normalised, so legacy `completed`
 * counts as `done`. Unknown values can never transition.
 */
function canTransition(from, to) {
  const current = normalizeAppointmentStatus(from);
  const next = normalizeAppointmentStatus(to);
  if (!current || !next) return false;
  return ALLOWED_TRANSITIONS[current].includes(next);
}

/**
 * Normalised statuses that may move to `to`, i.e. the source states the SQL
 * guard must accept. Returns null for an unknown target.
 */
function allowedFromStatuses(to) {
  const next = normalizeAppointmentStatus(to);
  if (!next) return null;
  return APPOINTMENT_STATUSES.filter((from) => ALLOWED_TRANSITIONS[from].includes(next));
}

/**
 * SQL expression that normalises the stored value in place, so a conditional
 * UPDATE can enforce the transition table atomically without a second write.
 * `column` is always an internal constant, never user input.
 */
function canonicalStatusSql(column) {
  return `(CASE WHEN LOWER(TRIM(${column})) = 'completed' THEN 'done' ELSE LOWER(TRIM(${column})) END)`;
}

module.exports = {
  APPOINTMENT_STATUSES,
  ALLOWED_TRANSITIONS,
  normalizeAppointmentStatus,
  isAppointmentStatus,
  canTransition,
  allowedFromStatuses,
  canonicalStatusSql,
};
