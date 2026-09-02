const express = require('express');
const bcrypt = require('bcrypt');
const User = require('../models/user');
const { requireAuth, requireAdmin, signToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { AppError } = require('../lib/errors');
const { logAudit } = require('../lib/auditLog');

const router = express.Router();

const MIN_PASSWORD_LENGTH = 8;

function sanitizeUser(user) {
  return { username: user.username, role: user.role, createdAt: user.createdAt };
}

router.get('/api/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const users = await User.find().sort({ username: 1 });
  res.json({ success: true, users: users.map(sanitizeUser) });
}));

router.post('/api/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { username, password, role } = req.body;
  const clean = String(username || '').trim().toLowerCase();
  if (!clean) throw new AppError(400, 'Username is required.');
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    throw new AppError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (!['admin', 'cashier'].includes(role)) throw new AppError(400, 'Role must be "admin" or "cashier".');

  const existing = await User.findOne({ username: clean });
  if (existing) throw new AppError(409, 'A user with that username already exists.');

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ username: clean, passwordHash, role, passwordChangedAt: new Date() });

  await logAudit({
    action: 'user.created',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'user',
    targetId: user.username,
    before: null,
    after: sanitizeUser(user),
  });

  res.status(201).json({ success: true, user: sanitizeUser(user) });
}));

router.delete('/api/users/:username', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const clean = String(req.params.username || '').trim().toLowerCase();
  if (clean === req.user.username) throw new AppError(400, 'You cannot delete your own account.');

  const user = await User.findOne({ username: clean });
  if (!user) throw new AppError(404, 'User not found.');

  if (user.role === 'admin') {
    const adminCount = await User.countDocuments({ role: 'admin' });
    if (adminCount <= 1) throw new AppError(400, 'Cannot delete the last remaining admin.');
  }

  await User.deleteOne({ _id: user._id });

  await logAudit({
    action: 'user.deleted',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'user',
    targetId: user.username,
    before: sanitizeUser(user),
    after: null,
  });

  res.json({ success: true });
}));

router.post('/api/users/:username/reset-password', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const clean = String(req.params.username || '').trim().toLowerCase();
  const { password } = req.body;
  if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
    throw new AppError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const user = await User.findOne({ username: clean });
  if (!user) throw new AppError(404, 'User not found.');

  user.passwordHash = await bcrypt.hash(password, 12);
  user.passwordChangedAt = new Date();
  await user.save();

  await logAudit({
    action: 'user.password_reset',
    actor: { username: req.user.username, role: req.user.role },
    targetType: 'user',
    targetId: user.username,
    before: null,
    after: null,
  });

  res.json({ success: true });
}));

router.post('/api/users/me/password', requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || String(newPassword).length < MIN_PASSWORD_LENGTH) {
    throw new AppError(400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const user = await User.findById(req.user.userId);
  if (!user) throw new AppError(401, 'Session expired. Please log in again.');

  const currentOk = await bcrypt.compare(currentPassword || '', user.passwordHash);
  if (!currentOk) throw new AppError(400, 'Current password is incorrect.');

  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.passwordChangedAt = new Date();
  await user.save();

  await logAudit({
    action: 'user.password_changed',
    actor: { username: user.username, role: user.role },
    targetType: 'user',
    targetId: user.username,
    before: null,
    after: null,
  });

  const token = signToken(user);
  res.json({ success: true, token, user: { username: user.username, role: user.role } });
}));

module.exports = router;
