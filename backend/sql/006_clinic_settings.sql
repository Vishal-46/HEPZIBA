-- Clinic-wide settings (key/value). Idempotent.
CREATE TABLE IF NOT EXISTS clinic_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Seed default clinic hours if missing (09:00-18:00 Mon-Sat, 15-min slots).
INSERT INTO clinic_settings (key, value)
VALUES ('clinicHours', '{"openTime":"09:00","closeTime":"18:00","days":"Mon-Sat","slotMinutes":"15"}')
ON CONFLICT (key) DO NOTHING;
