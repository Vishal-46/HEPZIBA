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

async function tokensForUser(userId) {
  try {
    const r = await pool.query(
      `SELECT DISTINCT token FROM patient_push_tokens
       WHERE user_id = $1
          OR user_id IN (SELECT id FROM patients WHERE user_id = $1)
          OR user_id IN (SELECT user_id FROM patients WHERE id = $1)`,
      [userId]
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
    return;
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
    if (!res.ok) {
      console.error('push send failed:', res.status, text);
    } else {
      console.log('push send ok:', text);
      try {
        const payload = JSON.parse(text);
        if (payload && Array.isArray(payload.data)) {
          payload.data.forEach((ticket, idx) => {
            if (ticket.status === 'error') {
              console.error(`push ticket error for token ${tokenList[idx]}:`, ticket.message, ticket.details);
              if (ticket.details && ticket.details.error === 'DeviceNotRegistered') {
                pool.query('DELETE FROM patient_push_tokens WHERE token=$1', [tokenList[idx]]).catch(() => {});
              }
            }
          });
        }
      } catch (_) {}
    }
  } catch (e) {
    console.error('push send error:', e.message);
  }
}

// Notify the patient that owns an appointment. Fire-and-forget.
async function notifyAppointmentOwner(appointmentId, title, body) {
  try {
    console.log(`push: lookup owner for appointment ${appointmentId}...`);
    const r = await pool.query(
      `SELECT COALESCE(p.user_id, p_by_user.user_id, a.patient_id) AS user_id
       FROM appointments a
       LEFT JOIN patients p ON p.id = a.patient_id
       LEFT JOIN patients p_by_user ON p_by_user.user_id = a.patient_id
       WHERE a.id = $1`,
      [appointmentId]
    );
    if (!r.rows.length || !r.rows[0].user_id) {
      console.log('push: no patient user found for appointment', appointmentId);
      return;
    }
    const userId = r.rows[0].user_id;
    const tokens = await tokensForUser(userId);
    if (!tokens.length) {
      console.log('push: no push tokens found for user', userId);
      return;
    }
    console.log(`push: sending notification to user ${userId} (${tokens.length} token(s)). Title: "${title}"`);
    await sendPush(tokens, title, body, { appointmentId });
  } catch (e) {
    console.error('notify failed:', e.message);
  }
}

module.exports = { tokensForUser, sendPush, notifyAppointmentOwner, isExpoPushToken };
