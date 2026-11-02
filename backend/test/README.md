# Backend tests

Two layers:

| Layer | Location | Runner | What it proves |
| --- | --- | --- | --- |
| Unit | `test/*.test.js` | `node --test` | Pure helpers: time/date parsing, UTC zone detection, schema-check formatting, money, redirects, status mapping, auth code expiry, PII masking, reminder configuration/scheduling |
| Integration | `test/integration/*.test.js` | `node --test` | The real SQL chain and the real Express app against a disposable Postgres |

## Prerequisites

- Node.js 20.10+ (uses the built-in test runner, `t.test` subtests,
  directory discovery and `--test-concurrency`).
- `npm install` in `backend/`. Integration tests need the devDependencies
  `@electric-sql/pglite` (Postgres compiled to WASM) and
  `@electric-sql/pglite-socket` (TCP bridge so the real `pg` driver can talk
  to it). They are not runtime dependencies of the API.

No PostgreSQL server, Docker, `.env`, credentials, or network access are
required.

## Commands

```bash
cd backend
npm test                 # unit + integration
npm run test:unit        # test/*.test.js only (fast, no WASM)
npm run test:integration # test/integration/ only (spawns PGlite)
```

Run a single file or a single scenario:

```bash
node --test test/dbTime.test.js
node --test --test-name-pattern="Scenario C" test/integration/migration.test.js
```

## What the integration tests do

`migration.test.js` replays `hepziba_schema.sql` and migrations `001`–`010`
statement-by-statement, the way `psql -f` executes them (autocommit per
statement, continue on error). Scenarios A–G cover:

- legacy `completed → done` migration and canonical CHECK rebuild
- an old `completed`-only CHECK, a `NOT VALID` CHECK, and a differently-named
  blocking CHECK
- unsupported status values aborting **before** any schema change
- recovery by mapping the value / dropping the blocker, then re-running
- `--single-transaction` rollback leaving nothing applied
- push-token reshape, partial unique index, idempotent re-runs
- 010 audit/reminder tables: idempotent apply, CHECK constraints, audit survives
  appointment deletion, reminder uniqueness and cascade delete

`api.integration.test.js` boots the real `backend/app.js` on an ephemeral port
with a real `pg` pool pointed at PGlite over a loopback socket. It exercises
auth/session rotation, password-reset invalidation, appointments and token
numbering, billing, prescriptions, inventory, push-token privacy, admin staff
lifecycle, the UTC session check, and the startup required-schema check. Two
areas are pinned explicitly:

- **Authorization:** patients read only their own records (`/patients/me`,
  `/appointments/my`, `/billing/my`, `/prescriptions/my`); `/patients/:id` is
  role-gated to admin/doctor; a patient cannot read another patient's chart,
  appointment, invoice, or prescription. Doctors have clinic-wide chart access
  (documented in `docs/Hospital Details.md`), asserted for both the assigned and
  an unrelated doctor so a policy change cannot happen silently.
- **Appointment transitions:** `pending → confirmed|done|cancelled`,
  `confirmed → done|cancelled`, `done`/`cancelled` terminal (notes stay
  editable), legacy `completed` treated as `done`. Reopening or moving
  backwards returns 409 and leaves the row untouched; concurrent requests
  cannot bypass the guard.

Only two outbound integrations are stubbed:

- `mailer/mailer.js` is replaced in `require.cache` (no email is sent).
- `global.fetch` is wrapped so calls to `https://exp.host/` return a synthetic
  ticket and every other URL is delegated to the real fetch. The recipient
  selection in `utils/push.js` still executes, so a wrong token list fails the
  test instead of being hidden by a stub.

`notificationIsolation.integration.test.js` is the focused regression suite for
the reported cross-user push leak. It seeds Patients A/B/C (A has two devices),
a walk-in and an account-less legacy patient, then asserts:

- `tokensForUser` returns exactly the owner's active devices (no patient-id
  drift, no foreign tokens) and fails closed for invalid ids;
- doctor and admin appointment updates reach only the appointment owner;
- a legacy appointment with no linked account sends nothing;
- deactivated devices are excluded and re-registering reactivates them;
- a shared device switches accounts (the previous account stops receiving);
- logout deactivates only the caller's rows;
- a client-supplied `user_id` cannot claim another account's token;
- interleaved events keep their own recipient lists;
- a provider outage is best-effort (no throw, no token rewrite) and a
  `DeviceNotRegistered` ticket removes only that dead device;
- API responses do not expose device tokens, and `/debug-push` is admin-only.

It runs the real SQL, the real `utils/push.js`, and the real Express routes;
only the Expo HTTP endpoint is intercepted.

`schemaCheck.integration.test.js` runs `utils/schemaCheck.js` against a real
PGlite engine: it must flag the base schema and the pre-009 push-token shape,
and pass only after `010` (which adds the audit/reminder tables).

`policies.integration.test.js` is the regression suite for the six approved
business policies:

- **A — invoice visibility:** admin sees all; a doctor sees only invoices for
  patients assigned via an appointment; detail/download/chart access enforced;
  the owner patient keeps access; unauthorized responses leak no invoice data.
- **B — masking:** Aadhaar/mobile masked in lists, profiles, search, charts,
  appointments, invoices, nested chart data and `/debug-push`; only the
  documented `?reveal=contact` role/endpoint pairs return originals; null/short/
  malformed values are safe.
- **C — booking notifications:** patient + assigned doctor only, after COMMIT,
  minimal `{ appointmentId }`; failed/duplicate bookings and provider outages
  send nothing and never roll back the booking.
- **D — cancellation notifications:** doctor + active admins only when the
  conditional UPDATE actually changed the row; repeats, rejected and completed
  cancellations send nothing; an outage does not reverse the cancellation.
- **E — audited reopening:** ordinary admin/doctor PATCH cannot reopen a closed
  visit; only admins may call `/admin/appointments/:id/reopen`; reason and target
  state are validated; audit fields are written atomically; concurrent attempts
  produce one correction; a forced audit failure rolls the status change back.
- **F — prescriptions, invoices, reminders:** only the correct patient is
  notified after persistence, payloads contain no clinical/financial data;
  failed writes send nothing; booking persists a durable reminder at the
  configured offset; cancelled/done visits are not reminded; concurrent claims
  and repeat worker runs never duplicate; missing configuration fails safe.

## Real PostgreSQL

The automated suite never connects to a real server. Before staging/production,
run the guarded disposable procedure in
[`REAL_POSTGRES.md`](REAL_POSTGRES.md). It verifies the known `001` failure,
`ON_ERROR_STOP`/transaction behaviour, the `009` abort and recovery paths, `010`
idempotency, the
UTC pool option, and the startup schema refusal. It refuses to run against any
database that is not loopback and named `hepziba_test_*`.

## Safety rules

- **Synthetic fixtures only.** Emails use `@example.test`, names are
  `Patient A`/`Doctor One`, and every value is generated inside the test.
- **No production access.** The suite never reads `.env`; it sets
  `DATABASE_URL` to a loopback PGlite socket and `JWT_SECRET` to a test-only
  value before requiring the app. `dotenv` does not override already-set
  environment variables.
- **No destructive external operations.** Each PGlite instance is created in
  memory and closed at the end of the run.
- **No secrets in output.** Tokens, codes and passwords are synthetic and are
  not printed by the suite.

## Limitations

- PGlite is Postgres compiled to WASM, not a full server. It is strong evidence
  for SQL semantics but **not** a substitute for running migrations against a
  disposable real PostgreSQL (connection pooler, SSL, `ALTER TABLE` locking,
  `psql --single-transaction` behaviour). Do that in staging before production.
  See [`REAL_POSTGRES.md`](REAL_POSTGRES.md) for the guarded procedure.
- PGlite ignores libpq startup `options` and shares a single session. The
  integration suite can prove that a non-UTC session is detected, but **cannot**
  prove that `options: '-c timezone=UTC'` is honoured by a real pooler. Verify
  that in staging.
- The migration test splits SQL itself (`test/helpers/sqlSplit.js`) rather than
  invoking `psql`; the splitter handles dollar-quoted `DO` blocks, comments and
  string literals, but it is a reimplementation, not `psql` itself.
- The API test runs the app in-process with a single connection
  (`DB_POOL_MAX=1`). It does not cover multi-instance/serverless behaviour;
  concurrent-claim/correction assertions are therefore serialized by the pool.
  Verify true multi-connection races in `REAL_POSTGRES.md` / staging.

## Adding tests

- Unit test: add `test/<name>.test.js` using `node:test` + `node:assert/strict`.
- Integration test: add a file under `test/integration/` ending in
  `.test.js`. Import `splitSql` from `../helpers/sqlSplit`, resolve the repo
  root with `path.resolve(__dirname, '..', '..', '..')`, and register checks
  with `t.test`.
- Never point integration tests at a real database. If a test needs a new
  external service, stub it at the network boundary (as the push tests do with
  `global.fetch`) or in `require.cache` (as the mailer test does) — never stub
  the database query or the authorization/recipient-selection code under test.
