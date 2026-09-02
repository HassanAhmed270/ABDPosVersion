// Stage 3 — split out of main.js verbatim, no logic changes.
const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Order = require('../models/Order');
const Customer = require('../models/Customers');
const PendingBill = require('../models/PendingBill');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { AppError } = require('../lib/errors');
const { roundMoney } = require('../lib/money');
const { getLatestSellingPrice } = require('../lib/pricing');
const { consumeFIFO, deriveCostSource, disableIfDepleted } = require('../lib/costing');
const { logAudit } = require('../lib/auditLog');
const { applyCustomerAccountDelta } = require('../lib/customerAccount');
const { isValidProductId, isValidOrderId, isValidEmail, isValidPhone } = require('../lib/validators');
const logger = require('../lib/logger');

const router = express.Router();

// Walk-in sentinel: the customerName for a walk-in/unknown-customer sale.
// Chosen to double as the human-readable label everywhere customerName is
// displayed (receipts, Orders list, audit log) — it's a real string stored
// on Order.customerName, not a code, so nothing downstream needs to know
// about it specially except the two spots below that skip the Customer
// collection for it. See CLAUDE.md's "Walk-in → customer conversion" note.
const WALKIN_CUSTOMER = 'Walk-in / Unknown';


// ── Cart stock holds (Stage 3) ──────────────────────────────
// "Available to sell" is always quantity - reserved. Both routes below use
// a single atomic findOneAndUpdate with the guard baked into the *query*
// filter (not a separate read-then-write) so two cashiers adding the same
// last unit at the same instant can't both succeed — the second one's
// filter simply won't match, and Mongo guarantees that at the document
// level regardless of request timing.

router.post('/billing/reserve', requireAuth, asyncHandler(async (req, res) => {
  const { productId, quantity } = req.body;
  const qty = parseInt(quantity);

  if (!isValidProductId(productId)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }
  if (!Number.isInteger(qty) || qty < 1) {
    return res.status(400).json({ success: false, message: 'Invalid quantity.' });
  }

  const updated = await Product.findOneAndUpdate(
    {
      productID: productId,
      // final.md Stage 9: a disabled (zero-stock) product can never be
      // reserved for a new cart, even if this exact check somehow raced
      // past the quantity guard below — belt and suspenders.
      disabled: { $ne: true },
      // quantity - reserved >= qty, evaluated atomically as part of the match
      $expr: { $gte: [{ $subtract: ['$quantity', '$reserved'] }, qty] },
    },
    { $inc: { reserved: qty } },
    { new: true }
  );

  if (!updated) {
    // Either the product doesn't exist, is disabled, or there isn't
    // enough available — tell them apart only for a clearer message, no
    // behavior difference.
    const existing = await Product.findOne({ productID: productId }).select('disabled');
    return res.status(409).json({
      success: false,
      message: !existing ? 'Product not found.' : existing.disabled ? 'This product is disabled (out of stock).' : 'Not enough stock available.',
    });
  }

  res.status(200).json({
    success: true,
    quantity: updated.quantity,
    reserved: updated.reserved,
    available: updated.quantity - updated.reserved,
  });
}));

router.post('/billing/release', requireAuth, asyncHandler(async (req, res) => {
  const { productId, quantity } = req.body;
  const qty = parseInt(quantity);

  if (!isValidProductId(productId)) {
    return res.status(400).json({ success: false, message: 'Invalid product ID.' });
  }
  if (!Number.isInteger(qty) || qty < 1) {
    return res.status(400).json({ success: false, message: 'Invalid quantity.' });
  }

  // Guard reserved >= qty so this can never push reserved negative — if a
  // release comes in "late" (e.g. duplicate call, or the reservation was
  // already consumed by a completed checkout), it's a safe no-op rather
  // than corrupting the count.
  const updated = await Product.findOneAndUpdate(
    { productID: productId, reserved: { $gte: qty } },
    { $inc: { reserved: -qty } },
    { new: true }
  );

  if (!updated) {
    return res.status(200).json({ success: true, message: 'Nothing to release.', released: false });
  }

  res.status(200).json({
    success: true,
    released: true,
    quantity: updated.quantity,
    reserved: updated.reserved,
    available: updated.quantity - updated.reserved,
  });
}));

// ── Draft bills (Stage 4) ───────────────────────────────────
// One in-progress cart per cashier, autosaved from the frontend and
// resumable after a refresh/crash. Commit (below) reads from here, not
// from whatever the client happens to POST — see CLAUDE.md Stage 4.

router.get('/billing/draft', requireAuth, asyncHandler(async (req, res) => {
  const draft = await PendingBill.findOne({ cashier: req.user.username, status: 'active' });
  res.json({ success: true, draft: draft && draft.items.length > 0 ? draft : null });
}));

router.post('/billing/draft', requireAuth, asyncHandler(async (req, res) => {
  const { billID, customerName, items, paidInput, paymentMethod, overpaymentChoice } = req.body;

  if (billID && !isValidOrderId(billID)) {
    return res.status(400).json({ success: false, message: 'Invalid bill ID.' });
  }

  const cleanPaidInput = Number.isFinite(Number(paidInput)) && Number(paidInput) >= 0 ? roundMoney(paidInput) : 0;
  const cleanMethod = ['cash', 'card', 'other'].includes(paymentMethod) ? paymentMethod : 'cash';
  // Stage 19: same quiet-default pattern as cleanMethod above — this
  // autosaves every few seconds, so an unexpected value falls back to
  // 'change' (today's existing behavior) rather than rejecting the save.
  const cleanOverpaymentChoice = ['change', 'balance'].includes(overpaymentChoice) ? overpaymentChoice : 'change';

  // Quietly drop malformed lines rather than rejecting the whole autosave —
  // this runs silently every few seconds, so a hard 400 here would be
  // disruptive for something the cashier didn't directly trigger.
  const cleanItems = Array.isArray(items)
  ? items
      .filter(
        (it) =>
          isValidProductId(it.productID) &&
          typeof it.productName === 'string' &&
          it.productName.trim() &&
          Number.isFinite(Number(it.retailPrice)) &&
          Number(it.retailPrice) >= 0 &&
          Number.isFinite(Number(it.unitPrice)) &&
          Number(it.unitPrice) >= 0 &&
          Number.isInteger(it.quantity) &&
          it.quantity >= 1
      )
      .map((it) => ({
        productID: it.productID,
        productName: it.productName.trim(),
        retailPrice: roundMoney(it.retailPrice),
        unitPrice: roundMoney(it.unitPrice),
        quantity: it.quantity,
      }))
  : [];

  const draft = await PendingBill.findOneAndUpdate(
    { cashier: req.user.username },
    {
      cashier: req.user.username,
      billID: billID || null,
      customerName: customerName || '',
      items: cleanItems,
      paidInput: cleanPaidInput,
      paymentMethod: cleanMethod,
      overpaymentChoice: cleanOverpaymentChoice,
      status: 'active',
      updatedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.status(200).json({ success: true, draft });
}));

router.delete('/billing/draft', requireAuth, asyncHandler(async (req, res) => {
  const draft = await PendingBill.findOne({ cashier: req.user.username, status: 'active' });
  if (!draft) {
    return res.status(200).json({ success: true, message: 'No active draft to discard.' });
  }

  // Release every reservation this draft was holding — same atomic,
  // guarded decrement as POST /billing/release (Stage 3).
  await Promise.all(
    draft.items.map((it) =>
      Product.findOneAndUpdate({ productID: it.productID, reserved: { $gte: it.quantity } }, { $inc: { reserved: -it.quantity } })
    )
  );

  draft.status = 'abandoned';
  draft.items = [];
  draft.updatedAt = new Date();
  await draft.save();

  res.status(200).json({ success: true, message: 'Draft discarded and stock released.' });
}));

router.post('/billing/orderDetails', requireAuth, asyncHandler(async (req, res) => {
  // The draft (autosaved by the frontend as the cart is built — see
  // POST /billing/draft) is the source of truth for what's being
  // committed, not whatever happens to be in this request body. This
  // closes the same class of tampering Stage 2 addressed for price, but
  // for the whole order shape.
  const draft = await PendingBill.findOne({ cashier: req.user.username, status: 'active' });
  if (!draft || draft.items.length === 0) {
    return res.status(400).json({ success: false, message: 'No active bill to commit. Add items to a bill first.' });
  }
  if (!isValidOrderId(draft.billID)) {
    return res.status(400).json({ success: false, message: 'This bill has no order ID yet — go to Preview first.' });
  }
  if (!draft.customerName || draft.customerName === 'unknown') {
    return res.status(400).json({ success: false, message: 'Invalid customer selected.' });
  }

  // Walk-in sale: intentionally has no backing Customer record — it's
  // recorded against the sentinel name only, so there's nothing to
  // look up or require here.
  const isWalkIn = draft.customerName === WALKIN_CUSTOMER;
  const customer = isWalkIn ? null : await Customer.findOne({ customerName: draft.customerName });
  if (!isWalkIn && !customer) {
    return res.status(400).json({ success: false, message: `Customer "${draft.customerName}" not found.` });
  }

  // Everything from here down either all happens or none of it does: the
  // order document, the stock+reservation decrement on every product line,
  // the customer's order-history push, and marking the draft committed. A
  // crash or thrown error at any point rolls the whole thing back — there's
  // no window where an order exists but stock wasn't deducted (or the
  // draft wasn't cleared), or vice versa. On a *thrown* error specifically
  // (bad price, lost stock), the draft rollback means it's left exactly as
  // it was — still active, with its items intact — so the cashier can fix
  // whatever's wrong and retry without losing their cart.
  const session = await mongoose.startSession();
  let order;

  try {
    await session.withTransaction(async () => {
      // Re-read the product's current retail price from the DB.
      // The cashier's entered unitPrice is allowed to be different because
      // it represents the actual selling rate ("Your Rate").
      const verifiedProducts = [];

      for (const item of draft.items) {
        const product = await Product.findOne({ productID: item.productID }).session(session);

        if (!product) {
          throw new AppError(400, `Product ${item.productID} no longer exists.`);
        }

      const currentRetailPrice = roundMoney(getLatestSellingPrice(product));
const capturedRetailPrice = roundMoney(item.retailPrice);
const sellingRate = roundMoney(item.unitPrice);

// Retail price is the database/reference price.
// The cashier's selling rate may intentionally be lower or otherwise
// different from the retail price.
if (Math.abs(currentRetailPrice - capturedRetailPrice) > 0.01) {
  logger.warn(
    {
      productID: item.productID,
      currentRetailPrice,
      capturedRetailPrice,
      sellingRate,
      user: req.user.username,
    },
    'Rejected order: current retail price no longer matches the draft'
  );

  throw new AppError(
    409,
    `Retail price for ${item.productID} has changed since you added it. Please review your bill and try again.`
  );
}

const amount = roundMoney(sellingRate * item.quantity);

verifiedProducts.push({
  productID: item.productID,
  quantity: item.quantity,
  retailPrice: currentRetailPrice,
  unitPrice: sellingRate,
  amount,
});
      }

      // Commit stock: decrement quantity and release the matching
      // reservation together, atomically, guarded in the query filter
      // (not read-then-write) so this can never go negative even under
      // concurrent checkouts. If the guard fails, the reservation this
      // cart held was somehow lost (shouldn't happen in normal use —
      // see CLAUDE.md Stage 3 "still open" for the one known gap) and we
      // abort the whole transaction rather than partially commit.
      for (const p of verifiedProducts) {
        const updated = await Product.findOneAndUpdate(
          { productID: p.productID, quantity: { $gte: p.quantity }, reserved: { $gte: p.quantity } },
          { $inc: { quantity: -p.quantity, reserved: -p.quantity } },
          { session, new: true }
        );

        if (!updated) {
          throw new AppError(409, `Stock for ${p.productID} could not be confirmed. Please refresh and try again.`);
        }

        await disableIfDepleted(updated, session);

        // Stage 22: record which cost batch(es) this line's units
        // actually came from (FIFO — oldest batch first), so the
        // dashboard's profit figure and this line's own historical cost
        // are both fixed at commit time. This never blocks the sale —
        // any quantity beyond what a batch can cover is recorded as
        // unknown-cost, not priced at today's cost (see lib/costing.js).
        const fifo = await consumeFIFO(p.productID, p.quantity, session);
        p.costAmount = fifo.costAmount;
        p.costQuantity = fifo.costQuantity;
        p.costSource = deriveCostSource(fifo.costQuantity, p.quantity);
        p.batchConsumption = fifo.consumption;
      }

      const verifiedTotal = roundMoney(verifiedProducts.reduce((sum, p) => sum + p.amount, 0));

      // Stage 5 (scope extended from routes/orders.js into this route,
      // per an explicit decision — see production-progress.md — since
      // customer store credit is otherwise generated but never used):
      // re-read the customer's current standing inside the transaction
      // (session-scoped, not from an earlier read) purely to compute
      // creditApplied below for the receipt — how much of *this* order
      // was covered by credit the customer already had. Walk-in sales
      // have no Customer document and never carry credit.
      //
      // The actual account update further down no longer needs this
      // value: applyCustomerAccountDelta() below applies one signed delta
      // to accountBalance, which automatically nets against whatever
      // existing credit or debt the customer already had — no separate
      // "apply credit, then check for balance" steps needed, and no
      // window where this read could go stale before the write (the
      // write is a plain $inc, not this value written back).
      let creditApplied = 0;

      if (!isWalkIn) {
        const customerDoc = await Customer.findOne({ customerName: draft.customerName }).session(session);

        if (!customerDoc) {
          throw new AppError(400, `Customer "${draft.customerName}" no longer exists.`);
        }

        const existingCredit = roundMoney(customerDoc.creditBalance || 0);
        creditApplied = roundMoney(Math.min(existingCredit, verifiedTotal));
      }

      const netOwed = roundMoney(verifiedTotal - creditApplied);

      // Payment (Stage 5): a bill no longer has to be paid in full to
      // commit — whatever's short becomes the customer's balanceDue.
      // Capped at netOwed (the total less any credit just applied):
      // anything paid beyond that is change handed back to the
      // customer, not credit applied to the order. This is
      // `draft.paidInput`, not a request param, for the same
      // tamper-resistance reason as everything else committed from the
      // draft (Stage 4).
      const amountPaid = roundMoney(Math.min(Math.max(draft.paidInput || 0, 0), netOwed));
      const balanceDue = roundMoney(Math.max(0, netOwed - amountPaid));
      const paymentStatus = amountPaid <= 0
        ? (balanceDue > 0 ? 'unpaid' : 'paid')
        : balanceDue > 0
          ? 'partial'
          : 'paid';

      const payments = amountPaid > 0
        ? [{ amount: amountPaid, date: new Date(), method: draft.paymentMethod || 'cash' }]
        : [];

      // Stage 19: the amount paid beyond netOwed — same "change" the
      // comment above already described, except now the cashier could
      // have chosen to credit it to the customer's balance instead. A
      // walk-in sale has no Customer document to credit, so this only
      // ever applies alongside the credit-auto-apply block above.
      // Anything except an explicit 'balance' choice keeps today's
      // behavior exactly: the excess is simply never persisted anywhere
      // (handed back as physical change at the register).
      const overpaidAmount = roundMoney(Math.max(0, (draft.paidInput || 0) - netOwed));
      const bankOverpay = !isWalkIn && overpaidAmount > 0 && draft.overpaymentChoice === 'balance';

      // Single signed delta for this whole transaction's effect on the
      // customer's running balance: what this order added minus what
      // actually got applied against it. When the overpaid excess is
      // banked, the entire cash collected (draft.paidInput) counts —
      // that's what makes it able to pay down debt from a completely
      // different order, not just this one, in the same step.
      const effectivePaid = bankOverpay ? roundMoney(Math.max(draft.paidInput || 0, 0)) : amountPaid;
      const accountDelta = roundMoney(verifiedTotal - effectivePaid);

      const created = await Order.create(
        [
          {
            orderID: draft.billID,
            customerName: draft.customerName,
            totalAmount: verifiedTotal,
            products: verifiedProducts,
            cashier: req.user.username,
            amountPaid,
            balanceDue,
            creditApplied,
            paymentStatus,
            payments,
          },
        ],
        { session }
      );

      order = created[0];

      // Walk-in sales don't get a customer order-history push —
      // there's no Customer document to push it onto, and creating one
      // just for this would defeat the point (no unnecessary customer/
      // credit record for an untracked sale).
      if (!isWalkIn) {
        await applyCustomerAccountDelta(Customer, draft.customerName, accountDelta, session);

        await Customer.updateOne(
          { customerName: draft.customerName },
          {
            $push: {
              orders: {
                orderNo: draft.billID,
                orderDate: new Date(),
                totalAmount: verifiedTotal,
                amountPaid,
                balanceDue,
                creditApplied,
              },
            },
          },
          { session }
        );
      }

      // Consume the draft: mark it committed and clear its items so the
      // next bill this cashier starts (same document, upserted by
      // cashier) begins from a clean slate.
      await PendingBill.updateOne(
        { _id: draft._id },
        { status: 'committed', items: [], paidInput: 0, updatedAt: new Date() },
        { session }
      );

      await logAudit(
        {
          action: 'order.created',
          actor: { username: req.user.username, role: req.user.role },
          targetType: 'order',
          targetId: order.orderID,
          before: null,
          after: order.toObject(),
        },
        session
      );
    });
  } finally {
    await session.endSession();
  }

  return res.status(200).json({
    success: true,
    message: 'Order saved and added to customer successfully.',
    order,
    customer,
  });
}));

// Read-only lookup, not a mutation — stays public like the other GET/list endpoints.
router.post('/billing/orderid', asyncHandler(async (req, res) => {
  const { billId } = req.body;
  const existingID = await Order.findOne({ orderID: billId });

  if (existingID) {
    res.status(200).json({ exists: true, orderId: existingID.orderID });
  } else {
    res.status(200).json({ exists: false, orderId: billId });
  }
}));

const { generateCustomerID } = require('../lib/customerID');

router.post('/billing/addCustomer', requireAuth, asyncHandler(async (req, res) => {
  let { customerName, mobileNo, emergencyMobile, email, address } = req.body;

  if (!customerName || customerName.trim() === '') {
    return res.status(400).json({ success: false, message: 'Customer name is required' });
  }

  customerName = customerName.trim().replace(/\s+/g, ' ');
  mobileNo = mobileNo ? mobileNo.trim() : '';
  emergencyMobile = emergencyMobile ? emergencyMobile.trim() : '';
  email = email ? email.trim() : '';
  address = address ? address.trim() : '';

  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'That email address doesn\'t look right.' });
  }

  if (!isValidPhone(mobileNo) || !isValidPhone(emergencyMobile)) {
    return res.status(400).json({ success: false, message: 'That phone number doesn\'t look right.' });
  }

  const existingCustomer = await Customer.findOne({ customerName });

  if (existingCustomer) {
    return res.status(400).json({ success: false, message: 'Customer already exists' });
  }

  const customerID = await generateCustomerID();

  const newCustomer = new Customer({
    customerID,
    customerName,
    mobileNo,
    emergencyMobile,
    email,
    address,
    orders: []
  });

  await newCustomer.save();

  res.status(201).json({
    success: true,
    message: 'Customer added successfully',
    customer: newCustomer
  });
}));

module.exports = router;