const test = require('node:test');
const assert = require('node:assert/strict');
const { roundMoney } = require('../lib/money');

// The functions under test here (recomputeOrderTotals, the checkout
// per-line amount/discountAmount calc, and applyLineReduction's
// proportional-reduction math) are not exported from main.js — they are
// local functions inside routes/handlers, some of which also touch the DB
// (Product.findOneAndUpdate, restoreConsumption) inside a transaction
// session. Stage 1's scope is "new tests/, package.json only — no
// production code logic changes," so main.js is not modified here to
// export them.
//
// These tests instead reimplement each formula exactly as it reads in
// main.js today (recomputeOrderTotals ~line 1337, the checkout
// verifiedProducts calc ~line 726-744, applyLineReduction's
// unitNetPrice/unitDiscountAmount calc ~line 1362-1383) and pin that
// math down as a regression net. Stage 3 (route module split) is a
// natural point to export these directly from routes/orders.js for a
// true integration-level test; flagged as a known limitation below and
// in production-progress.md.

function recomputeOrderTotals(order) {
  order.totalAmount = roundMoney(order.products.reduce((sum, p) => sum + p.amount, 0));
  order.balanceDue = roundMoney(Math.max(0, order.totalAmount - order.amountPaid));
  order.paymentStatus = order.amountPaid <= 0 ? 'unpaid' : order.balanceDue > 0 ? 'partial' : 'paid';
}

function checkoutLine(currentPrice, quantity, discountPercent) {
  const amount = roundMoney(currentPrice * quantity * (1 - discountPercent / 100));
  const discountAmount = roundMoney(currentPrice * quantity - amount);
  return { amount, discountAmount };
}

function applyLineReductionMath(line, newQty) {
  const originalQty = line.quantity;
  const unitNetPrice = originalQty > 0 ? line.amount / originalQty : 0;
  const unitDiscountAmount = originalQty > 0 ? (line.discountAmount || 0) / originalQty : 0;
  return {
    amount: roundMoney(unitNetPrice * newQty),
    discountAmount: roundMoney(unitDiscountAmount * newQty)
  };
}

test('checkoutLine: no discount', () => {
  const { amount, discountAmount } = checkoutLine(100, 3, 0);
  assert.equal(amount, 300);
  assert.equal(discountAmount, 0);
});

test('checkoutLine: percentage discount reduces amount and records the difference', () => {
  const { amount, discountAmount } = checkoutLine(100, 2, 10);
  assert.equal(amount, 180);
  assert.equal(discountAmount, 20);
});

test('checkoutLine: 100% discount zeroes the amount', () => {
  const { amount, discountAmount } = checkoutLine(50, 4, 100);
  assert.equal(amount, 0);
  assert.equal(discountAmount, 200);
});

test('checkoutLine: rounds cleanly on fractional cents', () => {
  const { amount, discountAmount } = checkoutLine(19.99, 3, 15);
  assert.equal(amount, roundMoney(19.99 * 3 * 0.85));
  assert.equal(discountAmount, roundMoney(19.99 * 3 - amount));
});

test('recomputeOrderTotals: unpaid order', () => {
  const order = { products: [{ amount: 100 }, { amount: 50 }], amountPaid: 0 };
  recomputeOrderTotals(order);
  assert.equal(order.totalAmount, 150);
  assert.equal(order.balanceDue, 150);
  assert.equal(order.paymentStatus, 'unpaid');
});

test('recomputeOrderTotals: partially paid order', () => {
  const order = { products: [{ amount: 200 }], amountPaid: 50 };
  recomputeOrderTotals(order);
  assert.equal(order.totalAmount, 200);
  assert.equal(order.balanceDue, 150);
  assert.equal(order.paymentStatus, 'partial');
});

test('recomputeOrderTotals: fully paid order', () => {
  const order = { products: [{ amount: 200 }], amountPaid: 200 };
  recomputeOrderTotals(order);
  assert.equal(order.balanceDue, 0);
  assert.equal(order.paymentStatus, 'paid');
});

test('recomputeOrderTotals: overpayment never produces a negative balanceDue', () => {
  const order = { products: [{ amount: 100 }], amountPaid: 150 };
  recomputeOrderTotals(order);
  assert.equal(order.balanceDue, 0);
  assert.equal(order.paymentStatus, 'paid');
});

test('recomputeOrderTotals: empty product list totals to zero', () => {
  const order = { products: [], amountPaid: 0 };
  recomputeOrderTotals(order);
  assert.equal(order.totalAmount, 0);
  assert.equal(order.balanceDue, 0);
  assert.equal(order.paymentStatus, 'unpaid');
});

test('applyLineReductionMath: proportionally reduces amount and discount for a partial reduction', () => {
  const line = { quantity: 4, amount: 360, discountAmount: 40 };
  const result = applyLineReductionMath(line, 2);
  assert.equal(result.amount, 180);
  assert.equal(result.discountAmount, 20);
});

test('applyLineReductionMath: reducing to zero quantity zeroes both fields', () => {
  const line = { quantity: 4, amount: 360, discountAmount: 40 };
  const result = applyLineReductionMath(line, 0);
  assert.equal(result.amount, 0);
  assert.equal(result.discountAmount, 0);
});

test('applyLineReductionMath: handles a line with no discount applied', () => {
  const line = { quantity: 3, amount: 300, discountAmount: 0 };
  const result = applyLineReductionMath(line, 1);
  assert.equal(result.amount, 100);
  assert.equal(result.discountAmount, 0);
});
