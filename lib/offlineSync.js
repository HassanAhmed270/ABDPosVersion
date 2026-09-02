// Stage 11 — the offline mirror of POST /billing/orderDetails's commit
// transaction (Stage 3/4), deliberately kept as its own self-contained
// path rather than refactored into main.js's existing route. Two things
// are structurally different here, which is why it isn't just a call
// into the same function:
//
//   1. There is no server-held PendingBill to source items from. A draft
//      only exists because the client could reach the server to autosave
//      it — offline, that never happened, so the items this function
//      trusts are whatever the client durably queued in IndexedDB.
//   2. Stock was never reserved for this cart (reservation itself is a
//      live API call — see POST /billing/reserve). So instead of
//      consuming an existing reservation, this checks current
//      availability (quantity - reserved) directly at sync time and
//      decrements quantity only.
//
// Keeping this separate also means the module stays true to its own
// exit criteria: it can be deleted (this file, models/OfflineSale.js,
// routes/sync.js, and the one mount line in main.js) without touching
// the live billing flow at all.
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Customer = require('../models/Customers');
const { AppError } = require('./errors');
const { roundMoney } = require('./money');
const { getLatestSellingPrice } = require('./pricing');
// Stage 22: an offline-synced sale is a completed sale like any other —
// it should draw down cost batches the same way, or it'd silently never
// contribute to the dashboard's profit figure. See main.js's
// POST /billing/orderDetails for the live-commit equivalent of this.
const { consumeFIFO, deriveCostSource, disableIfDepleted } = require('./costing');
const { applyCustomerAccountDelta } = require('./customerAccount');

const WALKIN_CUSTOMER = 'Walk-in / Unknown';

// Small-shop-scale ID allocation (same assumption Billing.jsx's own
// getUniqueOrderId retry loop makes) — try the client's own offline pick
// first, then fall back to random 4-digit candidates until one's free.
async function allocateOrderId(session, preferred) {
  const candidates = [];
  if (preferred && /^#\d{4}$/.test(preferred)) candidates.push(preferred);
  for (let i = 0; i < 30; i++) {
    candidates.push('#' + Math.floor(Math.random() * 10000).toString().padStart(4, '0'));
  }
  for (const id of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await Order.exists({ orderID: id }).session(session);
    if (!exists) return id;
  }
  throw new AppError(409, 'Could not allocate a unique order ID — try syncing again.');
}

// Attempts to turn one queued OfflineSale document into a real Order.
// Never throws for an *expected* conflict (bad price, insufficient stock,
// missing customer/product) — those come back as { conflictReason } so
// the caller can park the sale for admin review instead of retrying
// forever. Only genuine/unexpected errors (DB down, etc.) propagate.
async function syncOfflineSale(offlineSale, { cashier }) {
  const session = await mongoose.startSession();
  let order = null;
  let conflictReason = null;

  try {
    await session.withTransaction(async () => {
      const isWalkIn = offlineSale.customerName === WALKIN_CUSTOMER;
      if (!isWalkIn) {
        const customer = await Customer.findOne({ customerName: offlineSale.customerName }).session(session);
        if (!customer) {
          throw new AppError(409, `Customer "${offlineSale.customerName}" not found — it may not have existed yet when this sale was made offline.`);
        }
      }

      // Re-derive every line's price from the DB's current value, same
      // tolerance rule as the live commit path (Stage 2) — a price that
      // moved while the device was offline is exactly the kind of thing
      // this re-validation step exists to catch.
      const verifiedProducts = [];
      for (const item of offlineSale.items) {
        // eslint-disable-next-line no-await-in-loop
        const product = await Product.findOne({ productID: item.productID }).session(session);
        if (!product) {
          throw new AppError(409, `Product ${item.productID} no longer exists.`);
        }

        const currentPrice = getLatestSellingPrice(product);
        const expectedAmount = roundMoney(currentPrice * item.quantity * (1 - item.discount / 100));
        const capturedAmount = roundMoney(item.unitPrice * item.quantity * (1 - item.discount / 100));

        if (Math.abs(expectedAmount - capturedAmount) > 0.01) {
          throw new AppError(
            409,
            `Price for ${item.productID} changed since this sale was made offline (was ${capturedAmount}, now ${expectedAmount}).`
          );
        }

        verifiedProducts.push({
          productID: item.productID,
          quantity: item.quantity,
          amount: expectedAmount,
          discount: roundMoney(item.discount),
          discountType: item.discountType || 'manual',
          discountAmount: roundMoney(currentPrice * item.quantity - expectedAmount),
        });
      }

      // Availability check against *current* stock, not a reservation
      // this cart never held. Guarded in the query filter, same atomic
      // pattern as every other stock mutation in the app (Stage 3).
      for (const p of verifiedProducts) {
        // eslint-disable-next-line no-await-in-loop
        const updated = await Product.findOneAndUpdate(
          { productID: p.productID, $expr: { $gte: [{ $subtract: ['$quantity', '$reserved'] }, p.quantity] } },
          { $inc: { quantity: -p.quantity } },
          { session, new: true }
        );
        if (!updated) {
          throw new AppError(409, `Not enough current stock for ${p.productID} to honor this offline sale.`);
        }
        await disableIfDepleted(updated, session);

        const fifo = await consumeFIFO(p.productID, p.quantity, session);
        p.costAmount = fifo.costAmount;
        p.costQuantity = fifo.costQuantity;
        p.costSource = deriveCostSource(fifo.costQuantity, p.quantity);
        p.batchConsumption = fifo.consumption;
      }

      const verifiedTotal = roundMoney(verifiedProducts.reduce((sum, p) => sum + p.amount, 0));
      const amountPaid = roundMoney(Math.min(Math.max(offlineSale.paidInput || 0, 0), verifiedTotal));
      const balanceDue = roundMoney(Math.max(0, verifiedTotal - amountPaid));
      const paymentStatus = amountPaid <= 0 ? 'unpaid' : balanceDue > 0 ? 'partial' : 'paid';
      const payments =
        amountPaid > 0
          ? [{ amount: amountPaid, date: offlineSale.createdOfflineAt, method: offlineSale.paymentMethod || 'cash' }]
          : [];

      const orderID = await allocateOrderId(session, offlineSale.clientBillID);

      const created = await Order.create(
        [
          {
            orderID,
            customerName: offlineSale.customerName,
            totalAmount: verifiedTotal,
            products: verifiedProducts,
            cashier,
            amountPaid,
            balanceDue,
            paymentStatus,
            payments,
            // The sale happened offline at this timestamp, not "now" —
            // keeps date-scoped reports (Stage 9) accurate to when the
            // sale actually occurred rather than when the device
            // happened to reconnect.
            orderDate: offlineSale.createdOfflineAt,
            offlineOrigin: true,
          },
        ],
        { session }
      );
      order = created[0];

      if (!isWalkIn) {
        // Stage 5+ (accountBalance unification): this order's own
        // shortfall becomes part of what the customer owes overall.
        // Deliberately NOT reading/applying any pre-existing credit here
        // — offline sync never has, since there's no live session to
        // safely re-check it against (see this file's module comment on
        // why it's a separate path from the live checkout transaction).
        // That's an existing, separate limitation this change doesn't
        // touch either way.
        await applyCustomerAccountDelta(Customer, offlineSale.customerName, balanceDue, session);
        await Customer.updateOne(
          { customerName: offlineSale.customerName },
          {
            $push: {
              orders: {
                orderNo: orderID,
                orderDate: offlineSale.createdOfflineAt,
                totalAmount: verifiedTotal,
                amountPaid,
                balanceDue,
              },
            },
          },
          { session }
        );
      }
    });
  } catch (err) {
    if (err instanceof AppError) {
      conflictReason = err.message;
      order = null;
    } else {
      throw err; // genuine/unexpected failure — let asyncHandler's error middleware handle it
    }
  } finally {
    await session.endSession();
  }

  return { order, conflictReason };
}

module.exports = { syncOfflineSale, allocateOrderId };
