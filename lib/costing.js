// Batch-based costing / FIFO stock consumption (Stage 22).
//
// A StockBatch is created for every restock recorded through
// POST /supplier/purchase (both the real-supplier and self-purchased
// paths — see createBatch() below and its call site in main.js).
//
// consumeFIFO() is called once per order line inside the same
// transaction as POST /billing/orderDetails's stock decrement. It draws
// from the oldest available batch(es) first and returns exactly what it
// was able to cost — anything beyond available batch stock comes back
// as `unknownQuantity` rather than being silently priced at today's
// cost (Stage 22 exit criteria #7). This never blocks a sale: billing
// stays the proven, working core flow it already was, cost tracking is
// a pure overlay on top of it.
//
// restoreConsumption() is the inverse, used by admin edit/refund
// (applyLineReduction() in main.js) to give back exactly the batch units
// a reduced/removed order line had consumed, so a later sale can draw on
// them again and the dashboard's profit figure stays consistent with
// what's actually still sold (Stage 22 exit criteria #11). It restores
// "unknown" (unbatched) units first — there's no batch to credit them
// back to anyway — then works backward through the line's own
// batchConsumption list (most-recently-consumed batch first), so the
// oldest/earliest-batch portion of what's left survives a partial
// edit/refund with its cost basis intact.
const StockBatch = require('../models/StockBatch');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const { roundMoney } = require('./money');
const { AppError } = require('./errors');

// Shared by POST /supplier/purchase (routes/suppliers.js) and, as of
// final.md Stage 7, POST /api/product's create path (routes/products.js)
// — both create a StockBatch tagged to a purchaseID, so both need the
// same collision-checked ID generator rather than each rolling their own.
async function generateUniquePurchaseId() {
  for (let i = 0; i < 20; i++) {
    const candidate = 'PUR-' + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    const exists = await Supplier.exists({ 'purchases.purchaseID': candidate });
    if (!exists) return candidate;
  }
  throw new AppError(500, 'Could not generate a unique purchase ID. Please try again.');
}

async function createBatch({ productID, supplierID, purchaseID, quantity, unitCost, session }) {
  const created = await StockBatch.create(
    [
      {
        productID,
        supplierID: supplierID || null,
        purchaseID,
        quantityPurchased: quantity,
        quantityRemaining: quantity,
        unitCost,
        purchaseDate: new Date()
      }
    ],
    { session }
  );
  return created[0];
}

async function consumeFIFO(productID, quantity, session) {
  let remaining = quantity;
  const consumption = [];
  let costAmount = 0;
  let costQuantity = 0;

  const batches = await StockBatch.find({ productID, quantityRemaining: { $gt: 0 } })
    .sort({ purchaseDate: 1, _id: 1 })
    .session(session);

  for (const batch of batches) {
    if (remaining <= 0) break;
    const take = Math.min(batch.quantityRemaining, remaining);
    if (take <= 0) continue;
    // Guarded atomic decrement, not read-then-write — same pattern as
    // the product stock decrement right next to this call.
    const updated = await StockBatch.findOneAndUpdate(
      { _id: batch._id, quantityRemaining: { $gte: take } },
      { $inc: { quantityRemaining: -take } },
      { session, new: true }
    );
    if (!updated) continue; // lost a race to another concurrent sale — that portion just becomes unknown-cost below, never oversold
    consumption.push({ batchId: batch._id, quantity: take, unitCost: batch.unitCost });
    costAmount += take * batch.unitCost;
    costQuantity += take;
    remaining -= take;
  }

  return {
    consumption,
    costAmount: roundMoney(costAmount),
    costQuantity,
    unknownQuantity: remaining
  };
}

// final.md Stage 15 — admin-directed deduction from one specific batch,
// rather than consumeFIFO()'s always-oldest-first behavior. Used only by
// Deduct Stock's optional batch picker (routes/products.js) when a
// product has more than one distinct-cost batch remaining, so the admin
// can see and choose which cost applies instead of it being silently
// decided by purchase date. Checkout and offline sync are NOT changed —
// they keep using consumeFIFO() unconditionally; this is a separate,
// narrower function rather than a mode flag on consumeFIFO() so that
// invariant can't accidentally be loosened later.
async function consumeSpecificBatch(productID, batchId, quantity, session) {
  const batch = await StockBatch.findOne({ _id: batchId, productID }).session(session);
  if (!batch) {
    throw new AppError(400, 'Selected batch not found for this product.');
  }
  if (batch.quantityRemaining < quantity) {
    throw new AppError(400, `Only ${batch.quantityRemaining} unit(s) remain in the selected batch.`);
  }
  const updated = await StockBatch.findOneAndUpdate(
    { _id: batch._id, quantityRemaining: { $gte: quantity } },
    { $inc: { quantityRemaining: -quantity } },
    { session, new: true }
  );
  if (!updated) {
    throw new AppError(409, 'That batch changed, please retry.');
  }
  return {
    consumption: [{ batchId: batch._id, quantity, unitCost: batch.unitCost }],
    costAmount: roundMoney(quantity * batch.unitCost),
    costQuantity: quantity,
    unknownQuantity: 0
  };
}

// 'batch' — every unit's cost is known; 'unknown' — none is (legacy
// stock, or stock added via the Products form with no cost input);
// 'partial' — some of each, e.g. a sale that ran a batch dry mid-line.
function deriveCostSource(costQuantity, quantity) {
  if (quantity <= 0 || costQuantity <= 0) return 'unknown';
  if (costQuantity >= quantity) return 'batch';
  return 'partial';
}

async function restoreConsumption(batchConsumption, originalQuantity, restoreQty, session) {
  const entries = (batchConsumption || []).map((e) => (e.toObject ? e.toObject() : { ...e }));
  const knownQty = entries.reduce((sum, e) => sum + e.quantity, 0);
  const unknownQty = Math.max(0, originalQuantity - knownQty);

  let toRestore = restoreQty;
  const unknownQtyRestored = Math.min(unknownQty, toRestore);
  toRestore -= unknownQtyRestored;

  let costRestored = 0;
  let knownQtyRestored = 0;

  for (let i = entries.length - 1; i >= 0 && toRestore > 0; i--) {
    const entry = entries[i];
    const take = Math.min(entry.quantity, toRestore);
    if (take <= 0) continue;
    if (entry.batchId) {
      await StockBatch.updateOne({ _id: entry.batchId }, { $inc: { quantityRemaining: take } }, { session });
    }
    costRestored += take * entry.unitCost;
    knownQtyRestored += take;
    entry.quantity -= take;
    toRestore -= take;
  }

  const remainingConsumption = entries.filter((e) => e.quantity > 0);

  return {
    remainingConsumption,
    costRestored: roundMoney(costRestored),
    knownQtyRestored,
    unknownQtyRestored
  };
}

// final.md Stage 9 — zero-stock auto-disable. Called after any guarded
// stock decrement (`updated` is that findOneAndUpdate's `new: true`
// result), from every path that can take a product's quantity to 0:
// checkout (routes/billing.js), offline sync (lib/offlineSync.js), and
// Deduct Stock (routes/products.js). A product is re-enabled only by
// Add Stock (routes/products.js), never here.
async function disableIfDepleted(updated, session) {
  if (updated && updated.quantity === 0 && !updated.disabled) {
    await Product.updateOne({ _id: updated._id }, { $set: { disabled: true } }, { session });
  }
}

// final.md Stage 15 — the batch list Deduct Stock's picker fetches
// (routes/products.js's GET /api/product/:productID/batches). Oldest
// first, same ordering as consumeFIFO's own draw order, so "first in
// the list" still reads as "what FIFO would pick automatically".
async function listRemainingBatches(productID) {
  return StockBatch.find({ productID, quantityRemaining: { $gt: 0 } })
    .sort({ purchaseDate: 1, _id: 1 })
    .select('unitCost quantityRemaining purchaseDate');
}

module.exports = { createBatch, consumeFIFO, consumeSpecificBatch, listRemainingBatches, deriveCostSource, restoreConsumption, generateUniquePurchaseId, disableIfDepleted };
