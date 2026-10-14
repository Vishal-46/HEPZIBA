// Refresh-token rotation + access-token denylist (server-side logout).
// Stateless-server safe: all state lives in Postgres, so Vercel lambdas share it.
//
// Flow:
// - login / google login issue { access (15m JWT with jti), refresh (30d opaque) }.
// - POST /auth/refresh rotates: old hash revoked, new pair issued. Reuse of a
//   rotated-out token = suspected theft -> whole refresh family revoked.
// - POST /auth/logout revokes the refresh token AND denylists the access jti
//   until its exp, so logout kills the JWT immediately instead of at expiry.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 30);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function newOpaqueToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function signAccessToken(user) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email, jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL },
  );
}

function decodeAccessExp(token) {
  try {
    const payload = jwt.decode(token);
    if (payload && typeof payload.exp === 'number') return new Date(payload.exp * 1000);
  } catch {
    // ignore — caller falls back to a short TTL
  }
  return new Date(Date.now() + 15 * 60 * 1000);
}

async function issueSession(userRow, meta = {}) {
  const user = { id: userRow.id, name: userRow.name, email: userRow.email, role: userRow.role };
  const token = signAccessToken(user);
  const refreshToken = newOpaqueToken();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [user.id, sha256Hex(refreshToken), expiresAt, meta.userAgent || null, meta.ip || null],
  );
  return { token, refreshToken, refreshExpiresAt: expiresAt.toISOString(), user };
}

async function revokeRefreshFamily(userId) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

async function rotateRefreshToken(rawRefresh, meta = {}) {
  const hash = sha256Hex(rawRefresh);
  const found = await pool.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [hash]);
  if (!found.rows.length) {
    const err = new Error('Invalid refresh token.');
    err.status = 401;
    throw err;
  }
  const row = found.rows[0];
  if (row.revoked_at) {
    // Reuse of an already-rotated token: possible theft -> kill the family.
    if (row.replaced_by_hash) await revokeRefreshFamily(row.user_id);
    const err = new Error('Refresh token already used.');
    err.status = 401;
    throw err;
  }
  if (new Date(row.expires_at) < new Date()) {
    await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash]);
    const err = new Error('Refresh token expired.');
    err.status = 401;
    throw err;
  }
  const userRes = await pool.query('SELECT id, name, email, role, active FROM users WHERE id = $1', [row.user_id]);
  if (!userRes.rows.length || userRes.rows[0].active === false) {
    await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash]);
    const err = new Error('Account no longer available.');
    err.status = 401;
    throw err;
  }
  const user = userRes.rows[0];
  const next = await issueSession(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    meta,
  );
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by_hash = $2
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hash, sha256Hex(next.refreshToken)],
  );
  return next;
}

async function revokeRefreshToken(rawRefresh) {
  if (!rawRefresh) return false;
  const res = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [sha256Hex(rawRefresh)],
  );
  return res.rowCount > 0;
}

async function revokeAllUserRefreshTokens(userId) {
  await revokeRefreshFamily(userId);
}

async function denylistAccessToken(token) {
  try {
    const payload = jwt.decode(token);
    if (!payload || !payload.jti) return false;
    await pool.query(
      `INSERT INTO revoked_access_tokens (jti, user_id, expires_at)
       VALUES ($1, $2, $3) ON CONFLICT (jti) DO NOTHING`,
      [payload.jti, payload.id || null, decodeAccessExp(token)],
    );
    return true;
  } catch {
    return false;
  }
}

async function isAccessRevoked(jti) {
  if (!jti) return false;
  const res = await pool.query(
    `SELECT 1 FROM revoked_access_tokens WHERE jti = $1 AND expires_at > NOW()`,
    [jti],
  );
  return res.rowCount > 0;
}

function requestMeta(req) {
  return {
    userAgent: (req.headers['user-agent'] || '').slice(0, 300),
    ip: (req.ip || req.headers['x-forwarded-for'] || '').toString().slice(0, 100),
  };
}

module.exports = {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_DAYS,
  sha256Hex,
  signAccessToken,
  issueSession,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserRefreshTokens,
  denylistAccessToken,
  isAccessRevoked,
  requestMeta,
};
