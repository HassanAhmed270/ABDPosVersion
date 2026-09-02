const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveCostSource } = require('../lib/costing');

// consumeFIFO() and restoreConsumption() query/update StockBatch inside a
// live Mongo session (replica-set transaction) and are not exercised here.
// deriveCostSource() is the one pure-math path in this module and is
// covered directly below.

test('deriveCostSource returns "unknown" when nothing was costed', () => {
  assert.equal(deriveCostSource(0, 5), 'unknown');
});

test('deriveCostSource returns "unknown" when quantity is zero or negative', () => {
  assert.equal(deriveCostSource(3, 0), 'unknown');
  assert.equal(deriveCostSource(3, -1), 'unknown');
});

test('deriveCostSource returns "batch" when the full quantity was costed', () => {
  assert.equal(deriveCostSource(5, 5), 'batch');
});

test('deriveCostSource returns "batch" when costQuantity exceeds quantity', () => {
  assert.equal(deriveCostSource(7, 5), 'batch');
});

test('deriveCostSource returns "partial" when only some of the quantity was costed', () => {
  assert.equal(deriveCostSource(2, 5), 'partial');
});

test('deriveCostSource returns "unknown" when costQuantity is negative', () => {
  assert.equal(deriveCostSource(-1, 5), 'unknown');
});
