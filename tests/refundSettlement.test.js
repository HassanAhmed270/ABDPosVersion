const test = require('node:test');
const assert = require('node:assert/strict');
const { roundMoney } = require('../lib/money');

// Mirrors routes/orders.js's recomputeOrderTotals (Stage 5): returns the
// overpayment freed up by a total-amount reduction ("settlement") instead
// of letting it silently vanish, and caps amountPaid down to match.
function recomputeOrderTotals(order) {
  order.totalAmount = roundMoney(order.products.reduce((sum, p) => sum + p.amount, 0));
  const settlement = roundMoney(Math.max(0, order.amountPaid - order.totalAmount));
  if (settlement > 0) {
    order.amountPaid = roundMoney(order.amountPaid - settlement);
  }
  order.balanceDue = roundMoney(Math.max(0, order.totalAmount - order.amountPaid));
  order.paymentStatus = order.amountPaid <= 0 ? 'unpaid' : order.balanceDue > 0 ? 'partial' : 'paid';
  return settlement;
}

function makeOrder(totalAmount, amountPaid) {
  return { products: [{ amount: totalAmount }], amountPaid };
}

test('full refund of a paid-in-full order — everything freed up, cash-back', () => {
  const order = makeOrder(100, 100);
  order.products = [];
  const settlement = recomputeOrderTotals(order);
  assert.equal(settlement, 100);
  assert.equal(order.totalAmount, 0);
  assert.equal(order.amountPaid, 0);
  assert.equal(order.balanceDue, 0);
  assert.equal(order.paymentStatus, 'unpaid');
});

test('partial refund of a paid-in-full order', () => {
  const order = makeOrder(100, 100);
  order.products = [{ amount: 60 }];
  const settlement = recomputeOrderTotals(order);
  assert.equal(settlement, 40);
  assert.equal(order.totalAmount, 60);
  assert.equal(order.amountPaid, 60);
  assert.equal(order.balanceDue, 0);
  assert.equal(order.paymentStatus, 'paid');
});

test('partial refund of a partially-paid order frees up nothing', () => {
  const order = makeOrder(100, 40);
  order.products = [{ amount: 70 }];
  const settlement = recomputeOrderTotals(order);
  assert.equal(settlement, 0);
  assert.equal(order.amountPaid, 40);
  assert.equal(order.balanceDue, 30);
  assert.equal(order.paymentStatus, 'partial');
});

test('edit-down of a paid-in-full order always frees up settlement (forced to credit by the caller)', () => {
  const order = makeOrder(100, 100);
  order.products = [{ amount: 75 }];
  const settlement = recomputeOrderTotals(order);
  assert.equal(settlement, 25);
  assert.equal(order.amountPaid, 75);
  assert.equal(order.balanceDue, 0);
  assert.equal(order.paymentStatus, 'paid');
});

test('edit-down then later refund — second call settles against the already-adjusted amountPaid', () => {
  const order = makeOrder(100, 100);
  order.products = [{ amount: 75 }];
  const editSettlement = recomputeOrderTotals(order); // edit-down: 25 -> credit
  assert.equal(editSettlement, 25);
  assert.equal(order.amountPaid, 75);

  order.products = [{ amount: 30 }];
  const refundSettlement = recomputeOrderTotals(order); // later refund
  assert.equal(refundSettlement, 45);
  assert.equal(order.totalAmount, 30);
  assert.equal(order.amountPaid, 30);
  assert.equal(order.balanceDue, 0);
});

test('zero-amount edge case does not throw or go negative', () => {
  const order = makeOrder(0, 0);
  order.products = [];
  const settlement = recomputeOrderTotals(order);
  assert.equal(settlement, 0);
  assert.equal(order.paymentStatus, 'unpaid');
});

test('fractional-cent rounding stays clean', () => {
  const order = makeOrder(33.33, 33.33);
  order.products = [{ amount: 11.11 }];
  const settlement = recomputeOrderTotals(order);
  assert.equal(settlement, 22.22);
  assert.equal(order.amountPaid, 11.11);
  assert.equal(order.balanceDue, 0);
});

// Mirrors the checkout-side auto-apply added to routes/billing.js.
function applyCustomerCredit(existingCredit, verifiedTotal) {
  const creditApplied = roundMoney(Math.min(existingCredit, verifiedTotal));
  const newCreditBalance = roundMoney(existingCredit - creditApplied);
  const netOwed = roundMoney(verifiedTotal - creditApplied);
  return { creditApplied, newCreditBalance, netOwed };
}

test('checkout auto-apply: credit fully covers the order', () => {
  const { creditApplied, newCreditBalance, netOwed } = applyCustomerCredit(150, 100);
  assert.equal(creditApplied, 100);
  assert.equal(newCreditBalance, 50);
  assert.equal(netOwed, 0);
});

test('checkout auto-apply: credit partially covers the order', () => {
  const { creditApplied, newCreditBalance, netOwed } = applyCustomerCredit(40, 100);
  assert.equal(creditApplied, 40);
  assert.equal(newCreditBalance, 0);
  assert.equal(netOwed, 60);
});

test('checkout auto-apply: no existing credit is a no-op', () => {
  const { creditApplied, newCreditBalance, netOwed } = applyCustomerCredit(0, 100);
  assert.equal(creditApplied, 0);
  assert.equal(newCreditBalance, 0);
  assert.equal(netOwed, 100);
});
