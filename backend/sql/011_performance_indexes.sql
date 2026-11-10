-- 011_performance_indexes: indexes for fast batched pagination on high-volume tables.
-- Idempotent. Safe to re-run.

CREATE INDEX IF NOT EXISTS idx_appointments_doctor_sched
  ON appointments (doctor_id, COALESCE(scheduled_at, date_time) DESC);

CREATE INDEX IF NOT EXISTS idx_appointments_patient_sched
  ON appointments (patient_id, COALESCE(scheduled_at, date_time) DESC);

CREATE INDEX IF NOT EXISTS idx_prescriptions_patient_date
  ON prescriptions (patient_id, prescribed_on DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_patient_date
  ON invoices (patient_id, invoice_date DESC);

