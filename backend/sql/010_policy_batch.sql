-- 010_policy_batch: audited reopening of closed visits and durable
-- appointment reminders. Idempotent.
--
-- Apply after 001-009:
--   psql -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" \
--     -f backend/sql/010_policy_batch.sql
--
-- Both tables are additive. Re-running is safe.

-- ---------------------------------------------------------------------------
-- 1. Audited correction log for reopening a closed visit.
--    Only `POST /admin/appointments/:id/reopen` writes here, and the status
--    change + audit row are committed in one transaction. The FK is
--    ON DELETE SET NULL so an audit record survives appointment/user deletion
--    (an audit trail that disappears with its target is not an audit trail).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_status_corrections (
  id BIGSERIAL PRIMARY KEY,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  previous_status TEXT NOT NULL,
  corrected_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT appointment_status_corrections_previous_check
    CHECK (previous_status IN ('done', 'cancelled')),
  CONSTRAINT appointment_status_corrections_corrected_check
    CHECK (corrected_status IN ('pending', 'confirmed')),
  CONSTRAINT appointment_status_corrections_reason_check
    CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500)
);

CREATE INDEX IF NOT EXISTS appointment_status_corrections_appointment_idx
  ON appointment_status_corrections (appointment_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. Durable appointment reminders.
--    One row per appointment (UNIQUE) makes scheduling idempotent: a retried
--    booking insert cannot create a second reminder. The worker claims rows
--    atomically (`FOR UPDATE SKIP LOCKED` + `sent_at` set in the same UPDATE)
--    so concurrent workers cannot send the same reminder twice.
--
--    `scheduled_for` is an absolute TIMESTAMPTZ computed from the appointment
--    time minus the configured offset. The database session is UTC (enforced
--    by db.js), so daylight-saving shifts are handled by the absolute instant,
--    not by a wall-clock recomputation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointment_reminders (
  id BIGSERIAL PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT appointment_reminders_appointment_unique UNIQUE (appointment_id)
);

CREATE INDEX IF NOT EXISTS appointment_reminders_due_idx
  ON appointment_reminders (scheduled_for)
  WHERE sent_at IS NULL;

CREATE INDEX IF NOT EXISTS appointment_reminders_sent_idx
  ON appointment_reminders (sent_at);
