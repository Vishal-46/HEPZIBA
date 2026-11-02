# Appointment token numbering

Status: **current behaviour is UTC-day based. Do not change it without an
explicit clinic decision.** This document records the exact behaviour and the
minimal clinic-local alternative, including its effect on historical tokens.

## Current behaviour (implemented)

In `backend/appointments/appointmentController.js`:

1. The requested time is parsed and normalised to an ISO 8601 UTC instant:
   `scheduledAtISO = new Date(rawScheduled).toISOString()`.
2. The allocation day is the UTC calendar date of that instant:
   `dayStr = scheduledAtISO.slice(0, 10)`.
3. Allocation is serialised per doctor **and per UTC day** with a
   transaction-scoped advisory lock keyed `appt:<doctor_profile_id>:<dayStr>`.
4. The next token is:
   `MAX(token_number) + 1` over rows for the same doctor where
   `DATE(COALESCE(scheduled_at, date_time)) = DATE($scheduledAtISO)`.
5. Both `scheduled_at` and `date_time` are `timestamp without time zone`
   columns and are written with the UTC wall clock. `DATE(...)` therefore
   yields the UTC date; the token day does not depend on the database session
   timezone or the Node host timezone.
   Caveat: legacy `date_time` rows written before the UTC contract may hold a
   local wall clock. Check them before using them as historical evidence.
6. The token counter resets when the UTC date changes. There is no per-clinic
   timezone setting in `clinic_settings` (only `clinicHours`).

For a clinic at UTC+05:30 (India), the token counter resets at **05:30 local
time**, not at local midnight. A booking at 00:15 IST belongs to the previous
UTC day and continues that day's sequence.

This behaviour is pinned by `backend/test/integration/api.integration.test.js`
(“token day is the UTC calendar day”), which asserts:

- 09:00 IST, 18:00 IST, and 00:15 IST the next local day share one UTC day and
  receive tokens 1, 2, 3;
- 05:30 IST the next local day starts a new UTC day and receives token 1.

## Decision required

Choose exactly one:

- **A. Keep UTC-day numbering** — no code or data change. The clinic must
  accept that the counter resets at 05:30 IST.
- **B. Switch to clinic-local-day numbering** — requires an explicit IANA
  timezone (for this clinic, `Asia/Kolkata`) and a decision about historical
  token numbers. This is a workflow change for reception/queue display and must
  be confirmed by the clinic before any migration.

Do not implement B by inferring a timezone from the server, the browser, or the
clinic's UTC offset.

## Minimal clinic-local alternative (proposal only, not implemented)

### 1. Store the timezone explicitly

Add to `clinic_settings`:

```json
{ "timezone": "Asia/Kolkata" }
```

Validate it with `Intl.DateTimeFormat(undefined, { timeZone })` at write time;
reject unknown zones. Default only when the key is absent, and make the default
an explicit configuration value, not a guess.

### 2. Compute the clinic day from the UTC instant

```js
function clinicDay(isoInstant, timeZone) {
  // en-CA yields YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(isoInstant));
}
```

Use this for both the advisory-lock key and the allocation filter. Keep storing
`appointments.scheduled_at` as the same UTC wall clock; do not rewrite stored
timestamps.

### 3. Migration 010 (sketch)

```sql
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS clinic_day DATE;

-- scheduled_at/date_time are UTC wall clocks, so interpret them as UTC first.
UPDATE appointments
SET clinic_day = ((COALESCE(scheduled_at, date_time) AT TIME ZONE 'UTC')
                  AT TIME ZONE 'Asia/Kolkata')::date
WHERE clinic_day IS NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_doctor_clinic_day
  ON appointments (doctor_id, clinic_day, token_number);
```

Then switch the allocation query to `WHERE doctor_id=$1 AND clinic_day=$2`.
Backfill must be idempotent and must not touch `token_number`.

### 4. Historical token numbers — the blocking issue

UTC-day and clinic-local-day numbering disagree for bookings between 00:00 and
05:30 IST. Reinterpreting existing rows by clinic day can produce **duplicate
token numbers on the same clinic day**. Example:

- UTC day D-1: 00:15 IST booking is the first of that UTC day → token 1.
- UTC day D: 09:00 IST booking is the first of that UTC day → token 1.
- Under clinic-local day D, both rows are on the same day and both have token 1.

There is no migration that both preserves historical token numbers and
guarantees unique tokens per clinic day. The clinic must choose one:

1. **Renumber history** per clinic day in chronological order. Changes printed
   or handwritten historical token numbers; requires a record of old → new.
2. **Freeze history and start fresh** from a cutover instant. Rows before the
   cutover keep UTC tokens and are excluded from the new uniqueness rule; rows
   after use clinic-day tokens. The cutover day needs a documented rule (for
   example, the first clinic day after the deploy starts at 1, and older rows
   are display-only).
3. **Keep UTC numbering** (option A).

Option 2 is usually the least destructive, but it still changes what staff see
for the cutover day and needs sign-off. Do not run a renumbering `UPDATE`
without a backup and an explicit business decision.

### 5. Test plan before changing production logic

- Unit-test `clinicDay` at 00:00, 05:29, 05:30, and 23:59 IST, and in a
  DST-observing zone (e.g. `America/New_York`) to prove the helper is not
  hardcoded to a fixed offset.
- Integration-test allocation across the local boundary on a disposable
  database: 00:15 IST and 05:30 IST must fall on the expected clinic days.
- Test the backfill twice (idempotent) and assert `token_number` is unchanged.
- Test the chosen historical policy (renumber vs freeze) explicitly, including
  a duplicate-token fixture for the boundary day.
- Re-run the full API integration suite and the real-PostgreSQL procedure in
  `backend/test/REAL_POSTGRES.md`.

## What not to do

- Do not replace `slice(0, 10)` with a server-local date.
- Do not use the database session timezone as an implicit clinic timezone.
- Do not renumber historical appointments as part of a routine deploy.
- Do not add a NOT NULL/unique constraint on clinic-day tokens until the
  historical policy is settled and the data has been checked for collisions.
