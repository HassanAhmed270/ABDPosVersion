// Stage 3 — split out of main.js verbatim, no logic changes.
const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customers');
const Refund = require('../models/Refunds');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { AppError } = require('../lib/errors');
const { roundMoney } = require('../lib/money');
const { deriveCostSource, restoreConsumption, consumeFIFO, disableIfDepleted } = require('../lib/costing');
const { getLatestSellingPrice } = require('../lib/pricing');
const { escapeRegex, parsePagination, sortAndPaginate } = require('../lib/query');
const { getDashboardSummary } = require('../lib/reports');
const { logAudit } = require('../lib/auditLog');
const { applyCustomerAccountDelta } = require('../lib/customerAccount');
const { isValidOrderId, isValidProductId } = require('../lib/validators');

const router = express.Router();

// How long after orderDate an admin can still edit an order's line items
// (Stage 7). Refunds are NOT subject to this window — only edits are.
const ORDER_EDIT_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours

// Stage 14 — must match the sentinel in routes/billing.js and
// frontend/src/pages/Billing.jsx exactly; walk-in orders carry this as
// customerName instead of a real Customer document reference.
const WALKIN_CUSTOMER = 'Walk-in / Unknown';

// ── Dashboard summary (Stage 9/12) — kept alongside orders since it
// reads order data via lib/reports.js's getDashboardSummary. No
// dedicated dashboard route file was called for in production.md's
// Stage 3 file list, and this is the closest domain fit — flagged in
// production-progress.md.


router.get('/dashboard/load', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { range = 'month' } = req.query;
  const result = await getDashboardSummary(range);
  res.json({ success: true, dashboard: result });
}));

router.get('/api/orders', requireAuth, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'orderDate', sortDir = 'desc' } = req.query;
  const { page, limit } = parsePagination(req.query);

  const filter = search
    ? {
      $or: [
        { orderID: { $regex: escapeRegex(search), $options: 'i' } },
        { customerName: { $regex: escapeRegex(search), $options: 'i' } },
      ],
    }
    : {};

  const data = await Order.find(filter);
  const mapped = data.map((o) => {
    const avgPayment =
      o.payments && o.payments.length > 0
        ? roundMoney(o.payments.reduce((sum, p) => sum + p.amount, 0) / o.payments.length)
        : 0;
    return {
      _id: o._id,
      orderID: o.orderID,
      customerName: o.customerName,
      totalAmount: o.totalAmount,
      amountPaid: o.amountPaid,
      balanceDue: o.balanceDue,
      creditApplied: o.creditApplied || 0,
      paymentStatus: o.paymentStatus,
      status: o.status,
      displayStatus: o.status === 'refunded' ? 'refunded' : o.paymentStatus,
      avgPayment,
      cashier: o.cashier,
      orderDate: o.orderDate,
      products: o.products,
      editHistory: o.editHistory,
    };
  });

  const { data: orders, total } = sortAndPaginate(mapped, { sortBy, sortDir, page, limit });
  res.json({ success: true, orders, total, page, limit });
}));

router.get('/api/orders/:orderID', requireAuth, asyncHandler(async (req, res) => {
  const order = await Order.findOne({ orderID: req.params.orderID });
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found.' });
  }
  const refunds = await Refund.find({ orderID: req.params.orderID }).sort({ refundDate: -1 });
  res.json({ success: true, order, refunds });
}));

// ── Admin bill editing & refunds (Stage 7) ──────────────────
// Edit and refund share the same core operation — reduce/remove a line
// item, restore the matching stock atomically, log an audit entry, and
// recompute the order's totals from what's left. Refunds additionally
// write a Refund record and permanently mark the order 'refunded'; edits
// don't, and are time-boxed to ORDER_EDIT_WINDOW_MS. Both are
// requireAdmin — this is the first real use of that middleware beyond
// the manual stock-correction route from Stage 3.

// Stage 5: an edit/refund that shrinks totalAmount below what was already
// paid used to leave amountPaid untouched, so the overpayment silently
// vanished (balanceDue just clamped to 0, with no record of the extra
// money anywhere). This now returns that freed-up amount ("settlement")
// so the caller can hand it back as cash or convert it to customer
// credit — either way amountPaid is capped down to the new total so the
// order's own numbers stay internally consistent.
function recomputeOrderTotals(order) {
  order.totalAmount = roundMoney(order.products.reduce((sum, p) => sum + p.amount, 0));
  const settlement = roundMoney(Math.max(0, order.amountPaid - order.totalAmount));
  if (settlement > 0) {
    order.amountPaid = roundMoney(order.amountPaid - settlement);
  }
  order.balanceDue = roundMoney(Math.max(0, order.totalAmount - order.amountPaid));
  order.paymentStatus = order.amountPaid <= 0 ? 'unpaid' : order.balanceDue > 0 ? 'partial' : 'paid';
  return settlement;
}

// Reduces (or removes, if newQty === 0) one line item's quantity,
// proportionally recomputing its $ amount from what that line was
// *actually sold at* (not today's price — an edit/refund reflects the
// original sale), restores the freed stock atomically, and appends one
// editHistory entry. Returns the quantity restored to stock.
async function applyLineReduction(order, productID, newQty, reason, action, editedBy, session) {
  const line = order.products.find((p) => p.productID === productID);
  if (!line) {
    throw new AppError(400, `Order ${order.orderID} has no line item for ${productID}.`);
  }
  if (!Number.isInteger(newQty) || newQty < 0 || newQty > line.quantity) {
    throw new AppError(400, `Invalid new quantity for ${productID}.`);
  }
  if (newQty === line.quantity) {
    return 0; // nothing changed — don't log a no-op
  }

  const originalQty = line.quantity;
  const restoreQty = originalQty - newQty;
  const unitNetPrice = originalQty > 0 ? line.amount / originalQty : 0;
  const unitDiscountAmount = originalQty > 0 ? (line.discountAmount || 0) / originalQty : 0;

  // Stage 22: give back exactly the batch stock (and cost basis) this
  // reduction undoes, before the line's own fields are mutated below —
  // restoreConsumption needs the line's *original* quantity/consumption
  // to know which batches to credit. This keeps the batches usable for a
  // later sale and keeps the dashboard's profit figure from
  // double-counting a line that's been edited down or refunded.
  const { remainingConsumption, costRestored, knownQtyRestored } = await restoreConsumption(
    line.batchConsumption,
    originalQty,
    restoreQty,
    session
  );

  if (newQty === 0) {
    order.products = order.products.filter((p) => p.productID !== productID);
  } else {
    line.quantity = newQty;
    line.amount = roundMoney(unitNetPrice * newQty);
    line.discountAmount = roundMoney(unitDiscountAmount * newQty);
    line.batchConsumption = remainingConsumption;
    line.costAmount = roundMoney(Math.max(0, (line.costAmount || 0) - costRestored));
    line.costQuantity = Math.max(0, (line.costQuantity || 0) - knownQtyRestored);
    line.costSource = deriveCostSource(line.costQuantity, newQty);
  }

  order.editHistory.push({ editedBy, editedAt: new Date(), productID, originalQty, newQty, reason, action });

  const updated = await Product.findOneAndUpdate(
    { productID },
    { $inc: { quantity: restoreQty } },
    { session, new: true }
  );
  if (!updated) {
    throw new AppError(400, `Product ${productID} no longer exists — stock could not be restored.`);
  }

  return restoreQty;
}

// Stage 14 — the reduction-only counterpart above (applyLineReduction)
// can't add a product an order doesn't already have; this adds a new
// line during an exchange the same way checkout adds one (current
// selling price, FIFO cost basis via consumeFIFO), then logs one
// editHistory entry with action 'add'. Rejects a productID the order
// already carries a line for — quantity there stays applyLineReduction's
// job, keeping the two paths from fighting over the same line's fields.
async function applyLineAddition(order, productID, quantity, reason, editedBy, session) {
  if (order.products.some((p) => p.productID === productID)) {
    throw new AppError(400, `Order ${order.orderID} already has a line item for ${productID} — reduce or remove it via edit instead of adding it again.`);
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new AppError(400, `Invalid quantity for ${productID}.`);
  }

  const product = await Product.findOne({ productID }).session(session);
  if (!product) {
    throw new AppError(400, `Product ${productID} does not exist.`);
  }

  // No catalog price set is treated the same as this admin edit flow has
  // always treated it — falls back to 0 rather than propagating null into
  // the money math (roundMoney(null * n) would rely on NaN coercion).
  const currentPrice = getLatestSellingPrice(product) ?? 0;
  const amount = roundMoney(currentPrice * quantity);

  const updated = await Product.findOneAndUpdate(
    { productID, quantity: { $gte: quantity } },
    { $inc: { quantity: -quantity } },
    { session, new: true }
  );
  if (!updated) {
    throw new AppError(409, `Not enough stock for ${productID} to add ${quantity} unit(s).`);
  }
  await disableIfDepleted(updated, session);

  const fifo = await consumeFIFO(productID, quantity, session);

  order.products.push({
    productID,
    quantity,
    amount,
    discount: 0,
    discountType: 'none',
    discountAmount: 0,
    costAmount: fifo.costAmount,
    costQuantity: fifo.costQuantity,
    costSource: deriveCostSource(fifo.costQuantity, quantity),
    batchConsumption: fifo.consumption,
  });

  order.editHistory.push({ editedBy, editedAt: new Date(), productID, originalQty: 0, newQty: quantity, reason, action: 'add' });
}

router.post('/api/order/:orderID/edit', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productID, newQty, reason, action, quantity } = req.body;
  const { orderID } = req.params;
  const isAdd = action === 'add';

  if (!isValidOrderId(orderID)) {
    return res.status(400).json({ success: false, message: 'Invalid order ID.' });
  }
  if (!isValidProductId(productID)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, message: 'A reason is required for every edit.' });
  }
  let qty;
  if (isAdd) {
    qty = parseInt(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid quantity to add.' });
    }
  } else {
    qty = parseInt(newQty);
    if (!Number.isInteger(qty) || qty < 0) {
      return res.status(400).json({ success: false, message: 'Invalid new quantity.' });
    }
  }

  const session = await mongoose.startSession();
  let updatedOrder;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({ orderID }).session(session);
      if (!order) {
        throw new AppError(404, 'Order not found.');
      }
      if (order.status === 'refunded') {
        throw new AppError(400, 'This order has already been refunded and can no longer be edited.');
      }
      const ageMs = Date.now() - new Date(order.orderDate).getTime();
      if (ageMs > ORDER_EDIT_WINDOW_MS) {
        throw new AppError(403, 'The 72-hour edit window for this order has expired.');
      }

      const beforeOrder = order.toObject();
      const beforeBalanceDue = order.balanceDue;
      const historyStartIdx = order.editHistory.length;
      if (isAdd) {
        await applyLineAddition(order, productID, qty, reason.trim(), req.user.username, session);
      } else {
        await applyLineReduction(order, productID, qty, reason.trim(), 'edit', req.user.username, session);
      }
      // Stage 5: an edit is a correction/exchange, not a cash-handling
      // event at the register — any overpayment it frees up is always
      // converted to store credit, never handed back as cash. Adding a
      // line only ever raises the total, so this is 0 for an 'add'.
      const creditGenerated = recomputeOrderTotals(order);
      for (let i = historyStartIdx; i < order.editHistory.length; i++) {
        order.editHistory[i].settlement = creditGenerated > 0 ? 'credit' : 'none';
        order.editHistory[i].creditAmount = creditGenerated;
      }
      await order.save({ session });

      // Single signed delta applied to the customer's running account
      // balance (see lib/customerAccount.js): how much THIS order's own
      // outstanding amount changed, plus whatever of that change is being
      // banked as credit right now. This is what lets a freed-up
      // overpayment from an edit actually pay down a balance the
      // customer carries on a *different* order — it's the same running
      // number, not a separate credit bucket that only checkout ever
      // reads. No-ops harmlessly for a walk-in order, which has no
      // matching Customer document to update.
      const accountDelta = (order.balanceDue - beforeBalanceDue) - creditGenerated;
      await applyCustomerAccountDelta(Customer, order.customerName, accountDelta, session);

      const customerUpdate = {
        $set: {
          'orders.$.totalAmount': order.totalAmount,
          'orders.$.amountPaid': order.amountPaid,
          'orders.$.balanceDue': order.balanceDue,
        },
      };
      if (creditGenerated > 0) {
        customerUpdate.$set['orders.$.creditGenerated'] = creditGenerated;
      }
      // Only a real customer's own order-history entry needs to actually
      // match here — a walk-in order has no Customer document at all
      // (matchedCount 0 for it is expected, not an error).
      if (order.customerName !== WALKIN_CUSTOMER) {
        const customerUpdateResult = await Customer.updateOne(
          { customerName: order.customerName, 'orders.orderNo': order.orderID },
          customerUpdate,
          { session }
        );
        if (customerUpdateResult.matchedCount !== 1) {
          throw new AppError(400, `Customer order history could not be updated for order "${order.orderID}".`);
        }
      }
      await logAudit(
        {
          action: 'order.edited',
          actor: { username: req.user.username, role: req.user.role },
          targetType: 'order',
          targetId: order.orderID,
          before: beforeOrder,
          after: order.toObject(),
        },
        session
      );

      updatedOrder = order;
    });
  } finally {
    await session.endSession();
  }

  res.status(200).json({ success: true, message: 'Order updated.', order: updatedOrder });
}));

// Stage 14 — converts a walk-in order (customerName === WALKIN_CUSTOMER)
// to a real customer inline, so credit an exchange on that order
// generates has somewhere to land. Expects the Customer record to
// already exist (create it first via POST /customer/create); this route
// only reattaches the order.
router.post('/api/order/:orderID/convert-customer', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { orderID } = req.params;
  let { customerName } = req.body;

  if (!isValidOrderId(orderID)) {
    return res.status(400).json({ success: false, message: 'Invalid order ID.' });
  }
  if (!customerName || !customerName.trim()) {
    return res.status(400).json({ success: false, message: 'Customer name is required.' });
  }
  customerName = customerName.trim().replace(/\s+/g, ' ');

  const session = await mongoose.startSession();
  let updatedOrder;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({ orderID }).session(session);
      if (!order) {
        throw new AppError(404, 'Order not found.');
      }
      if (order.customerName !== WALKIN_CUSTOMER) {
        throw new AppError(400, 'This order is already attached to a customer.');
      }

      const customer = await Customer.findOne({ customerName }).session(session);
      if (!customer) {
        throw new AppError(400, `Customer "${customerName}" does not exist — create it first.`);
      }

      const beforeOrder = order.toObject();
      order.customerName = customerName;
      await order.save({ session });

      // This order's own outstanding balanceDue now becomes part of what
      // this customer owes overall — under the old model that happened
      // for free (totalBalanceDue was a live sum over orders[]); now that
      // accountBalance is the one aggregate figure, attaching an order
      // with money still owed on it has to explicitly add that amount,
      // or a walk-in sale with an unpaid balance would silently stop
      // counting toward the customer's standing the moment it's attached.
      // A walk-in order is never overpaid (checkout never banks
      // overpayment for one — see routes/billing.js), so balanceDue here
      // is always >= 0 and this is always a debit, never a credit.
      await applyCustomerAccountDelta(Customer, customerName, order.balanceDue, session);

      await Customer.updateOne(
        { customerName },
        {
          $push: {
            orders: {
              orderNo: order.orderID,
              orderDate: order.orderDate,
              totalAmount: order.totalAmount,
              amountPaid: order.amountPaid,
              balanceDue: order.balanceDue,
              creditApplied: order.creditApplied,
            },
          },
        },
        { session }
      );

      await logAudit(
        {
          action: 'order.customer_attached',
          actor: { username: req.user.username, role: req.user.role },
          targetType: 'order',
          targetId: order.orderID,
          before: beforeOrder,
          after: order.toObject(),
        },
        session
      );

      updatedOrder = order;
    });
  } finally {
    await session.endSession();
  }

  res.status(200).json({ success: true, message: 'Order attached to customer.', order: updatedOrder });
}));

router.post('/api/order/:orderID/refund', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { items, reason, settlement } = req.body;
  const { orderID } = req.params;

  if (!isValidOrderId(orderID)) {
    return res.status(400).json({ success: false, message: 'Invalid order ID.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'No items selected to refund.' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).json({ success: false, message: 'A reason is required for every refund.' });
  }
  // Stage 5: cash-back by default, matching what the register was doing
  // before this stage — an admin may explicitly choose 'credit' instead.
  const requestedSettlement = settlement === 'credit' ? 'credit' : 'cash';
  for (const item of items) {
    if (!isValidProductId(item.productID) || !Number.isInteger(item.quantity) || item.quantity < 1) {
      return res.status(400).json({ success: false, message: 'Invalid refund item.' });
    }
  }

  const session = await mongoose.startSession();
  let refund;
  let updatedOrder;
  try {
    await session.withTransaction(async () => {
      const order = await Order.findOne({ orderID }).session(session);
      if (!order) {
        throw new AppError(404, 'Order not found.');
      }
      if (order.status === 'refunded') {
        throw new AppError(400, 'This order has already been refunded.');
      }

      const beforeOrder = order.toObject();
      const beforeBalanceDue = order.balanceDue;
      const refundedItems = [];
      const historyStartIdx = order.editHistory.length;
      let refundAmount = 0;

      for (const item of items) {
        const line = order.products.find((p) => p.productID === item.productID);
        if (!line) {
          throw new AppError(400, `Order ${orderID} has no line item for ${item.productID}.`);
        }
        if (item.quantity > line.quantity) {
          throw new AppError(400, `Cannot refund more than was ordered for ${item.productID}.`);
        }
        const unitNetPrice = line.quantity > 0 ? line.amount / line.quantity : 0;
        const lineRefundAmount = roundMoney(unitNetPrice * item.quantity);
        refundedItems.push({ productID: item.productID, quantity: item.quantity, amount: lineRefundAmount });
        refundAmount += lineRefundAmount;

        await applyLineReduction(order, item.productID, line.quantity - item.quantity, reason.trim(), 'refund', req.user.username, session);
      }

      refundAmount = roundMoney(refundAmount);
      // Stage 5: this is the overpayment freed up by the refund (which
      // can differ from refundAmount — e.g. a partially-paid order's
      // refund frees up nothing to settle even though items were
      // refunded). Only settled (cash or credit) when > 0.
      const overpaid = recomputeOrderTotals(order);
      const creditGenerated = overpaid > 0 && requestedSettlement === 'credit' ? overpaid : 0;
      const disposition = overpaid > 0 ? requestedSettlement : 'none';
      for (let i = historyStartIdx; i < order.editHistory.length; i++) {
        order.editHistory[i].settlement = disposition;
        order.editHistory[i].creditAmount = creditGenerated;
      }

      // Refunding always finalizes the order — no partial-refund status,
      // per spec ("mark order status: refunded, don't delete").
      order.status = 'refunded';
      await order.save({ session });

      const created = await Refund.create(
        [
          {
            orderID,
            customerName: order.customerName,
            refundAmount,
            refundedItems,
            reason: reason.trim(),
            processedBy: req.user.username,
            settlement: disposition,
            creditGenerated,
          },
        ],
        { session }
      );
      refund = created[0];

      // Same unified account-delta formula as the edit route above: the
      // change in this order's own outstanding amount, plus whatever of
      // that is being banked as credit right now (0 when the admin chose
      // 'cash' — that portion left as physical cash instead, so it never
      // touches the running balance). Unconditional and applied
      // regardless of disposition: even a straight cash refund still
      // needs to correct the ledger down by however much of the order's
      // prior balanceDue this refund erased.
      const accountDelta = (order.balanceDue - beforeBalanceDue) - creditGenerated;
      await applyCustomerAccountDelta(Customer, order.customerName, accountDelta, session);

      const customerUpdate = {
        $set: {
          'orders.$.totalAmount': order.totalAmount,
          'orders.$.amountPaid': order.amountPaid,
          'orders.$.balanceDue': order.balanceDue,
        },
      };
      if (creditGenerated > 0) {
        customerUpdate.$set['orders.$.creditGenerated'] = creditGenerated;
      }
      // Only a real customer's own order-history entry needs to actually
      // match here — a walk-in order has no Customer document at all.
      if (order.customerName !== WALKIN_CUSTOMER) {
        await Customer.updateOne({ customerName: order.customerName, 'orders.orderNo': order.orderID }, customerUpdate, { session });
      }

      await logAudit(
        {
          action: 'order.refunded',
          actor: { username: req.user.username, role: req.user.role },
          targetType: 'order',
          targetId: order.orderID,
          before: beforeOrder,
          after: order.toObject(),
        },
        session
      );

      updatedOrder = order;
    });
  } finally {
    await session.endSession();
  }

  res.status(200).json({ success: true, message: 'Refund processed.', refund, order: updatedOrder });
}));

module.exports = router;
