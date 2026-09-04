// Stage 3 — split out of main.js verbatim, no logic changes.
const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Counter = require('../models/Counter');
const Loss = require('../models/Loss');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { AppError } = require('../lib/errors');
const { roundMoney } = require('../lib/money');
const { getLatestSellingPrice, getLatestBuyingPrice } = require('../lib/pricing');
const { createBatch, generateUniquePurchaseId, consumeFIFO, consumeSpecificBatch, listRemainingBatches, disableIfDepleted } = require('../lib/costing');
const { escapeRegex, parsePagination, sortAndPaginate } = require('../lib/query');
const { logAudit } = require('../lib/auditLog');
const { isValidProductId } = require('../lib/validators');

const router = express.Router();

// Stage 20: the sentinel supplier value for stock the business bought
// itself, with no external supplier involved — see CLAUDE.md Stage 20.
const NO_SUPPLIER = 'NoSupplier';

// Defaults to 10 (matches the Product schema default) for missing/invalid input.
function parseThreshold(value) {
  if (value === undefined || value === null || value === '') return 10;
  const n = parseInt(value);
  return Number.isInteger(n) && n >= 0 ? n : 10;
}

// Stage 20: resolves whatever the Product/restock forms submit for
// "supplier" into either a real Supplier _id or null (self-purchased /
// NoSupplier). Rejects anything that isn't a valid, *existing* Supplier
// id — per Stage 20's exit criteria, an arbitrary/stale id must 400, not
// be silently accepted or silently coerced to null.
// Stage 2 (final.md) — server-generated sequential Product IDs for
// newly-created products. Backed by a Counter doc rather than
// max(existing productID), so a deleted product's ID is never reissued.
// Lazily seeded from the current max productID the first time it's used,
// so pre-existing data doesn't collide with freshly generated IDs.
async function nextProductId() {
  let counter = await Counter.findById('productId');
  if (!counter) {
    const highest = await Product.findOne({ productID: /^#\d{4}$/ }).sort({ productID: -1 }).lean();
    const seed = highest ? parseInt(highest.productID.slice(1), 10) : 0;
    counter = await Counter.findOneAndUpdate(
      { _id: 'productId' },
      { $setOnInsert: { seq: seed } },
      { new: true, upsert: true }
    );
  }
  const updated = await Counter.findOneAndUpdate({ _id: 'productId' }, { $inc: { seq: 1 } }, { new: true });
  return `#${String(updated.seq).padStart(4, '0')}`;
}

async function resolveSupplierId(rawSupplierId) {
  if (!rawSupplierId || rawSupplierId === NO_SUPPLIER) return { ok: true, value: null };
  if (!mongoose.Types.ObjectId.isValid(rawSupplierId)) return { ok: false };
  const exists = await Supplier.exists({ _id: rawSupplierId });
  return exists ? { ok: true, value: rawSupplierId } : { ok: false };
}

router.get('/api/products', requireAuth, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'productID', sortDir = 'asc' } = req.query;
  const { page, limit } = parsePagination(req.query);

  const filter = search
    ? {
      $or: [
        { productID: { $regex: escapeRegex(search), $options: 'i' } },
        { productName: { $regex: escapeRegex(search), $options: 'i' } },
        { category: { $regex: escapeRegex(search), $options: 'i' } },
      ],
    }
    : {};

  const data = await Product.find(
    filter,
    'productID productName category sellingPriceHistory buyingPriceHistory quantity reserved lowStockThreshold supplierID disabled'
  ).populate('supplierID', 'supplierName');
  const mapped = data.map((p) => {
    const available = p.quantity - p.reserved;
    return {
      _id: p._id,
      productID: p.productID,
      productName: p.productName,
      category: p.category,
      quantity: p.quantity,
      reserved: p.reserved,
      available,
      lowStockThreshold: p.lowStockThreshold,
      lowStock: available <= p.lowStockThreshold,
      disabled: p.disabled || false,
      // Stage 20: p.supplierID is populated to {_id, supplierName} when
      // set, or null for self-purchased/no-supplier products — surfaced
      // as two plain fields so the frontend combobox doesn't need to know
      // about Mongoose population shapes.
      supplierId: p.supplierID?._id || null,
      supplierName: p.supplierID?.supplierName || null,
      sellingPriceHistory: p.sellingPriceHistory,
      // null means genuinely unset — do not round/coerce to 0. Every
      // consumer of `price` (Products/Billing tables, receipts, the
      // edit form's "Previous:" hint) must render null as blank, never
      // as Rs 0.00.
      price: getLatestSellingPrice(p) === null ? null : roundMoney(getLatestSellingPrice(p)),
      costPrice: roundMoney(getLatestBuyingPrice(p)),
    };
  });

  const { data: products, total } = sortAndPaginate(mapped, { sortBy, sortDir, page, limit });
  res.json({ success: true, products, total, page, limit });
}));

// Stage 15 — Low-Stock Notifications. Admin-only: returns every product
// currently at-or-below its lowStockThreshold, unpaginated (this feeds a
// header bell/badge, not a browsable list — Products.jsx already has the
// paginated view with the same per-row highlighting). Sorted so the most
// depleted stock (lowest available) surfaces first.
router.get('/api/products/low-stock', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const data = await Product.find(
    {},
    'productID productName category quantity reserved lowStockThreshold'
  );
  const products = data
    .map((p) => ({
      productID: p.productID,
      productName: p.productName,
      category: p.category,
      quantity: p.quantity,
      reserved: p.reserved,
      available: p.quantity - p.reserved,
      lowStockThreshold: p.lowStockThreshold,
    }))
    .filter((p) => p.available <= p.lowStockThreshold)
    .sort((a, b) => a.available - b.available || a.productID.localeCompare(b.productID));

  res.json({ success: true, count: products.length, products });
}));

// ── Mutating routes — all require a valid JWT ───────────────
// (requireAdmin is available in middleware/auth.js for role-gating
// specific actions like edits/refunds in a later stage.)

router.post('/api/product', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const {
    productId,
    productName,
    category,
    price,
    stock,
    supplierId,
    lowStockThreshold,
    cost
  } = req.body;

  if (productId && !isValidProductId(productId)) {
    return res.status(400).json({
      success: false,
      message: 'Product ID must look like #0001.'
    });
  }

  if (!productName || !productName.trim()) {
    return res.status(400).json({
      success: false,
      message: 'Product name is required.'
    });
  }

  // Normalize product name:
  // - trim leading/trailing whitespace
  // - collapse multiple spaces into one
  // Example: "  Coca   Cola  " -> "Coca Cola"
  const normalizedProductName = productName.trim().replace(/\s+/g, ' ');

  // Selling price is optional — blank/omitted means "no selling price",
  // not "$0". Only validate/round when something was actually submitted;
  // hasPrice=false is what lets Update Product explicitly clear a
  // previously-set price (see the update branch below), same pattern as
  // POST /supplier/purchase's optional per-item sellingPrice.
  const hasPrice = price !== undefined && price !== null && price !== '';
  if (hasPrice && (!Number.isFinite(Number(price)) || Number(price) < 0)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid selling price.'
    });
  }
  const submittedPrice = hasPrice ? roundMoney(price) : null;
  const threshold = parseThreshold(lowStockThreshold);
  const existingProduct = productId
    ? await Product.findOne({ productID: productId })
    : null;

  // Prevent duplicate product names.
  // Comparison is case-insensitive and ignores leading/trailing
  // whitespace and repeated internal whitespace.
  const duplicateProduct = await Product.findOne({
    productName: new RegExp(
      `^${escapeRegex(normalizedProductName).replace(/ /g, '\\s+')}$`,
      'i'
    )
  });

  // During an update, allow the product to keep its own current name.
  if (
    duplicateProduct &&
    (
      !existingProduct ||
      duplicateProduct._id.toString() !== existingProduct._id.toString()
    )
  ) {
    return res.status(409).json({
      success: false,
      message: `A product with the name "${duplicateProduct.productName}" already exists.`
    });
  }

  // Supplier is only ever set at creation (declarative, informational) —
  // Update Product no longer accepts or changes it; that field belongs to
  // Add Product only. Actual restocking (real supplier or self-buy) goes
  // through Add Stock / Suppliers > Record a Purchase, not this form.
  let resolvedSupplier = { ok: true, value: null };

  if (!existingProduct) {
    resolvedSupplier = await resolveSupplierId(supplierId);

    if (!resolvedSupplier.ok) {
      return res.status(400).json({
        success: false,
        message: 'Invalid supplier selected.'
      });
    }
  }

  // Stage 7 (final.md): a new product's cost is required and always
  // becomes a NoSupplier-tagged StockBatch — see the create branch below.
  // Update path is unaffected (existingProduct truthy skips this).
  if (
    !existingProduct &&
    (!Number.isFinite(Number(cost)) || Number(cost) < 0)
  ) {
    return res.status(400).json({
      success: false,
      message: 'Cost is required.'
    });
  }

  // Stage 14: snapshot before any mutation, for the audit entry below.
  const beforeSnapshot = existingProduct
    ? existingProduct.toObject()
    : null;

  if (existingProduct) {
    // final.md Stage 9: Update Product no longer touches stock at all —
    // that's Add Stock/Deduct Stock's job now (see the two routes below).
    // supplierID is intentionally left untouched here — see note above.
    existingProduct.productName = normalizedProductName;
    existingProduct.category = category;

    if (lowStockThreshold !== undefined) {
      existingProduct.lowStockThreshold = threshold;
    }

    // Only record a new price-history entry if the price actually moved —
    // this is what makes getLatestSellingPrice() meaningful instead of the
    // array just growing with the same number forever. latestPrice is
    // null when no price is currently set (never 0), so it's compared
    // directly against submittedPrice (also null when the field was left
    // blank this submit) rather than being coerced through roundMoney.
    const latestPrice = getLatestSellingPrice(existingProduct);

    if (hasPrice) {
      // A real price was submitted — record it if it's new or different
      // from whatever's currently set (including "currently unset").
      if (latestPrice === null || submittedPrice !== latestPrice) {
        existingProduct.sellingPriceHistory.push({
          price: submittedPrice,
          date: new Date()
        });
      }
    } else if (latestPrice !== null) {
      // The field was explicitly left blank on this submit and a price
      // was previously set — record the clear as its own history entry
      // rather than silently dropping it, so getLatestSellingPrice()
      // (sorted by date) correctly reports "unset" from here on, and the
      // audit trail/price history still shows when and that it happened.
      existingProduct.sellingPriceHistory.push({
        price: null,
        date: new Date()
      });
    }

    await existingProduct.save();

    await logAudit({
      action: 'product.updated',
      actor: {
        username: req.user.username,
        role: req.user.role
      },
      targetType: 'product',
      targetId: productId,
      before: beforeSnapshot,
      after: existingProduct.toObject(),
    });
  } else {
    const generatedProductId = await nextProductId();
    const parsedStock = isNaN(parseInt(stock))
      ? 0
      : parseInt(stock);

    const roundedCost = roundMoney(cost);

    const newProduct = new Product({
      productID: generatedProductId,
      productName: normalizedProductName,
      category,
      // hasPrice=false (blank at creation) means genuinely no price
      // recorded — an empty array, not a [{price: 0}] or [{price: null}]
      // entry — so a brand-new product with no selling price entered
      // yet has no history to sort through at all.
      sellingPriceHistory: hasPrice
        ? [
            {
              price: submittedPrice
            }
          ]
        : [],

      // Stage 7: a real cost basis from the moment the product exists,
      // same buyingPriceHistory shape POST /supplier/purchase writes —
      // supplierID: null marks it self-purchased (NoSupplier), matching
      // the StockBatch created below.
      buyingPriceHistory: [
        {
          price: roundedCost,
          date: new Date(),
          supplierID: null
        }
      ],

      quantity: parsedStock,
      reserved: 0,
      lowStockThreshold: threshold,
      supplierID: resolvedSupplier.value,
    });

    // Stage 7: only a positive initial stock has anything to batch — a
    // zero-stock product still gets its cost basis recorded above, but
    // there's nothing to create a StockBatch for yet (matches
    // StockBatch's own quantityPurchased min: 1). Generated up front,
    // same as POST /supplier/purchase, since it's not itself part of the
    // transactional write.
    const purchaseID = parsedStock > 0
      ? await generateUniquePurchaseId()
      : null;

    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        await newProduct.save({ session });

        if (parsedStock > 0) {
          await createBatch({
            productID: generatedProductId,
            supplierID: null,
            purchaseID,
            quantity: parsedStock,
            unitCost: roundedCost,
            session,
          });
        }
      });
    } finally {
      await session.endSession();
    }

    await logAudit({
      action: 'product.created',
      actor: {
        username: req.user.username,
        role: req.user.role
      },
      targetType: 'product',
      targetId: generatedProductId,
      before: null,
      after: newProduct.toObject(),
    });

    return res.status(200).json({
      success: true,
      message: 'Product saved successfully',
      productId: generatedProductId
    });
  }

  res.status(200).json({
    success: true,
    message: 'Product saved successfully'
  });
}));

// final.md Stage 9 — dedicated restock action, replacing Update
// Product's old stock field. Always self-buying (NoSupplier), same
// pattern Stage 7 established for a brand-new product's initial stock —
// a real supplier restock still goes through POST /supplier/purchase.
// Also the only path that re-enables a disabled (zero-stock) product.
router.post('/api/product/:productID/add-stock', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productID } = req.params;
  const { cost, quantity } = req.body;

  if (!isValidProductId(productID)) {
    return res.status(400).json({ success: false, message: 'Product ID must look like #0001.' });
  }
  if (!Number.isFinite(Number(cost)) || Number(cost) < 0) {
    return res.status(400).json({ success: false, message: 'Cost is required.' });
  }
  const qty = parseInt(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    return res.status(400).json({ success: false, message: 'Quantity must be a positive whole number.' });
  }
  const roundedCost = roundMoney(cost);
  const purchaseID = await generateUniquePurchaseId();

  const session = await mongoose.startSession();
  let updatedProduct;
  try {
    await session.withTransaction(async () => {
      const product = await Product.findOne({ productID }).session(session);
      if (!product) {
        throw new AppError(404, 'Product not found.');
      }
      const before = product.toObject();
      product.quantity += qty;
      product.buyingPriceHistory.push({ price: roundedCost, date: new Date(), supplierID: null });
      if (product.disabled) product.disabled = false;
      await product.save({ session });

      await createBatch({
        productID,
        supplierID: null,
        purchaseID,
        quantity: qty,
        unitCost: roundedCost,
        session,
      });

      await logAudit(
        {
          action: 'product.stock_added',
          actor: { username: req.user.username, role: req.user.role },
          targetType: 'product',
          targetId: productID,
          before,
          after: product.toObject(),
        },
        session
      );
      updatedProduct = product;
    });
  } finally {
    await session.endSession();
  }

  res.status(200).json({ success: true, message: 'Stock added.', quantity: updatedProduct.quantity, disabled: updatedProduct.disabled });
}));

// final.md Stage 9 — reason-coded stock write-off/return, replacing any
// notion of freely editing quantity down. "Returned to Supplier"
// recovers cost as supplier credit and creates no Loss entry; every
// other reason records one (models/Loss.js), surfaced on the Dashboard/
// Reports as of Stage 9b. Draws down FIFO cost batches the same way a
// sale does (lib/costing.js) so the recorded cost/credit is never
// invented for stock that has no batch behind it.
// final.md Stage 15 — lets Deduct Stock's picker show remaining batches
// only when there's a real cost choice to make (2+ distinct unitCost
// values with stock left); the frontend decides whether to render the
// picker, this route just returns the raw list either way.
router.get('/api/product/:productID/batches', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productID } = req.params;
  if (!isValidProductId(productID)) {
    return res.status(400).json({ success: false, message: 'Product ID must look like #0001.' });
  }
  const batches = await listRemainingBatches(productID);
  res.status(200).json({ success: true, batches });
}));

const DEDUCT_REASONS = [...Loss.REASONS, 'returned_to_supplier'];
router.post('/api/product/:productID/deduct-stock', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productID } = req.params;
  const { quantity, reason, note, supplierId, batchId } = req.body;

  if (!isValidProductId(productID)) {
    return res.status(400).json({ success: false, message: 'Product ID must look like #0001.' });
  }
  if (!DEDUCT_REASONS.includes(reason)) {
    return res.status(400).json({ success: false, message: 'Invalid reason.' });
  }
  if (!note || !note.trim()) {
    return res.status(400).json({ success: false, message: 'A note is required.' });
  }
  const qty = parseInt(quantity);
  if (!Number.isInteger(qty) || qty < 1) {
    return res.status(400).json({ success: false, message: 'Quantity must be a positive whole number.' });
  }
  if (batchId && !mongoose.Types.ObjectId.isValid(batchId)) {
    return res.status(400).json({ success: false, message: 'Invalid batch selected.' });
  }

  let resolvedSupplierId = null;
  if (reason === 'returned_to_supplier') {
    if (!supplierId || !mongoose.Types.ObjectId.isValid(supplierId)) {
      return res.status(400).json({ success: false, message: 'A supplier is required for a Returned to Supplier deduction.' });
    }
    const supplierExists = await Supplier.exists({ _id: supplierId });
    if (!supplierExists) {
      return res.status(400).json({ success: false, message: 'Selected supplier not found.' });
    }
    resolvedSupplierId = supplierId;
  }

  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const product = await Product.findOne({ productID }).session(session);
      if (!product) {
        throw new AppError(404, 'Product not found.');
      }
      const available = product.quantity - product.reserved;
      if (qty > available) {
        throw new AppError(400, `Only ${available} unit(s) available to deduct — the rest is held in an open cart.`);
      }
      const before = product.toObject();

      const fifo = batchId
        ? await consumeSpecificBatch(productID, batchId, qty, session)
        : await consumeFIFO(productID, qty, session);

      const updated = await Product.findOneAndUpdate(
        { _id: product._id, quantity: { $gte: qty } },
        { $inc: { quantity: -qty } },
        { session, new: true }
      );
      if (!updated) {
        throw new AppError(409, 'Stock changed, please retry.');
      }
      await disableIfDepleted(updated, session);

      let supplierCredited = 0;
      if (reason === 'returned_to_supplier') {
        supplierCredited = fifo.costAmount;
        await Supplier.updateOne({ _id: resolvedSupplierId }, { $inc: { creditBalance: supplierCredited } }, { session });
      } else {
        await Loss.create(
          [
            {
              productID,
              productName: product.productName,
              quantity: qty,
              costValue: fifo.costAmount,
              reason,
              note: note.trim(),
              actor: { username: req.user.username, role: req.user.role },
            },
          ],
          { session }
        );
      }

      await logAudit(
        {
          action: 'product.stock_deducted',
          actor: { username: req.user.username, role: req.user.role },
          targetType: 'product',
          targetId: productID,
          before,
          after: {
            ...updated.toObject(),
            reason,
            note: note.trim(),
            quantityDeducted: qty,
            costValue: fifo.costAmount,
            ...(reason === 'returned_to_supplier' ? { supplierCredited, supplierId: resolvedSupplierId } : {}),
          },
        },
        session
      );

      result = { quantity: updated.quantity, disabled: updated.disabled, costValue: fifo.costAmount, supplierCredited };
    });
  } finally {
    await session.endSession();
  }

  res.status(200).json({ success: true, message: 'Stock deducted.', ...result });
}));

// final.md Stage 9c — hard delete is genuinely destructive, so it's now
// only reachable once a product's stock is fully accounted for (zero
// remaining — get there via Deduct Stock above for any residual
// quantity) and opens the same reason form Deduct Stock uses. The
// reason/note here is a separate audit annotation on *why the whole
// product record is being removed*, not a stock movement — no Loss/
// credit side effects fire from this route itself (those already fired,
// if relevant, when Deduct Stock brought quantity to 0).
router.delete('/product/:productID', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productID } = req.params;
  const { reason, note } = req.body;

  if (!DEDUCT_REASONS.includes(reason)) {
    return res.status(400).json({ success: false, message: 'Invalid reason.' });
  }
  if (!note || !note.trim()) {
    return res.status(400).json({ success: false, message: 'A note is required.' });
  }

  const product = await Product.findOne({ productID });
  if (!product) {
    return res.status(404).json({ success: false, message: 'Product not found.' });
  }
  if (product.quantity > 0) {
    return res.status(400).json({
      success: false,
      message: `This product still has ${product.quantity} unit(s) of stock. Deduct all remaining stock before deleting.`,
    });
  }

  const deleted = await Product.findOneAndDelete({ productID });

  await logAudit({
    action: 'product.deleted',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'product',
    targetId: productID,
    before: { ...deleted.toObject(), reason, note: note.trim() },
    after: null,
  });

  return res.status(200).json({ success: true, message: 'Product deleted successfully' });
}));

router.post('/product/undo', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { productId, productName, category, price, stock, supplierId, lowStockThreshold } = req.body;
  if (!isValidProductId(productId)) {
    return res.status(400).json({ success: false, message: 'Product ID must look like #0001.' });
  }
  const threshold = parseThreshold(lowStockThreshold);
  const resolvedSupplier = await resolveSupplierId(supplierId);
  if (!resolvedSupplier.ok) {
    return res.status(400).json({ success: false, message: 'Invalid supplier selected.' });
  }

  const existingProduct = await Product.findOne({ productID: productId });
  const beforeSnapshot = existingProduct ? existingProduct.toObject() : null;
  let restoredProduct;
  if (existingProduct) {
    existingProduct.productName = productName;
    existingProduct.category = category;
    existingProduct.sellingPriceHistory = [{ price: price === null || price === undefined || price === '' ? null : roundMoney(price) }];
    existingProduct.quantity = isNaN(parseInt(stock)) ? 0 : parseInt(stock);
    existingProduct.reserved = 0; // a restored product starts with nothing held in any open cart
    existingProduct.lowStockThreshold = threshold;
    existingProduct.supplierID = resolvedSupplier.value;
    await existingProduct.save();
    restoredProduct = existingProduct;
  } else {
    const newProduct = new Product({
      productID: productId,
      productName,
      category,
      sellingPriceHistory: [{ price: price === null || price === undefined || price === '' ? null : roundMoney(price) }],
      quantity: isNaN(parseInt(stock)) ? 0 : parseInt(stock),
      reserved: 0,
      lowStockThreshold: threshold,
      supplierID: resolvedSupplier.value,
    });
    await newProduct.save();
    restoredProduct = newProduct;
  }

  await logAudit({
    action: 'product.restored',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'product',
    targetId: productId,
    before: beforeSnapshot,
    after: restoredProduct.toObject(),
  });

  res.status(201).json({ ok: true, message: 'Product restored successfully!' });
}));

module.exports = router;
