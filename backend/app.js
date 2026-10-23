require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Trust Vercel / Render proxies (correct protocol + IPs behind load balancers).
app.set('trust proxy', 1);

// Low-risk default headers for a JSON API. crossOriginResourcePolicy is
// disabled so a separately-hosted frontend (allowed via CORS below) can
// still read API responses; all other helmet defaults stay on.
app.use(require('helmet')({ crossOriginResourcePolicy: false }));

// Tightened CORS: explicit env allowlist, localhost fallback for dev.
// CORS_ORIGIN is a comma-separated list, e.g.
// CORS_ORIGIN=https://app.example.com,https://admin.example.com
// FRONTEND_URL is also honored when set.
const corsAllowlist = [
  ...(process.env.CORS_ORIGIN || '').split(','),
  process.env.FRONTEND_URL || '',
  'https://hepziba.vercel.app',
].map((s) => s.trim()).filter(Boolean);
const localhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // non-browser clients (curl, health checks)
    if (corsAllowlist.includes(origin)) return cb(null, true);
    if (corsAllowlist.length === 0 && localhostOrigin.test(origin)) return cb(null, true);
    // Deny by omitting CORS headers (browser blocks the response) rather
    // than erroring, so a disallowed origin never surfaces a 500.
    return cb(null, false);
  },
  credentials: true,
}));

const errorHandler = require('./middleware/errorHandler');
app.use(express.json());

// Mount authentication endpoints
app.use('/auth', require('./auth/authRoutes'));
// Mount patient endpoints
app.use('/patients', require('./patients/patientRoutes'));
// Mount appointment endpoints
app.use('/appointments', require('./appointments/appointmentRoutes'));
// Mount doctor endpoints
app.use('/doctors', require('./doctors/doctorRoutes'));
// Mount admin endpoints
app.use('/admin', require('./admin/adminRoutes'));
// Mount prescription endpoints
app.use('/prescriptions', require('./prescriptions/prescriptionRoutes'));
// Mount billing endpoints
app.use('/billing', require('./billing/billingRoutes'));
// Mount inventory endpoints
app.use('/inventory', require('./inventory/inventoryRoutes'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const debugPushHandler = async (req, res) => {
  const pool = require('./db');
  const { tokensForUser, notifyAppointmentOwner } = require('./utils/push');
  try {
    const appointmentId = req.params.appointmentId ? Number(req.params.appointmentId) : null;
    let appointment = null;
    let patient = null;
    let apptOwnerUserId = null;
    let appointmentTokens = [];

    if (appointmentId) {
      const apptRes = await pool.query('SELECT * FROM appointments WHERE id = $1', [appointmentId]);
      appointment = apptRes.rows[0] || null;
      if (appointment) {
        const ownerRes = await pool.query(
          `SELECT COALESCE(p.user_id, p_by_user.user_id, a.patient_id) AS user_id
           FROM appointments a
           LEFT JOIN patients p ON p.id = a.patient_id
           LEFT JOIN patients p_by_user ON p_by_user.user_id = a.patient_id
           WHERE a.id = $1`,
          [appointmentId]
        );
        apptOwnerUserId = ownerRes.rows[0]?.user_id || null;
        if (apptOwnerUserId) {
          appointmentTokens = await tokensForUser(apptOwnerUserId);
        }
        const patRes = await pool.query(
          'SELECT * FROM patients WHERE id = $1 OR user_id = $1',
          [appointment.patient_id]
        );
        patient = patRes.rows[0] || null;
      }
    }

    const allTokensRes = await pool.query('SELECT * FROM patient_push_tokens ORDER BY updated_at DESC LIMIT 20');
    const recentAppointmentsRes = await pool.query('SELECT id, patient_id, doctor_id, status, notes, scheduled_at FROM appointments ORDER BY id DESC LIMIT 10');
    const recentUsersRes = await pool.query('SELECT id, email, role, created_at FROM users ORDER BY id DESC LIMIT 10');

    let pushResult = null;
    if (req.query.trigger === 'true' && appointmentId) {
      pushResult = await notifyAppointmentOwner(appointmentId, 'Hepziba Diagnostic', 'Testing push notification delivery');
    }

    return res.json({
      appointmentId,
      appointment,
      patient,
      apptOwnerUserId,
      appointmentTokens,
      allTokensInDb: allTokensRes.rows,
      recentAppointments: recentAppointmentsRes.rows,
      recentUsers: recentUsersRes.rows,
      pushResult,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
};
app.get('/debug-push', debugPushHandler);
app.get('/debug-push/:appointmentId', debugPushHandler);

// Public legal pages (also satisfy Google OAuth publishing, which requires
// an app homepage, privacy policy and terms on an authorized domain).
const CONTACT_EMAIL = process.env.SUPPORT_EMAIL || 'hepzibachestclinic@gmail.com';
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title} — Hepziba Chest Clinic</title>` +
  `<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}` +
  `h1{font-size:1.6rem}a{color:#0b5fff}</style></head>` +
  `<body><h1>${title}</h1>${body}<hr><p>Contact: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p></body></html>`;

app.get('/', (_req, res) => res.type('html').send(page('Hepziba Chest Clinic',
  `<p>Backend API for the Hepziba Chest Clinic patient mobile app and clinic admin tools.</p>` +
  `<p>Patients: use the mobile app to book appointments, view prescriptions and message your doctor.</p>` +
  `<ul><li><a href="/privacy">Privacy policy</a></li><li><a href="/terms">Terms of service</a></li>` +
  `<li><a href="/health">API status</a></li></ul>`)));

app.get('/privacy', (_req, res) => res.type('html').send(page('Privacy policy',
  `<p>Last updated: October 2026.</p>` +
  `<p><strong>Data we collect:</strong> name and email address (including via Google sign-in), appointment and prescription records you create in the app, and basic technical logs.</p>` +
  `<p><strong>How we use it:</strong> to create your patient account, verify your email, provide appointments/prescriptions/billing, and keep the service secure. We do not sell personal data and do not use it for advertising.</p>` +
  `<p><strong>Sharing:</strong> data is stored in our database and shared only with your treating clinic staff and service providers strictly needed to run the service (hosting, database, email delivery).</p>` +
  `<p><strong>Your rights:</strong> request access, correction or deletion of your account data at any time via the contact email below.</p>` +
  `<p><strong>Data retention:</strong> account data is kept while your account is active and as required for medical record-keeping; contact us for deletion requests.</p>`)));

app.get('/terms', (_req, res) => res.type('html').send(page('Terms of service',
  `<p>Last updated: October 2026.</p>` +
  `<p><strong>Service:</strong> the Hepziba Chest Clinic app helps patients manage appointments, prescriptions and billing with their clinic. It is not an emergency service — in an emergency, call your local emergency number.</p>` +
  `<p><strong>Acceptable use:</strong> provide accurate information, keep your login secret, and do not misuse or attempt to disrupt the service.</p>` +
  `<p><strong>Medical disclaimer:</strong> content in the app is for care coordination and does not replace professional medical advice, diagnosis or treatment.</p>` +
  `<p><strong>Availability:</strong> the service is provided as-is; we may update or suspend features for maintenance or security.</p>` +
  `<p><strong>Termination:</strong> you may stop using the service anytime; we may suspend accounts for misuse or security reasons.</p>`)));

// Centralized Error Handling MUST be last
app.use(errorHandler);

module.exports = app;
