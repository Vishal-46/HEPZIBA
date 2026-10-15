-- Itemized billing (doctor fee separate from medicines) + push tokens. Idempotent.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS doctor_fee NUMERIC(10,2) NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_status_check') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN ('unpaid', 'paid'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS patient_push_tokens (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
