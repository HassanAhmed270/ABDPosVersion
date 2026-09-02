// Stage 3 — split out of main.js verbatim, no logic changes.
const express = require('express');
const AuditLog = require('../models/AuditLog');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { escapeRegex, parsePagination, sortAndPaginate } = require('../lib/query');

const router = express.Router();

// ── Audit Log (Stage 14) — admin-only, read-only. See lib/auditLog.js
// for how entries get written and how the collection stays bounded.
router.get('/api/audit-log', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { search = '', sortBy = 'date', sortDir = 'desc', action = '' } = req.query;
  const { page, limit } = parsePagination(req.query);

  const filter = {};
  if (action) filter.action = action;
  if (search) {
    filter.$or = [
      { 'actor.username': { $regex: escapeRegex(search), $options: 'i' } },
      { targetId: { $regex: escapeRegex(search), $options: 'i' } },
      { action: { $regex: escapeRegex(search), $options: 'i' } },
    ];
  }

  const data = await AuditLog.find(filter);
  const mapped = data.map((a) => ({
    _id: a._id,
    action: a.action,
    actor: a.actor,
    targetType: a.targetType,
    targetId: a.targetId,
    before: a.before,
    after: a.after,
    date: a.date,
  }));

  const { data: entries, total } = sortAndPaginate(mapped, { sortBy, sortDir, page, limit });
  res.json({ success: true, entries, total, page, limit });
}));

module.exports = router;
