const mongoose = require('mongoose');
const { Schema } = mongoose;

// One distinct cost lot for a product — created once per restock
// (POST /supplier/purchase, both real-supplier and self-purchased) so
// that the same product bought at different costs over time can be told
// apart and sold oldest-cost-first (FIFO — see lib/costing.js).
//
// Historically, stock added through the plain Products admin form
// (POST /api/product's `stock`/`already` fields) did NOT create a batch
// here — that form had no cost input, and Stage 22 explicitly said not
// to invent one. final.md Stage 7 supersedes this for the Add Product
// (create) path specifically: Cost is now a required field there, and
// every new product's initial stock creates a NoSupplier-tagged batch
// the same way a self-purchase does. The Update Product (`already`)
// path is unaffected — it still has no cost input and still doesn't
// batch (final.md Stage 9 removes stock from Update Product entirely).
// Sales that end up drawing on unbatched/legacy stock (or on more stock
// than any batch currently covers) are still recorded with an "unknown"
// cost source — see Order.products[].costSource and lib/costing.js.
const stockBatchSchema = new Schema({
  productID: { type: String, required: true, match: /^#\d{4}$/ },
  // Mirrors buyingPriceHistory's supplierID — null for a self-purchase
  // (NoSupplier), a real Supplier reference otherwise.
  supplierID: { type: Schema.Types.ObjectId, ref: 'Supplier', default: null },
  purchaseID: { type: String, required: true, match: /^PUR-\d{4}$/ },
  quantityPurchased: { type: Number, required: true, min: 1 },
  // Consumed down by consumeFIFO() as sales draw on this batch, and
  // given back by restoreConsumption() when an edit/refund undoes a sale
  // that drew on it. Never goes below 0 or above quantityPurchased —
  // every mutation to this field is a guarded atomic $inc, never a
  // read-then-write (see lib/costing.js).
  quantityRemaining: { type: Number, required: true, min: 0 },
  // Frozen at creation — a later restock creates a brand-new batch with
  // its own unitCost, it never rewrites this one. This is what makes
  // already-completed sales' recorded cost basis immune to later price
  // changes (Stage 22 exit criteria #6).
  unitCost: { type: Number, required: true, min: 0 },
  purchaseDate: { type: Date, default: Date.now }
});

// FIFO consumption order — oldest batch for a product first.
stockBatchSchema.index({ productID: 1, purchaseDate: 1 });

module.exports = mongoose.model('StockBatch', stockBatchSchema);
