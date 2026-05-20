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

- PUT `/patients/me`  
  Update own profile (name, email, dob, address).  
  (role: patient)

---

## Appointments (Patients & Doctors)

- POST `/appointments/`  
  Book appointment as patient.  
  Body: `{ doctor_id, scheduled_at, reason }`  
  (role: patient)

- GET `/appointments/my`  
  List all appointments for current patient.  
  Returns array with doctor names/dates/status.

- GET `/doctors/appointments/:id`  
  View details of a single appointment assigned to doctor.  
  (role: doctor)

- PATCH `/doctors/appointments/:id`  
  Update status or notes (e.g., accept, complete, add remarks).  
  Body: `{ status?, notes? }`  
  (role: doctor)

- GET `/appointments/for-me`  
  List all appointments for the current doctor.  
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

---

## General

- GET `/health`  
  Public. Returns `{ status: 'ok' }` if API is live.

---

## Notes and Expectations

- JWT tokens to be provided with `Authorization: Bearer <token>` header.
- All role-based endpoints are protected server-side (RBAC).
- Dates typically in ISO 8601 format (UTC).
- Status values for appointments: `'pending' | 'confirmed' | 'done' | 'cancelled'`
- For PATCH/PUT endpoints, only supply fields to change.
- 404/400 errors returned as `{ error: '...' }`.

---

**For full field reference, see the `db-schema.md`.**  
If you need examples (request/response bodies) or want to discuss edge cases, talk with the backend lead.

---
_Last updated: May 2026_
