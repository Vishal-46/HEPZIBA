// Central PII masking for API responses.
//
// Aadhaar and mobile numbers are stored in full (billing, identity checks and
// the owner's profile editor need them), but they must never be returned in
// full by default. Every serializer that emits these fields goes through the
// helpers below so the format stays identical across the API.
//
// Format:
//   Aadhaar  "1234 5678 9012" -> "XXXX-XXXX-9012"  (last 4 digits only)
//   Mobile   "9876543210"     -> "XXXXXX3210"      (last 4 digits only)
//
// Values that are null/undefined stay null/undefined. Short or malformed
// values never leak digits: anything with four or fewer digits is masked
// completely.
//
// Disclosure exception (`?reveal=contact`):
//   * admin  - staff directory/chart/billing/queue endpoints (the edit form and
//              printed invoices need the original values);
//   * doctor - only the caller's own appointment lists, which are already
//              scoped to appointments assigned to that doctor;
//   * patient- only `/patients/me` (the owner's own profile editor).
// The check is server-side and role-based; a frontend role check is never the
// authorization boundary.

const MASKED_AADHAAR = 'XXXX-XXXX-XXXX';

function digitsOf(value) {
  return String(value).replace(/\D/g, '');
}

/** Mask an Aadhaar number, keeping only the last four digits. */
function maskAadhaar(value) {
  if (value === undefined || value === null) return value;
  const raw = String(value).trim();
  if (!raw) return raw;
  const digits = digitsOf(raw);
  if (digits.length <= 4) return MASKED_AADHAAR;
  return `XXXX-XXXX-${digits.slice(-4)}`;
}

/** Mask a mobile number, keeping only the last four digits. */
function maskMobile(value) {
  if (value === undefined || value === null) return value;
  const raw = String(value).trim();
  if (!raw) return raw;
  const digits = digitsOf(raw);
  if (!digits) return 'X'.repeat(raw.length);
  if (digits.length <= 4) return 'X'.repeat(digits.length);
  return `${'X'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

const AADHAAR_KEYS = ['aadhar_number', 'aadhaar_number', 'patient_aadhar'];
const MOBILE_KEYS = ['mobile', 'patient_mobile', 'phone'];

/**
 * Mask a patient-like record in place-free fashion. Only known contact keys
 * are touched, so unrelated fields (ids, statuses, money) are unaffected.
 */
function maskPatientContact(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const out = { ...record };
  for (const key of AADHAAR_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = maskAadhaar(out[key]);
  }
  for (const key of MOBILE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = maskMobile(out[key]);
  }
  return out;
}

function maskPatientContacts(rows) {
  if (Array.isArray(rows)) return rows.map(maskPatientContact);
  return maskPatientContact(rows);
}

/** True when the caller explicitly asked for original contact values. */
function contactRevealRequested(req) {
  const raw = req && req.query ? req.query.reveal : undefined;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'contact';
}

/**
 * Server-side disclosure check: the request must carry `reveal=contact` AND
 * the authenticated role must be in the allowlist for that endpoint.
 */
function shouldRevealContact(req, allowedRoles) {
  if (!contactRevealRequested(req)) return false;
  const role = req && req.user ? req.user.role : null;
  return Boolean(role) && Array.isArray(allowedRoles) && allowedRoles.includes(role);
}

module.exports = {
  MASKED_AADHAAR,
  maskAadhaar,
  maskMobile,
  maskPatientContact,
  maskPatientContacts,
  contactRevealRequested,
  shouldRevealContact,
};
