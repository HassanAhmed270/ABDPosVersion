const mongoose = require('mongoose');
const { Schema } = mongoose;

// final.md Stage 9 — one entry per Deduct Stock action whose reason
// isn't "Returned to Supplier" (that path recovers cost as supplier
// credit instead — see routes/products.js's deduct-stock route, the
// only writer of this collection). costValue is whatever consumeFIFO()
// could actually attribute to a known cost batch, same "never invent a
// cost for unknown stock" rule the rest of the app follows
// (lib/costing.js) — it can be less than quantity * true cost if some
// of the deducted stock had no batch behind it.
const REASONS = ['expired', 'damaged_lost', 'discontinued'];

const lossSchema = new Schema({
  productID: { type: String, required: true, match: /^#\d{4}$/ },
  productName: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  costValue: { type: Number, required: true, min: 0 },
  reason: { type: String, required: true, enum: REASONS },
  note: { type: String, required: true },
  actor: {
    username: { type: String, required: true },
    role: { type: String, required: true }
  },
  date: { type: Date, default: Date.now }
});

lossSchema.index({ date: -1 });

module.exports = mongoose.model('Loss', lossSchema);
module.exports.REASONS = REASONS;
