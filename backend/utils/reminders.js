// Durable appointment reminders.
//
// Design constraints (policy F):
//   * Reminders are rows in `appointment_reminders`, not timers inside an API
//     request and not a process-local job list. A restart or crash loses no
//     unsent reminder because the schedule lives in the database.
//   * `UNIQUE(appointment_id)` makes scheduling idempotent: a retried booking
//     insert cannot create a second reminder for the same visit.
//   * The worker claims a due row with `FOR UPDATE SKIP LOCKED` and sets
//     `sent_at` in the same statement, so two workers can never both send the
//     same reminder. Delivery is at-most-once: a crash after the claim but
//     before the provider call may drop one reminder, but can never duplicate
//     it. This trade-off is documented in docs/API_REFERENCE.md.
//   * The claim re-checks the appointment status and timing at send time, so a
//     cancelled/done visit or one that already started is never reminded.
//
// Configuration:
//   APPOINTMENT_REMINDER_OFFSET_MINUTES — minutes before the appointment to
//   send the reminder. Unset/empty/0 disables both scheduling and the worker.
//   `scheduled_for` is an absolute TIMESTAMPTZ (appointment time minus the
//   offset); the DB session is UTC, so DST does not shift the instant.
//
// The worker is started by `backend/index.js` only. The Vercel serverless
// entrypoint (`api/index.js`) does not start it; serverless deployments must
// run the worker as a separate scheduled process (see docs/API_REFERENCE.md).

const { canonicalStatusSql } = require('./appointmentStatus');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const MAX_OFFSET_MINUTES = 60 * 24 * 30; // 30 days

/**
 * Parsed reminder offset in minutes, or null when reminders are disabled or
 * the configured value is invalid. Never throws: bad config disables the
 * feature instead of crashing the API.
 */
function reminderOffsetMinutes(env = process.env) {
  const raw = env.APPOINTMENT_REMINDER_OFFSET_MINUTES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  // `0` is the documented "off" value; treat it as disabled, not as a typo.
  if (String(raw).trim() === '0') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_OFFSET_MINUTES) {
    console.error(
      `reminders: APPOINTMENT_REMINDER_OFFSET_MINUTES must be an integer 1-${MAX_OFFSET_MINUTES}; reminders disabled`
    );
    return null;
  }
  return n;
}

function remindersEnabled(env = process.env) {
  return reminderOffsetMinutes(env) !== null;
}

/**
 * Insert the reminder row for a freshly booked appointment. Must run inside
 * the booking transaction (before COMMIT) so the reminder and the appointment
 * are committed together. Returns the reminder row, or null when disabled or
 * the appointment is not remindable.
 */
async function scheduleReminder(client, appointment, env = process.env) {
  const offset = reminderOffsetMinutes(env);
  if (offset === null) return null;
  const appointmentId = Number(appointment && appointment.id);
  if (!Number.isInteger(appointmentId) || appointmentId < 1) return null;

  const when = appointment.scheduled_at || appointment.date_time;
  if (!when) return null;
  const scheduledAt = new Date(when);
  if (Number.isNaN(scheduledAt.getTime())) return null;

  // Reminder time = appointment time - offset. Skip reminders that would
  // already be in the past (e.g. booking inside the reminder window).
  const scheduledFor = new Date(scheduledAt.getTime() - offset * 60 * 1000);
  if (scheduledFor.getTime() <= Date.now()) return null;

  const r = await client.query(
    `INSERT INTO appointment_reminders (appointment_id, scheduled_for)
     VALUES ($1, $2)
     ON CONFLICT (appointment_id) DO NOTHING
     RETURNING id, appointment_id, scheduled_for`,
    [appointmentId, scheduledFor.toISOString()]
  );
  return r.rows[0] || null;
}

/**
 * Atomically claim one due reminder. The status/timing re-check happens in the
 * same statement as the claim, so a concurrent cancellation cannot be
 * overtaken by a stale reminder.
 */
async function claimDueReminder(client) {
  // Lazy require keeps unit tests from opening a database connection just to
  // import the module.
  const q = client || require('../db');
  const r = await q.query(
    `WITH due AS (
       SELECT r.id
         FROM appointment_reminders r
         JOIN appointments a ON a.id = r.appointment_id
        WHERE r.sent_at IS NULL
          AND r.scheduled_for <= NOW()
          AND COALESCE(a.scheduled_at, a.date_time) > NOW()
          AND ${canonicalStatusSql('a.status')} IN ('pending', 'confirmed')
        ORDER BY r.scheduled_for
        FOR UPDATE OF r SKIP LOCKED
        LIMIT 1
     )
     UPDATE appointment_reminders r
        SET sent_at = NOW(),
            attempts = r.attempts + 1
       FROM due
      WHERE r.id = due.id
      RETURNING r.id, r.appointment_id, r.scheduled_for`
  );
  return r.rows[0] || null;
}

/**
 * Claim and deliver every due reminder, up to `max` per run. Delivery is
 * best-effort; a provider error is recorded on the row but does not throw.
 * Returns a summary suitable for tests and logs.
 */
async function processDueReminders({ max = 50, notifier } = {}) {
  const send = notifier || (async (appointmentId) => {
    const { notifyAppointmentOwner } = require('./push');
    return notifyAppointmentOwner(
      appointmentId,
      'Appointment reminder',
      'You have an upcoming appointment. Open the app to view the details.',
      { appointmentId }
    );
  });

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < max; i += 1) {
    let claimed;
    try {
      claimed = await claimDueReminder();
    } catch (e) {
      console.error('reminders: claim failed:', e.message);
      break;
    }
    if (!claimed) break;

    try {
      const result = await send(claimed.appointment_id);
      if (result && result.ok === false) {
        failed += 1;
        await require('../db').query(
          'UPDATE appointment_reminders SET last_error = $2 WHERE id = $1',
          [claimed.id, String(result.reason || result.error || 'not delivered').slice(0, 500)]
        );
      } else {
        sent += 1;
      }
    } catch (e) {
      failed += 1;
      console.error('reminders: delivery failed:', e.message);
      try {
        await require('../db').query(
          'UPDATE appointment_reminders SET last_error = $2 WHERE id = $1',
          [claimed.id, String(e.message || e).slice(0, 500)]
        );
      } catch (_) { /* best effort */ }
    }
  }
  return { sent, failed };
}

let timer = null;
let running = false;

/**
 * Start the polling worker. No-op when the offset is not configured, so the
 * feature stays disabled until an operator opts in. The interval is unref'd
 * so it never keeps a short-lived process alive.
 */
function startReminderWorker({ intervalMs = DEFAULT_INTERVAL_MS, env = process.env } = {}) {
  if (!remindersEnabled(env)) {
    console.log('reminders: disabled (APPOINTMENT_REMINDER_OFFSET_MINUTES not set)');
    return null;
  }
  if (timer) return timer;
  const tick = async () => {
    if (running) return; // never overlap runs in one process
    running = true;
    try {
      const summary = await processDueReminders();
      if (summary.sent || summary.failed) {
        console.log(`reminders: sent=${summary.sent} failed=${summary.failed}`);
      }
    } catch (e) {
      console.error('reminders: worker tick failed:', e.message);
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`reminders: worker started (every ${intervalMs}ms, offset ${reminderOffsetMinutes(env)} min)`);
  return timer;
}

function stopReminderWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MAX_OFFSET_MINUTES,
  reminderOffsetMinutes,
  remindersEnabled,
  scheduleReminder,
  claimDueReminder,
  processDueReminders,
  startReminderWorker,
  stopReminderWorker,
};
