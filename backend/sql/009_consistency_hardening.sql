-- 009_consistency_hardening: appointment status consistency, multi-device
-- push tokens, and password-reset session invalidation. Idempotent.
--
-- Apply after 001-008:
--   psql -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" \
--     -f backend/sql/009_consistency_hardening.sql
--
-- Failure behavior: section 1 is a single atomic DO block. It validates the
-- data BEFORE dropping anything, so an unsupported status aborts the block
-- with the table and its constraint unchanged. psql continues after an error
-- by default, so `-v ON_ERROR_STOP=1 --single-transaction` is recommended to
-- leave the whole file unapplied on failure. Re-running is safe.

-- ---------------------------------------------------------------------------
-- 1. Canonical appointment status: `done` (legacy `completed` is migrated).
-- ---------------------------------------------------------------------------
-- One DO block = one transaction. The preflight runs first, then the old CHECK
-- is dropped, legacy rows are migrated, and the canonical CHECK is rebuilt.
-- If anything fails, all three steps roll back together: the old constraint is
-- never left dropped and no rows are half-migrated.
DO $$
DECLARE
  bad_detail text;
  bad_total bigint;
BEGIN
  -- `completed` is a supported *input* value (migrated below); anything else
  -- outside the canonical set needs a human decision and aborts the migration.
  SELECT string_agg(format('%s (%s rows)', status, n), ', ' ORDER BY status),
         COALESCE(SUM(n), 0)
    INTO bad_detail, bad_total
    FROM (
      SELECT status, COUNT(*) AS n
        FROM appointments
       WHERE status IS NOT NULL
         AND status NOT IN ('pending', 'confirmed', 'done', 'cancelled', 'completed')
       GROUP BY status
    ) bad;

  IF bad_total > 0 THEN
    RAISE EXCEPTION
      '009 aborted before schema changes: % appointment(s) have unsupported status values: %. Map them to pending/confirmed/done/cancelled, then re-run. Existing rows and constraints were left unchanged. If an existing CHECK blocks the mapping, drop that CHECK first; this migration rebuilds it.',
      bad_total, bad_detail;
  END IF;

  -- Subtransaction: if any step fails (including a differently-named CHECK
  -- that still forbids the canonical values), the drop/update/add all roll
  -- back and the caller gets an actionable message instead of a raw 23514.
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'appointments'::regclass
        AND conname = 'appointments_status_check'
    ) THEN
      ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;
    END IF;

    UPDATE appointments SET status = 'done' WHERE status = 'completed';

    ALTER TABLE appointments
      ADD CONSTRAINT appointments_status_check
      CHECK (status IS NULL OR status IN ('pending', 'confirmed', 'done', 'cancelled'));
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION
      '009 aborted: an existing CHECK constraint blocked the status migration (%). No changes were applied. Drop the conflicting CHECK and re-run 009.',
      SQLERRM;
  END;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Password reset must invalidate access tokens issued before the change.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 3. patient_push_tokens: support multiple devices per patient.
--    Legacy schema had user_id as PRIMARY KEY, which rejected a second device
--    and made `ON CONFLICT (user_id, token)` fail.
-- ---------------------------------------------------------------------------
ALTER TABLE patient_push_tokens ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE patient_push_tokens ADD COLUMN IF NOT EXISTS platform TEXT;
ALTER TABLE patient_push_tokens ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE patient_push_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE patient_push_tokens ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

DO $$
DECLARE
  pk_name text;
  pk_def text;
BEGIN
  SELECT conname, pg_get_constraintdef(oid)
    INTO pk_name, pk_def
    FROM pg_constraint
   WHERE conrelid = 'patient_push_tokens'::regclass AND contype = 'p';
  IF pk_def LIKE '%(user_id)%' THEN
    EXECUTE format('ALTER TABLE patient_push_tokens DROP CONSTRAINT %I', pk_name);
  END IF;
END $$;

-- Create the (user_id, token) unique index only when no equivalent unique
-- index already exists. A table provisioned by db.js already has
-- UNIQUE(user_id, token); adding a second identical index wastes space and
-- makes re-runs non-idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_attribute a
      ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'patient_push_tokens'::regclass
      AND i.indisunique
      AND i.indisvalid
      AND i.indpred IS NULL
      AND i.indnkeyatts = 2
    GROUP BY i.indexrelid
    HAVING COUNT(*) = 2
       AND BOOL_AND(a.attname IN ('user_id', 'token'))
  ) THEN
    CREATE UNIQUE INDEX patient_push_tokens_user_token_key
      ON patient_push_tokens (user_id, token);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'patient_push_tokens'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE patient_push_tokens ADD PRIMARY KEY (id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Billing / inventory columns required by current controllers.
--    (Already in 006-008, repeated here so a partially-migrated DB recovers.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinic_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO clinic_settings (key, value)
VALUES ('clinicHours', '{"openTime":"09:00","closeTime":"18:00","days":"Mon-Sat","slotMinutes":"15"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS mrp NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS doctor_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
