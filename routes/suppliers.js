// Stage 3 — split out of main.js verbatim, no logic changes.
const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const StockBatch = require('../models/StockBatch');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { AppError } = require('../lib/errors');
const { roundMoney } = require('../lib/money');
const { getLatestSellingPrice } = require('../lib/pricing');
const { createBatch, generateUniquePurchaseId } = require('../lib/costing');
const { escapeRegex, parsePagination, sortAndPaginate } = require('../lib/query');
const { logAudit } = require('../lib/auditLog');
const { isValidProductId, isValidEmail, isValidPhone } = require('../lib/validators');

const router = express.Router();

// Stage 20: the sentinel supplier value for stock the business bought
// itself, with no external supplier involved — see CLAUDE.md Stage 20.
const NO_SUPPLIER = 'NoSupplier';

// ── Suppliers & purchases (Stage 5) ─────────────────────────
// Mirrors the Customer/Order relationship, but for the other side of the
// ledger: what we owe suppliers instead of what customers owe us.


// ── Suppliers & purchases (Stage 5) ─────────────────────────
// Mirrors the Customer/Order relationship, but for the other side of the
// ledger: what we owe suppliers instead of what customers owe us.

router.get('/api/suppliers', requireAuth, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'supplierName', sortDir = 'asc' } = req.query;
  const { page, limit } = parsePagination(req.query);

  const filter = search
    ? {
      $or: [
        { supplierName: { $regex: escapeRegex(search), $options: 'i' } },
        { contactPerson: { $regex: escapeRegex(search), $options: 'i' } },
      ],
    }
    : {};

  const suppliers = await Supplier.find(filter);
  const mapped = suppliers.map((s) => ({
    _id: s._id,
    supplierName: s.supplierName,
    contactPerson: s.contactPerson,
    phone: s.phone,
    email: s.email,
    address: s.address,
    purchases: s.purchases,
    purchaseCount: s.purchases.length,
    totalBalanceDue: roundMoney(s.purchases.reduce((sum, p) => sum + (p.balanceDue || 0), 0)),
    // Stage 21 credit fix: what this supplier currently owes *us* from a
    // past overpayment, automatically applied to reduce what's owed on
    // their next purchase — see POST /supplier/purchase. Independent of
    // totalBalanceDue above (that's what we owe them; this is the
    // reverse), so a supplier can show both a balance due *and* a credit
    // at the same time if purchases happened in that order.
    creditBalance: roundMoney(s.creditBalance || 0),
  }));

  const { data: withBalance, total } = sortAndPaginate(mapped, { sortBy, sortDir, page, limit });
  res.json({ success: true, suppliers: withBalance, total, page, limit });
}));

router.post('/api/supplier', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  let {
    supplierName,
    contactPerson,
    phone,
    email,
    address,
    amountPaid,
  } = req.body;

  if (!supplierName || !supplierName.trim()) {
    return res.status(400).json({
      success: false,
      message: 'Supplier name is required.',
    });
  }

  supplierName = supplierName.trim().replace(/\s+/g, ' ');
  phone = phone ? phone.trim() : '';
  email = email ? email.trim() : '';

  if (!isValidEmail(email)) {
    return res.status(400).json({
      success: false,
      message: "That email address doesn't look right.",
    });
  }

  if (!isValidPhone(phone)) {
    return res.status(400).json({
      success: false,
      message: "That phone number doesn't look right.",
    });
  }

  // Payment / balance adjustment is optional.
  // Blank or omitted means no adjustment.
  const hasAmountPaid =
    amountPaid !== undefined &&
    amountPaid !== null &&
    amountPaid !== '';

  if (
    hasAmountPaid &&
    (
      !Number.isFinite(Number(amountPaid)) ||
      Number(amountPaid) < 0
    )
  ) {
    return res.status(400).json({
      success: false,
      message: 'Invalid amount paid.',
    });
  }

  const adjustmentAmount = roundMoney(
    hasAmountPaid ? Number(amountPaid) : 0
  );

  const beforeSupplier = await Supplier.findOne({ supplierName });

  // ---------------------------------------------------------
  // ADD SUPPLIER
  // ---------------------------------------------------------
  // When there is no existing supplier, amountPaid is ignored.
  // A new supplier must always start with no purchases and no
  // manually-created opening balance.
  if (!beforeSupplier) {
    const supplier = await Supplier.findOneAndUpdate(
      { supplierName },
      {
        supplierName,
        contactPerson: contactPerson || '',
        phone,
        email,
        address: address || '',
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    await logAudit({
      action: 'supplier.created',
      actor: {
        username: req.user.username,
        role: req.user.role,
      },
      targetType: 'supplier',
      targetId: supplierName,
      before: null,
      after: supplier.toObject(),
    });

    return res.status(200).json({
      success: true,
      message: 'Supplier saved successfully',
      supplier,
    });
  }

  // ---------------------------------------------------------
  // EDIT EXISTING SUPPLIER
  // ---------------------------------------------------------
  // Supplier details are updated normally.
  // The adjustment is applied ONLY to existing outstanding
  // purchases. No fake purchase is created.
  //
  // creditBalance is deliberately NOT changed.
  // ---------------------------------------------------------

  const beforeSnapshot = beforeSupplier.toObject();

  const session = await mongoose.startSession();

  let supplier;

  try {
    await session.withTransaction(async () => {
      supplier = await Supplier.findOne({
        _id: beforeSupplier._id,
      }).session(session);

      if (!supplier) {
        throw new AppError(404, 'Supplier not found.');
      }

      // Update normal supplier details exactly as before.
      supplier.supplierName = supplierName;
      supplier.contactPerson = contactPerson || '';
      supplier.phone = phone;
      supplier.email = email;
      supplier.address = address || '';

      // -----------------------------------------------------
      // Apply payment to EXISTING outstanding purchases.
      //
      // Oldest outstanding purchase is paid first.
      // -----------------------------------------------------
      let remainingAdjustment = adjustmentAmount;

      if (remainingAdjustment > 0) {
        for (const purchase of supplier.purchases) {
          if (remainingAdjustment <= 0) {
            break;
          }

          const currentBalance = roundMoney(
            purchase.balanceDue || 0
          );

          if (currentBalance <= 0) {
            continue;
          }

          const paymentForPurchase = roundMoney(
            Math.min(currentBalance, remainingAdjustment)
          );

          purchase.balanceDue = roundMoney(
            currentBalance - paymentForPurchase
          );

          purchase.amountPaid = roundMoney(
            (purchase.amountPaid || 0) + paymentForPurchase
          );

          remainingAdjustment = roundMoney(
            remainingAdjustment - paymentForPurchase
          );
        }
      }

      await supplier.save({ session });

      // Audit the actual balance adjustment.
      if (adjustmentAmount > 0) {
        await logAudit(
          {
            action: 'supplier.payment.adjusted',
            actor: {
              username: req.user.username,
              role: req.user.role,
            },
            targetType: 'supplier',
            targetId: supplier.supplierName,

            before: {
              supplierName: beforeSupplier.supplierName,
              contactPerson: beforeSupplier.contactPerson,
              phone: beforeSupplier.phone,
              email: beforeSupplier.email,
              address: beforeSupplier.address,
              totalBalanceDue: roundMoney(
                beforeSupplier.purchases.reduce(
                  (sum, purchase) => sum + (purchase.balanceDue || 0),
                  0
                )
              ),
              creditBalance: roundMoney(beforeSupplier.creditBalance || 0),
            },

            after: {
              supplierName: supplier.supplierName,
              contactPerson: supplier.contactPerson,
              phone: supplier.phone,
              email: supplier.email,
              address: supplier.address,

              adjustmentAmount,
              totalBalanceDue: roundMoney(
                supplier.purchases.reduce(
                  (sum, purchase) => sum + (purchase.balanceDue || 0),
                  0
                )
              ),
              creditBalance: roundMoney(supplier.creditBalance || 0),
              unappliedAmount: remainingAdjustment,
            },
          },
          session
        );
      } else {
        await logAudit(
          {
            action: 'supplier.updated',
            actor: {
              username: req.user.username,
              role: req.user.role,
            },
            targetType: 'supplier',
            targetId: supplier.supplierName,
            before: beforeSnapshot,
            after: supplier.toObject(),
          },
          session
        );
      }
    });
  } finally {
    await session.endSession();
  }

  return res.status(200).json({
    success: true,
    message:
      adjustmentAmount > 0
        ? 'Supplier updated and payment applied successfully.'
        : 'Supplier saved successfully',
    supplier,
    amountPaid: adjustmentAmount,
  });
}));

router.delete('/supplier/:supplierName', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const deleted = await Supplier.findOneAndDelete({ supplierName: req.params.supplierName });
  if (!deleted) {
    return res.status(404).json({ success: false, message: 'Supplier not found.' });
  }
  // NOTE: unlike products/customers, there's no undo for this (Stage 5
  // scope) — a supplier's own purchase history goes with it. Deleting a
  // supplier does not touch Product.buyingPriceHistory entries that
  // reference it; those stay as a historical record.
  await logAudit({
    action: 'supplier.deleted',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'supplier',
    targetId: deleted.supplierName,
    before: deleted.toObject(),
    after: null,
  });
  res.status(200).json({ success: true, message: 'Supplier deleted successfully' });
}));

// Records a restock: creates the purchase record (with its own payment/
// balance tracking, mirroring Order), increments stock, and appends to
// each product's buyingPriceHistory — all atomically, same transaction
// pattern as POST /billing/orderDetails (Stage 3/4), since this touches
// money and stock together just like a sale does.
//
// final.md Stage 9: this route now always requires a real, existing
// Supplier — self-purchase (formerly the NO_SUPPLIER/"Buy Myself"
// option here) moved to its own dedicated Add Stock action on the
// Products page (routes/products.js's POST /api/product/:productID/
// add-stock), which uses the same NoSupplier-tagged-batch pattern
// Stage 7 established for a brand-new product's initial stock.
//
// Stage 21: each item may *optionally* carry a `sellingPrice` alongside
// its (required) `unitCost` — restocking is now allowed to update what
// customers are charged, not just what the business paid. This is the
// exact same "only record a history entry if the price actually moved"
// rule POST /api/product already uses for sellingPriceHistory (see
// below), so a restock that doesn't touch selling price is a no-op on
// that array, and a restock that does is immediately what Billing/
// Products/receipts see — same array, same getLatestSellingPrice()
// reader, no separate "restock price" concept. buyingPriceHistory is
// updated the same as before regardless; the two histories never touch
// each other.
// Stage 21 credit fix: overpaying a purchase used to just get silently
// capped at the total (`Math.min(paid, totalAmount)`), so the extra
// money vanished from every record instead of being tracked anywhere.
// Now: amountPaid is no longer capped, and if it exceeds what's owed
// (after any existing credit is applied — see below), the excess becomes
// supplier credit (Supplier.creditBalance) that automatically reduces
// what's owed on the *next* purchase from the same supplier. A single
// purchase's own balanceDue still never goes negative — the credit lives
// on the supplier document, not as a negative number on one purchase.
router.post('/supplier/purchase', requireAuth, asyncHandler(async (req, res) => {
  const { supplierName, items, amountPaid } = req.body;

  if (!supplierName || !supplierName.trim() || supplierName === NO_SUPPLIER) {
    return res.status(400).json({ success: false, message: 'Supplier is required.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'No items in this purchase.' });
  }
  for (const item of items) {
    if (!isValidProductId(item.productID)) {
      return res.status(400).json({ success: false, message: `"${item.productID}" is not a valid product ID.` });
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1) {
      return res.status(400).json({ success: false, message: `Invalid quantity for ${item.productID}.` });
    }
    if (!Number.isFinite(Number(item.unitCost)) || Number(item.unitCost) < 0) {
      return res.status(400).json({ success: false, message: `Invalid unit cost for ${item.productID}.` });
    }
    // sellingPrice is optional — omit/blank means "don't touch the
    // selling price this restock", not "set it to zero". Only validate
    // when something was actually submitted.
    const hasSellingPrice = item.sellingPrice !== undefined && item.sellingPrice !== null && item.sellingPrice !== '';
    if (hasSellingPrice && (!Number.isFinite(Number(item.sellingPrice)) || Number(item.sellingPrice) < 0)) {
      return res.status(400).json({ success: false, message: `Invalid selling price for ${item.productID}.` });
    }
  }
  // Stage 21 credit fix: amountPaid used to be silently coerced to 0 on
  // anything non-numeric (`Number(amountPaid) || 0`) — garbage input just
  // vanished instead of erroring. Now validated the same way item fields
  // are: blank/omitted means "0 paid" (still valid), anything present
  // must be a real non-negative number.
  const hasAmountPaid = amountPaid !== undefined && amountPaid !== null && amountPaid !== '';
  if (hasAmountPaid && (!Number.isFinite(Number(amountPaid)) || Number(amountPaid) < 0)) {
    return res.status(400).json({ success: false, message: 'Invalid amount paid.' });
  }
  const paidInput = roundMoney(hasAmountPaid ? Number(amountPaid) : 0);

  const supplier = await Supplier.findOne({ supplierName: supplierName.trim().replace(/\s+/g, ' ') });
  if (!supplier) {
    return res.status(400).json({ success: false, message: `Supplier "${supplierName}" not found.` });
  }

  const cleanItems = items.map((it) => {
    const hasSellingPrice = it.sellingPrice !== undefined && it.sellingPrice !== null && it.sellingPrice !== '';
    return {
      productID: it.productID,
      quantity: parseInt(it.quantity),
      unitCost: roundMoney(it.unitCost),
      // Kept off the object entirely (not just undefined) when not
      // submitted, so it never gets pushed into Supplier.purchases or the
      // audit log as a spurious "sellingPrice: undefined".
      ...(hasSellingPrice ? { sellingPrice: roundMoney(it.sellingPrice) } : {}),
    };
  });
  const totalAmount = roundMoney(cleanItems.reduce((sum, it) => sum + it.unitCost * it.quantity, 0));
  const purchaseID = await generateUniquePurchaseId();
  // The real (credit-aware) math happens inside the transaction below,
  // once the supplier's current creditBalance can be read consistently.
  let paid = null;
  let balanceDue = null;
  let creditApplied = 0;
  let creditGenerated = 0;
  let newCreditBalance = 0;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const item of cleanItems) {
        const product = await Product.findOne({ productID: item.productID }).session(session);
        if (!product) {
          throw new AppError(400, `Product ${item.productID} no longer exists.`);
        }
        product.quantity += item.quantity;
        product.buyingPriceHistory.push({
          price: item.unitCost,
          date: new Date(),
          supplierID: supplier._id,
        });
        // Stage 21: only append a new sellingPriceHistory entry if a
        // selling price was actually submitted for this item AND it
        // differs from the current one — identical to the "did the price
        // move" guard POST /api/product uses. buyingPriceHistory (above)
        // is completely separate and always updates regardless.
        if (item.sellingPrice !== undefined) {
          const currentSellingPrice = roundMoney(getLatestSellingPrice(product));
          if (item.sellingPrice > 0 && item.sellingPrice !== currentSellingPrice) {
            product.sellingPriceHistory.push({ price: item.sellingPrice, date: new Date() });
          }
        }
        await product.save({ session });

        // Stage 22: every restock is its own distinct cost batch —
        // consumed oldest-first by a future sale (lib/costing.js).
        await createBatch({
          productID: item.productID,
          supplierID: supplier._id,
          purchaseID,
          quantity: item.quantity,
          unitCost: item.unitCost,
          session,
        });
      }

      // Stage 21 credit fix: re-read the supplier's creditBalance
      // inside the transaction (session-scoped), not from the `supplier`
      // fetched before the transaction started — another purchase could
      // have changed it in between. Any existing credit is applied to
      // *this* purchase's total first; only what's left after that is
      // "owed", and only overpaying *that* remainder creates new credit.
      const supplierDoc = await Supplier.findOne({ _id: supplier._id }).session(session);
      if (!supplierDoc) {
        throw new AppError(400, `Supplier "${supplierName}" no longer exists.`);
      }
      const existingCredit = roundMoney(supplierDoc.creditBalance || 0);
      creditApplied = roundMoney(Math.min(existingCredit, totalAmount));
      const netOwed = roundMoney(totalAmount - creditApplied);
      creditGenerated = roundMoney(Math.max(0, paidInput - netOwed));
      paid = paidInput; // what was actually paid this transaction, recorded as-is (no longer capped)
      balanceDue = roundMoney(Math.max(0, netOwed - paidInput));
      newCreditBalance = roundMoney(existingCredit - creditApplied + creditGenerated);

      // Note: Supplier.purchases' item sub-schema (models/Supplier.js)
      // doesn't declare a `sellingPrice` field, so Mongoose silently
      // strips it here even though cleanItems carries it — intentional,
      // not a bug. A supplier's purchase-history table is a record of
      // what was bought/owed, not a place selling-price changes need to
      // live twice; the actual record of the change is
      // Product.sellingPriceHistory (updated above) and this action's
      // own audit-log entry (below, which does keep it — before Mongo
      // schema stripping applies).
      await Supplier.updateOne(
        { _id: supplier._id },
        {
          $set: { creditBalance: newCreditBalance },
          $push: { purchases: { purchaseID, totalAmount, amountPaid: paid, balanceDue, creditApplied, creditGenerated, items: cleanItems } },
        },
        { session }
      );

      await logAudit(
        {
          action: 'supplier.purchase',
          actor: { username: req.user.username, role: req.user.role },
          targetType: 'supplier',
          targetId: supplier.supplierName,
          before: null,
          after: {
            purchaseID,
            supplierName: supplier.supplierName,
            items: cleanItems,
            totalAmount,
            amountPaid: paid,
            balanceDue,
            creditApplied,
            creditGenerated,
            newCreditBalance,
          },
        },
        session
      );
    });
  } finally {
    await session.endSession();
  }

  res.status(201).json({
    success: true,
    message: 'Purchase recorded and stock updated.',
    purchaseID,
    totalAmount,
    amountPaid: paid,
    balanceDue,
    creditApplied,
    creditGenerated,
    creditBalance: newCreditBalance,
  });
}));

module.exports = router;
