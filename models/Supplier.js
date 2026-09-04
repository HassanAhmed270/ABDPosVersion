const mongoose = require('mongoose');
const { Schema } = mongoose;

const purchaseItemSchema = new Schema(
  {
    productID: { type: String, required: true, match: /^#\d{4}$/ },
    quantity: { type: Number, required: true, min: 1 },
    unitCost: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const purchaseSchema = new Schema(
  {
    purchaseID: { type: String, required: true, match: /^PUR-\d{4}$/ },
    billID: { type: String, default: '' },
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
  billID: { type: String, default: '' },
  creditBalance: { type: Number, min: 0, default: 0 }
});


supplierSchema.virtual('totalBalanceDue').get(function () {
  return this.purchases.reduce((sum, p) => sum + (p.balanceDue || 0), 0);
});

module.exports = mongoose.model('Supplier', supplierSchema);