# BUILDROADMAP (v2)

## Phase-by-Phase Guide
This is your stepwise implementation plan as a beginner dev or for AI-assisted build-out.

### 0. Setup & Git
- Install Node.js, npm, git, VS Code.
- `git init` your repo, create and push to GitHub.
- Organize folders: backend/, patient-app/, doctor-admin/, shared/, docs/.

### 1. Backend & DB Foundations
- Set up Node.js/Express project in backend/.
- Install `express`, `pg`, `dotenv`; set up PostgreSQL locally.
- Use `db-schema.md` for tables: users, patients, appointments.
- Create `.env` config.
- Test DB connection.
- Add `/health` endpoint.

### 2. Core APIs (Auth, Patients, Appointments)
- Implement /signup, /login, /patients (CRUD), /appointments (CRUD).
- Use JWT for secure login/session.
- Test all endpoints with Postman.

### 3. Patient Mobile App
- Scaffold with React Native/Expo (patient-app/).
- Login/signup forms connected to backend.
- Show upcoming appts, booking, profile.

### 4. Web App (Doctor/Admin)
- `doctor-admin/` with React (use Create React App or Vite).
- Login form, dashboard, appointments table, role-based pages.
- Doctor: see schedule, view patients, add visit notes, Rx.
- Admin: manage billing, see stats.

### 5. Health Records/Rx
- Backend: add visit notes, prescription endpoints.
- Frontend: doctor page for visit notes, easy PDF Rx export.

### 6. Billing & Invoices
- Backend: create/view invoice endpoint.
- Web/mobile: download bill as PDF.

### 7. Notifications
- Setup email (Nodemailer), SMS (Twilio) for reminders.
- Basic frontend for notification management.

### 8. Security/Polish
- All APIs behind JWT auth.
- Hash passwords. Set CORS/security headers.
- Add basic tests (Jest/Mocha for backend).

### 9. Deployment
- Host backend (Heroku/AWS).
- Publish web (Vercel/Netlify).
- Build mobile (Expo build for APK).

### 10. Maintenance
- Update docs, code, and DB as needed.
- Fix bugs, enhance as per user feedback.

---
Read this and the other .md docs in rep/ before every major milestone!