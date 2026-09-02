const test = require('node:test');
const assert = require('node:assert/strict');
const { roundMoney } = require('../lib/money');

test('roundMoney rounds to 2dp', () => {
  assert.equal(roundMoney(1.005), 1.01);
  assert.equal(roundMoney(10.126), 10.13);
  assert.equal(roundMoney(10.124), 10.12);
});

test('roundMoney handles floating point drift', () => {
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(roundMoney(19.99 * 3), 59.97);
});

test('roundMoney handles negative values', () => {
  assert.equal(roundMoney(-10.005), -10.01);
  assert.equal(roundMoney(-1.005), -1);
  assert.equal(roundMoney(-2.5), -2.5);
});

test('roundMoney handles zero and integers', () => {
  assert.equal(roundMoney(0), 0);
  assert.equal(roundMoney(5), 5);
});

test('roundMoney handles non-numeric input', () => {
  assert.equal(roundMoney('abc'), 0);
  assert.equal(roundMoney(undefined), 0);
  assert.equal(roundMoney(null), 0);
  assert.equal(roundMoney({}), 0);
  assert.equal(roundMoney(NaN), 0);
});

test('roundMoney handles Infinity', () => {
  assert.equal(roundMoney(Infinity), 0);
  assert.equal(roundMoney(-Infinity), 0);
});

test('roundMoney parses numeric strings (parseFloat, not parseInt)', () => {
  assert.equal(roundMoney('19.99'), 19.99);
  assert.equal(roundMoney('19.99abc'), 19.99);
  assert.equal(roundMoney('abc'), 0);
});
