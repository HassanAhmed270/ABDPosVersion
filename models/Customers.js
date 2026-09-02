const mongoose = require('mongoose');

const { roundMoney } = require('../lib/money');

// Sub-schema for customer orders.
// customerID is stored here as a historical reference to the customer
// who owned this order at the time it was added.
const customerOrderSchema = new mongoose.Schema(
  {
    customerID: {
      type: String,
      required: true,
      match: /^#\d{4}$/,
    },

    orderNo: {
      type: String,
      required: true,
    },

    orderDate: {
      type: Date,
      required: true,
      default: Date.now,
    },

    totalAmount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    amountPaid: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    balanceDue: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },

    creditApplied: {
      type: Number,
      min: 0,
      default: 0,
    },

    creditGenerated: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  { _id: false }
);

const customerSchema = new mongoose.Schema({
  customerID: {
    type: String,
    required: true,
    unique: true,
    match: /^#\d{4}$/,
  },

  customerName: {
    type: String,
    required: true,
    unique: true,
    set: (value) => value.trim().replace(/\s+/g, ' '),
  },

  mobileNo: {
    type: String,
    required: false,
    set: (value) => (value ? value.trim() : ''),
  },

  emergencyMobile: {
    type: String,
    required: false,
    set: (value) => (value ? value.trim() : ''),
  },

  email: {
    type: String,
    required: false,
    set: (value) => (value ? value.trim() : ''),
  },

  address: {
    type: String,
    required: false,
    set: (value) => (value ? value.trim() : ''),
  },

  orders: [customerOrderSchema],

  accountBalance: {
    type: Number,
    default: 0,
  },
});

// Optional: virtual to get orders sorted by date descending.
customerSchema.virtual('sortedOrders').get(function () {
  return this.orders.sort((a, b) => b.orderDate - a.orderDate);
});

customerSchema.virtual('totalBalanceDue').get(function () {
  return Math.max(0, roundMoney(this.accountBalance || 0));
});

customerSchema.virtual('creditBalance').get(function () {
  return Math.max(0, roundMoney(-(this.accountBalance || 0)));
});

customerSchema.set('toObject', { virtuals: true });
customerSchema.set('toJSON', { virtuals: true });

const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;