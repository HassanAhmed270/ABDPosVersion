const mongoose = require('mongoose');
const { Schema } = mongoose;

// One document per balance payment a customer makes (see
// routes/customers.js's POST /customer/updateCustomer) — the printable,
// permanent record behind the "PINV-####" receipt. Distinct from a
// regular sales Order: no items, just the balance movement itself.
const paymentInvoiceSchema = new Schema(
  {
    invoiceNumber: {
      type: String,
      required: true,
      match: /^PINV-\d{4,}$/,
      unique: true
    },
    customerName: { type: String, required: true },
    // Signed, same convention as Customer.accountBalance: positive =
    // customer owed us, negative = customer was in credit.
    oldBalance: { type: Number, required: true },
    paidAmount: { type: Number, required: true, min: 0 },
    newBalance: { type: Number, required: true },
    cashier: { type: String, default: '' }
  },
  { timestamps: true }
);

paymentInvoiceSchema.index({ customerName: 1, createdAt: -1 });

module.exports = mongoose.model('PaymentInvoice', paymentInvoiceSchema);
