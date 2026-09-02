const express = require('express');
const bcrypt = require('bcrypt');
const User = require('../models/user');
const { signToken, requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { loginLimiter } = require('../middleware/rateLimit');
const logger = require('../lib/logger');

const router = express.Router();

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required.' });
    }

    const user = await User.findOne({ username: username.trim().toLowerCase() });
    const genericFail = { success: false, message: 'Invalid username or password.' };

    if (!user) {
      logger.warn({ username }, 'Login attempt for unknown user');
      return res.status(401).json(genericFail);
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      logger.warn({ username: user.username }, 'Login attempt with wrong password');
      return res.status(401).json(genericFail);
    }

    const token = signToken(user);
    logger.info({ username: user.username, role: user.role }, 'Login successful');
    return res.status(200).json({ success: true, token, user: { username: user.username, role: user.role } });
  })
);

// Stage 12: silent re-auth. The JWT is a flat 8h token with no built-in
// renewal, so a cashier mid-shift got hard-logged-out with no graceful
// recovery. As long as the *current* token still verifies (requireAuth),
// this issues a fresh one with a new 8h expiry — the frontend calls this
// on an interval well inside the expiry window so a session never has to
// lapse while the app is open. Re-reads the user from the DB (not just
// req.user off the token) so a deactivated/deleted account or a role
// change since login takes effect immediately instead of riding out the
// old token's claims.
router.post(
  '/refresh',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.userId);
    if (!user) {
      return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    }
    const token = signToken(user);
    return res.status(200).json({ success: true, token, user: { username: user.username, role: user.role } });
  })
);

module.exports = router;