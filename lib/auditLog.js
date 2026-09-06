const AuditLog = require('../models/AuditLog');
const logger = require('./logger');
const { roundMoney } = require('./money');

// Stage 14: fixed-size app-level audit log ring buffer.
const MAX_ENTRIES = parseInt(process.env.AUDIT_LOG_MAX_ENTRIES, 10) || 5000;

/**
 * Canonical customer financial snapshot.
 *
 * accountBalance is the single running customer balance:
 *   > 0  customer owes the business
 *   = 0  settled
 *   < 0  customer has store credit
 */
function customerFinancialSnapshot(customer) {
  if (!customer) return null;

  return {
    accountBalance: roundMoney(Number(customer.accountBalance) || 0),
  };
}

/**
 * Canonical order financial snapshot.
 */
function orderFinancialSnapshot(order) {
  if (!order) return null;

  return {
    totalAmount: roundMoney(Number(order.totalAmount) || 0),
    amountPaid: roundMoney(Number(order.amountPaid) || 0),
    balanceDue: roundMoney(Number(order.balanceDue) || 0),
    paymentStatus: order.paymentStatus || null,
  };
}

/**
 * Canonical supplier financial snapshot.
 *
 * totalBalanceDue is the sum of outstanding purchase balances.
 * creditBalance is supplier credit and is intentionally kept separate.
 */
function supplierFinancialSnapshot(supplier) {
  if (!supplier) return null;

  const totalBalanceDue = roundMoney(
    (supplier.purchases || []).reduce(
      (sum, purchase) => sum + (Number(purchase.balanceDue) || 0),
      0
    )
  );

  return {
    totalBalanceDue,
    creditBalance: roundMoney(Number(supplier.creditBalance) || 0),
  };
}

/**
 * Write one audit entry.
 *
 * Audit failures are deliberately swallowed so an audit problem can never
 * break checkout, an edit, a refund, or another business operation.
 */
async function logAudit(
  {
    action,
    actor,
    targetType,
    targetId,
    before = null,
    after = null,
  },
  session = null
) {
  try {
    const opts = session ? { session } : undefined;

    await AuditLog.create(
      [{
        action,
        actor,
        targetType,
        targetId,
        before,
        after,
      }],
      opts
    );

    await evictExcess(session);
  } catch (err) {
    logger.error(
      {
        err: err.message,
        action,
        targetType,
        targetId,
      },
      'Audit log write failed'
    );
  }
}

async function evictExcess(session) {
  const countQuery = AuditLog.countDocuments();

  if (session) countQuery.session(session);

  const count = await countQuery;
  const excess = count - MAX_ENTRIES;

  if (excess <= 0) return;

  const oldestQuery = AuditLog
    .find()
    .sort({ date: 1, _id: 1 })
    .limit(excess)
    .select('_id');

  if (session) oldestQuery.session(session);

  const oldest = await oldestQuery;

  if (!oldest.length) return;

  const deleteQuery = AuditLog.deleteMany({
    _id: { $in: oldest.map((document) => document._id) },
  });

  if (session) deleteQuery.session(session);

  await deleteQuery;
}

module.exports = {
  logAudit,
  customerFinancialSnapshot,
  orderFinancialSnapshot,
  supplierFinancialSnapshot,
  AUDIT_LOG_MAX_ENTRIES: MAX_ENTRIES,
};
