// Expo push notifications (best-effort: failures never break the API call).
const pool = require('../db');

function isExpoPushToken(token) {
  if (typeof token !== 'string') return false;
  return (
    /^ExponentPushToken\[[^\]]+\]$/.test(token) ||
    /^ExpoPushToken\[[^\]]+\]$/.test(token) ||
    /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(token)
  );
}

// Device tokens belong to a user account, not to a patient record.
//
// `patient_push_tokens.user_id` references `users(id)` (008 + 009). Earlier
// versions of this helper also matched the value against `patients.id` and
// `patients.user_id`, which is a cross-account leak: `users.id` and
// `patients.id` are independent sequences, so a walk-in patient (no user
// account) or a deleted account shifts them apart and a patient id collides
// with an unrelated user id. That delivered one patient's appointment
// notification to another patient's phone. Recipient selection must be an
// exact users.id match.
//
// Inactive rows are skipped so a token revoked on logout/account switch (or
// reported as DeviceNotRegistered) never receives another user's message.
// A missing column (pre-009 schema) makes this fail closed: no send rather
// than a broadcast to the wrong devices.
async function tokensForUser(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) return [];
  try {
    const r = await pool.query(
      `SELECT DISTINCT token FROM patient_push_tokens
       WHERE user_id = $1
         AND is_active IS TRUE
         AND token IS NOT NULL`,
      [id]
    );
    return r.rows.map((x) => x.token).filter(Boolean);
  } catch (e) {
    console.error('push tokensForUser error:', e.message);
    return [];
  }
}

async function sendPush(tokens, title, body, data = {}) {
  const tokenList = (Array.isArray(tokens) ? tokens : [tokens]).filter(isExpoPushToken);
  if (!tokenList.length) {
    console.log('push: no valid tokens to send to');
    return { ok: false, error: 'No valid tokens provided', tokens: [] };
  }
  const messages = tokenList.map((to) => ({
    to,
    sound: 'default',
    title,
    body,
    channelId: 'default',
    priority: 'high',
    data,
    _displayInForeground: true,
  }));
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
      console.error('push send failed:', res.status, text);
    } else {
      console.log('push send ok:', text);
      if (payload && Array.isArray(payload.data)) {
        payload.data.forEach((ticket, idx) => {
          if (ticket.status === 'error') {
            console.error('push ticket error:', ticket.message, ticket.details);
            if (ticket.details && ticket.details.error === 'DeviceNotRegistered') {
              pool.query('DELETE FROM patient_push_tokens WHERE token=$1', [tokenList[idx]]).catch(() => {});
            }
          }
        });
      }
    }
    return { ok: res.ok, status: res.status, raw: text, payload };
  } catch (e) {
    console.error('push send error:', e.message);
    return { ok: false, error: e.message };
  }
}

// Notify the patient that owns an appointment.
//
// The owner is resolved only through `appointments.patient_id -> patients.id ->
// patients.user_id`. There is no fallback to `appointments.patient_id` as a
// user id: that value is a patients.id and can equal an unrelated users.id,
// which would send the notification to a different patient.
async function notifyAppointmentOwner(appointmentId, title, body, data = {}) {
  const id = Number(appointmentId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, reason: 'Invalid appointment id', appointmentId };
  }
  try {
    const r = await pool.query(
      `SELECT p.user_id AS user_id
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       WHERE a.id = $1`,
      [id]
    );
    if (!r.rows.length || !r.rows[0].user_id) {
      console.log('push: no patient user found for appointment', id);
      return { ok: false, reason: 'Appointment owner not found', appointmentId: id };
    }
    const userId = r.rows[0].user_id;
    const tokens = await tokensForUser(userId);
    if (!tokens.length) {
      console.log('push: no push tokens found for user', userId);
      return { ok: false, reason: 'No push tokens found for user', userId, appointmentId: id };
    }
    // Payload carries only the opaque appointment id; the app fetches the
    // record after its own authorization check.
    const sendRes = await sendPush(tokens, title, body, { appointmentId: id, ...data });
    return { ok: true, userId, tokens, sendResult: sendRes };
  } catch (e) {
    console.error('notify failed:', e.message);
    return { ok: false, error: e.message, appointmentId: id };
  }
}

// Notify a single account (patient, doctor or admin). Recipient selection is
// the same exact users.id match as tokensForUser, so a caller can never widen
// it with a client-supplied id.
async function notifyUser(userId, title, body, data = {}) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, reason: 'Invalid user id', userId };
  }
  const tokens = await tokensForUser(id);
  if (!tokens.length) {
    console.log('push: no push tokens found for user', id);
    return { ok: false, reason: 'No push tokens found for user', userId: id };
  }
  const sendResult = await sendPush(tokens, title, body, data);
  return { ok: true, userId: id, tokens, sendResult };
}

// Notify every active admin account that has a registered device. Admins are
// resolved from the users table (role + active), never from a request field.
async function tokensForAdmins() {
  try {
    const r = await pool.query(
      `SELECT DISTINCT t.token
         FROM patient_push_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE u.role = 'admin'
          AND COALESCE(u.active, TRUE) = TRUE
          AND t.is_active IS TRUE
          AND t.token IS NOT NULL`
    );
    return r.rows.map((x) => x.token).filter(Boolean);
  } catch (e) {
    console.error('push tokensForAdmins error:', e.message);
    return [];
  }
}

async function notifyAdmins(title, body, data = {}) {
  const tokens = await tokensForAdmins();
  if (!tokens.length) {
    console.log('push: no admin devices registered');
    return { ok: false, reason: 'No admin push tokens found', tokens: [] };
  }
  const sendResult = await sendPush(tokens, title, body, data);
  return { ok: true, tokens, sendResult };
}

// Booking: notify the patient who owns the new appointment and the assigned
// doctor. Both sides are resolved from persisted relationships. The payload
// carries only the opaque appointment id (no name, contact, or clinical data).
async function notifyAppointmentBooked(appointment) {
  const appointmentId = Number(appointment && appointment.id);
  if (!Number.isInteger(appointmentId) || appointmentId < 1) {
    return { ok: false, reason: 'Invalid appointment id' };
  }
  const data = { appointmentId };
  const results = { patient: null, doctor: null };
  try {
    const pQ = await pool.query('SELECT user_id FROM patients WHERE id=$1', [appointment.patient_id]);
    const patientUserId = pQ.rows[0] ? pQ.rows[0].user_id : null;
    if (patientUserId) {
      results.patient = await notifyUser(
        patientUserId,
        'Appointment booked',
        'Your appointment has been booked. Open the app to view the details.',
        data
      );
    }
  } catch (e) {
    results.patient = { ok: false, error: e.message };
  }
  try {
    const dQ = await pool.query('SELECT user_id FROM doctors WHERE id=$1', [appointment.doctor_id]);
    const doctorUserId = dQ.rows[0] ? dQ.rows[0].user_id : null;
    if (doctorUserId) {
      results.doctor = await notifyUser(
        doctorUserId,
        'New appointment',
        'A new appointment was booked. Open the app to view your schedule.',
        data
      );
    }
  } catch (e) {
    results.doctor = { ok: false, error: e.message };
  }
  return results;
}

// Invoice: notify the patient the invoice actually belongs to (resolved
// through invoices.patient_id -> patients.user_id). No amounts or line items.
async function notifyInvoiceOwner(invoiceId, title, body, data = {}) {
  const id = Number(invoiceId);
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, reason: 'Invalid invoice id', invoiceId };
  }
  try {
    const r = await pool.query(
      `SELECT p.user_id AS user_id
         FROM invoices inv
         JOIN patients p ON p.id = inv.patient_id
        WHERE inv.id = $1`,
      [id]
    );
    if (!r.rows.length || !r.rows[0].user_id) {
      console.log('push: no patient user found for invoice', id);
      return { ok: false, reason: 'Invoice owner not found', invoiceId: id };
    }
    return notifyUser(r.rows[0].user_id, title, body, { invoiceId: id, ...data });
  } catch (e) {
    console.error('invoice notify failed:', e.message);
    return { ok: false, error: e.message, invoiceId: id };
  }
}

module.exports = {
  tokensForUser,
  tokensForAdmins,
  sendPush,
  notifyUser,
  notifyAdmins,
  notifyAppointmentOwner,
  notifyAppointmentBooked,
  notifyInvoiceOwner,
  isExpoPushToken,
};
