-- 002_fix_doctors_and_constraints.sql
-- Forward-only, idempotent integrity fixes (M0).
--
-- Purpose:
--   1. Create the missing `doctors` table expected by controllers
--      (doctorController, appointmentController, prescriptionController, adminController)
--      and by 001_hospital_alignment.sql (prescriptions.doctor_id -> doctors.id).
--   2. Enforce UNIQUE(patients.user_id) required by ON CONFLICT (user_id) in authController.
--   3. Retarget appointments.doctor_id FK from users(id) to doctors(id) safely,
--      with backfill of legacy user-id values to doctor-profile ids.
--   4. Backfill users.active, add safe CHECKs/indexes, handle scheduled_at/date_time compat.
--   5. Repair 001 tables if 001 aborted early on a fresh DB (001 references
--      doctors(id) before doctors exists, so its later CREATE TABLEs may be missing).
--
-- Safety:
--   - All statements are idempotent (IF NOT EXISTS / pg_constraint guards / DO blocks).
--   - Safe to run multiple times, and safe to run after base + 001 on fresh or existing DBs.
--   - Preserves data: deduplication is never destructive (constraints are skipped
--     with NOTICE when existing data violates them; see manual cleanup notes).
--   - No secrets. Local-only; do NOT run against prod without review/backup.
--
-- Apply order (fresh DB):
--   psql -U <user> -d <db> -f hepziba_schema.sql
--   psql -U <user> -d <db> -f backend/sql/001_hospital_alignment.sql
--   psql -U <user> -d <db> -f backend/sql/002_fix_doctors_and_constraints.sql

-- ============================================================================
-- 0. Ensure 001 columns exist (repairs partial 001 runs; all idempotent)
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_code_expires_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_expires_at TIMESTAMP;

ALTER TABLE patients ADD COLUMN IF NOT EXISTS patient_code TEXT UNIQUE;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS sex TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS mobile TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS aadhar_number TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS height_cm NUMERIC(5,2);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(5,2);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS bp TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS spo2 INTEGER;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS token_number INTEGER;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP;
-- date_time exists in base schema; re-add only if some future revision dropped it.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS date_time TIMESTAMP;

-- ============================================================================
-- 1. doctors table (required by controllers + 001 prescriptions FK)
--    Controllers expect: id, user_id UNIQUE FK users, specialty, phone, bio, created_at.
-- ============================================================================

CREATE TABLE IF NOT EXISTS doctors (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  specialty TEXT,
  phone TEXT,
  bio TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Harden a pre-existing malformed doctors table (idempotent column repair).
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS specialty TEXT;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();

-- Ensure UNIQUE(user_id) when the table pre-existed without it and data allows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'doctors'::regclass AND contype = 'u'
      AND array_to_string(conkey, ',') = (
        SELECT attnum::text FROM pg_attribute
        WHERE attrelid = 'doctors'::regclass AND attname = 'user_id'
      )
  ) AND NOT EXISTS (
    -- pg_constraint lookup above is name-agnostic but brittle; fall back to index check
    SELECT 1 FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'doctors'::regclass AND i.indisunique
      AND a.attname = 'user_id' AND array_length(i.indkey, 1) = 1
  ) THEN
    IF EXISTS (SELECT user_id, COUNT(*) FROM doctors WHERE user_id IS NOT NULL GROUP BY user_id HAVING COUNT(*) > 1) THEN
      RAISE NOTICE '002: skipping UNIQUE(doctors.user_id): duplicate user_id values exist; dedupe manually.';
    ELSE
      ALTER TABLE doctors ADD CONSTRAINT doctors_user_id_unique UNIQUE (user_id);
    END IF;
  END IF;
END $$;

-- Ensure FK doctors.user_id -> users(id) when missing and data allows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'doctors'::regclass AND contype = 'f'
      AND confrelid = 'users'::regclass
  ) THEN
    IF EXISTS (
      SELECT 1 FROM doctors d LEFT JOIN users u ON u.id = d.user_id
      WHERE d.user_id IS NOT NULL AND u.id IS NULL
    ) THEN
      RAISE NOTICE '002: skipping FK doctors.user_id -> users(id): dangling user_id values exist.';
    ELSE
      ALTER TABLE doctors ADD CONSTRAINT doctors_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

-- Backfill NOT NULL on doctors.user_id only when safe (NULLs would violate).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'doctors' AND column_name = 'user_id' AND is_nullable = 'YES'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM doctors WHERE user_id IS NULL) THEN
      ALTER TABLE doctors ALTER COLUMN user_id SET NOT NULL;
    ELSE
      RAISE NOTICE '002: skipping NOT NULL on doctors.user_id: NULL values exist.';
    END IF;
  END IF;
END $$;

-- ============================================================================
-- 2. Repair 001 tables if 001 aborted early (doctors missing => 001 failed at
--    prescriptions). IF NOT EXISTS makes this a no-op when 001 fully applied.
--    Definitions mirror 001 exactly so fresh and repaired DBs converge.
-- ============================================================================

CREATE TABLE IF NOT EXISTS prescriptions (
  id SERIAL PRIMARY KEY,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
  doctor_id INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  doctor_name TEXT,
  prescribed_on TIMESTAMP DEFAULT NOW(),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS prescription_items (
  id SERIAL PRIMARY KEY,
  prescription_id INTEGER REFERENCES prescriptions(id) ON DELETE CASCADE,
  medicine_name TEXT NOT NULL,
  dosage_morning BOOLEAN DEFAULT FALSE,
  dosage_afternoon BOOLEAN DEFAULT FALSE,
  dosage_evening BOOLEAN DEFAULT FALSE,
  dosage_night BOOLEAN DEFAULT FALSE,
  before_food BOOLEAN DEFAULT FALSE,
  after_food BOOLEAN DEFAULT FALSE,
  quantity INTEGER,
  instructions TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  doctor_name TEXT,
  invoice_date TIMESTAMP DEFAULT NOW(),
  total_amount NUMERIC(12,2) DEFAULT 0,
  status TEXT DEFAULT 'unpaid'
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id SERIAL PRIMARY KEY,
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
  medicine_name TEXT NOT NULL,
  expiry_date DATE,
  unit TEXT,
  mrp NUMERIC(10,2) DEFAULT 0,
  quantity INTEGER DEFAULT 1,
  total NUMERIC(10,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  stock INTEGER DEFAULT 0,
  reorder_level INTEGER DEFAULT 0,
  unit TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- 3. UNIQUE(patients.user_id) — required by ON CONFLICT (user_id) in authController
--    (registerPatient, googleLogin). Never deletes data: skips with NOTICE on dupes.
-- ============================================================================

DO $$
BEGIN
  -- A single-column unique constraint OR unique index both satisfy ON CONFLICT (user_id).
  IF EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = 'patients'::regclass AND i.indisunique
      AND a.attname = 'user_id' AND array_length(i.indkey, 1) = 1
  ) THEN
    -- Already satisfied; nothing to do.
    RETURN;
  END IF;

  IF EXISTS (
    SELECT user_id, COUNT(*) FROM patients
    WHERE user_id IS NOT NULL GROUP BY user_id HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE '002: skipping UNIQUE(patients.user_id): duplicate user_id values exist. Dedupe manually, then re-run this migration.';
    RETURN;
  END IF;

  ALTER TABLE patients ADD CONSTRAINT patients_user_id_unique UNIQUE (user_id);
END $$;

-- Ensure patients.user_id FK exists (base schema has it, but repair if dropped).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'patients'::regclass AND contype = 'f'
      AND confrelid = 'users'::regclass
  ) THEN
    IF EXISTS (
      SELECT 1 FROM patients p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.user_id IS NOT NULL AND u.id IS NULL
    ) THEN
      RAISE NOTICE '002: skipping FK patients.user_id -> users(id): dangling user_id values exist.';
    ELSE
      ALTER TABLE patients ADD CONSTRAINT patients_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    END IF;
  END IF;
END $$;

-- ============================================================================
-- 4. Backfill users.active (+ keep 001 scheduled_at backfill idempotent)
-- ============================================================================

-- 001 added active DEFAULT TRUE, but be explicit: default + backfill NULLs.
ALTER TABLE users ALTER COLUMN active SET DEFAULT TRUE;
UPDATE users SET active = TRUE WHERE active IS NULL;

-- Re-run 001 date_time -> scheduled_at backfill for rows created between 001 and 002.
UPDATE appointments SET scheduled_at = COALESCE(scheduled_at, date_time)
WHERE scheduled_at IS NULL AND date_time IS NOT NULL;

-- Reverse backfill keeps legacy readers working (controllers dual-write on insert,
-- but old rows written only via scheduled_at need date_time populated).
UPDATE appointments SET date_time = COALESCE(date_time, scheduled_at)
WHERE date_time IS NULL AND scheduled_at IS NOT NULL;

-- 001 drops NOT NULL from date_time when present; keep it idempotent here too.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'appointments'
      AND column_name = 'date_time'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE appointments ALTER COLUMN date_time DROP NOT NULL;
  END IF;
END $$;

-- ============================================================================
-- 5. Retarget appointments.doctor_id FK: users(id) -> doctors(id)
--    Legacy rows hold users.id; new code expects doctors.id.
--    One-shot remap guarded by "old FK still points at users", so re-runs are safe.
-- ============================================================================

DO $$
DECLARE
  r RECORD;
  v_old_fk_found BOOLEAN := FALSE;
  v_remapped INTEGER := 0;
  v_nulled INTEGER := 0;
BEGIN
  -- 5a. Every doctor user needs a profile row so legacy ids can be mapped.
  INSERT INTO doctors (user_id, specialty, phone, bio)
  SELECT u.id, NULL, NULL, NULL
  FROM users u
  LEFT JOIN doctors d ON d.user_id = u.id
  WHERE u.role = 'doctor' AND d.user_id IS NULL;

  -- 5b. Drop any FK on appointments(doctor_id) that still points at users,
  --     whatever its constraint name is (base default: appointments_doctor_id_fkey).
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'appointments'::regclass
      AND c.contype = 'f'
      AND a.attname = 'doctor_id'
      AND c.confrelid = 'users'::regclass
  LOOP
    EXECUTE format('ALTER TABLE appointments DROP CONSTRAINT %I', r.conname);
    v_old_fk_found := TRUE;
    RAISE NOTICE '002: dropped legacy FK % on appointments.doctor_id -> users(id)', r.conname;
  END LOOP;

  IF v_old_fk_found THEN
    -- 5c. Remap legacy users.id values to doctors.id values.
    --     Runs only when the old FK existed, so a second run cannot double-map.
    UPDATE appointments a SET doctor_id = d.id
    FROM doctors d
    WHERE d.user_id = a.doctor_id
      AND a.doctor_id IS NOT NULL;
    GET DIAGNOSTICS v_remapped = ROW_COUNT;

    -- 5d. NULL out values with no matching doctor profile so the new FK can be created.
    --     These are data errors (non-doctor user ids / deleted users); count them loudly.
    UPDATE appointments SET doctor_id = NULL
    WHERE doctor_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM doctors d WHERE d.id = appointments.doctor_id);
    GET DIAGNOSTICS v_nulled = ROW_COUNT;

    RAISE NOTICE '002: remapped % appointment(s) users.id -> doctors.id, nulled % unresolvable doctor_id(s)', v_remapped, v_nulled;
  END IF;

  -- 5e. Ensure the new FK exists (covers: just-migrated DBs, partial prior runs,
  --     and DBs where the old FK was already dropped manually).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'appointments'::regclass
      AND c.contype = 'f'
      AND a.attname = 'doctor_id'
      AND c.confrelid = 'doctors'::regclass
  ) THEN
    IF EXISTS (
      SELECT 1 FROM appointments a
      LEFT JOIN doctors d ON d.id = a.doctor_id
      WHERE a.doctor_id IS NOT NULL AND d.id IS NULL
    ) THEN
      RAISE NOTICE '002: skipping FK appointments.doctor_id -> doctors(id): dangling values remain. Re-run after cleanup.';
    ELSE
      ALTER TABLE appointments ADD CONSTRAINT appointments_doctor_id_doctors_fkey
        FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE SET NULL;
      RAISE NOTICE '002: added FK appointments.doctor_id -> doctors(id)';
    END IF;
  END IF;
END $$;

-- ============================================================================
-- 6. Safe CHECKs (added only when missing AND existing data passes)
-- ============================================================================

-- users.role IN ('patient','doctor','admin') — base schema has it under an
-- auto-generated name; add explicitly only if no equivalent CHECK exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%role%'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM users WHERE role NOT IN ('patient', 'doctor', 'admin')) THEN
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('patient', 'doctor', 'admin'));
    ELSE
      RAISE NOTICE '002: skipping users.role CHECK: invalid role values exist.';
    END IF;
  END IF;
END $$;

-- appointments.status IN ('pending','confirmed','done','cancelled')
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_status_check'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM appointments
      WHERE status IS NOT NULL AND status NOT IN ('pending', 'confirmed', 'done', 'cancelled')
    ) THEN
      ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
        CHECK (status IS NULL OR status IN ('pending', 'confirmed', 'done', 'cancelled'));
    ELSE
      RAISE NOTICE '002: skipping appointments.status CHECK: invalid status values exist.';
    END IF;
  END IF;
END $$;

-- At least one appointment timestamp must be present (compat for dual-column reads).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_scheduled_at_check'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM appointments WHERE scheduled_at IS NULL AND date_time IS NULL
    ) THEN
      ALTER TABLE appointments ADD CONSTRAINT appointments_scheduled_at_check
        CHECK (scheduled_at IS NOT NULL OR date_time IS NOT NULL);
    ELSE
      RAISE NOTICE '002: skipping appointments timestamp CHECK: rows with both scheduled_at and date_time NULL exist.';
    END IF;
  END IF;
END $$;

-- patients.spo2 range 0-100 (mirrors patientController validation).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'patients_spo2_check'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM patients WHERE spo2 IS NOT NULL AND (spo2 < 0 OR spo2 > 100)) THEN
      ALTER TABLE patients ADD CONSTRAINT patients_spo2_check CHECK (spo2 IS NULL OR (spo2 >= 0 AND spo2 <= 100));
    ELSE
      RAISE NOTICE '002: skipping patients.spo2 CHECK: out-of-range values exist.';
    END IF;
  END IF;
END $$;

-- Non-negative stock/quantities (mirrors controller defaults of 0/1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_items_stock_check') THEN
    IF NOT EXISTS (SELECT 1 FROM inventory_items WHERE stock IS NOT NULL AND stock < 0) THEN
      ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_stock_check CHECK (stock IS NULL OR stock >= 0);
    ELSE
      RAISE NOTICE '002: skipping inventory stock CHECK: negative stock exists.';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_items_quantity_check') THEN
    IF NOT EXISTS (SELECT 1 FROM invoice_items WHERE quantity IS NOT NULL AND quantity < 0) THEN
      ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_quantity_check CHECK (quantity IS NULL OR quantity >= 0);
    ELSE
      RAISE NOTICE '002: skipping invoice_items quantity CHECK: negative quantity exists.';
    END IF;
  END IF;
END $$;

-- ============================================================================
-- 7. Indexes (all IF NOT EXISTS — safe, scalable lookups for controller queries)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_appointments_doctor_scheduled_at ON appointments(doctor_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_patient_id ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor_id ON appointments(doctor_id);
CREATE INDEX IF NOT EXISTS idx_patients_user_id ON patients(user_id);
CREATE INDEX IF NOT EXISTS idx_doctors_user_id ON doctors(user_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_id ON prescriptions(patient_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_doctor_id ON prescriptions(doctor_id);
CREATE INDEX IF NOT EXISTS idx_prescriptions_appointment_id ON prescriptions(appointment_id);
CREATE INDEX IF NOT EXISTS idx_prescription_items_prescription_id ON prescription_items(prescription_id);
CREATE INDEX IF NOT EXISTS idx_invoices_patient_id ON invoices(patient_id);
CREATE INDEX IF NOT EXISTS idx_invoices_appointment_id ON invoices(appointment_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active);
