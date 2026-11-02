'use strict';

// Policy B: Aadhaar/mobile masking is a server-side serialization rule.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MASKED_AADHAAR,
  maskAadhaar,
  maskMobile,
  maskPatientContact,
  maskPatientContacts,
  shouldRevealContact,
  contactRevealRequested,
} = require('../utils/pii');

test('maskAadhaar keeps only the last four digits in a stable format', () => {
  assert.equal(maskAadhaar('123456789012'), 'XXXX-XXXX-9012');
  assert.equal(maskAadhaar('1234 5678 9012'), 'XXXX-XXXX-9012');
  assert.equal(maskAadhaar('1234-5678-9012'), 'XXXX-XXXX-9012');
});

test('maskAadhaar handles null, empty, short and malformed values safely', () => {
  assert.equal(maskAadhaar(null), null);
  assert.equal(maskAadhaar(undefined), undefined);
  assert.equal(maskAadhaar(''), '');
  assert.equal(maskAadhaar('   '), '');
  assert.equal(maskAadhaar('1234'), MASKED_AADHAAR, 'four digits must not be exposed');
  assert.equal(maskAadhaar('12'), MASKED_AADHAAR);
  assert.equal(maskAadhaar('not-a-number'), MASKED_AADHAAR);
});

test('maskMobile keeps only the last four digits', () => {
  assert.equal(maskMobile('9876543210'), 'XXXXXX3210');
  assert.equal(maskMobile('+91 98765 43210'), 'XXXXXXXX3210');
  assert.equal(maskMobile('98765'), 'X8765');
});

test('maskMobile handles null, empty, short and malformed values safely', () => {
  assert.equal(maskMobile(null), null);
  assert.equal(maskMobile(undefined), undefined);
  assert.equal(maskMobile(''), '');
  assert.equal(maskMobile('1234'), 'XXXX');
  assert.equal(maskMobile('12'), 'XX');
  assert.equal(maskMobile('abc'), 'XXX', 'malformed values must not leak the input');
});

test('maskPatientContact masks known contact keys and leaves other fields intact', () => {
  const row = {
    id: 7,
    patient_code: 'HEP-A0001',
    name: 'Synthetic Patient',
    mobile: '9000000001',
    aadhar_number: '111122223333',
    patient_mobile: '9000000002',
    patient_aadhar: '444455556666',
    phone: '9000000003',
    total_amount: '125.00',
  };
  const masked = maskPatientContact(row);
  assert.equal(masked.mobile, 'XXXXXX0001');
  assert.equal(masked.aadhar_number, 'XXXX-XXXX-3333');
  assert.equal(masked.patient_mobile, 'XXXXXX0002');
  assert.equal(masked.patient_aadhar, 'XXXX-XXXX-6666');
  assert.equal(masked.phone, 'XXXXXX0003');
  assert.equal(masked.id, 7);
  assert.equal(masked.patient_code, 'HEP-A0001');
  assert.equal(masked.name, 'Synthetic Patient');
  assert.equal(masked.total_amount, '125.00');
  // The input object is never mutated.
  assert.equal(row.mobile, '9000000001');
});

test('maskPatientContacts handles arrays, null and primitives', () => {
  assert.deepEqual(maskPatientContacts([]), []);
  assert.equal(maskPatientContacts(null), null);
  assert.equal(maskPatientContact('not-an-object'), 'not-an-object');
  const rows = maskPatientContacts([{ mobile: '9000000001' }, { mobile: null }]);
  assert.equal(rows[0].mobile, 'XXXXXX0001');
  assert.equal(rows[1].mobile, null);
});

test('reveal requires the query flag AND an allowed server-side role', () => {
  const req = (role, query) => ({ user: role ? { role } : undefined, query });
  assert.equal(contactRevealRequested(req('admin', { reveal: 'contact' })), true);
  assert.equal(contactRevealRequested(req('admin', { reveal: 'CONTACT' })), true);
  assert.equal(contactRevealRequested(req('admin', {})), false);

  assert.equal(shouldRevealContact(req('admin', { reveal: 'contact' }), ['admin']), true);
  assert.equal(shouldRevealContact(req('doctor', { reveal: 'contact' }), ['admin']), false);
  assert.equal(shouldRevealContact(req('patient', { reveal: 'contact' }), ['admin']), false);
  assert.equal(shouldRevealContact(req(null, { reveal: 'contact' }), ['admin']), false);
  assert.equal(shouldRevealContact(req('admin', {}), ['admin']), false);
  assert.equal(shouldRevealContact(req('doctor', { reveal: 'contact' }), ['doctor']), true);
});
