// RBAC Middleware to secure endpoints by user role
const jwt = require('jsonwebtoken');

// Usage: roleAuth('admin'), roleAuth(['admin','doctor'])
function roleAuth(roles) {
  if (!Array.isArray(roles)) roles = [roles];

  return (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Missing Authorization header' });
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Malformed Authorization header' });

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err || !decoded) return res.status(401).json({ error: 'Invalid token' });
      if (!roles.includes(decoded.role)) return res.status(403).json({ error: 'Forbidden: insufficient role' });
      // Attach user info from token if needed
      req.user = decoded;
      return next();
    });
  };
}

module.exports = roleAuth;
