const nodemailer = require('nodemailer');

const RESEND_API_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 15000;

// Sender resolution for the Resend path: RESEND_FROM wins so the 4-step
// setup works out of the box (FROM_EMAIL is typically an unverified
// placeholder like no-reply@example.com which Resend would reject).
// NOTE: onboarding@resend.dev only delivers to the address used to sign
// up for Resend. For production, verify your own domain in Resend and set
// RESEND_FROM (e.g. "Hepziba <no-reply@yourdomain.com>").
function resolveResendFrom(explicitFrom) {
  return (
    process.env.RESEND_FROM ||
    explicitFrom ||
    process.env.FROM_EMAIL ||
    'onboarding@resend.dev'
  );
}

// ---- Tier 1: Resend HTTPS API (works where outbound SMTP is blocked) ----
async function sendViaResend({ to, from, subject, text, html }) {
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: resolveResendFrom(from),
        to,
        subject,
        html: html || undefined,
        text: text || undefined,
      }),
      signal: controller.signal,
    });

    const bodyText = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`Resend API error ${res.status}: ${bodyText.slice(0, 300)}`);
    }
    let data = null;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch (_) {
      data = { raw: bodyText };
    }
    console.log(`Email sent via Resend to ${Array.isArray(to) ? to.join(',') : to}${data && data.id ? ` (id ${data.id})` : ''}`);
    return data;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Resend API timed out after ${RESEND_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Tier 2: existing nodemailer SMTP path (kept as-is) ----
let smtpTransporter = null;
function getSmtpTransporter() {
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  }
  return smtpTransporter;
}

// ---- Tier 3: Ethereal dev fallback (port 465 SSL) ----
let etherealTransporterPromise = null;
function getEtherealTransporter() {
  if (!etherealTransporterPromise) {
    etherealTransporterPromise = (async () => {
      const testAccount = await nodemailer.createTestAccount();
      console.log('----------------------');
      console.log('Ethereal SMTP created for you!');
      console.log('SMTP_USER=' + testAccount.user);
      console.log('SMTP_PASS=' + testAccount.pass);
      console.log('Login Ethereal: https://ethereal.email/login/');
      console.log('----------------------');

      // Port 465 (implicit SSL) is less commonly filtered than 587 (STARTTLS).
      return nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: 465,
        secure: true,
        auth: { user: testAccount.user, pass: testAccount.pass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      });
    })();
  }
  return etherealTransporterPromise;
}

function logDevCode(to, subject, text) {
  if (process.env.NODE_ENV === 'production') return;
  const match = String(text || '').match(/\b\d{4,8}\b/);
  if (match) {
    console.log(`[dev] email code for ${to}: ${match[0]} (valid 15 min)`);
  }
}

module.exports = {
  /**
   * Same signature as before so controllers are untouched:
   * sendMail({ to, from, subject, text, html }).
   *
   * Priority:
   *  1. RESEND_API_KEY set -> Resend HTTPS API (port-443 friendly).
   *  2. SMTP_USER/SMTP_PASS set -> nodemailer SMTP.
   *  3. Ethereal dev fallback (+ dev console.log of the OTP code).
   */
  sendMail: async (options) => {
    const { to, from, subject, text, html } = options || {};

    // Tier 1: Resend HTTPS.
    if ((process.env.RESEND_API_KEY || '').trim()) {
      return sendViaResend({ to, from, subject, text, html });
    }

    const defaultFrom = process.env.FROM_EMAIL;

    // Tier 2: configured SMTP.
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      const transporter = getSmtpTransporter();
      const info = await transporter.sendMail({
        to,
        from: from || defaultFrom,
        subject,
        text,
        html,
      });
      logDevCode(to, subject, text);
      return info;
    }

    // Tier 3: Ethereal dev fallback.
    const transporter = await getEtherealTransporter();
    try {
      const info = await transporter.sendMail({
        to,
        from: from || defaultFrom,
        subject,
        text,
        html,
      });
      if (nodemailer.getTestMessageUrl) {
        console.log('\n--- Ethereal preview: ' + nodemailer.getTestMessageUrl(info));
      }
      logDevCode(to, subject, text);
      return info;
    } catch (err) {
      // Dev networks often block outbound SMTP entirely. Log the body so
      // local testing can continue offline, then rethrow so the controller
      // returns its standard mailSent:false / dev-code response.
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[dev] Ethereal send failed (${err && err.message}). Email to ${to} subject "${subject}":\n${text || ''}`);
        logDevCode(to, subject, text);
      }
      throw err;
    }
  },
};
