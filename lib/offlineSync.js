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
const { consumeFIFO, deriveCostSource, disableIfDepleted } = require('./costing');
const { applyCustomerAccountDelta } = require('./customerAccount');

const WALKIN_CUSTOMER = 'Walk-in / Unknown';

// Small-shop-scale ID allocation (same assumption Billing.jsx's own
// getUniqueOrderId retry loop makes) — try the client's own offline pick
// first, then fall back to random 4-digit candidates until one's free.
async function allocateOrderId(session, preferred) {
  const candidates = [];

  if (preferred && /^#\d{4}$/.test(preferred)) {
    candidates.push(preferred);
  }

  for (let i = 0; i < 30; i++) {
    candidates.push(
      '#' + Math.floor(Math.random() * 10000).toString().padStart(4, '0')
    );
  }

  for (const id of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await Order.exists({ orderID: id }).session(session);

    if (!exists) {
      return id;
    }
  }

  throw new AppError(409, 'Could not allocate a unique order ID — try syncing again.');
}

// Attempts to turn one queued OfflineSale document into a real Order.
// Never throws for an expected conflict (retail price changed,
// insufficient stock, missing customer/product) — those come back as
// { conflictReason } so the caller can park the sale for admin review
// instead of retrying forever. Only genuine/unexpected errors propagate.
async function syncOfflineSale(offlineSale, { cashier }) {
  const session = await mongoose.startSession();

  let order = null;
  let conflictReason = null;

  try {
    await session.withTransaction(async () => {
      const isWalkIn = offlineSale.customerName === WALKIN_CUSTOMER;

      if (!isWalkIn) {
        const customer = await Customer.findOne({
          customerName: offlineSale.customerName
        }).session(session);

        if (!customer) {
          throw new AppError(
            409,
            `Customer "${offlineSale.customerName}" not found — it may not have existed yet when this sale was made offline.`
          );
        }
      }

      // Re-check the retail price from the database.
      //
      // IMPORTANT:
      // retailPrice is the reference/normal retail price.
      // unitPrice is the actual selling rate chosen by the cashier.
      //
      // Therefore we ONLY validate retailPrice against the current
      // product selling price. We deliberately do NOT require
      // unitPrice === retailPrice because a cashier is allowed to sell
      // the item at their own rate.
      const verifiedProducts = [];

      for (const item of offlineSale.items) {
        // eslint-disable-next-line no-await-in-loop
        const product = await Product.findOne({
          productID: item.productID
        }).session(session);

        if (!product) {
          throw new AppError(
            409,
            `Product ${item.productID} no longer exists.`
          );
        }

        const currentRetailPrice = roundMoney(
          getLatestSellingPrice(product)
        );

        const capturedRetailPrice = roundMoney(
          item.retailPrice
        );

        const sellingRate = roundMoney(
          item.unitPrice
        );

        // The normal retail price must still match the price that was
        // captured when the sale was made offline.
        //
        // The cashier's selling rate is intentionally allowed to differ.
        if (Math.abs(currentRetailPrice - capturedRetailPrice) > 0.01) {
          throw new AppError(
            409,
            `Retail price for ${item.productID} changed since this sale was made offline (was ${capturedRetailPrice}, now ${currentRetailPrice}).`
          );
        }

        const amount = roundMoney(
          sellingRate * item.quantity
        );

        verifiedProducts.push({
          productID: item.productID,
          quantity: item.quantity,
          retailPrice: currentRetailPrice,
          unitPrice: sellingRate,
          amount
        });
      }

      // Availability check against current stock, not a reservation
      // this cart never held. Guarded in the query filter, same atomic
      // pattern as every other stock mutation in the app.
      for (const p of verifiedProducts) {
        // eslint-disable-next-line no-await-in-loop
        const updated = await Product.findOneAndUpdate(
          {
            productID: p.productID,
            $expr: {
              $gte: [
                { $subtract: ['$quantity', '$reserved'] },
                p.quantity
              ]
            }
          },
          {
            $inc: {
              quantity: -p.quantity
            }
          },
          {
            session,
            new: true
          }
        );

        if (!updated) {
          throw new AppError(
            409,
            `Not enough current stock for ${p.productID} to honor this offline sale.`
          );
        }

        await disableIfDepleted(updated, session);

        const fifo = await consumeFIFO(
          p.productID,
          p.quantity,
          session
        );

        p.costAmount = fifo.costAmount;
        p.costQuantity = fifo.costQuantity;
        p.costSource = deriveCostSource(
          fifo.costQuantity,
          p.quantity
        );
        p.batchConsumption = fifo.consumption;
      }

      const verifiedTotal = roundMoney(
        verifiedProducts.reduce(
          (sum, p) => sum + p.amount,
          0
        )
      );

      const amountPaid = roundMoney(
        Math.min(
          Math.max(offlineSale.paidInput || 0, 0),
          verifiedTotal
        )
      );

      const balanceDue = roundMoney(
        Math.max(
          0,
          verifiedTotal - amountPaid
        )
      );

      const paymentStatus =
        amountPaid <= 0
          ? 'unpaid'
          : balanceDue > 0
            ? 'partial'
            : 'paid';

      const payments =
        amountPaid > 0
          ? [
              {
                amount: amountPaid,
                date: offlineSale.createdOfflineAt,
                method: offlineSale.paymentMethod || 'cash'
              }
            ]
          : [];

      const orderID = await allocateOrderId(
        session,
        offlineSale.clientBillID
      );

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

            // The sale happened offline at this timestamp, not "now".
            orderDate: offlineSale.createdOfflineAt,

            offlineOrigin: true
          }
        ],
        { session }
      );

      order = created[0];

      if (!isWalkIn) {
        // Offline behavior remains the same regarding customer balance:
        // any unpaid portion of this offline sale becomes customer debt.
        await applyCustomerAccountDelta(
          Customer,
          offlineSale.customerName,
          balanceDue,
          session
        );

        await Customer.updateOne(
          {
            customerName: offlineSale.customerName
          },
          {
            $push: {
              orders: {
                orderNo: orderID,
                orderDate: offlineSale.createdOfflineAt,
                totalAmount: verifiedTotal,
                amountPaid,
                balanceDue
              }
            }
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
      throw err;
    }
  } finally {
    await session.endSession();
  }

  return {
    order,
    conflictReason
  };
}

module.exports = {
  syncOfflineSale,
  allocateOrderId
};