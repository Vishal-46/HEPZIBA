# SQL Migrations (local-only; never run against prod without backup/review)

## Order
```bash
psql -v ON_ERROR_STOP=1 -U your_username -d your_database_name -f hepziba_schema.sql
# 001 is expected to fail on a fresh DB (two known errors); see below.
psql -U your_username -d your_database_name -f backend/sql/001_hospital_alignment.sql
psql -v ON_ERROR_STOP=1 --single-transaction -U your_username -d your_database_name -f backend/sql/002_fix_doctors_and_constraints.sql
# Re-run to prove idempotency:
psql -v ON_ERROR_STOP=1 --single-transaction -U your_username -d your_database_name -f backend/sql/002_fix_doctors_and_constraints.sql
# Column repair for databases created by older/partial DDL — no-op on a fresh DB, idempotent:
psql -v ON_ERROR_STOP=1 --single-transaction -U your_username -d your_database_name -f backend/sql/004_repair_clinic_columns.sql
# Session tokens (refresh rotation + logout denylist) — idempotent:
psql -v ON_ERROR_STOP=1 --single-transaction -U your_username -d your_database_name -f backend/sql/005_session_tokens.sql
# Clinic settings key/value (admin Hours tab) — idempotent:
psql -v ON_ERROR_STOP=1 --single-transaction -U your_username -d your_database_name -f backend/sql/006_clinic_settings.sql
# Inventory MRP + expiry columns — idempotent:
psql -v ON_ERROR_STOP=1 --single-transaction -U your_username -d your_database_name -f backend/sql/007_inventory_mrp_expiry.sql
# Invoice doctor fee + paid check + push tokens — idempotent:
psql -v ON_ERROR_STOP=1 --single-transaction -U your_username -d your_database_name -f backend/sql/008_billing_fee_push.sql
# Status consistency, multi-device push tokens, reset session invalidation — idempotent.
# Use both flags so an unsupported status aborts the whole file:
psql -v ON_ERROR_STOP=1 --single-transaction -U your_username -d your_database_name -f backend/sql/009_consistency_hardening.sql
# Audited visit corrections + durable appointment reminders — idempotent:
psql -v ON_ERROR_STOP=1 --single-transaction -U your_username -d your_database_name -f backend/sql/010_policy_batch.sql
```
`002_fix_doctors_and_constraints.sql` is forward-only and idempotent (safe to re-run).
`003_seed_admin_example.sql` is a commented-out template only (no-op) and is
intentionally skipped by the normal chain. It must not be run with placeholder
values; insert the first real admin out of band with a bcrypt hash.

## Known quirk (not a designed failure)
On a fresh DB, `001` fails at `prescriptions` with `relation "doctors" does not exist`
because it references `doctors(id)` before `002` creates that table. psql then
also fails `prescription_items` (`relation "prescriptions" does not exist`).
These two errors are expected on a fresh database and `002` repairs both; any
other error must stop the run. Do not run `001` with `ON_ERROR_STOP=0` in an
unattended pipeline without asserting that exactly these two messages occurred
and nothing else. The guarded procedure is in
[`../test/REAL_POSTGRES.md`](../test/REAL_POSTGRES.md).

## Runtime startup checks
`backend/db.js` opens every connection with `options: '-c timezone=UTC'`, then
verifies `SHOW TimeZone` before serving traffic. A non-UTC session is fatal by
default (`DB_REQUIRE_UTC=0` downgrades it to a warning). Providers whose pooler
rejects startup `options` must set `DB_DISABLE_UTC_OPTIONS=1` and configure
`ALTER ROLE ... SET timezone='UTC'` / `ALTER DATABASE ... SET timezone='UTC'`;
the startup check still enforces the result.

After the compatibility DDL, startup verifies the objects required by
migrations `005`–`010` (`backend/utils/schemaCheck.js`). In production, or with
`SCHEMA_STRICT=1`, the API refuses to start if any are missing. This is a
guardrail, not a replacement for applying the migrations in order.

Token numbering (per doctor per **UTC** day) is documented in
[`TOKEN_NUMBERING.md`](TOKEN_NUMBERING.md).

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

## Before applying 009 (appointment statuses)

009 validates appointment statuses inside a single atomic `DO` block **before**
touching the schema. If any unsupported value exists it aborts with an error
naming the values and counts; the table, its rows, and any existing CHECK are
left exactly as they were. `completed` is a supported input value and is
migrated to `done` during the same block.

Run the preflight query first (it excludes `completed`, which 009 migrates):

```sql
SELECT status, COUNT(*) FROM appointments
WHERE status IS NOT NULL
  AND status NOT IN ('pending','confirmed','done','cancelled','completed')
GROUP BY status ORDER BY status;
```

If it returns rows, map them to a canonical value, then re-run 009. If an
existing CHECK blocks the `UPDATE`, drop that CHECK first — 009 rebuilds the
canonical one. Re-running after a successful run is a no-op apart from
re-validating the constraint.

Apply with both flags so an abort leaves nothing half-applied:

```bash
psql -v ON_ERROR_STOP=1 --single-transaction "$DATABASE_URL" \
  -f backend/sql/009_consistency_hardening.sql
```

Without `--single-transaction`, psql continues after the status block aborts
and the idempotent later sections (password column, push tokens, billing
columns) still apply; the status table itself remains unchanged.


## Time and date conventions

- `TIMESTAMP` (without time zone) columns store **UTC wall clock**. Appointment
  times are written from ISO 8601 UTC strings; every other such column is
  written by `NOW()` while the database session runs in UTC. The API parses
  OID 1114 as UTC so responses do not depend on the Node host timezone.
- `TIMESTAMPTZ` columns carry absolute instants and keep the driver default
  (`refresh_tokens.expires_at`, `password_changed_at`, push-token timestamps).
- `DATE` columns (`patients.dob`, `inventory_items.expiry_date`,
  `invoice_items.expiry_date`) are returned as `YYYY-MM-DD` text, never as a
  local-midnight `Date`, so they cannot drift a day across timezones.
- This relies on the database session timezone being **UTC**. `backend/db.js`
  sets it per connection and verifies it at startup; if a provider rejects the
  startup option, configure the role/database default and set
  `DB_DISABLE_UTC_OPTIONS=1`; the startup check still enforces the result.
  Enabling UTC enforcement does **not** rewrite existing rows: if a database
  previously ran with a non-UTC default, audit/convert old `TIMESTAMP` values
  before relying on cross-row time comparisons.
- Token numbers are allocated per doctor per **UTC** date. For a UTC+05:30
  clinic the counter resets at 05:30 local; during 09:00–18:00 clinic hours the
  UTC date matches the local date. Making the boundary clinic-local requires an
  explicit clinic-timezone setting.

## If 002 emits NOTICEs (data preserved, action needed)
- `skipping UNIQUE(patients.user_id): duplicate user_id values exist` → `SELECT user_id, COUNT(*) FROM patients GROUP BY user_id HAVING COUNT(*)>1`, merge manually, re-run 002.
- `skipping FK ... dangling values exist` → find orphans (e.g. appointments whose `doctor_id` matches no `doctors.id`), fix/NULL them, re-run 002.
- `nulled N unresolvable doctor_id(s)` → those appointments pointed at non-doctor/deleted users; review them.
- `skipping ... CHECK: invalid ... values exist` → clean offending rows, re-run 002.

## What 010 does
- Creates `appointment_status_corrections` (audit actor, appointment, previous
  status, corrected status, reason, timestamp). `previous_status` is constrained
  to `done|cancelled`, `corrected_status` to `pending|confirmed`, and the reason
  to 5–500 trimmed characters. The appointment/user FKs are `ON DELETE SET NULL`
  so the audit trail survives later deletions.
- Creates `appointment_reminders` with `UNIQUE(appointment_id)` and a due index.
  One durable row per appointment makes scheduling idempotent; the worker claims
  with `FOR UPDATE SKIP LOCKED` and sets `sent_at` atomically (at-most-once).
- No existing table or row is modified. Re-running is safe.

## Automated evidence (this change)
Validated with embedded Postgres (PGlite): fresh chain base→001 (tolerated expected doctors error)→002→002 re-run converges; legacy `doctor_id=<users.id>` remapped to `doctors.id` including divergent-sequence case (`users.id=3 → doctors.id=1`); re-run does not double-map; `ON CONFLICT (user_id)` works; `users.active` backfilled; `scheduled_at` backfilled from `date_time`; bogus `appointments.status` rejected; duplicate `patients.user_id` tolerated without throw.

009 chain (27/27 checks): legacy `completed → done`; old CHECK allowing only `completed` dropped then rebuilt; canonical CHECK rejects `completed`; unsupported status aborts **before** any schema change (rows, statuses, and an existing `NOT VALID` CHECK preserved); a differently-named CHECK that blocks the update aborts with an actionable message and no changes; after mapping/dropping the blocker, a re-run recovers and enforces the CHECK; `--single-transaction` abort rolls back every section (no `password_changed_at`, no push-token columns); `password_changed_at` is TIMESTAMPTZ; legacy push-token row preserved and PK moved to `id`; multiple devices per patient; duplicate `(user_id, token)` rejected; idempotent re-run; new-shape table not given a duplicate unique index; a partial unique index does not suppress the full one.

010 chain checks: applies cleanly and re-runs without error; valid audit insert
accepted; short reason and non-closed/invalid states rejected by CHECK; audit
survives appointment deletion with a NULL target; reminder uniqueness rejects a
second row per appointment; reminder is removed when its appointment is deleted.

These checks are reproducible from the repository: `cd backend && npm run test:integration`
(runs `test/integration/migration.test.js`, synthetic data only). See
`backend/test/README.md` for prerequisites and limitations.
