// Shared by every list route (products/customers/orders/suppliers).
//
// NOTE on approach: several sortable fields per screen are *computed*
// (price, available stock, totalBalanceDue, avgPayment) rather than
// stored on the document, so they can't be sorted/paginated at the DB
// level without a materialized/indexed field — out of scope at this
// shop's data scale. Instead: the DB does the *search* filter (so we're
// not pulling the whole collection over the wire needlessly), then the
// matched set is mapped to its display shape, sorted, and sliced in
// memory. Real pagination from the client's perspective (limit/skip
// params, a total count, only one page's worth of data returned) — just
// not backed by a DB-level skip/limit for computed fields. See
// CLAUDE.md Stage 8.

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePagination(query, defaults = {}) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(1000, Math.max(1, parseInt(query.limit) || defaults.limit || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function sortAndPaginate(items, { sortBy, sortDir = 'asc', page, limit }) {
  const dir = sortDir === 'desc' ? -1 : 1;
  const sorted = sortBy
    ? [...items].sort((a, b) => {
        const av = a[sortBy];
        const bv = b[sortBy];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'string') return av.localeCompare(bv) * dir;
        return (av - bv) * dir; // works for numbers and Dates alike
      })
    : items;
  const total = sorted.length;
  const skip = (page - 1) * limit;
  return { data: sorted.slice(skip, skip + limit), total };
}

module.exports = { escapeRegex, parsePagination, sortAndPaginate };