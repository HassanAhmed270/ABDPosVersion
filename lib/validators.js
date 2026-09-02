// Server-side validation, deliberately independent of Mongoose schema
// validation — these run *before* anything touches the DB, so bad input
// gets a clear 400 instead of surfacing as a confusing CastError/
// ValidationError further down (or, worse, silently coercing to garbage).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose on purpose (shop may take local or international numbers) but
// still rejects obvious junk like letters or a 3-digit "phone number".
const PHONE_RE = /^[0-9+\-\s()]{7,20}$/;
const PRODUCT_ID_RE = /^#\d{4}$/;
const ORDER_ID_RE = /^#\d{4}$/;

// Email/phone are optional fields throughout this app — "empty" is valid,
// "present but malformed" is not.
const isValidEmail = (value) => !value || EMAIL_RE.test(String(value).trim());
const isValidPhone = (value) => !value || PHONE_RE.test(String(value).trim());

const isValidProductId = (value) => typeof value === 'string' && PRODUCT_ID_RE.test(value);
const isValidOrderId = (value) => typeof value === 'string' && ORDER_ID_RE.test(value);

const isValidDiscount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100;
};

const isPositiveInt = (value) => Number.isInteger(Number(value)) && Number(value) > 0;

module.exports = {
  isValidEmail,
  isValidPhone,
  isValidProductId,
  isValidOrderId,
  isValidDiscount,
  isPositiveInt,
};