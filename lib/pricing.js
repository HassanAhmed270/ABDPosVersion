// Product now tracks two separate price histories (Stage 5) — what we
// charge customers vs. what we paid suppliers. They used to be conflated
// in a single ambiguous `unitPrice` array; that's gone. Always read via
// these helpers (never index into the array directly) so "current" means
// "most recent by date", not "happens to be first in the array".

function latestOf(history, fallback) {
  if (!Array.isArray(history) || history.length === 0) return fallback;
  const latest = [...history].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  return latest.price;
}

// Selling price is optional (unlike buying price, which always has a real
// cost basis). No history at all, or the most recent entry being an
// explicit `price: null` (a deliberately cleared price), both mean
// "unset" — this returns null, never 0, so callers can't mistake "no
// price entered" for "priced at zero". Every caller that displays or
// compares this value must handle null explicitly rather than coercing
// it with `?? 0` / `roundMoney()`.
function getLatestSellingPrice(product) {
  const price = latestOf(product?.sellingPriceHistory, null);
  return price === undefined ? null : price;
}

function getLatestBuyingPrice(product) {
  return latestOf(product?.buyingPriceHistory, 0) ?? 0;
}

module.exports = { getLatestSellingPrice, getLatestBuyingPrice };