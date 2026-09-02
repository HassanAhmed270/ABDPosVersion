const mongoose = require('mongoose');
const { Schema } = mongoose;

// A refund is its own record (not just Order.editHistory entries) because
// it's a different kind of event: money actually leaving the shop for
// this order, as opposed to a correction to what's owed. One document per
// refund action (which may cover several line items at once).
const refundSchema = new Schema({
  orderID: { type: String, required: true, match: /^#\d{4}$/ },
  customerName: { type: String, required: true },
  refundAmount: { type: Number, required: true, min: 0 },
  refundedItems: [
    {
      productID: { type: String, required: true, match: /^#\d{4}$/ },
      quantity: { type: Number, required: true, min: 1 },
      amount: { type: Number, required: true, min: 0 }
    }
  ],
  reason: { type: String, default: '' },
  refundDate: { type: Date, default: Date.now },
  processedBy: { type: String, required: true },
  // Stage 5 — how the freed-up overpayment (if any) was settled. 'none'
  // when this refund didn't free up any overpayment to begin with.
  settlement: { type: String, enum: ['none', 'cash', 'credit'], default: 'none' },
  creditGenerated: { type: Number, min: 0, default: 0 }
});

module.exports = mongoose.model('Refund', refundSchema);