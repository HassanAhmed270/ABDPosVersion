// Stage 11 — Offline Sync Module. Entirely optional and self-contained:
// delete this file, lib/offlineSync.js, models/OfflineSale.js, and the
// one mount line + require in main.js, and nothing else changes. Nothing
// in the live billing/draft/reservation flow (Stage 3/4) depends on this
// existing — see lib/offlineSync.js's header comment for why the commit
// logic is a separate path rather than a shared one.
const express = require('express');
const OfflineSale = require('../models/OfflineSale');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { AppError } = require('../lib/errors');
const { isValidProductId } = require('../lib/validators');
const { roundMoney } = require('../lib/money');
const { syncOfflineSale } = require('../lib/offlineSync');
const logger = require('../lib/logger');

const router = express.Router();

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) return null;

  const clean = [];

  for (const it of items) {
    if (
      !isValidProductId(it.productID) ||
      typeof it.productName !== 'string' ||
      !it.productName.trim() ||
      !Number.isFinite(Number(it.retailPrice)) ||
      Number(it.retailPrice) < 0 ||
      !Number.isFinite(Number(it.unitPrice)) ||
      Number(it.unitPrice) < 0 ||
      !Number.isInteger(it.quantity) ||
      it.quantity < 1
    ) {
      return null;
    }

    clean.push({
      productID: it.productID,
      productName: it.productName.trim(),
      retailPrice: roundMoney(it.retailPrice),
      unitPrice: roundMoney(it.unitPrice),
      quantity: it.quantity
    });
  }

  return clean;
}

// POST /api/sync/commit — replay one queued offline sale. Idempotent by
// design: the same idempotencyKey retried (flaky reconnect, duplicate
// flush from the client's queue) returns the same result instead of
// creating a second order.
router.post(
  '/commit',
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      idempotencyKey,
      customerName,
      items,
      paidInput,
      paymentMethod,
      clientBillID,
      createdOfflineAt
    } = req.body;

    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid idempotency key.'
      });
    }

    if (!customerName || typeof customerName !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Customer name is required.'
      });
    }

    const cleanItems = validateItems(items);

    if (!cleanItems) {
      return res.status(400).json({
        success: false,
        message: 'This offline sale has invalid or missing items.'
      });
    }

    const offlineTimestamp = new Date(createdOfflineAt);

    if (!createdOfflineAt || Number.isNaN(offlineTimestamp.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid offline timestamp.'
      });
    }

    // Already resolved (by this call or an earlier retry that raced it) —
    // hand back the existing outcome rather than re-processing.
    const existing = await OfflineSale.findOne({ idempotencyKey });

    if (existing) {
      return res.status(existing.status === 'synced' ? 200 : 409).json({
        success: existing.status === 'synced',
        alreadyProcessed: true,
        status: existing.status,
        orderID: existing.resultingOrderID,
        message:
          existing.status === 'synced'
            ? 'Already synced.'
            : existing.conflictReason ||
              'This offline sale is already flagged for review.'
      });
    }

    // Build the record first (status defaults to 'conflict') so that even
    // if the process crashes mid-commit, this offline sale is durably on
    // the server and shows up for admin review rather than being lost.
    const offlineSale = await OfflineSale.create({
      idempotencyKey,
      clientBillID: /^#\d{4}$/.test(clientBillID || '')
        ? clientBillID
        : null,
      cashier: req.user.username,
      customerName: customerName.trim().replace(/\s+/g, ' '),
      items: cleanItems,
      paidInput:
        Number.isFinite(Number(paidInput)) && Number(paidInput) >= 0
          ? roundMoney(paidInput)
          : 0,
      paymentMethod: ['cash', 'card', 'other'].includes(paymentMethod)
        ? paymentMethod
        : 'cash',
      createdOfflineAt: offlineTimestamp
    });

    const { order, conflictReason } = await syncOfflineSale(
      offlineSale,
      { cashier: req.user.username }
    );

    if (order) {
      offlineSale.status = 'synced';
      offlineSale.resultingOrderID = order.orderID;
      await offlineSale.save();

      logger.info(
        {
          idempotencyKey,
          orderID: order.orderID,
          cashier: req.user.username
        },
        'Offline sale synced'
      );

      return res.status(200).json({
        success: true,
        status: 'synced',
        orderID: order.orderID
      });
    }

    offlineSale.status = 'conflict';
    offlineSale.conflictReason =
      conflictReason || 'Could not be synced.';
    await offlineSale.save();

    logger.warn(
      {
        idempotencyKey,
        cashier: req.user.username,
        reason: conflictReason
      },
      'Offline sale flagged for review'
    );

    return res.status(409).json({
      success: false,
      status: 'conflict',
      message: offlineSale.conflictReason
    });
  })
);

// GET /api/sync/conflicts — admin queue of offline sales needing a human
// decision (stock ran out in the meantime, retail price moved, customer/
// product deleted, etc).
router.get(
  '/conflicts',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const conflicts = await OfflineSale.find({
      status: 'conflict'
    }).sort({ receivedAt: 1 });

    res.json({
      success: true,
      conflicts
    });
  })
);

// POST /api/sync/conflicts/:id/resolve — admin decides. 'retry' re-runs
// the same commit logic (useful once stock's been topped up); 'reject'
// permanently discards it — no order is ever created for a rejected sale.
router.post(
  '/conflicts/:id/resolve',
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { action, reason } = req.body;

    if (!['retry', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'action must be "retry" or "reject".'
      });
    }

    const offlineSale = await OfflineSale.findById(req.params.id);

    if (!offlineSale) {
      throw new AppError(404, 'Offline sale not found.');
    }

    if (offlineSale.status !== 'conflict') {
      return res.status(409).json({
        success: false,
        message: `Already resolved (${offlineSale.status}).`
      });
    }

    if (action === 'reject') {
      offlineSale.status = 'rejected';
      offlineSale.conflictReason =
        reason || offlineSale.conflictReason;
      offlineSale.resolvedBy = req.user.username;
      offlineSale.resolvedAt = new Date();

      await offlineSale.save();

      return res.json({
        success: true,
        status: 'rejected'
      });
    }

    // action === 'retry'
    const { order, conflictReason } = await syncOfflineSale(
      offlineSale,
      { cashier: offlineSale.cashier }
    );

    offlineSale.resolvedBy = req.user.username;
    offlineSale.resolvedAt = new Date();

    if (order) {
      offlineSale.status = 'synced';
      offlineSale.resultingOrderID = order.orderID;

      await offlineSale.save();

      return res.json({
        success: true,
        status: 'synced',
        orderID: order.orderID
      });
    }

    offlineSale.conflictReason =
      conflictReason || offlineSale.conflictReason;

    await offlineSale.save();

    return res.status(409).json({
      success: false,
      status: 'conflict',
      message: offlineSale.conflictReason
    });
  })
);

module.exports = router;