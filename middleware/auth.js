const jwt = require('jsonwebtoken');
const logger = require('../lib/logger');
const User = require('../models/user');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Copy .env.example to .env and set a real secret.');
}
const EXAMPLE_JWT_SECRET = 'REPLACE_THIS_INSECURE_EXAMPLE_VALUE_DO_NOT_USE_IN_PRODUCTION';
if (JWT_SECRET === EXAMPLE_JWT_SECRET) {
  throw new Error('JWT_SECRET is still set to the placeholder value from .env.example. Set a real secret before starting the server.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

function signToken(user) {
  return jwt.sign(
    {
      userId: user._id.toString(),
      username: user.username,
      role: user.role,
      pwdTs: user.passwordChangedAt ? user.passwordChangedAt.getTime() : 0,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ success: false, message: 'Login required.' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).select('passwordChangedAt');
    const currentPwdTs = user && user.passwordChangedAt ? user.passwordChangedAt.getTime() : 0;
    if (!user || currentPwdTs > (decoded.pwdTs || 0)) {
      return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    }
    req.user = decoded;
    return next();
  } catch (err) {
    logger.warn({ err: err.message }, 'Rejected invalid/expired token');
    return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Login required.' });
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admins only.' });
  return next();
}

module.exports = { signToken, requireAuth, requireAdmin, JWT_SECRET };