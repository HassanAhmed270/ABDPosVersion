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
const {
  logAudit,
  supplierFinancialSnapshot,
} = require('../lib/auditLog');
const { isValidProductId, isValidEmail, isValidPhone } = require('../lib/validators');

const router = express.Router();
const NO_SUPPLIER = 'NoSupplier';

router.get('/api/suppliers', requireAuth, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'supplierName', sortDir = 'asc' } = req.query;
  const { page, limit } = parsePagination(req.query);
  const filter = search
  ? {
      $or: [
        {
          supplierName: {
            $regex: escapeRegex(search),
            $options: 'i',
          },
        },
        {
          contactPerson: {
            $regex: escapeRegex(search),
            $options: 'i',
          },
        },
        {
          'purchases.billID': {
            $regex: escapeRegex(search),
            $options: 'i',
          },
        },
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
    creditBalance,
    billID,
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
  const hasCreditBalance =
    creditBalance !== undefined &&
    creditBalance !== null &&
    creditBalance !== '';
  if (
    hasCreditBalance &&
    !Number.isFinite(Number(creditBalance))
  ) {
    return res.status(400).json({
      success: false,
      message: 'Invalid supplier balance.',
    });
  }
  const initialCreditBalance = roundMoney(
    hasCreditBalance
      ? Number(creditBalance)
      : 0
  );
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
  const beforeSupplier = await Supplier.findOne({
    supplierName
  });
  if (!beforeSupplier) {
    const supplier = await Supplier.findOneAndUpdate(
      { supplierName },
      {
        supplierName,
        contactPerson: contactPerson || '',
        phone,
        email,
        address: address || '',
        creditBalance: initialCreditBalance,
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
      supplier.supplierName = supplierName;
      supplier.contactPerson = contactPerson || '';
      supplier.phone = phone;
      supplier.email = email;
      supplier.address = address || '';
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
            Math.min(
              currentBalance,
              remainingAdjustment
            )
          );
          purchase.balanceDue = roundMoney(
            currentBalance - paymentForPurchase
          );
          purchase.amountPaid = roundMoney(
            (purchase.amountPaid || 0) +
            paymentForPurchase
          );
          remainingAdjustment = roundMoney(
            remainingAdjustment -
            paymentForPurchase
          );
        }
      }
      if (remainingAdjustment > 0) {
        supplier.creditBalance = roundMoney(
          (supplier.creditBalance || 0) +
          remainingAdjustment
        );
      }
      await supplier.save({ session });
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
              financial:
                supplierFinancialSnapshot(
                  beforeSupplier
                ),
            },
            after: {
              supplierName: supplier.supplierName,
              financial:
                supplierFinancialSnapshot(
                  supplier
                ),
              payment: {
                amount: roundMoney(
                  adjustmentAmount
                ),
                unappliedAmount: roundMoney(
                  remainingAdjustment
                ),
              },
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
            before: {
              supplierName:
                beforeSupplier.supplierName,
              financial:
                supplierFinancialSnapshot(
                  beforeSupplier
                ),
            },
            after: {
              supplierName:
                supplier.supplierName,
              financial:
                supplierFinancialSnapshot(
                  supplier
                ),
            },
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
  await logAudit({
    action: 'supplier.deleted',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'supplier',
    targetId: deleted.supplierName,
    before: {
      supplierName: deleted.supplierName,
      financial: supplierFinancialSnapshot(deleted),
    },
    after: null,
  });
  res.status(200).json({ success: true, message: 'Supplier deleted successfully' });
}));

router.post('/supplier/purchase', requireAuth, asyncHandler(async (req, res) => {
  const { supplierName, items, amountPaid, billID } = req.body;
  if (!supplierName || !supplierName.trim() || supplierName === NO_SUPPLIER) {
    return res.status(400).json({ success: false, message: 'Supplier is required.' });
  }
  const cleanBillID =
    billID !== undefined && billID !== null
      ? String(billID).trim()
      : '';
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
    const hasSellingPrice = item.sellingPrice !== undefined && item.sellingPrice !== null && item.sellingPrice !== '';
    if (hasSellingPrice && (!Number.isFinite(Number(item.sellingPrice)) || Number(item.sellingPrice) < 0)) {
      return res.status(400).json({ success: false, message: `Invalid selling price for ${item.productID}.` });
    }
  }
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
      ...(hasSellingPrice ? { sellingPrice: roundMoney(it.sellingPrice) } : {}),
    };
  });
  const totalAmount = roundMoney(cleanItems.reduce((sum, it) => sum + it.unitCost * it.quantity, 0));
  const purchaseID = await generateUniquePurchaseId();
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
        if (item.sellingPrice !== undefined) {
          const currentSellingPrice = getLatestSellingPrice(product);
          if (item.sellingPrice > 0 && item.sellingPrice !== currentSellingPrice) {
            product.sellingPriceHistory.push({ price: item.sellingPrice, date: new Date() });
          }
        }
        await product.save({ session });
        await createBatch({
          productID: item.productID,
          supplierID: supplier._id,
          purchaseID,
          quantity: item.quantity,
          unitCost: item.unitCost,
          session,
        });
      }
      const supplierDoc = await Supplier.findOne({ _id: supplier._id }).session(session);
      if (!supplierDoc) {
        throw new AppError(400, `Supplier "${supplierName}" no longer exists.`);
      }
      const existingCredit = roundMoney(supplierDoc.creditBalance || 0);
      creditApplied = roundMoney(Math.min(existingCredit, totalAmount));
      const netOwed = roundMoney(totalAmount - creditApplied);
      creditGenerated = roundMoney(Math.max(0, paidInput - netOwed));
      paid = paidInput;
      balanceDue = roundMoney(Math.max(0, netOwed - paidInput));
      newCreditBalance = roundMoney(existingCredit - creditApplied + creditGenerated);
      await Supplier.updateOne(
        { _id: supplier._id },
        {
          $set: { creditBalance: newCreditBalance },
          $push: {
            purchases: {
              purchaseID,
              billID: cleanBillID,
              totalAmount,
              amountPaid: paid,
              balanceDue,
              creditApplied,
              creditGenerated,
              items: cleanItems
            }
          },
        },
        { session }
      );
      const afterSupplier = await Supplier
        .findOne({ _id: supplier._id })
        .session(session);
      await logAudit(
        {
          action: 'supplier.purchase',
          actor: {
            username: req.user.username,
            role: req.user.role,
          },
          targetType: 'supplier',
          targetId: supplier.supplierName,
          before: {
            financial: supplierFinancialSnapshot(supplier),
          },
          after: {
            purchase: {
              purchaseID,
              billID: cleanBillID,
              items: cleanItems,
              totalAmount: roundMoney(totalAmount),
              amountPaid: roundMoney(paid),
              balanceDue: roundMoney(balanceDue),
              creditApplied: roundMoney(creditApplied),
              creditGenerated: roundMoney(creditGenerated),
            },
            financial: supplierFinancialSnapshot(afterSupplier),
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
    billID: cleanBillID,
    totalAmount,
    amountPaid: paid,
    balanceDue,
    creditApplied,
    creditGenerated,
    creditBalance: newCreditBalance,
  });
}));

module.exports = router;