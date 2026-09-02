const { roundMoney } = require('./money');

// The single place any code path is allowed to change a customer's
// running account balance (models/Customers.js's accountBalance —
// positive = customer owes us, negative = store credit, zero = settled).
// Checkout, order edits, and refunds all call this with a signed delta
// instead of touching a "credit" bucket and a "balance due" bucket
// separately, which is what let those two drift apart from each other in
// the first place. A pure $inc — no read-then-write — so concurrent
// updates for the same customer (two register sessions, an edit landing
// mid-checkout) can never lose one side's change to the other.
//
// delta > 0: the customer now owes more (a new unpaid/underpaid sale, or
//            a line added back to an order during an exchange).
// delta < 0: the customer now owes less, or has more credit (a payment,
//            a refund, an edit-down, or a banked overpayment) — this is
//            what makes a refund's credit actually reduce whatever the
//            customer already owed, from any other order, automatically:
//            it's the same running number, not a separate bucket.
async function applyCustomerAccountDelta(Customer, customerName, delta, session) {
  const roundedDelta = roundMoney(delta || 0);
  if (roundedDelta === 0) return; // no-op, avoid a needless write
  await Customer.updateOne(
    { customerName },
    { $inc: { accountBalance: roundedDelta } },
    session ? { session } : undefined
  );
}

module.exports = { applyCustomerAccountDelta };
