const logger = require('../lib/logger');

// Wrap an async route handler so a rejected promise / thrown error is
// forwarded to next(err) instead of crashing the process or hanging the
// request. Usage: app.post('/x', asyncHandler(async (req, res) => {...}))
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Known, safe-to-show error shapes. Anything else becomes a generic
// message so raw Mongo/Mongoose internals never leak to the client.
function publicMessageFor(err) {
  if (err.expose) return err.message; // AppError — deliberate, already client-safe (lib/errors.js)
  if (err.name === 'ValidationError') return 'Some fields are invalid. Please check your input.';
  if (err.code === 11000) return 'That record already exists.';
  if (err.name === 'CastError') return 'That record could not be found.';
  return 'Something went wrong. Please try again.';
}

// Must be registered last, after all routes.
function errorHandler(err, req, res, _next) {
  logger.error(
    { err: err.stack || err.message, route: `${req.method} ${req.originalUrl}`, user: req.user?.username || 'anonymous' },
    'Request failed'
  );

  const status = err.status || (err.name === 'ValidationError' || err.code === 11000 ? 400 : 500);
  res.status(status).json({ success: false, message: publicMessageFor(err) });
}

module.exports = { asyncHandler, errorHandler };