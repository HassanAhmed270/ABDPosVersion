// f:\Billing System js\models\Product.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const productSchema = new Schema({
  productID: { 
    type: String, 
    required: true, 
    match: /^#\d{4}$/, 
    unique: true 
  },
  category: { type: String, required: true },
  productName: { type: String, required: true },
  quantity: { type: Number, required: true, min: 0 },
  // How many units are currently held in an open cart (added-to-bill but
  // not yet committed). "Available to sell" is always quantity - reserved.
  reserved: { type: Number, required: true, min: 0, default: 0 },
  // Below this many *available* units, the row gets highlighted low-stock
  // in Products and Billing (see CLAUDE.md Stage 3).
  lowStockThreshold: { type: Number, required: true, min: 0, default: 10 },
  // What we charge customers, over time — always read via
  // getLatestSellingPrice() (lib/pricing.js), never index [0].
  // Replaces the old, ambiguously-named `unitPrice` field (Stage 5).
  sellingPriceHistory: [
    {
      price: { type: Number, required: true },
      date: { type: Date, default: Date.now }
    }
  ],
  // What we paid suppliers, over time — populated only by recording a
  // supplier purchase (POST /supplier/purchase), never by the product
  // add/restock form. See CLAUDE.md Stage 5.
  buyingPriceHistory: [
    {
      price: { type: Number, required: true },
      date: { type: Date, default: Date.now },
      supplierID: { type: Schema.Types.ObjectId, ref: 'Supplier' }
    }
  ],
  buyingDate: { type: Date, default: Date.now },
  // Which supplier this product is currently sourced from (Stage 20) — a
  // real reference to a Supplier document, not an arbitrary string like
  // the old `supplier` field this replaces. null means self-purchased /
  // no supplier (the "NoSupplier" sentinel on the frontend and in
  // main.js's NO_SUPPLIER constant — see resolveSupplierId()). This is
  // the product's *current* declared supplier, distinct from each
  // buyingPriceHistory entry's own `supplierID`, which is a per-purchase
  // historical snapshot that does not change retroactively when this
  // field does.
  supplierID: { type: Schema.Types.ObjectId, ref: 'Supplier', default: null },
  hidden: { type: Boolean, default: false },
  // final.md Stage 9 — set true whenever quantity reaches 0 (sale,
  // offline sync, or a Deduct Stock action), false again the moment the
  // product is restocked via Add Stock. A disabled product stays fully
  // visible/historical everywhere (Products list, past orders) but can
  // no longer be selected for a new bill — see routes/billing.js's
  // /billing/reserve guard and lib/costing.js's disableIfDepleted().
  disabled: { type: Boolean, default: false }
});

// Stage 3: category is searched via regex in /api/products' $or filter
// and had no index before this stage.
productSchema.index({ category: 1 });

module.exports = mongoose.model('Product', productSchema);