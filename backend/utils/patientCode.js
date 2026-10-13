const crypto = require('crypto');

// Crockford base32 without visually confusing chars (no 0/O, 1/I, L).
// 32 symbols => 6 chars give 32^6 (~1B) combinations.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const PREFIX = 'HEP-';

// Non-sequential, non-guessable patient code, e.g. HEP-7KQ2XD.
// Takes no input: codes must not encode the user id or leak patient count.
// Existing issued codes (e.g. legacy HEP-00001) stay valid — they are simply
// never re-issued because uniqueness is checked against the DB.
function generatePatientCode() {
  let suffix = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    suffix += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  }
  return PREFIX + suffix;
}

// Generate a candidate and confirm it is unused in patients(patient_code).
// queryFn(sql, params) must behave like pg client/pool.query (resolves to
// { rows } or { rowCount }). Throws after maxAttempts collisions — callers
// should treat this as a 500 (it means the code space is exhausted or the
// DB is unreachable), NOT as a duplicate-email 400.
async function generateUniquePatientCode(queryFn, maxAttempts = 5) {
  if (typeof queryFn !== 'function') {
    throw new TypeError('generateUniquePatientCode requires a queryFn(sql, params)');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
    throw new TypeError('maxAttempts must be a positive integer');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const candidate = generatePatientCode();
    const res = await queryFn('SELECT 1 FROM patients WHERE patient_code=$1', [candidate]);
    const exists = res && Array.isArray(res.rows) ? res.rows.length > 0 : res && res.rowCount > 0;
    if (!exists) return candidate;
  }
  throw new Error(`Failed to generate a unique patient code after ${maxAttempts} attempts`);
}

module.exports = { generatePatientCode, generateUniquePatientCode };
