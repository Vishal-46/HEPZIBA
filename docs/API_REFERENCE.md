# API Documentation — Hepziba Chest Clinic Backend

All endpoints are under `/` (root), except where otherwise noted.  
**All operations require JWT authentication unless marked public.**  
Roles: `patient`, `doctor`, `admin`

---

## Auth Endpoints

- POST `/auth/register/patient`  
  Register a new patient.  
  Body: `{ name, email, password }`

- POST `/auth/register/doctor` *(admin only)*  
  Register a new doctor.  
  Body: `{ name, email, password }`

- POST `/auth/register/admin` *(admin only)*  
  Register a new admin.  
  Body: `{ name, email, password }`

- POST `/auth/verify-email`  
  Confirm user's email with code sent via email.  
  Body: `{ email, code }`

- POST `/auth/login`  
  Log in to receive JWT.  
  Body: `{ email, password }`  
  Returns: `{ token, user }`

- POST `/auth/forgot-password`  
  Start reset; sends email.  
  Body: `{ email }`

- POST `/auth/reset-password`  
  Reset password by code.  
  Body: `{ email, code, newPassword }`

---

## Patients

- GET `/patients/me`  
  Get current patient’s profile.  
  (role: patient)
  `mobile` and `aadhar_number` are masked by default (see **Privacy: Aadhaar
  and mobile**). The owner may request originals with `?reveal=contact` for the
  profile editor.

- PUT `/patients/me`  
  Update own profile (name, email, dob, address).  
  (role: patient)

- POST `/patients/push-token`
  Register this device's Expo push token for the caller.
  Body: `{ token, platform? }`. A physical device token is active for exactly
  one account: registering it here deactivates the same token on any other account.
  (roles: patient, doctor, admin — staff need devices for booking/cancellation
  notifications)

- DELETE `/patients/push-token`
  Deactivate the caller's push token(s), e.g. on logout / account switch.
  Body: `{ token? }` — omit `token` to deactivate every device of this account.
  Only the caller's rows are touched; other users' tokens are never modified.
  (roles: patient, doctor, admin)

- POST `/patients/test-push`
  Send a test notification to the caller's own registered device(s).
  Returns 400 when the account has no active device token.
  (roles: patient, doctor, admin)

---

## Appointments (Patients & Doctors)

- POST `/appointments/`  
  Book appointment as patient.  
  Body: `{ doctor_id, scheduled_at, reason }`  
  (roles: patient; admin/doctor may book on behalf and must supply `patient_id`)
  On success the patient and the assigned doctor receive a push notification
  after the booking is committed. Payload contains only `{ appointmentId }`.
  Failed/duplicate bookings send nothing.

- GET `/appointments/my`  
  List all appointments for current patient.  
  Returns array with doctor names/dates/status.

- GET `/appointments/:id`
  View one own appointment.
  (role: patient)

- PATCH `/appointments/:id`
  Cancel an own appointment. Patients may only set `status: 'cancelled'`
  (omitting `status` also cancels); any other value is rejected.
  (role: patient)
  A cancellation that actually changes the state notifies the assigned doctor
  and active admin devices (`{ appointmentId }` only). Rejected, repeated, or
  race-losing cancellations send nothing; completed visits stay non-cancellable.

- GET `/doctors/appointments/:id`
  View details of a single appointment assigned to doctor.
  (role: doctor)

- PATCH `/doctors/appointments/:id`
  Update status or notes (e.g., accept, complete, add remarks).
  Body: `{ status?, notes? }`. Status transitions: `pending → confirmed|done|cancelled`,
  `confirmed → done|cancelled`, `done` and `cancelled` are terminal (notes stay editable).
  Re-sending the current status is an idempotent no-op. Reopening a closed visit or
  moving backwards (`confirmed → pending`) returns 409 and changes nothing.
  (role: doctor)

- GET `/appointments/for-me`  
  List all appointments for the current doctor.  
  Contact fields are masked by default; the assigned doctor may pass
  `?reveal=contact` to call the patient.
  (role: doctor)

---

## Doctors

- GET `/doctors/me`  
  Get current doctor’s profile.  
  (role: doctor)

- PUT `/doctors/me`  
  Update profile (name, email, specialty, phone, bio).  
  (role: doctor)

---

## Admin

- GET `/admin/users?role=patient|doctor|admin`  
  List all users, optionally filtered by role.  
  (role: admin)

- GET `/admin/users/:id`  
  Get user details by user ID.  
  (role: admin)

- PUT `/admin/users/:id`  
  Update a user (name, email, role, email_verified).  
  (role: admin)

- DELETE `/admin/users/:id`  
  Soft-deactivate a user account (sets active=false).  
  (role: admin)

- GET `/admin/appointments`
  List all appointments for the clinic (admin overview).
  (role: admin)

- PATCH `/admin/appointments/:id`
  Update appointment status or notes. Uses the same transition table as the
  doctor endpoint: `pending → confirmed|done|cancelled`, `confirmed → done|cancelled`,
  `done`/`cancelled` terminal. Invalid transitions return 409 and change nothing.
  This endpoint can never reopen a closed visit, even for an admin.
  (role: admin)

- POST `/admin/appointments/:id/reopen`
  The only way to reopen a `done` or `cancelled` visit. Body:
  `{ reason, status? }`; `reason` is required (5–500 characters) and `status`
  must be `pending` or `confirmed` (default `confirmed`). The status change and
  an `appointment_status_corrections` audit row (actor, appointment, previous
  state, corrected state, reason, timestamp) commit in one transaction; if the
  audit insert fails the whole correction rolls back. Returns 409 when the visit
  is not closed, 400 for a missing/invalid reason or target state, 404 when the
  visit does not exist.
  (role: admin)

---

## Billing

- GET `/billing/invoices`
  Invoice list. Admins see every invoice. A doctor sees only invoices for
  patients assigned to them through an appointment; the assignment is resolved
  in SQL, never from a client-supplied id.
  (roles: admin, doctor)

- POST `/billing/invoices` (role: admin)
  Create an invoice. On success the invoice owner receives a push notification
  containing only `{ invoiceId }` — no amounts, line items, or contact data.

- GET `/billing/invoices/:id`
  Invoice detail. Patients may read their own invoice; doctors only for assigned
  patients; admins always. Unauthorized requests return 403/404 without invoice
  data. Patient contact fields are masked unless the documented admin reveal is
  used. (roles: admin, doctor, patient)

- PATCH `/billing/invoices/:id` (role: admin)
  Update invoice status (`paid` / `unpaid`).

- GET `/billing/my` (role: patient)
  The caller's own invoices, with contact fields masked.

---

## General

- GET `/health`  
  Public. Returns `{ status: 'ok' }` if API is live.

---

## Notifications

Push payloads are deliberately minimal: `{ appointmentId }` or `{ invoiceId }`
only. They never contain patient names, Aadhaar, mobile numbers, clinical notes,
medication names, invoice amounts, or line items.

| Event | Recipients | Timing |
| --- | --- | --- |
| Appointment booked | owning patient + assigned doctor | after COMMIT |
| Patient cancels (state actually changed) | assigned doctor + active admins | after the conditional UPDATE |
| Prescription created | appointment's patient | after COMMIT |
| Invoice created | invoice's patient | after COMMIT |
| Visit reopened by admin | visit's patient | after COMMIT |
| Appointment reminder | appointment's patient | durable worker, once |

Recipients are resolved from database relationships (`patients.user_id`,
`doctors.user_id`, `users.role='admin'`), never from request fields. Provider
failures are best-effort: they never fail or roll back the business write.

### Appointment reminders

Reminders are rows in `appointment_reminders`, not request timers or an
in-memory job list. `UNIQUE(appointment_id)` makes scheduling idempotent and the
worker claims a due row atomically (`FOR UPDATE SKIP LOCKED` + `sent_at` in the
same UPDATE), so concurrent workers cannot send the same reminder twice.
Delivery is **at-most-once**: a crash after the claim may drop one reminder but
never duplicate it. The claim re-checks that the visit is still
`pending`/`confirmed` and has not started.

Configuration (disabled by default):

```bash
APPOINTMENT_REMINDER_OFFSET_MINUTES=60   # minutes before the visit; unset/0 = off
```

`scheduled_for` is an absolute `TIMESTAMPTZ` (visit time minus the offset); the
database session is UTC, so daylight-saving changes do not shift the instant.
`backend/index.js` starts the polling worker. Serverless deployments
(`api/index.js`) must run the worker as a separate scheduled process (for
example, a cron job that runs `node -e "require('./utils/reminders').processDueReminders()"`).
A reminder is only created for bookings made while the offset is configured and
whose reminder time is still in the future.

---

## Privacy: Aadhaar and mobile

Every API serializer masks patient Aadhaar and mobile by default, server-side:

| Field | Stored value | Default response |
| --- | --- | --- |
| Aadhaar | `1234 5678 9012` | `XXXX-XXXX-9012` |
| Mobile | `9876543210` | `XXXXXX3210` |

Values with four or fewer digits are masked completely (`XXXX-XXXX-XXXX` /
`XXXX`); `null`/empty values are preserved; malformed values never leak digits.
The originals stay in the database and are used internally for search and
validation.

Explicit disclosure exception: `?reveal=contact`, checked server-side against
the authenticated role.

| Endpoint | Allowed role |
| --- | --- |
| `GET /patients`, `GET /patients/:id`, `GET /admin/patients`, `GET /admin/appointments`, `GET /billing/invoices`, `GET /billing/invoices/:id` | admin |
| `GET /appointments/for-me` | doctor (own assigned list) |
| `GET /patients/me` | patient (owner) |

A frontend role check is never the authorization boundary; a role not listed
above gets masked data even with the query parameter. Search, nested chart
objects, invoice detail, and the admin debug endpoint all pass through the same
masking helper.

---

## Notes and Expectations

- JWT tokens to be provided with `Authorization: Bearer <token>` header.
- All role-based endpoints are protected server-side (RBAC).
- Dates typically in ISO 8601 format (UTC).
- Status values for appointments: `'pending' | 'confirmed' | 'done' | 'cancelled'`
- `GET /patients` and `GET /patients/:id` are admin/doctor chart endpoints.
  Doctors have clinic-wide EHR read access (`docs/Hospital Details.md`); patients
  read their own data via `/patients/me`, `/appointments/my`, `/billing/my`, and
  `/prescriptions/my` and cannot open another patient's chart or history.
  Invoice access is narrower: doctors only see invoices for patients assigned to
  them through an appointment, and unassigned chart requests return `invoices: []`.
- Aadhaar and mobile are masked by default in every response; see
  **Privacy: Aadhaar and mobile** for the format and the narrow reveal exception.
- For PATCH/PUT endpoints, only supply fields to change.
- 404/400 errors returned as `{ error: '...' }`. Conflicting state transitions
  return 409 with `{ error: '...' }`.

---

**For full field reference, see the `db-schema.md`.**  
If you need examples (request/response bodies) or want to discuss edge cases, talk with the backend lead.

---
_Last updated: October 2026_

