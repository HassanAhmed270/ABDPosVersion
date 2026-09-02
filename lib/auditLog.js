const AuditLog = require('../models/AuditLog');
const logger = require('./logger');

// Stage 14: a fixed-size ring buffer, not an unbounded log. Once the
// collection reaches AUDIT_LOG_MAX_ENTRIES, writing a new entry evicts
// the oldest one(s) so the total count never grows past the cap —
// one-in-one-out at steady state.
//
// Deliberately app-level rather than a MongoDB *capped* collection: this
// app's convention everywhere else (products/customers/orders/suppliers)
// is a plain collection queried in full and paginated in memory (see
// lib/query.js) — a capped collection would be a one-off exception to
// that, and can't be resized later without dropping and recreating it.
// A plain collection with an eviction check on write stays consistent
// with the rest of the codebase and lets AUDIT_LOG_MAX_ENTRIES just be
// another .env knob, same as DRAFT_IDLE_TIMEOUT_MS or ENABLE_EXPORTS.
const MAX_ENTRIES = parseInt(process.env.AUDIT_LOG_MAX_ENTRIES) || 5000;

// Writes one audit entry and then trims the collection back down to
// MAX_ENTRIES if it's now over. `session` is optional — pass the
// transaction's session when called from inside an existing
// session.withTransaction() block (order commit/edit/refund) so the log
// entry commits or rolls back with the rest of that operation; omit it
// for routes with no transaction of their own (plain product/customer/
// supplier saves), where the log write is its own, separate operation
// immediately after the save it's describing.
//
// Logging failures are swallowed (logged, not thrown): an audit-log bug
// must never be able to break checkout, an edit, or a refund. This is
// the one place in the app that deliberately does NOT propagate an
// error up to the caller.
async function logAudit({ action, actor, targetType, targetId, before = null, after = null }, session = null) {
  try {
    const opts = session ? { session } : undefined;
    await AuditLog.create([{ action, actor, targetType, targetId, before, after }], opts);
    await evictExcess(session);
  } catch (err) {
    logger.error({ err: err.message, action, targetType, targetId }, 'Audit log write failed');
  }
}

async function evictExcess(session) {
  const countQuery = AuditLog.countDocuments();
  if (session) countQuery.session(session);
  const count = await countQuery;

  const excess = count - MAX_ENTRIES;
  if (excess <= 0) return;

  const oldestQuery = AuditLog.find().sort({ date: 1, _id: 1 }).limit(excess).select('_id');
  if (session) oldestQuery.session(session);
  const oldest = await oldestQuery;

  const deleteQuery = AuditLog.deleteMany({ _id: { $in: oldest.map((d) => d._id) } });
  if (session) deleteQuery.session(session);
  await deleteQuery;
}

module.exports = { logAudit, AUDIT_LOG_MAX_ENTRIES: MAX_ENTRIES };
