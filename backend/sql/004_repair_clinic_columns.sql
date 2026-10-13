-- 004_repair_clinic_columns.sql
-- Forward-only, idempotent column repair (M0 follow-up).
--
-- Problem: live DBs whose clinic tables were created by an older/different DDL
-- (or a partial 001 run) can miss columns the controllers use, e.g.
--   error: column p.prescribed_on does not exist (42703)
-- from backend/prescriptions/prescriptionController.js getMyPrescriptions.
-- CREATE TABLE IF NOT EXISTS never backfills columns on existing tables,
-- so this migration adds every column from the 001 definitions idempotently.
--
-- Safety: ADD COLUMN IF NOT EXISTS only; never drops/renames; re-runnable.
-- Apply order: base -> 001 -> 002 -> 004 (004 is a no-op on healthy DBs).

-- prescriptions (mirrors 001:55-63)
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS appointment_id INTEGER REFERENCES appointments(id) ON DELETE CASCADE;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES doctors(id) ON DELETE SET NULL;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS doctor_name TEXT;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS prescribed_on TIMESTAMP DEFAULT NOW();
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS notes TEXT;

-- prescription_items (mirrors 001:65-77)
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS prescription_id INTEGER REFERENCES prescriptions(id) ON DELETE CASCADE;
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS medicine_name TEXT;
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS dosage_morning BOOLEAN DEFAULT FALSE;
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS dosage_afternoon BOOLEAN DEFAULT FALSE;
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS dosage_evening BOOLEAN DEFAULT FALSE;
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS dosage_night BOOLEAN DEFAULT FALSE;
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS before_food BOOLEAN DEFAULT FALSE;
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS after_food BOOLEAN DEFAULT FALSE;
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS quantity INTEGER;
ALTER TABLE prescription_items ADD COLUMN IF NOT EXISTS instructions TEXT;

-- invoices (mirrors 001:79-87)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS doctor_name TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_date TIMESTAMP DEFAULT NOW();
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS total_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'unpaid';

-- invoice_items (mirrors 001:89-98)
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS medicine_name TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS mrp NUMERIC(10,2) DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS quantity INTEGER DEFAULT 1;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS total NUMERIC(10,2) DEFAULT 0;

-- inventory_items (mirrors 001:100-108)
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS stock INTEGER DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS reorder_level INTEGER DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS unit TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

-- Backfill the new timestamp default for pre-existing rows (NULL-safe).
UPDATE prescriptions SET prescribed_on = NOW() WHERE prescribed_on IS NULL;
UPDATE invoices SET invoice_date = NOW() WHERE invoice_date IS NULL;
UPDATE inventory_items SET updated_at = NOW() WHERE updated_at IS NULL;
