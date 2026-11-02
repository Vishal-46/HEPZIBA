'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { moneyToCents } = require('../utils/money');

test('parses whole rupees', () => {
  assert.equal(moneyToCents('12'), 1200);
  assert.equal(moneyToCents(12), 1200);
  assert.equal(moneyToCents('0'), 0);
});

test('parses one and two decimal places without float drift', () => {
  assert.equal(moneyToCents('19.99'), 1999);
  assert.equal(moneyToCents('0.1'), 10);
  assert.equal(moneyToCents('0.01'), 1);
  assert.equal(moneyToCents('1234.5'), 123450);
  assert.equal(moneyToCents(' 7.25 '), 725);
});

test('treats blank input as zero', () => {
  assert.equal(moneyToCents(''), 0);
  assert.equal(moneyToCents(null), 0);
  assert.equal(moneyToCents(undefined), 0);
});

test('returns NaN for invalid money strings', () => {
  assert.ok(Number.isNaN(moneyToCents('abc')));
  assert.ok(Number.isNaN(moneyToCents('1.999')));
  assert.ok(Number.isNaN(moneyToCents('-5')));
  assert.ok(Number.isNaN(moneyToCents('1,000')));
  assert.ok(Number.isNaN(moneyToCents('.5')));
});
