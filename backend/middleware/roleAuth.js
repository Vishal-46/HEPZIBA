// RBAC Middleware to secure endpoints by user role
const jwt = require('jsonwebtoken');
const pool = require('../db');

// Usage: roleAuth('admin'), roleAuth(['admin','doctor'])
function roleAuth(roles) {
  if (!Array.isArray(roles)) roles = [roles];

  return async (req, res, next) => {
    // Fail closed when the signing secret is not configured — never verify
    // tokens against an undefined secret.
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error('roleAuth: JWT_SECRET is not configured');
      return res.status(500).json({ error: 'Server misconfiguration.' });
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || !/^Bearer$/i.test(parts[0]) || !parts[1]) {
      return res.status(401).json({ error: 'Malformed Authorization header' });
    }

    let decoded;
    try {
      decoded = jwt.verify(parts[1], secret);
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
    // Server-side logout kill-switch: a logged-out access jti stays rejected
    // until its exp, even though the JWT signature is still technically valid.
    if (decoded && decoded.jti) {
      try {
        const { isAccessRevoked } = require('../auth/sessionTokens');
        if (await isAccessRevoked(decoded.jti)) {
          return res.status(401).json({ error: 'Session expired. Please sign in again.' });
        }
      } catch (e) {
        console.error('roleAuth denylist check failed:', e.message);
        return res.status(500).json({ error: 'Authorization check failed.' });
      }
    }
    if (!decoded || !roles.includes(decoded.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }

    // Re-check the live user row: a token issued before deactivation or a
    // role change must not keep working. Fail closed on DB errors.
    try {
      const q = await pool.query('SELECT id, email, role, active FROM users WHERE id=$1', [decoded.id]);
      if (q.rows.length === 0) return res.status(401).json({ error: 'Invalid token' });
      const fresh = q.rows[0];
      if (fresh.active === false) return res.status(401).json({ error: 'Account deactivated.' });
      if (!roles.includes(fresh.role)) return res.status(403).json({ error: 'Forbidden: insufficient role' });
      req.user = { id: fresh.id, email: fresh.email, role: fresh.role };
      return next();
    } catch (e) {
      console.error('roleAuth DB check failed:', e.message);
      return res.status(500).json({ error: 'Authorization check failed.' });
    }
  };
}

module.exports = roleAuth;
