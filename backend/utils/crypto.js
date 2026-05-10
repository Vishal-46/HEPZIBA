const bcrypt = require('bcrypt');

function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

function checkPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function generateCode(length = 6) {
  return Math.random().toString().substring(2, 2 + length);
}

module.exports = { hashPassword, checkPassword, generateCode };
