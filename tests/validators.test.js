const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidEmail,
  isValidPhone,
  isValidProductId,
  isValidOrderId,
  isValidDiscount,
  isPositiveInt
} = require('../lib/validators');

test('isValidEmail accepts empty/absent values', () => {
  assert.equal(isValidEmail(''), true);
  assert.equal(isValidEmail(undefined), true);
  assert.equal(isValidEmail(null), true);
});

test('isValidEmail accepts well-formed addresses', () => {
  assert.equal(isValidEmail('user@example.com'), true);
  assert.equal(isValidEmail('  user@example.com  '), true);
});

test('isValidEmail rejects malformed addresses', () => {
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidEmail('user@'), false);
  assert.equal(isValidEmail('@example.com'), false);
  assert.equal(isValidEmail('user example.com'), false);
});

test('isValidPhone accepts empty/absent values', () => {
  assert.equal(isValidPhone(''), true);
  assert.equal(isValidPhone(undefined), true);
  assert.equal(isValidPhone(null), true);
});

test('isValidPhone accepts plausible numbers', () => {
  assert.equal(isValidPhone('0300-1234567'), true);
  assert.equal(isValidPhone('+92 300 1234567'), true);
  assert.equal(isValidPhone('(021) 111222'), true);
});

test('isValidPhone rejects obvious junk', () => {
  assert.equal(isValidPhone('abc'), false);
  assert.equal(isValidPhone('123'), false);
  assert.equal(isValidPhone('1'.repeat(21)), false);
});

test('isValidProductId accepts the #0000 format', () => {
  assert.equal(isValidProductId('#0001'), true);
  assert.equal(isValidProductId('#9999'), true);
});

test('isValidProductId rejects malformed ids', () => {
  assert.equal(isValidProductId('0001'), false);
  assert.equal(isValidProductId('#001'), false);
  assert.equal(isValidProductId('#00011'), false);
  assert.equal(isValidProductId(''), false);
  assert.equal(isValidProductId(undefined), false);
  assert.equal(isValidProductId(1), false);
});

test('isValidOrderId accepts the #0000 format', () => {
  assert.equal(isValidOrderId('#1234'), true);
});

test('isValidOrderId rejects malformed ids', () => {
  assert.equal(isValidOrderId('1234'), false);
  assert.equal(isValidOrderId('#abcd'), false);
  assert.equal(isValidOrderId(null), false);
});

test('isValidDiscount accepts 0-100 inclusive', () => {
  assert.equal(isValidDiscount(0), true);
  assert.equal(isValidDiscount(100), true);
  assert.equal(isValidDiscount(50.5), true);
  assert.equal(isValidDiscount('25'), true);
});

test('isValidDiscount rejects out-of-range or non-numeric values', () => {
  assert.equal(isValidDiscount(-1), false);
  assert.equal(isValidDiscount(101), false);
  assert.equal(isValidDiscount('abc'), false);
  assert.equal(isValidDiscount(undefined), false);
  assert.equal(isValidDiscount(NaN), false);
});

test('isPositiveInt accepts positive integers, including numeric strings', () => {
  assert.equal(isPositiveInt(1), true);
  assert.equal(isPositiveInt(100), true);
  assert.equal(isPositiveInt('5'), true);
});

test('isPositiveInt rejects zero, negatives, floats, and junk', () => {
  assert.equal(isPositiveInt(0), false);
  assert.equal(isPositiveInt(-5), false);
  assert.equal(isPositiveInt(1.5), false);
  assert.equal(isPositiveInt('abc'), false);
  assert.equal(isPositiveInt(undefined), false);
});
