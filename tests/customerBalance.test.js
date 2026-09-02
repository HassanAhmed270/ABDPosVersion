const test = require('node:test');
const assert = require('node:assert/strict');
const { roundMoney } = require('../lib/money');

// Mirrors models/Customers.js's totalBalanceDue/creditBalance virtuals —
// both are just the two non-negative faces of one signed accountBalance
// (positive = customer owes us, negative = store credit), so unlike the
// old model (two independently-stored/updated fields, one a real sum
// over every order's own balanceDue) they can never disagree with each
// other or need reconciling.
function totalBalanceDue(accountBalance) {
  return Math.max(0, roundMoney(accountBalance || 0));
}
function creditBalance(accountBalance) {
  return Math.max(0, roundMoney(-(accountBalance || 0)));
}

test('a settled account (zero) shows no balance due and no credit', () => {
  assert.equal(totalBalanceDue(0), 0);
  assert.equal(creditBalance(0), 0);
});

test('a positive accountBalance is balance due, not credit', () => {
  assert.equal(totalBalanceDue(150.5), 150.5);
  assert.equal(creditBalance(150.5), 0);
});

test('a negative accountBalance is credit, not balance due', () => {
  assert.equal(totalBalanceDue(-40), 0);
  assert.equal(creditBalance(-40), 40);
});

test('the two views round consistently on fractional cents', () => {
  const balance = roundMoney(19.995 + 0.005);
  assert.equal(totalBalanceDue(balance), balance);
  assert.equal(creditBalance(-balance), balance);
});

// Mirrors routes/billing.js's checkout delta: a single signed number for
// this transaction's effect on the customer's running balance, which
// automatically nets against whatever the account already stood at —
// whether that was existing debt or existing credit — with no separate
// "apply credit first" step.
function checkoutAccountDelta(verifiedTotal, paidInput, { overpaymentChoice = 'change' } = {}) {
  const amountPaid = roundMoney(Math.min(Math.max(paidInput || 0, 0), verifiedTotal));
  const overpaidAmount = roundMoney(Math.max(0, (paidInput || 0) - verifiedTotal));
  const bankOverpay = overpaidAmount > 0 && overpaymentChoice === 'balance';
  const effectivePaid = bankOverpay ? roundMoney(Math.max(paidInput || 0, 0)) : amountPaid;
  return roundMoney(verifiedTotal - effectivePaid);
}

test('checkout delta: underpayment increases what the customer owes', () => {
  const delta = checkoutAccountDelta(100, 40);
  assert.equal(delta, 60);
});

test('checkout delta: paid in full is a no-op', () => {
  const delta = checkoutAccountDelta(100, 100);
  assert.equal(delta, 0);
});

test('checkout delta: an order paid in full with no overpayment leaves any unrelated existing balance untouched', () => {
  // Customer already owes 60 (accountBalance = 60 going in). This order
  // is paid in full with no overpayment banked — delta is 0, so the
  // prior 60 stays untouched, exactly like an order that was never
  // overpaid shouldn't reach into unrelated existing debt.
  const delta = checkoutAccountDelta(100, 100);
  const startingBalance = 60;
  assert.equal(startingBalance + delta, 60);
});

test('checkout delta: overpayment defaults to discarded (physical change), not credited', () => {
  const delta = checkoutAccountDelta(100, 150); // no overpaymentChoice passed
  // amountPaid caps at 100 (the order's own total), so the extra 50 never
  // enters the delta at all — matches "the excess is simply never
  // persisted anywhere" from routes/billing.js.
  assert.equal(delta, 0);
});

test('checkout delta: overpayment explicitly banked becomes negative (credit/paydown)', () => {
  const delta = checkoutAccountDelta(100, 150, { overpaymentChoice: 'balance' });
  assert.equal(delta, -50);
});

test('checkout delta: banked overpayment on an order with existing debt pays that debt down first, automatically', () => {
  // Customer owes 80 already (accountBalance = 80). New order of 100,
  // paid 150 (50 over), banked as balance.
  const delta = checkoutAccountDelta(100, 150, { overpaymentChoice: 'balance' });
  const startingBalance = 80;
  // 80 (existing debt) + 100 (new order) - 150 (all cash collected) = 30
  // still owed — the same single $inc naturally absorbs both this
  // order's own total AND the pre-existing debt, with no separate
  // "apply credit to old orders" step required.
  assert.equal(startingBalance + delta, 30);
});

// Mirrors routes/orders.js's unified edit/refund delta: how much this
// specific order's own balanceDue changed, minus whatever of that change
// is being banked as credit right now (0 when a refund's admin chose
// cash — that portion leaves as physical cash instead and never touches
// the running balance).
function editOrRefundAccountDelta(oldBalanceDue, newBalanceDue, creditGenerated) {
  return roundMoney(newBalanceDue - oldBalanceDue - creditGenerated);
}

test('edit-down of a paid-in-full order: settlement is banked as credit (edits are always forced to credit)', () => {
  // total 100 -> 75, was fully paid. oldBalanceDue=0, newBalanceDue=0
  // (recomputeOrderTotals caps amountPaid down), creditGenerated=25.
  const delta = editOrRefundAccountDelta(0, 0, 25);
  assert.equal(delta, -25);
});

test('partial refund of a partially-paid order: reduces what is owed, no credit involved', () => {
  // total 100 -> 70, paid 40. oldBalanceDue=60, newBalanceDue=30,
  // creditGenerated=0 (nothing was overpaid).
  const delta = editOrRefundAccountDelta(60, 30, 0);
  assert.equal(delta, -30);
});

test('refund with disposition=cash still corrects the ledger even though nothing is banked', () => {
  // total 100 -> 20, paid 40 (order was already 60 short before the
  // refund). oldBalanceDue=60, newBalanceDue=0, and the freed-up
  // overpayment (20) was handed back as physical cash — creditGenerated
  // is 0 because the admin chose 'cash', not because nothing was freed.
  const delta = editOrRefundAccountDelta(60, 0, 0);
  // The prior 60 owed is erased regardless of disposition — only whether
  // any *extra* beyond that becomes banked credit depends on the choice.
  assert.equal(delta, -60);
});

test('refund with disposition=credit banks the same freed-up amount instead of discarding it from the ledger', () => {
  // Same order as above, admin instead chooses 'credit': the 20 that
  // would have been cash instead stays on the books.
  const delta = editOrRefundAccountDelta(60, 0, 20);
  assert.equal(delta, -80);
});

test('adding a line item during an exchange increases what the customer owes', () => {
  // total +50, nothing paid for the addition yet. oldBalanceDue=0,
  // newBalanceDue=50, creditGenerated=0 (nothing was ever overpaid).
  const delta = editOrRefundAccountDelta(0, 50, 0);
  assert.equal(delta, 50);
});
