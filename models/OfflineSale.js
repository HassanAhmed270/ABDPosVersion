const mongoose = require('mongoose');
const { Schema } = mongoose;

// One document per offline sale a client durably queued in IndexedDB and
// then replayed to the server once connectivity returned. This is
// deliberately its own record, separate from Order/PendingBill: an
// offline sale is "provisional" until synced (see CLAUDE.md/progress.md
// Stage 11), and even after resolution this doc is the audit trail of
// what was captured offline vs. what actually got committed.
const offlineSaleSchema = new Schema({
  // Client-generated (crypto.randomUUID() in the browser), unique per
  // offline sale — the whole point is that retrying a sync (flaky
  // reconnect, duplicate flush) must never create two orders for the same
  // offline sale. See lib/offlineSync.js.
  idempotencyKey: { type: String, required: true, unique: true },

  // The order ID the client picked for itself while offline (no network
  // to ask the server for a free one) — informational / preferred, not
  // guaranteed unique. The server allocates the real orderID at sync time.
  clientBillID: { type: String, match: /^#\d{4}$/, default: null },

  cashier: { type: String, required: true },
  customerName: { type: String, required: true },

  items: [
    {
      productID: { type: String, required: true, match: /^#\d{4}$/ },
      productName: { type: String, required: true },

      // Normal retail price captured when the item was sold offline.
      // This is displayed as the retail/reference price and is checked
      // again against the current product price when the sale syncs.
      retailPrice: { type: Number, required: true, min: 0 },

      // Actual amount the cashier agreed to charge the customer.
      // This may be lower than retailPrice. It is NOT a discount.
      unitPrice: { type: Number, required: true, min: 0 },

      quantity: { type: Number, required: true, min: 1 }
    }
  ],

  paidInput: { type: Number, min: 0, default: 0 },
  paymentMethod: { type: String, enum: ['cash', 'card', 'other'], default: 'cash' },

  // When the sale actually happened, per the device's clock, while
  // offline — kept as the Order's orderDate at sync time so reports stay
  // scoped to when the sale happened, not when the device reconnected.
  createdOfflineAt: { type: Date, required: true },

  // When this sync request first reached the server.
  receivedAt: { type: Date, default: Date.now },

  status: {
    type: String,
    enum: ['synced', 'conflict', 'rejected'],
    required: true,
    default: 'conflict'
  },

  resultingOrderID: { type: String, default: null },
  conflictReason: { type: String, default: '' },
  resolvedBy: { type: String, default: null },
  resolvedAt: { type: Date, default: null }
});

module.exports = mongoose.model('OfflineSale', offlineSaleSchema);