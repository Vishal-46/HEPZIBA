function generatePatientCode(userId) {
  const padded = String(userId).padStart(5, '0');
  return `HEP-${padded}`;
}

module.exports = { generatePatientCode };
