# Hepziba Chest Clinic Management System

## Overview
The **Hepziba Chest Clinic** system is a specialized, comprehensive management platform designed for a pulmonology clinic in Nagercoil (Dr. T. Joseph Pratheeban). This system aims to digitize the clinic's workflow, including patient records, appointment scheduling, prescription management, medical inventory, and billing.

## Project Structure
The repository is structured as a monorepo containing the following key components:

- `/backend`: The core API backend built with **Node.js** and **Express**, connecting to a **PostgreSQL** database. Handles authentication, data management, and business logic.
- `/frontend/doctor-admin-web`: A **React** web application (powered by **Vite**) tailored for doctors and clinic administrators to manage the clinic, view patient histories, and handle appointments.
- `/frontend/patient-mobile`: A mobile application built with **React Native** and **Expo**, designed for patients to book appointments, view invoices, and manage their profiles.
- `/docs`, `/shared`, `/scripts`: Folders containing documentation, shared assets, and utility scripts.
- `db-schema.md` & `hepziba_schema.sql`: Documentation and SQL scripts for the database schema.
- `PROJECT_STATUS_REPORT.md`: A detailed report on the current development progress, feature completion matrix, and technical debt.

## Tech Stack
- **Backend:** Node.js, Express.js, PostgreSQL (Supabase pooler via `pg`), JSON Web Tokens (JWT) for authentication, `bcrypt` for password hashing, Resend for email. Deployed serverless on **Vercel** (`backend/` mirrors to [hepziba-backend](https://github.com/Vishal-46/hepziba-backend)).
- **Web Frontend:** React, Vite, React Router, React Query, Axios.
- **Mobile Frontend:** React Native, Expo, React Navigation, React Native Paper, `expo-secure-store` for token storage.
- **Database:** PostgreSQL.

## Authentication & Sessions
- **Password + Google OAuth:** patients use email/password (with email OTP verification) or Continue with Google. Staff (doctor/admin) use email/password.
- **Backend-mediated Google OAuth (no Expo proxy):** the app opens `GET /auth/google/start`; Google redirects to the backend callback (`/auth/google/callback`); the backend verifies the `id_token`, creates/finds the patient, and redirects to the app deep link (`patient-mobile://auth`, or `exp://…` in Expo Go dev). Google only ever sees the backend HTTPS URL, so no frontend client IDs or Expo account are needed — one **Web** OAuth client in Google Cloud Console.
- **Sessions:** short-lived access JWT (15m, `ACCESS_TOKEN_TTL`, carries `jti`+role) + rotating opaque refresh tokens (30d, `REFRESH_TOKEN_DAYS`, SHA-256 hashed in `refresh_tokens`). `POST /auth/refresh` rotates with reuse detection (reused token kills the whole family). `POST /auth/logout` revokes the refresh token and denylists the access `jti` until expiry; `POST /auth/logout-all` kills every session. `roleAuth` checks signature → denylist → live user row (active + current role).
- **Clients:** both apps refresh silently on 401 (single-flight) and call server logout on sign-out. Mobile stores tokens in SecureStore; web in localStorage.
- **Public legal pages** (required for Google OAuth publishing): `GET /`, `/privacy`, `/terms` on the backend host.

## Core Features (Current Status)
- **Authentication & Roles:** JWT + refresh rotation with 'patient', 'doctor', and 'admin' RBAC. *(Working)*
- **Patient Registration & Profiles:** Managing patient details, medical history, and contact info. *(Working)*
- **Appointment Management:** Scheduling and tracking patient appointments. *(Working)*
- **Electronic Health Records (EHR):** Digital management of patient medical data. *(Working)*
- **Billing/Invoicing, Inventory, Prescriptions:** *(Working — see `PROJECT_STATUS_REPORT.md`)*

## Getting Started

### Prerequisites
- Node.js (v18 or higher recommended)
- PostgreSQL installed and running
- Expo CLI (for mobile app development)

### 1. Database Setup
1. Create a PostgreSQL database for the project.
2. Apply migrations in order (all idempotent; re-running is safe):
   ```bash
   psql -U your_username -d your_database_name -f hepziba_schema.sql
   psql -U your_username -d your_database_name -f backend/sql/001_hospital_alignment.sql
   psql -U your_username -d your_database_name -f backend/sql/002_fix_doctors_and_constraints.sql
   psql -U your_username -d your_database_name -f backend/sql/005_session_tokens.sql
   ```
   This sets up `users`, `patients`, `doctors`, `appointments`, plus prescriptions/billing/inventory tables, then `refresh_tokens` + `revoked_access_tokens` for sessions. Note: on a fresh DB, `001` may stop at `prescriptions` with `relation "doctors" does not exist` (it references `doctors` before it exists); `002` creates `doctors` and any missing tables, so just continue to `002`. See `db-schema.md` and `backend/sql/README.md` for details and verification steps.

### 2. Backend Setup
1. Navigate to the backend directory: `cd backend`
2. Install dependencies: `npm install`
3. Set up your environment variables by copying `.env.example` to `.env` and configuring database credentials, JWT secret, Google OAuth (`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`), and email (Resend/SMTP).
4. Run the development server: `npm run dev`
5. Deploy: push `backend/` to the [hepziba-backend](https://github.com/Vishal-46/hepziba-backend) repo (Vercel project root = repo root); set the same env vars in Vercel and redeploy. Live API: `https://hepziba-backend.vercel.app` (`/health`).

### Google OAuth Setup (one Web client)
1. Google Cloud Console → one **Web application** OAuth client.
2. Authorized JavaScript origin: `https://hepziba-backend.vercel.app`; Authorized redirect URI: `https://hepziba-backend.vercel.app/auth/google/callback` (must exactly match `GOOGLE_REDIRECT_URI`).
3. Consent screen → add `https://hepziba-backend.vercel.app/`, `/privacy`, `/terms` as home/privacy/terms links, then Publish so any Gmail can sign in (Testing mode = test users only).

### 3. Web Admin Panel Setup
1. Navigate to the web frontend: `cd frontend/doctor-admin-web`
2. Install dependencies: `npm install`
3. Run the development server: `npm run dev`

### 4. Patient Mobile App Setup
1. Navigate to the mobile frontend: `cd frontend/patient-mobile`
2. Install dependencies: `npm install`
3. Set `EXPO_PUBLIC_API_URL` in `.env` (LAN IP for local backend, or `https://hepziba-backend.vercel.app` — Google login requires the hosted backend).
4. Start the Expo server: `npx expo start -c` (Use the Expo Go app on your phone or an emulator to preview).
5. Production test build (APK): `eas build -p android --profile preview` (API URL is baked in at build time, so rebuild after `.env` changes).

## Current Development Tasks
Refer to the `PROJECT_STATUS_REPORT.md` for immediate action items, which currently include locating the Doctor-Admin UI (now found!), verifying DB implementations, auditing code for validation/errors, and planning the deployment strategy.
