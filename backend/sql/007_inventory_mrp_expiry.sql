-- Real-time pharmacy attributes. Idempotent.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS mrp NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE;
