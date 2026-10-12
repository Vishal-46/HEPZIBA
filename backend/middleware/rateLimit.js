// Lightweight, configurable rate limiters for auth endpoints.
// Env-overridable so tests/local dev can relax them without code changes.
// express-rate-limit v8 uses `limit` (not `max`).
const rateLimit = require('express-rate-limit');

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const WINDOW_15_MIN = 15 * 60 * 1000;

function makeLimiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: message },
  });
}

// Brute-force protection for credentialed login (password + Google).
const loginLimiter = makeLimiter({
  windowMs: num('AUTH_LOGIN_WINDOW_MS', WINDOW_15_MIN),
  limit: num('AUTH_LOGIN_MAX', 50),
  message: 'Too many login attempts, please try again later.',
});

// Stricter: forgot-password triggers outbound email (abuse/mailing cost).
const forgotLimiter = makeLimiter({
  windowMs: num('AUTH_FORGOT_WINDOW_MS', WINDOW_15_MIN),
  limit: num('AUTH_FORGOT_MAX', 10),
  message: 'Too many reset requests, please try again later.',
});

// Code-guessing protection on the reset-confirm step.
const resetLimiter = makeLimiter({
  windowMs: num('AUTH_RESET_WINDOW_MS', WINDOW_15_MIN),
  limit: num('AUTH_RESET_MAX', 20),
  message: 'Too many reset attempts, please try again later.',
});

module.exports = { loginLimiter, forgotLimiter, resetLimiter };
