// Expo push notifications (best-effort: failures never break the API call).
const pool = require('../db');

async function tokensForUser(userId) {
  try {
    const r = await pool.query('SELECT token FROM patient_push_tokens WHERE user_id=$1', [userId]);
    return r.rows.map((x) => x.token).filter(Boolean);
  } catch {
    return [];
  }
}

async function sendPush(tokens, title, body, data = {}) {
  if (!tokens.length) return;
  const messages = tokens.map((to) => ({ to, sound: 'default', title, body, data }));
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!res.ok) console.error('push send failed:', res.status);
  } catch (e) {
    console.error('push send error:', e.message);
  }
}

// Notify the patient that owns an appointment. Fire-and-forget.
async function notifyAppointmentOwner(appointmentId, title, body) {
  try {
    const r = await pool.query(
      `SELECT p.user_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id=$1`,
      [appointmentId]
    );
    if (!r.rows.length || !r.rows[0].user_id) return;
    const tokens = await tokensForUser(r.rows[0].user_id);
    await sendPush(tokens, title, body, { appointmentId });
  } catch (e) {
    console.error('notify failed:', e.message);
  }
}

module.exports = { tokensForUser, sendPush, notifyAppointmentOwner };
