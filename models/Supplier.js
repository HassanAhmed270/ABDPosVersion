const mongoose = require('mongoose');
const { Schema } = mongoose;

// One line item within a purchase — what was bought, how much, at what
// per-unit cost. Mirrors Order.products in shape/spirit.
const purchaseItemSchema = new Schema(
  {
    productID: { type: String, required: true, match: /^#\d{4}$/ },
    quantity: { type: Number, required: true, min: 1 },
    unitCost: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

// A single restock transaction from this supplier. Balance math mirrors
// Order's (Stage 5): totalAmount - amountPaid = balanceDue, i.e. what we
// still owe *them* rather than what a customer owes *us*.
//
// creditApplied (Stage 21 credit fix) — how much of the supplier's
// running creditBalance (see supplierSchema below) was used to offset
// *this* purchase's totalAmount before amountPaid/balanceDue were
// computed. Recorded per-purchase purely for audit/transparency (so a
// purchase history row can show "was partly covered by existing
// credit" rather than that credit silently vanishing into the balance
// math) — it's a snapshot, never re-read or re-applied after the fact.
//
// creditGenerated — the flip side: how much of amountPaid on *this*
// purchase went toward *new* credit rather than the purchase itself,
// because either the total was already fully covered by creditApplied
// above, or amountPaid simply exceeded what was left owed after that.
// Without this recorded separately, a row showing e.g. totalAmount=200,
// amountPaid=250, creditApplied=200 reads as contradictory — it looks
// like $450 of value went toward a $200 purchase. Recording the $250
// as creditGenerated makes clear all of it became new credit (since the
// $200 total was already paid for by existing credit, none of this
// purchase's own cash was needed), not that anything was double-counted.
const purchaseSchema = new Schema(
  {
    purchaseID: { type: String, required: true, match: /^PUR-\d{4}$/ },
    date: { type: Date, default: Date.now },
    totalAmount: { type: Number, required: true, min: 0 },
    amountPaid: { type: Number, required: true, min: 0, default: 0 },
    balanceDue: { type: Number, required: true, min: 0, default: 0 },
    creditApplied: { type: Number, min: 0, default: 0 },
    creditGenerated: { type: Number, min: 0, default: 0 },
    items: [purchaseItemSchema]
  },
  { _id: false }
);
const supplierSchema = new Schema({
  // Stage 3: evaluated for an index alongside Order.orderDate/customerName
  // and Product.category — `unique: true` below already creates a
  // standard index on this field (Mongo unique indexes are regular
  // indexes with an added constraint), so no separate index is added.
  supplierName: {
    type: String,
    required: true,
    unique: true,
    set: (value) => value.trim().replace(/\s+/g, ' ')
  },
  contactPerson: { type: String, default: '' },
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  address: { type: String, default: '' },
  purchases: [purchaseSchema],
  // Stage 21 credit fix — running total of what *this supplier* owes
  // *us* from having been overpaid on a past purchase. Always >= 0 (0
  // means no credit outstanding); a negative balanceDue on an individual
  // purchase is never stored directly — overpayment instead reduces
  // totalAmount owed via this field on the *next* purchase from the same
  // supplier (see POST /supplier/purchase), so credit rolls forward
  // automatically rather than needing to be manually tracked/applied.
  creditBalance: { type: Number, min: 0, default: 0 }
});

// Total we still owe this supplier across every purchase — queryable
// straight off the document (Stage 5 exit criteria), same pattern as
// Customer.totalBalanceDue.
supplierSchema.virtual('totalBalanceDue').get(function () {
  return this.purchases.reduce((sum, p) => sum + (p.balanceDue || 0), 0);
});

module.exports = mongoose.model('Supplier', supplierSchema);