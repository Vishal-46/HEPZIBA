const bcrypt = require('bcrypt');
const crypto = require('crypto');

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

function checkPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Secure 6-digit zero-padded code (e.g. "004217"). Uses crypto.randomInt,
// NOT Math.random. Generic length support retained for callers that need
// longer numeric strings.
function generateCode(length = 6) {
  if (!Number.isInteger(length) || length <= 0) length = 6;
  if (length === 6) {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  }
  let out = '';
  for (let i = 0; i < length; i++) out += String(crypto.randomInt(0, 10));
  return out;
}

// Random hex token for non-memorable secrets (e.g. throwaway passwords for
// OAuth-created accounts). Not a substitute for a reset-code flow.
function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { hashPassword, checkPassword, generateCode, generateSecureToken };
