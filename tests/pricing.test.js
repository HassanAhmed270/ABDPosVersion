const test = require('node:test');
const assert = require('node:assert/strict');
const { getLatestSellingPrice, getLatestBuyingPrice } = require('../lib/pricing');

test('getLatestSellingPrice returns null (not 0) for missing/empty history', () => {
  assert.equal(getLatestSellingPrice({}), null);
  assert.equal(getLatestSellingPrice({ sellingPriceHistory: [] }), null);
  assert.equal(getLatestSellingPrice(null), null);
  assert.equal(getLatestSellingPrice(undefined), null);
});

test('getLatestSellingPrice returns null when the most recent entry was an explicit clear', () => {
  const product = {
    sellingPriceHistory: [
      { price: 100, date: '2026-01-01' },
      { price: null, date: '2026-02-01' }
    ]
  };
  assert.equal(getLatestSellingPrice(product), null);
});

test('getLatestSellingPrice returns the only entry for a single-entry history', () => {
  const product = { sellingPriceHistory: [{ price: 100, date: '2026-01-01' }] };
  assert.equal(getLatestSellingPrice(product), 100);
});

test('getLatestSellingPrice returns the most recent by date, not array order', () => {
  const product = {
    sellingPriceHistory: [
      { price: 100, date: '2026-01-01' },
      { price: 150, date: '2026-03-01' },
      { price: 120, date: '2026-02-01' }
    ]
  };
  assert.equal(getLatestSellingPrice(product), 150);
});

test('getLatestSellingPrice does not mutate the original history array order', () => {
  const history = [
    { price: 100, date: '2026-01-01' },
    { price: 150, date: '2026-03-01' }
  ];
  const product = { sellingPriceHistory: history };
  getLatestSellingPrice(product);
  assert.equal(history[0].price, 100);
  assert.equal(history[1].price, 150);
});

test('getLatestBuyingPrice returns 0 for missing/empty history', () => {
  assert.equal(getLatestBuyingPrice({}), 0);
  assert.equal(getLatestBuyingPrice({ buyingPriceHistory: [] }), 0);
});

test('getLatestBuyingPrice returns the most recent entry for a multi-entry history', () => {
  const product = {
    buyingPriceHistory: [
      { price: 50, date: '2026-02-01' },
      { price: 40, date: '2026-01-01' },
      { price: 60, date: '2026-03-15' }
    ]
  };
  assert.equal(getLatestBuyingPrice(product), 60);
});

test('selling and buying histories are independent', () => {
  const product = {
    sellingPriceHistory: [{ price: 200, date: '2026-01-01' }],
    buyingPriceHistory: [{ price: 90, date: '2026-01-01' }]
  };
  assert.equal(getLatestSellingPrice(product), 200);
  assert.equal(getLatestBuyingPrice(product), 90);
});
