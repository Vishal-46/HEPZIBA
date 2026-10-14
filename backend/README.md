# Backend — Node.js/Express API

Live: `https://hepziba-backend.vercel.app` (`GET /health`). This folder mirrors to
[hepziba-backend](https://github.com/Vishal-46/hepziba-backend) (Vercel project root = repo root).

## Run locally

```bash
cd backend
npm install
cp .env.example .env   # fill DATABASE_URL, JWT_SECRET, Google OAuth, email
npm run dev
```

`index.js` listens locally; Vercel uses `api/index.js` (serverless, no `listen`).
Shared Express setup lives in `app.js`. DB pooling in `db.js` is serverless-safe
(`DB_POOL_MAX=1`, SSL for non-local hosts).

## Auth endpoints (`/auth`)

| Method | Route | Notes |
|---|---|---|
| POST | `/register/patient` | Email OTP verification (15-min codes via Resend/SMTP) |
| POST | `/verify-email`, `/resend-verification` | 6-digit codes |
| POST | `/login` | Returns `{ token (15m JWT), refreshToken (30d), user }` |
| POST | `/google` | Legacy direct `idToken` login, same session shape |
| GET | `/google/start?redirect=` | Backend-mediated OAuth: 302 to Google (Google only sees `GOOGLE_REDIRECT_URI`) |
| GET | `/google/callback` | Exchanges code, then 302 to the app deep link with `token/id/name/email/role/refresh` |
| POST | `/refresh` | Rotates refresh family (reuse kills the family); rate-limited |
| POST | `/logout` | Revokes refresh + denylists access `jti`; always 200 |
| POST | `/logout-all` | Authed; kills every session on all devices |
| POST | `/forgot-password`, `/reset-password` | OTP reset flow |

Access JWTs carry `jti`+role and are checked by `middleware/roleAuth.js`
(signature → denylist → live user active/role). Tune with `ACCESS_TOKEN_TTL`
(default `15m`) and `REFRESH_TOKEN_DAYS` (default `30`).

## Migrations (`sql/`)

Apply in order (all idempotent): base `hepziba_schema.sql`, then
`001_hospital_alignment.sql`, `002_fix_doctors_and_constraints.sql`,
`005_session_tokens.sql` (refresh + denylist tables). See `sql/README.md`.

## Public pages

`GET /`, `/privacy`, `/terms` — also satisfy Google OAuth publishing
(homepage / privacy / terms links on an authorized domain).

## Key env vars

`DATABASE_URL`, `JWT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI` (= `https://<host>/auth/google/callback`, whitelisted in
Google Console), `MOBILE_GOOGLE_REDIRECT=patient-mobile://auth`,
`RESEND_API_KEY`, `RESEND_FROM`, `CORS_ORIGIN`, `FRONTEND_URL`.
