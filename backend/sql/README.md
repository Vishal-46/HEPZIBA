# SQL Migrations (local-only; never run against prod without backup/review)

## Order
```bash
psql -U your_username -d your_database_name -f hepziba_schema.sql
psql -U your_username -d your_database_name -f backend/sql/001_hospital_alignment.sql
psql -U your_username -d your_database_name -f backend/sql/002_fix_doctors_and_constraints.sql
# Re-run to prove idempotency:
psql -U your_username -d your_database_name -f backend/sql/002_fix_doctors_and_constraints.sql
```
`002_fix_doctors_and_constraints.sql` is forward-only and idempotent (safe to re-run).
`002_seed_admin_example.sql` is a commented-out template only (no-op); consider renumbering it to `003_` to avoid the duplicate `002_` prefix.

## Known quirk
On a fresh DB, `001` errors at `prescriptions` with `relation "doctors" does not exist`
(it references `doctors(id)` before `doctors` exists). Earlier 001 ALTERs persist;
`002` then creates `doctors` and any missing 001 tables — just continue to `002`.

## What 002 does
- Creates `doctors(id, user_id UNIQUE FK users, specialty, phone, bio, created_at)` + repairs malformed variants.
- Repairs 001 tables (`prescriptions`, `prescription_items`, `invoices`, `invoice_items`, `inventory_items`) if 001 aborted early.
- Adds `UNIQUE(patients.user_id)` (skips with NOTICE on duplicates — never deletes data).
- Retargets `appointments.doctor_id` FK `users(id)` → `doctors(id)`: auto-creates missing doctor profiles, remaps legacy `users.id` values to `doctors.id` one-shot (guarded by old-FK detection so re-runs can't double-map), NULLs only unresolvable ids with NOTICE.
- Backfills `users.active=TRUE` where NULL (+ `SET DEFAULT TRUE`); backfills `scheduled_at ↔ date_time` both ways; drops leftover `NOT NULL` on `date_time`.
- Adds CHECKs only when missing and data passes: `users.role`, `appointments.status`, one-of-two-timestamps NOT NULL, `patients.spo2 0–100`, non-negative stock/quantity.
- Adds indexes for controller query patterns.

## Manual verification (psql)
```sql
SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1;
SELECT column_name FROM information_schema.columns WHERE table_name='doctors' ORDER BY 1;
SELECT c.conname, cf.relname AS reftable
FROM pg_constraint c JOIN pg_class cl ON cl.oid=c.conrelid
JOIN pg_class cf ON cf.oid=c.confrelid
WHERE cl.relname='appointments' AND c.contype='f';
SELECT COUNT(*) FROM users WHERE active IS NULL; -- expect 0
SELECT COUNT(*) FROM appointments WHERE scheduled_at IS NULL AND date_time IS NULL; -- expect 0 (else CHECK skipped with NOTICE)
```

## If 002 emits NOTICEs (data preserved, action needed)
- `skipping UNIQUE(patients.user_id): duplicate user_id values exist` → `SELECT user_id, COUNT(*) FROM patients GROUP BY user_id HAVING COUNT(*)>1`, merge manually, re-run 002.
- `skipping FK ... dangling values exist` → find orphans (e.g. appointments whose `doctor_id` matches no `doctors.id`), fix/NULL them, re-run 002.
- `nulled N unresolvable doctor_id(s)` → those appointments pointed at non-doctor/deleted users; review them.
- `skipping ... CHECK: invalid ... values exist` → clean offending rows, re-run 002.

## Automated evidence (this change)
Validated with embedded Postgres (PGlite): fresh chain base→001 (tolerated expected doctors error)→002→002 re-run converges; legacy `doctor_id=<users.id>` remapped to `doctors.id` including divergent-sequence case (`users.id=3 → doctors.id=1`); re-run does not double-map; `ON CONFLICT (user_id)` works; `users.active` backfilled; `scheduled_at` backfilled from `date_time`; bogus `appointments.status` rejected; duplicate `patients.user_id` tolerated without throw.
