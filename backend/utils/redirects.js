// Allow-list for the mobile deep link that receives the OAuth session.
// Only our own scheme (plus explicit operator allow-list entries) is accepted
// in production. Expo Go / LAN HTTP redirects are development-only: leaving
// them enabled in production lets an attacker redirect a freshly issued JWT
// (and refresh token) to a host they control.
function isAllowedMobileRedirect(url, options = {}) {
  if (!url || typeof url !== 'string') return false;
  const value = url.trim();
  if (!value) return false;

  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const rawAllowlist = options.allowlist ?? process.env.MOBILE_REDIRECT_ALLOWLIST ?? '';
  const allowlist = String(rawAllowlist)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (allowlist.some((prefix) => value.startsWith(prefix))) return true;
  if (value.startsWith('patient-mobile://')) return true;

  // Dev conveniences must not be available in production.
  if (nodeEnv === 'production') return false;

  return (
    value.startsWith('exp://') ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(value) ||
    /^http:\/\/(192\.168\.|10\.)/.test(value)
  );
}

module.exports = { isAllowedMobileRedirect };
