# POS System — Staged Improvement Plan

Ordered so each stage only depends on what's already built in a prior stage. Skipping ahead will mean redoing work later (e.g. building refunds before payments exist means rebuilding refunds once payments land).

---

## Stage 1 — Foundations: Auth & Error Handling
*Nothing role-gated (admin edits, refunds) is safe to build before this exists.*

1. Add `User` schema (`username`, `passwordHash`, `role: admin|cashier`).
2. Hash passwords with bcrypt on creation; verify on login.
3. On successful login, issue a JWT (`role`, `userId`, `username`) — replace the current query-string-only login.
4. Store token client-side (localStorage to start) and attach to every protected `fetch()` call.
5. Add JWT verification middleware in Express; apply to all mutating routes.
6. Add role-check middleware (`requireAdmin`) — used later for edits/refunds.
7. Add login rate limiting (`express-rate-limit`) — cap failed attempts per IP/username.
8. Wrap every route in try/catch (or centralized async error middleware).
9. Add `pino` logger server-side; log route + user + stack trace on error.
10. Replace all raw `err.message` responses with clean, user-friendly messages.

**Exit criteria:** every route requires a valid token; failed logins are throttled; errors are logged server-side and shown cleanly client-side.

---

## Stage 2 — Data Integrity: Validation & Pricing
*Fixes the calculation flaws before any new money features are layered on top.*

1. Add server-side validation (independent of Mongoose schema) for: phone/email format, `productID`/`orderID` regex — reject bad input before it reaches the DB.
2. On order save, re-fetch `Product.unitPrice` server-side and validate the submitted price matches (reject or flag mismatches) instead of trusting the browser value.
3. Fix `unitPrice` read logic — always use the latest price entry, not `[0]`.
4. Replace `parseInt` truncation on `grandTotal`/payment checks with `parseFloat` + explicit rounding to 2 decimals, consistently, both in display and in what's saved.
5. Cap discount at `max: 100` in the `Order` schema; validate server-side too.

**Exit criteria:** no order can be saved with a tampered price, an out-of-range discount, or a truncated total.

---

## Stage 3 — Inventory Correctness: Reservation & Atomic Stock
*Depends on Stage 2's validated order-save path.*

1. Add `reserved` field to `Product`.
2. Add-to-cart action becomes a real API call: atomic `$expr`-guarded `$inc` on `reserved` (reject if `quantity - reserved < qty`).
3. Remove-from-cart / cart timeout → atomic `$inc` release of `reserved`.
4. Commit (Generate Bill) → wrap `Order` insert + `Product` stock decrement (`quantity -= qty, reserved -= qty`) + `Customer.orders` push in a single MongoDB transaction.
5. Add per-product `lowStockThreshold` field (default 10) to the add-product form and schema.
6. Update product list, billing cart, and any stock display to highlight rows red when `quantity - reserved <= lowStockThreshold`.

**Exit criteria:** two cashiers can never oversell the same unit; a crash mid-checkout can't leave stock undeducted; low stock is visible everywhere stock is shown.

---

## Stage 4 — Draft Bills (Persistence Before Commit)
*Depends on Stage 3's reservation logic, since drafts are what triggers reservation.*

1. Add `PendingBill` schema: `cashier`, `billID`, `customerName`, `items[]`, `status`, `updatedAt`.
2. Debounced autosave (5–10s or on cart change) → upsert by `{cashier}`.
3. On login/page load, check for an existing draft and offer to resume it.
4. On commit, use the draft's items as source of truth; on success, delete/mark `committed`.
5. On failure (e.g. stock no longer available), leave draft as-is for correction.
6. Add TTL/scheduled cleanup for drafts idle past a timeout → release their `reserved` stock, mark `abandoned`.

**Exit criteria:** a refresh or crash mid-bill never loses cart progress or leaves stock reserved forever.

---

## Stage 5 — Customer & Supplier Credit
*Independent of Stages 3–4; can run in parallel with them if needed, but needs Stage 2's validated order flow.*

1. Extend `Order` with `amountPaid`, `balanceDue`, `paymentStatus`, `payments: [{amount, date, method}]`.
2. Actually send `paidInput` from the billing page to `/billing/orderDetails` (currently dropped).
3. Enrich `Customer.orders[]` with `{orderNo, orderDate, totalAmount, amountPaid, balanceDue}`.
4. Add `Supplier` schema: contact info, `purchases: [{purchaseID, date, totalAmount, amountPaid, balanceDue, items[]}]`.
5. Add `sellingPriceHistory` and `buyingPriceHistory` (with `supplierID`) to `Product`, replacing the ambiguous single `unitPrice` array.

**Exit criteria:** every order/purchase has a real payment status; customer and supplier balances are queryable directly from their records.

---

## Stage 6 — Discounts UI
*Depends on Stage 2's discount cap and Stage 5's order structure.*

1. Add "Add Discount" toggle on billing → reveals 10%/15%/20% buttons + manual input.
2. Store `discountType`, `discountValue`, `discountAmount` per line item in `Order.products[]`.

**Exit criteria:** every discount applied is traceable to a specific button/manual choice, per item.

---

## Stage 7 — Admin Bill Editing (Exchange) & Refunds
*Depends on Stages 1 (roles), 3 (atomic stock), 5 (payment/credit fields) — the riskiest stage, build last among "core" features.*

1. Add admin-only edit route: reduce/remove item on an order, enforced server-side to a 72-hour window from `orderDate`.
2. Log each edit as an audit entry (`editedBy`, `editedAt`, `originalQty`, `newQty`, `reason`) — never mutate silently.
3. Restore stock atomically for the removed/reduced quantity.
4. Add distinct "revised" print view — same `orderID`, shows edit history inline.
5. Add `Refund` schema: `orderID`, `customerName`, `refundAmount`, `refundedItems`, `refundDate`, `processedBy`.
6. Refund action (admin-only): mark order `status: refunded` (don't delete), restore all stock atomically in a transaction, adjust customer balance.
7. Add `refunded` status to Orders screen.

**Exit criteria:** only admins can edit/refund; every change is auditable; stock and customer balances stay correct after either action.

---

## Stage 8 — Orders & Suppliers Screens
*Depends on Stage 5 (data to display) and benefits from Stage 7 (statuses to show).*

1. Orders list: `orderID`, `customerName`, `totalAmount`, `orderDate`, `avgPayment`, status (`paid/partial/unpaid/refunded`).
2. Row-click expands in place to show full detail (items, discounts, payments, cashier, edit/refund history).
3. Suppliers list: same pattern — name, purchase history total, amount owed; row-expand for purchase detail.
4. Add sortable columns (ascending/descending) on all list screens.
5. Add live substring ("contains") search, debounced, no search button, across Products/Customers/Orders/Suppliers.
6. Add real pagination (limit/skip or cursor) to all list screens.

**Exit criteria:** every list screen is sortable, searchable-as-you-type, and paginated.

---

## Stage 9 — Dashboard Reporting
*Depends on Stage 5 (credit/payables), Stage 7 (refunds), Stage 8's query patterns.*

1. Add weekly/monthly/yearly toggle to dashboard aggregation queries (parameterize date range instead of hardcoded `startOfMonth`).
2. Add metrics: total sales, total orders, failed/refunded orders (net of refunds), total customer credit outstanding, total supplier payable.
3. Ensure exchanges are counted distinctly from refunds in the numbers.

**Exit criteria:** dashboard reflects accurate, date-scoped totals across all money flows built in prior stages.

---

## Stage 10 — CSV/Excel Export (Modular)
*Depends on Stage 9's report queries.*

1. Build export as a separate, toggleable module (feature flag) reusing Stage 9's aggregation queries — no core logic depends on this module existing.
2. Support weekly/monthly/yearly export of sales, refunds, credit, payables.

**Exit criteria:** export can be fully disabled/removed without touching core billing/report code.

---

## Stage 11 — Offline Sync Module (Modular, Optional)
*Depends on Stage 3/4 (reservation + drafts) and Stage 10's module pattern — build last, most complex, most optional.*

1. Local durable write queue (IndexedDB) for offline actions, each tagged with an idempotency key + timestamp.
2. Background connectivity check + auto-flush when DB reachable again.
3. Offline sales treated as provisional; re-validated against live stock at sync time; conflicts flagged for admin review.
4. Export screen distinguishes synced vs. pending records.
5. Entire module behind a single feature flag — removable without touching core commit flow.

**Exit criteria:** system can be used offline without data loss, and the whole capability can be switched off cleanly if not wanted.

---

## Deferred / Not in Scope For Now
- Tax handling
- Barcode scanning
- Proper PDF receipt design (mechanism swap only, once Stage 6/7 data is final — layout designed separately later)
- Automated test suite
- Notifications (low-stock alerts beyond red-highlight UI)
- Activity/audit log beyond bill edits & refunds
