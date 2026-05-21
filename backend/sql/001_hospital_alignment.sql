-- Hospital doc alignment migration
-- Run this once against your Postgres database.

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

-- Backfill if legacy schema used date_time
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'appointments'
      AND column_name = 'date_time'
  ) THEN
    EXECUTE 'UPDATE appointments SET scheduled_at = COALESCE(scheduled_at, date_time)';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_appointments_doctor_scheduled_at
  ON appointments(doctor_id, scheduled_at);

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
