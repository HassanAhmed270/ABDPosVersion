const mongoose = require('mongoose');
const { Schema } = mongoose;

const orderSchema = new Schema({
  orderID: {
    type: String,
    required: true,
    // Accepts current "INV-dddd+" (lib/orderId.js) and legacy random
    // "#dddd" orders already on file — see lib/validators.js.
    match: /^(?:INV-\d{4,}|#\d{4})$/,
    unique: true
  },
  customerName: { type: String, required: true },
  products: [
    {
      productID: { type: String, required: true },
      quantity: { type: Number, required: true, min: 1 },
      retailPrice: { type: Number, required: true, min: 0 },
      unitPrice: { type: Number, required: true, min: 0 },
      amount: { type: Number, required: true, min: 0 },
      // Stage 22 — batch-based costing. Set once at commit time
      // (POST /billing/orderDetails) from lib/costing.js's consumeFIFO(),
      // then frozen: later restocks/price changes never rewrite these.
      // costAmount is the total FIFO cost of only the *known-cost*
      // portion of this line's quantity (costQuantity units); the
      // remaining (quantity - costQuantity) units have no batch backing
      // (legacy stock, or stock added with no cost via the Products
      // form) and are deliberately left out of costAmount rather than
      // priced at today's cost — see CLAUDE.md Stage 22.
      costAmount: { type: Number, min: 0, default: 0 },
      costQuantity: { type: Number, min: 0, default: 0 },
      costSource: { type: String, enum: ['batch', 'partial', 'unknown'], default: 'unknown' },
      // Which batch(es) this line's costQuantity units actually came
      // from, oldest-first — needed so an admin edit/refund can give the
      // exact right units back (see applyLineReduction/restoreConsumption).
      batchConsumption: [
        {
          batchId: { type: Schema.Types.ObjectId, ref: 'StockBatch' },
          quantity: { type: Number, required: true, min: 1 },
          unitCost: { type: Number, required: true, min: 0 }
        }
      ]
    }
  ],
  cashier: { type: String, required: true },
  totalAmount: { type: Number, required: true, min: 0 },
  // Payment tracking (Stage 5) — an order no longer has to be paid in
  // full at commit time; the difference becomes customer credit.
  amountPaid: { type: Number, required: true, min: 0, default: 0 },
  balanceDue: { type: Number, required: true, min: 0, default: 0 },
  // Stage 5 — how much of this order's total was covered by pre-existing
  // Customer.creditBalance at checkout (mirrors Supplier.purchases'
  // creditApplied). Recorded once at commit, never re-read afterward.
  creditApplied: { type: Number, min: 0, default: 0 },
  paymentStatus: {
    type: String,
    enum: ['paid', 'partial', 'unpaid'],
    required: true,
    default: 'unpaid'
  },
  payments: [
    {
      amount: { type: Number, required: true, min: 0 },
      date: { type: Date, default: Date.now },
      method: { type: String, enum: ['cash', 'card', 'other'], default: 'cash' }
    }
  ],
  orderDate: { type: Date, default: Date.now },
  // Stage 13 (final.md): set true only by lib/offlineSync.js's
  // syncOfflineSale — marks an order that was actually made offline and
  // committed at reconnect, for dashboard/reports visibility.
  offlineOrigin: { type: Boolean, default: false },
  // Stage 7: admin bill editing & refunds.
  status: { type: String, enum: ['active', 'refunded'], default: 'active', required: true },
  // Every reduce/remove edit appends one entry here — the order is never
  // silently mutated. One entry per line-item change (not per API call),
  // so a multi-item refund produces multiple entries.
  editHistory: [
    {
      editedBy: { type: String, required: true },
      editedAt: { type: Date, default: Date.now },
      productID: { type: String, required: true },
      originalQty: { type: Number, required: true, min: 0 },
      newQty: { type: Number, required: true, min: 0 },
      reason: { type: String, required: true },
      action: { type: String, enum: ['edit', 'refund', 'add'], required: true },
      // Stage 5 — how any overpayment freed up by this change was
      // settled. 'none' when the change didn't free up any overpayment.
      // Edits are always forced to 'credit' (an edit is a correction/
      // exchange, not a cash-handling event); refunds default to 'cash'
      // but an admin may choose 'credit' instead.
      settlement: { type: String, enum: ['none', 'cash', 'credit'], default: 'none' },
      creditAmount: { type: Number, min: 0, default: 0 }
    }
  ]
});

// Stage 3: orderDate is range-queried by every dashboard/report window
// (lib/reports.js) and is the default sort for /api/orders; customerName
// is searched via regex in /api/orders and looked up for credit
// reporting. Neither had an index before this stage.
orderSchema.index({ orderDate: 1 });
orderSchema.index({ customerName: 1 });

module.exports = mongoose.model('Order', orderSchema);