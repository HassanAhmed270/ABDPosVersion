// Product now tracks two separate price histories (Stage 5) — what we
// charge customers vs. what we paid suppliers. They used to be conflated
// in a single ambiguous `unitPrice` array; that's gone. Always read via
// these helpers (never index into the array directly) so "current" means
// "most recent by date", not "happens to be first in the array".

function latestOf(history) {
  if (!Array.isArray(history) || history.length === 0) return 0;
  const latest = [...history].sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  return latest.price;
}

function getLatestSellingPrice(product) {
  return latestOf(product?.sellingPriceHistory);
}

function getLatestBuyingPrice(product) {
  return latestOf(product?.buyingPriceHistory);
}

module.exports = { getLatestSellingPrice, getLatestBuyingPrice };