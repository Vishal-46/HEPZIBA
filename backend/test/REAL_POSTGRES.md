# Real PostgreSQL verification (disposable only)

The repository's automated suite runs against PGlite (PostgreSQL compiled to
WASM). That is strong evidence for SQL semantics, but it is **not** a real
server: it cannot verify libpq startup options, PgBouncer/pooler behaviour,
SSL, `ALTER TABLE` locking, or `psql --single-transaction` handling.

This procedure exercises migrations `001`–`010` on a throwaway PostgreSQL
instance with synthetic data. It has **not** been executed in this environment:
no `psql`, `postgres`, container runtime, or database listener is available
here. Treat it as a staging runbook, not as completed evidence.

## Hard safety rules

- Use a database created only for this test. Never point `PGURL` at staging or
  production, even read-only: the script writes and drops objects.
- Synthetic data only (`@example.test`, `Patient One`, `Doctor One`). No real
  patient data, no production dumps.
- Never print or commit `PGURL`, passwords, or `.env` contents.
- The script refuses to run unless the host is loopback and the database name
  starts with `hepziba_test_`, and `ALLOW_DISPOSABLE_PG=1` is set.
- Cleanup is explicit. The script does not drop the database automatically so
  a failure can be inspected; the final section shows how to remove it.

## Prerequisites

- PostgreSQL 14+ (16 recommended) reachable on `127.0.0.1`, or a container
  runtime you are authorised to use.
- `psql` matching the server major version.
- Run from the repository root (`hepziba_schema.sql` and `backend/sql/` must be
  reachable).
- No backend process pointed at the same database.

Start a disposable server with Docker (skip if you already have one):

```bash
docker run --rm --name hepziba-pg \
  -e POSTGRES_PASSWORD=hepziba_test_pw \
  -e POSTGRES_DB=hepziba_test_run1 \
  -p 127.0.0.1:55432:5432 \
  postgres:16
```

Then, in another shell:

```bash
export PGURL='postgresql://postgres:hepziba_test_pw@127.0.0.1:55432/hepziba_test_run1'
export ALLOW_DISPOSABLE_PG=1
```

For a locally installed PostgreSQL, create the database first:

```bash
createdb hepziba_test_run1
export PGURL='postgresql://localhost/hepziba_test_run1'
export ALLOW_DISPOSABLE_PG=1
```

## Guarded driver

Save as `run-real-pg.sh` (or paste into a shell). It stops at the first
unexpected error and prints the cleanup command on failure.

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${PGURL:?Set PGURL to a disposable database}"
: "${ALLOW_DISPOSABLE_PG:?Set ALLOW_DISPOSABLE_PG=1 to confirm this database is disposable}"

case "$PGURL" in
  *localhost*|*127.0.0.1*) ;;
  *) echo "REFUSING: PGURL host is not loopback" >&2; exit 1 ;;
esac

DBNAME=$(psql "$PGURL" -Atc 'SELECT current_database()')
case "$DBNAME" in
  hepziba_test_*) ;;
  *) echo "REFUSING: database '$DBNAME' is not named hepziba_test_*" >&2; exit 1 ;;
esac

on_error() {
  echo >&2
  echo "FAILED. The disposable database '$DBNAME' was left for inspection." >&2
  echo "Clean up with: dropdb --if-exists '$DBNAME'  (or: docker rm -f hepziba-pg)" >&2
}
trap on_error ERR

run_strict() {
  echo "== $1"
  psql "$PGURL" -v ON_ERROR_STOP=1 --single-transaction -f "$1"
}

echo "== hepziba_schema.sql"
psql "$PGURL" -v ON_ERROR_STOP=1 -f hepziba_schema.sql

# ---------------------------------------------------------------------------
# 001 is expected to fail on a fresh database: it references `doctors` before
# 002 creates it. This is a known ordering defect, repaired by 002 -- not a
# designed failure. Capture the output and prove ONLY the two known errors
# occurred. Any other error aborts the run.
# ---------------------------------------------------------------------------
echo "== 001_hospital_alignment.sql (expected: 2 known errors)"
set +e
psql "$PGURL" -v ON_ERROR_STOP=0 -f backend/sql/001_hospital_alignment.sql \
  > /tmp/hepziba-001.log 2>&1
set -e

ERROR_COUNT=$(grep -c 'ERROR:' /tmp/hepziba-001.log || true)
if [ "$ERROR_COUNT" -ne 2 ]; then
  echo "001 produced $ERROR_COUNT error(s); expected exactly 2." >&2
  cat /tmp/hepziba-001.log >&2
  false
fi
grep -q 'relation "doctors" does not exist' /tmp/hepziba-001.log
grep -q 'relation "prescriptions" does not exist' /tmp/hepziba-001.log

# 001 stopped before creating these; 002 repairs them.
test "$(psql "$PGURL" -Atc "SELECT to_regclass('prescriptions') IS NULL")" = t
test "$(psql "$PGURL" -Atc "SELECT to_regclass('invoices') IS NOT NULL")" = t

# ---------------------------------------------------------------------------
# Synthetic fixtures. Every id is read back with RETURNING/\gset; nothing
# assumes sequences start at 1. Insert BEFORE 002 for two reasons:
#   - appointments.doctor_id still references users(id) and 002 remaps it;
#   - 002 must see the legacy `completed`/`no-show` rows so it does NOT add the
#     canonical CHECK that would block the 009 abort test.
# ---------------------------------------------------------------------------
echo "== synthetic fixtures (pre-002 legacy shape)"
psql "$PGURL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO users (name, email, password, role)
VALUES ('Doctor One', 'doctor1@example.test', 'x', 'doctor')
RETURNING id AS doctor_user_id \gset

INSERT INTO users (name, email, password, role)
VALUES ('Patient One', 'patient1@example.test', 'x', 'patient')
RETURNING id AS patient_user_id \gset

INSERT INTO patients (user_id)
VALUES (:patient_user_id)
RETURNING id AS patient_id \gset

INSERT INTO appointments (patient_id, doctor_id, date_time, status)
VALUES (:patient_id, :doctor_user_id, NOW(), 'completed')
RETURNING id AS completed_id \gset

INSERT INTO appointments (patient_id, doctor_id, date_time, status)
VALUES (:patient_id, :doctor_user_id, NOW(), 'no-show')
RETURNING id AS unsupported_id \gset

SELECT :doctor_user_id AS doctor_user_id, :patient_id AS patient_id,
       :completed_id AS completed_id, :unsupported_id AS unsupported_id;
SQL

run_strict backend/sql/002_fix_doctors_and_constraints.sql
run_strict backend/sql/002_fix_doctors_and_constraints.sql   # idempotency
run_strict backend/sql/004_repair_clinic_columns.sql         # no-op on a fresh DB
run_strict backend/sql/005_session_tokens.sql
run_strict backend/sql/006_clinic_settings.sql
run_strict backend/sql/007_inventory_mrp_expiry.sql
run_strict backend/sql/008_billing_fee_push.sql

# 002 remapped the fixture appointments to doctors.id; confirm the legacy
# statuses survived and no canonical CHECK was added yet.
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM appointments WHERE status='completed'")" = 1
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM appointments WHERE status='no-show'")" = 1
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM pg_constraint
       WHERE conrelid='appointments'::regclass AND conname='appointments_status_check'")" = 0

# ---------------------------------------------------------------------------
# 009 must abort on the unsupported value and change nothing (transactional).
# ---------------------------------------------------------------------------
echo "== 009 with an unsupported status (expected: abort)"
set +e
psql "$PGURL" -v ON_ERROR_STOP=1 --single-transaction \
  -f backend/sql/009_consistency_hardening.sql > /tmp/hepziba-009-abort.log 2>&1
STATUS=$?
set -e
if [ "$STATUS" -eq 0 ]; then
  echo "009 unexpectedly succeeded with an unsupported status" >&2
  false
fi
grep -qi 'unsupported status' /tmp/hepziba-009-abort.log
grep -qi 'no-show' /tmp/hepziba-009-abort.log

# Nothing from any section may have been applied.
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM appointments WHERE status='completed'")" = 1
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM appointments WHERE status='no-show'")" = 1
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM information_schema.columns
       WHERE table_name='users' AND column_name='password_changed_at'")" = 0
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM information_schema.columns
       WHERE table_name='patient_push_tokens' AND column_name='platform'")" = 0

# ---------------------------------------------------------------------------
# Recover and apply for real, then re-run to prove idempotency.
# ---------------------------------------------------------------------------
echo "== recovery + 009"
psql "$PGURL" -v ON_ERROR_STOP=1 -c \
  "UPDATE appointments SET status='cancelled' WHERE status='no-show';"
run_strict backend/sql/009_consistency_hardening.sql
run_strict backend/sql/009_consistency_hardening.sql

# Post-conditions.
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM appointments WHERE status='completed'")" = 0
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM appointments WHERE status='done'")" = 1
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM appointments WHERE status='cancelled'")" = 1
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM information_schema.columns
       WHERE table_name='users' AND column_name='password_changed_at'")" = 1

CHECK_DEF=$(psql "$PGURL" -Atc "SELECT pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conrelid='appointments'::regclass AND conname='appointments_status_check'")
case "$CHECK_DEF" in
  *done*) ;;
  *) echo "canonical status CHECK missing 'done': $CHECK_DEF" >&2; false ;;
esac
case "$CHECK_DEF" in
  *completed*) echo "canonical status CHECK still allows 'completed'" >&2; false ;;
esac

# Canonical CHECK rejects the legacy value.
set +e
psql "$PGURL" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO appointments (patient_id, doctor_id, date_time, status)
   VALUES ((SELECT id FROM patients LIMIT 1), (SELECT id FROM doctors LIMIT 1), NOW(), 'completed');" \
  > /dev/null 2>&1
BAD_STATUS=$?
set -e
test "$BAD_STATUS" -ne 0

# ---------------------------------------------------------------------------
# 010: audited corrections + durable reminders. Re-run proves idempotency.
# ---------------------------------------------------------------------------
echo "== 010 (twice)"
run_strict backend/sql/010_policy_batch.sql
run_strict backend/sql/010_policy_batch.sql
test "$(psql "$PGURL" -Atc "SELECT COUNT(*) FROM information_schema.tables
       WHERE table_name IN ('appointment_status_corrections','appointment_reminders')")" = 2

echo "== PASS: migrations 001-010, abort, recovery, and idempotent re-runs"
```

## What the run proves

| Check | Expected |
| --- | --- |
| Fresh `hepziba_schema.sql` | succeeds |
| `001` on a fresh DB | exactly 2 errors: `doctors` missing, then `prescriptions` missing; `002` repairs both |
| `002` re-run | succeeds (idempotent) |
| `004` | succeeds and is a no-op on a fresh DB (repairs columns on legacy DBs) |
| `005`–`008` | succeed with `ON_ERROR_STOP=1 --single-transaction` |
| `009` with `no-show` | aborts with an actionable message; no status, column, or constraint change |
| Recovery (`no-show` → `cancelled`) + `009` | succeeds; `completed` → `done`; canonical CHECK rebuilt |
| `009` re-run | succeeds, no duplicate constraint/index, no data change |
| Inserting `completed` after 009 | rejected by the canonical CHECK |
| `010` | creates the audit + reminder tables; a second run changes nothing |

The script stops before any later migration after an unexpected failure
(`set -e` + `run_strict`). `001` is the only file allowed to continue after an
error, and only after its output matches the two known messages exactly.

## Optional: non-transactional partial-application check

Use a **second** disposable database. Seed the same fixtures, then run:

```bash
psql "$PGURL" -v ON_ERROR_STOP=0 -f backend/sql/009_consistency_hardening.sql
```

psql continues after the status error, so sections 2–3 may apply while section 1
stays unchanged. Confirm that `password_changed_at` and the push-token columns
exist and that the appointments statuses are untouched. This demonstrates why
`-v ON_ERROR_STOP=1 --single-transaction` is required in staging/production.

## Startup checks against real PostgreSQL

The backend now:

1. opens each pooled connection with `options: '-c timezone=UTC'` (unless
   `DB_DISABLE_UTC_OPTIONS=1`);
2. runs `SHOW TimeZone` and refuses to serve unless it is `UTC`/`Etc/UTC`
   (`DB_REQUIRE_UTC=0` downgrades this to a warning);
3. runs the compatibility DDL, then checks the required objects;
4. in production (`NODE_ENV=production`, or `SCHEMA_STRICT=1`) refuses to start
   if any required object is missing.

This changes how **new** `NOW()` values are written; it does not rewrite
existing rows. If the database previously ran with a non-UTC default, audit
old `TIMESTAMP` values before relying on them.

Verify on the disposable server:

```bash
psql "$PGURL" -c 'SHOW TimeZone'          # server default; the app checks its own pool

# With the migrated disposable DB:
cd backend
DATABASE_URL="$PGURL" JWT_SECRET=test-only-not-a-real-key NODE_ENV=production \
  SCHEMA_STRICT=1 node index.js            # must start; stop it after the ready log
```

Then create a second disposable database with only `hepziba_schema.sql` (no
migrations) and start the backend with `DATABASE_URL` pointing at it. It must
refuse to start and name the missing objects/migrations. Do not run this
against staging.

If the provider's pooler rejects the `options` startup parameter, set
`DB_DISABLE_UTC_OPTIONS=1` and configure the role/database default instead:

```sql
ALTER ROLE <app_user> SET timezone = 'UTC';
ALTER DATABASE <db> SET timezone = 'UTC';
```

Re-run the `SHOW TimeZone` check through the application pool; the startup
verification must still pass. Document the provider and the chosen mode.

## Cleanup

```bash
# Local PostgreSQL
dropdb --if-exists "$DBNAME"

# Docker (matches the port/user in the example above)
PGPASSWORD=hepziba_test_pw dropdb -h 127.0.0.1 -p 55432 -U postgres --if-exists "$DBNAME"
docker rm -f hepziba-pg
```

Remove `/tmp/hepziba-001.log` and `/tmp/hepziba-009-abort.log` if they contain
anything sensitive (they contain synthetic SQL errors only).
