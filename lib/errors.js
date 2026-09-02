// A deliberate, expected failure (stock lost, price changed, bad input
// found mid-transaction, etc.) — as opposed to a genuine bug/DB hiccup.
// `expose: true` tells middleware/errorHandler.js it's safe to send
// `message` straight to the client instead of a generic fallback.
class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.expose = true;
  }
}

module.exports = { AppError };