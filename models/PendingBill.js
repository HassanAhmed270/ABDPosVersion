const mongoose = require('mongoose');
const { Schema } = mongoose;

// One document per cashier, for their life (upserted by `cashier`, never
// duplicated) — not a history table. `status` cycles active -> committed
// or abandoned, then back to active whenever that cashier starts a new
// bill. See CLAUDE.md Stage 4.
const pendingBillSchema = new Schema({
  cashier: { type: String, required: true, unique: true, trim: true, lowercase: true },
  // Only set once the cashier reaches Preview (that's when an order ID is
  // reserved) — null before that.
  billID: { type: String, match: /^#\d{4}$/, default: null },
  customerName: { type: String, default: '' },
  // What the cashier has typed into the "Paid" field so far — carried in
  // the draft (not a separate request param) for the same reason
  // everything else here is: it's what gets committed, so it needs to
  // survive a refresh and be tamper-resistant the same way (Stage 5).
  paidInput: { type: Number, min: 0, default: 0 },
  paymentMethod: { type: String, enum: ['cash', 'card', 'other'], default: 'cash' },
  // Stage 19: the cashier's choice for how an overpayment (paidInput
  // beyond what's owed) is settled at commit time — 'change' handed
  // back (today's only behavior, still the default) or 'balance'
  // credited to the customer's account. Carried in the draft, same
  // tamper-resistance reason as paidInput/paymentMethod above.
  overpaymentChoice: { type: String, enum: ['change', 'balance'], default: 'change' },
  items: [
    {
      productID: { type: String, required: true, match: /^#\d{4}$/ },
      productName: { type: String, required: true },
      retailPrice: { type: Number, required: true, min: 0 },
      unitPrice: { type: Number, required: true, min: 0 },
      quantity: { type: Number, required: true, min: 1 }
    }
  ],
  status: { type: String, enum: ['active', 'committed', 'abandoned'], default: 'active' },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PendingBill', pendingBillSchema);