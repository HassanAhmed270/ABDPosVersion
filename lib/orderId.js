// Sequential invoice IDs — "INV-0001", "INV-0002", ... (sales) and
// "PINV-0001", "PINV-0002", ... (customer payment invoices), each
// counting up forever in their own namespace, never truncated past 4
// digits.
//
// Mirrors routes/products.js's nextProductId(): each format has its own
// Counter doc (models/Counter.js) incremented atomically via $inc, so
// two requests hitting this at the same instant can never be handed the
// same number — Mongo's atomic update guarantees each caller gets a
// distinct seq. Deliberately not seeded from any existing record: legacy
// orders use the old random "#dddd" format (a different namespace
// entirely — see lib/validators.js's ORDER_ID_RE, which still accepts
// both formats so old records keep validating on re-save), so counting
// starts fresh at 0001 rather than trying to parse/continue from them.
const Counter = require('../models/Counter');

async function nextSequentialId(counterId, prefix, session) {
  const opts = session ? { session } : {};

  let counter = await Counter.findById(counterId, null, opts);

  if (!counter) {
    counter = await Counter.findOneAndUpdate(
      { _id: counterId },
      { $setOnInsert: { seq: 0 } },
      { new: true, upsert: true, ...opts }
    );
  }

  const updated = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { new: true, ...opts }
  );

  return `${prefix}${String(updated.seq).padStart(4, '0')}`;
}

function nextInvoiceId(session) {
  return nextSequentialId('invoiceId', 'INV-', session);
}

// A customer's balance-payment receipt (see routes/customers.js's
// POST /customer/updateCustomer) — its own namespace/counter, entirely
// separate from sales invoices.
function nextPaymentInvoiceId(session) {
  return nextSequentialId('paymentInvoiceId', 'PINV-', session);
}

module.exports = { nextInvoiceId, nextPaymentInvoiceId };
