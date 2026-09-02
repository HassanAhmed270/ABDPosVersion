# Billing System Rebuild — Progress Log

Companion to `CLAUDE.md` (full narrative detail per stage). Fast-reference
version: what exists, where, what remains open.

Repo root: `POS-INITIAL/`. Backend: Express + Mongoose at root (`main.js`).
Frontend: React + Vite + Tailwind in `frontend/`. No server-rendered UI —
legacy EJS views were removed once React covered every screen (see "EJS
removal" below).

## Stage 1 — Frontend migration kickoff

Scaffolded `frontend/` (Vite + React + Tailwind). Ported Login,
Dashboard, Billing, Products, Customers. Added JSON API routes. No auth
at this point.

## Spec Stage 1 — Auth & Error Handling

JWT login, `requireAuth`/`requireAdmin`, login rate limiting, centralized
error handling, Pino logging, `scripts/createUser.js`. Frontend token
storage + auto Bearer auth + 401 logout.

## Spec Stage 2 — Data Integrity: Validation & Pricing

Independent validators, shared money helpers, server-side price
verification, server-recomputed totals, discounts capped at 100%.

## Spec Stage 3 — Inventory Correctness

`Product.reserved` + `lowStockThreshold`, atomic reserve/release, order
commit uses a Mongo transaction, manual stock correction is admin-only.
Requires a replica set. (Abandoned-reservation expiry completed Stage 4.)

## Spec Stage 4 — Draft Bills

`PendingBill` persistence per cashier, draft GET/POST/DELETE, order
commit uses the persisted draft, background expiry sweep, frontend
autosave/restore/discard. Gap: ~7s autosave window after a crash.

## Spec Stage 5 — Customer & Supplier Credit

Split selling/buying price histories, `amountPaid`/`balanceDue`/
`paymentStatus`/`payments[]`, customer outstanding balance, Supplier
model + purchase flow (transactional restock), `Suppliers.jsx`. Gap: no
later "pay existing balance" flow.

## Spec Stage 6 — Discounts UI

`discountType`: `none|preset|manual`, 10/15/20% + manual UI, flows
through draft persistence, `discountAmount` server-computed. Gap: not
shown in Billing receipt/cart.

## Spec Stage 7 — Admin Bill Editing & Refunds

`Refund` model + order `editHistory`, `active/refunded` status,
admin-only edit (72h window) and refund (no time limit), atomic stock
restore, recomputed totals, `/api/orders` routes, `Orders.jsx`. Gap:
refund cash-back vs store-credit not distinguished.

## Spec Stage 8 — Search, Sort & Pagination

Shared query/search/pagination utilities across Products/Customers/
Orders/Suppliers; debounced search, sortable headers, pagination UI,
lazy-loaded inline details. Gaps: no sort allow-list, fielded search, or
URL state.

## Spec Stage 9 — Dashboard Reporting

Week/month/year ranges, order/refund/exchange counts, customer credit +
supplier payable snapshots, `totalSales` net of edits/refunds, stat
cards. Gaps: order-date vs refund-date scopes differ; dashboard route
under-protected (**closed in Stage 12**).

## Spec Stage 10 — CSV/Excel Export

`lib/reports.js`, dependency-free RFC 4180 CSV writer,
`GET /api/export/{summary,sales,refunds,credit,payables}` (auth +
`ENABLE_EXPORTS`), `Reports.jsx`. Verified end-to-end. Scope limitation:
CSV, not binary `.xlsx`.

## Spec Stage 11 — Offline Sync Module

Optional (`ENABLE_OFFLINE_SYNC` / `VITE_ENABLE_OFFLINE_SYNC`).
`OfflineSale` model w/ idempotency, `POST /api/sync/commit`,
`GET /api/sync/conflicts`, `POST /api/sync/conflicts/:id/resolve`,
durable IndexedDB queue, connectivity watcher, offline Billing fallback,
Reports conflict panel. **End-to-end verified in a real browser +
database**: offline sale created, queued, auto-synced on reconnect,
conflict reproduced and resolved. Deliberate limitations: device-local
queue, no substitute-item editing during conflict resolution, no max
pending duration, not stress-tested at scale.

## EJS removal — MERN-only

Cleanup pass once React covered every screen. Deleted `views/`,
`public/css`, `src/input.css`, `output.css`. `main.js` now serves
`frontend/dist` directly (unmatched GET → `index.html`; unmatched
`/api/*`/`/auth/*` → JSON 404). Removed `ejs`/root `tailwindcss` deps,
added `build-frontend` script; fixed a dev-proxy gap (`/supplier` was
missing). Rewrote `CLAUDE.md`/`frontend/README.md` to match reality.
Verified: full boot test, all client routes → 200, protected API routes
→ 401, unknown API → clean 404. One-way: no EJS fallback remains.

## Spec Stage 12 — Close Remaining Security Gaps

`GET /dashboard/load`, `GET /api/products`, `GET /api/customers` were
public — now `requireAuth`. Added `POST /auth/refresh` (silent re-auth:
re-reads user from DB, issues a fresh token) + a 30-min frontend refresh
interval in `AuthContext.jsx`, inside the default 8h `JWT_EXPIRES_IN`.
Gap (accepted tradeoff): refresh is interval-driven, not activity-aware.
**Verified:** `node --check` on changed files; all 4 routes boot-tested
live, correctly 401 with no token; `requireAuth` unit-tested directly
(valid/missing/malformed token); frontend builds. **Not verified:** DB
paths past the auth gate — no live MongoDB replica set in this sandbox
(applies to every stage below too, noted once here).

## Spec Stage 13 — Product Price Edit: Show Previous vs. New (Admin-only)

Products edit form and Suppliers purchase form both show a "Previous:
<amount>" line (admin-only, via `isAdmin`) next to the Price / Unit Cost
input, sourced from data (`p.price`/`p.costPrice`) already returned by
`GET /api/products` — no backend change needed. Simplification: no
purchase history shows as "Rs 0.00", consistent with
`getLatestBuyingPrice()`'s existing convention elsewhere.
**Verified:** frontend build + lint clean. Not exercised live (sandbox
limitation, see Stage 12).

## Spec Stage 14 — Unified Audit Log (Admin-only)

New `models/AuditLog.js` (`action`, `actor{username,role}`, `targetType`,
`targetId`, `before`/`after` snapshots, `date`, indexed). New
`lib/auditLog.js`: `logAudit(entry, session?)` — **fixed-size FIFO ring
buffer**, not unbounded: past `AUDIT_LOG_MAX_ENTRIES` (default 5000,
`.env`-configurable), each write evicts the single oldest entry. Plain
collection + app-level eviction, not a native Mongo capped collection
(stays consistent with this app's plain-collection/in-memory-pagination
convention; capped can't be resized without recreating). Logging
failures are caught/logged, never thrown. Hooked into all mutation
points — 12 action types:
`order.created/edited/refunded` (inside their existing transactions),
`product.created/updated/deleted/restored`,
`customer.updated/deleted/restored`,
`supplier.created/updated/deleted/purchase` (purchase logged inside its
existing transaction). New `GET /api/audit-log`
(`requireAuth`+`requireAdmin`), reuses Stage 8's search/sort/pagination
helpers. New frontend `AuditLog.jsx` (search, action filter,
sortable/paginated table, expandable before/after JSON) +
`AdminRoute.jsx` (admin-only route guard) + admin-only Sidebar link.

**Verified:** `node --check` on all backend files; frontend build+lint
clean; `GET /api/audit-log` boot-tested live — 401 no token, 403 cashier
token; all newly-touched mutation routes regression-checked, still 401
correctly; FIFO eviction unit-tested against a mocked model (8 writes,
cap=5 → exactly the 5 most recent survive). **Not verified:** DB paths
past the auth gate (sandbox limitation, see Stage 12).

## Stage 15 — Low-Stock Notifications (Admin-only)

In-app only (browser push flagged as a follow-up, per spec — needs a
service worker/HTTPS/permission prompt, bigger lift than scoped here).

New `GET /api/products/low-stock` (`requireAuth`+`requireAdmin`),
unpaginated: every product currently at-or-below `lowStockThreshold`
(`available = quantity - reserved`), sorted most-depleted first. Reuses
the same `available`/`lowStock` shape `GET /api/products` already
computes — no new model/schema. New frontend `LowStockBell.jsx`: bell +
badge count in `Topbar.jsx` (admin-only, same convention as Stage 14's
Audit Log link), checked on mount and every 60s, dropdown lists affected
products (name, ID, available/threshold) with the same red highlight
Products.jsx already uses, links through to `/products`. Cashiers never
see the bell at all (frontend gate) and the backend route 403s them
directly if called (real boundary).

**Verified:** `node --check` on `main.js`; live boot test —
`GET /api/products/low-stock` 401 with no token, 403 ("Admins only.")
with a cashier token, reaches the DB query correctly with an admin token
(times out past that point — no local MongoDB replica set in this
sandbox, same limitation as every stage since 12); regression-checked
`/api/products`, `/dashboard/load`, `/api/audit-log` still 401 with no
token. Frontend: `npm run build` and `npm run lint` both clean (one
pre-existing unrelated warning in `AuthContext.jsx`); boot-tested the
server serving the built `frontend/dist` — `/`, `/products` (SPA route)
→ 200, unknown `/api/*` → JSON 404. **Not verified:** the actual DB
query result / dropdown contents against live data (sandbox limitation,
see Stage 12) — the query itself is a straightforward `find()` + filter
matching `GET /api/products`'s already-verified `available`/`lowStock`
logic, not new aggregation.

## Stage 16 — Full Responsive Design Pass

Frontend-only CSS/Tailwind pass, no backend/schema/route changes. Covers
all 9 screens (Login, Dashboard, Billing, Products, Customers, Suppliers,
Orders, Reports, Audit Log).

**Sidebar** (`components/Sidebar.jsx`) rebuilt as a responsive drawer:
below `md` it's a fixed, off-canvas panel toggled by a hamburger button
(+ tap-to-close backdrop) that the component renders itself, so no page
had to change its own markup to get it; at `md`+ it's unchanged —
always-visible, in-flow, exactly as before Stage 16. Nav links close the
drawer on click (mobile). `Topbar.jsx` reserves space for the hamburger
(`pl-14` below `md`), wraps instead of overflowing at narrow widths, and
hides the username label (keeps the avatar) below `sm`.

**Billing** (highest-risk per spec — doesn't use Topbar, has its own
header): added matching hamburger clearance, header now wraps, the
`h-[600px]` three-panel grid only applies at `md`+ (stacks naturally
below that), and the product-search table sits in its own
`overflow-x-auto` with a `min-w-[560px]` floor instead of columns
crushing unreadably.

**Products / Customers / Suppliers** — all three share the same
list+edit-form two-pane pattern; that pane split now stacks vertically
through `lg` (list on top, form below, both full-width) and only goes
side-by-side at `lg`+. Each list table got `overflow-x-auto` + a `min-w`
floor (Products 640px, Customers 780px — 7 columns, Suppliers 640px, plus
its nested purchase-history sub-table at 520px) rather than squishing
columns. Search inputs go full-width below `sm`.

**Orders** — table wrapped in `overflow-x-auto` + `min-w-[720px]`; the
expanded per-order detail row was already a 1-col/2-col responsive grid
and needed no change.

**Dashboard** — stat-card grid changed from a `2 → 4` column jump to
`1 → 2 → 4`, both report tables wrapped in `overflow-x-auto`, header
wraps, padding scales down on mobile.

**Reports** — header wraps, padding scales down; the export-card grid and
offline-sync/conflict panel already used responsive patterns and needed
no table/overflow fixes.

**Audit Log** — already had `overflow-x-auto` from Stage 14; added a
`min-w-[700px]` floor for consistency and matching mobile padding. The
expandable before/after JSON `<pre>` blocks already scroll independently
and needed no change.

**Login** — fixed `w-96` card replaced with fluid `w-full max-w-sm/md`,
heading sizes scale down below `sm`, page padding added so the card never
touches the viewport edge; `h-screen` → `min-h-screen` so a very short
viewport doesn't clip content.

No new dependencies — existing Tailwind/`@tailwindcss/vite` setup
handled all of it, matching the spec's expectation.

**Verified:** `npm run build` and `npm run lint` clean (frontend) — same
one pre-existing unrelated `AuthContext.jsx` warning as every prior
stage, no new warnings/errors. Live boot test (server + built
`frontend/dist`, no MongoDB in this sandbox): `/` → 200, `/products` (SPA
route) → 200, `GET /api/products` no token → 401 (regression check,
unaffected by this stage), unknown `/api/*` → clean JSON 404. Reviewed
every touched screen's markup by hand at the mobile/tablet/small-laptop/
wide-desktop breakpoints named in the spec, including nested elements
(Orders' expanded detail row, Suppliers' purchase-history sub-table,
Audit Log's before/after JSON panel) for scroll/stacking correctness.
**Not verified:** no real browser in this sandbox to visually confirm
against actual device viewports or to check touch-target sizing
empirically — this was a code-level review against Tailwind's documented
breakpoints, not a rendered-pixel check. Recommend a quick manual pass in
a real browser (or its responsive-mode devtools) before calling this
stage fully closed, particularly on Billing given its density.

## Stage 17 — Special Bill (Alternate Receipt Layout)

Scoped from a supplied catering-invoice reference image once it arrived
(this stage was blocked on that — see prior entry). Turned out to be a
different ask than the original Stage 17 framing ("swap the print popup
for a real generated PDF") — instead: a **second, selectable receipt
layout**, previewed before commit, both still going through the existing
`window.open()` print flow (`lib/print.js` untouched).

Billing.jsx now has two buttons at the payment step: **Generate Bill**
(unchanged — original plain-table receipt) and **🧾 Special Bill**, which
opens an on-screen preview modal styled after the reference image
(double border, "INVOICE" title, BILLED TO / ORDER INFO two-box header,
Quantity/Description/Price/Amount table, Grand Total, italic "Thanks"
footer) before anything is committed. The modal's own "Generate Bill"
button then runs the exact same commit path as the normal button
(`saveDraftNow` → `api.saveOrder`, same validation, same Stage 11
offline-queue fallback) and prints using the special layout instead of
the default one — `handleGenerateBill` took a `special` flag rather than
becoming two separate functions, so there is one commit path, not two.

**No new fields anywhere** — every value on the Special Bill layout
already existed: Bill ID, order date, cashier (`username`), payment
method, cart line items, and Grand Total/Paid/Balance are the same as the
default receipt; customer mobile/address/email are real `Customer`
document fields already returned by `GET /api/customers` (Stage 8) —
Billing previously only kept the customer *name* from that response for
its dropdown and discarded the rest, so a `customerDirectory` lookup
(name → {mobileNo, email, address}) was added to keep what the API
already sends, not to add new data. The reference template's Ship To,
Delivery Date/Terms/People/Delivery Time, and company-logo/address boxes
were dropped entirely — no such fields exist anywhere in this app's
schema, and the ask was explicit that none should be added.

**Verified:** `npm run build` and `npm run lint` clean (frontend) — same
one pre-existing unrelated `AuthContext.jsx` warning as every prior
stage, no new ones. Live boot test of the server serving the built
`frontend/dist` (no MongoDB in this sandbox): `/` → 200, `/billing` (SPA
route) → 200, `GET /api/products` and `GET /api/customers` (regression
check, unrelated to this stage's change) → 401 with no token, all
unchanged. **Not verified:** no live MongoDB replica set or real browser
in this sandbox — the actual print popup output, the on-screen preview
modal's rendering, and a real order commit through either button path
are code-reviewed only, not exercised end-to-end. Recommend a manual
pass (place a real cart, try both buttons, confirm the print dialog
layout matches) before treating this as fully closed.

**Addendum — logo:** both the printed HTML and the on-screen preview
modal now reference `frontend/public/logo.png` (top of the invoice,
above the "INVOICE" title) — the person's shop logo, dropped into
`frontend/public/` by them, not something this app generates or stores.
The printed popup uses an absolute URL (`window.location.origin +
'/logo.png'`) since it's a blank window with no base URL of its own to
resolve a relative path against; the on-screen preview uses a normal
relative `/logo.png` (served from the app's own origin either way). Both
fail gracefully (`onerror`/`onError` hides the `<img>`) if the file isn't
present yet, so this doesn't break anything before the logo is actually
added. Not verified with a real file in this sandbox — only that the
markup builds clean and degrades safely without one.

## Stage 19 — Worker Permissions & Walk-in / Unknown Customers

(Stage 18 — Desktop Distribution — remains skipped/deferred; commented
out in `optimization.md` rather than deleted, per the person's note that
it tends to get skipped. Picking up at 19.)

**Backend permission tightening** — `requireAdmin` added (alongside the
existing `requireAuth`) to the product and supplier *master-data*
mutation routes: `POST /api/product` (create/update), `DELETE
/product/:productID`, `POST /product/undo`, `POST /api/supplier`
(create/update), `DELETE /supplier/:supplierName`. This is enforced at
the route/middleware level, same pattern as the existing admin-only
routes (`/billing/update`, `/api/order/:orderID/edit`, etc.) — a worker
calling these directly with a valid worker token now gets a clean 403
`{ success: false, message: 'Admins only.' }`, not just a hidden button.

**Deliberately left `requireAuth`-only (not admin-gated):**
`POST /supplier/purchase` (restocking) and `POST /billing/addCustomer` /
`POST /customer/updateCustomer` — restocking is inventory work, not
supplier*-management* (it references an existing supplier, it doesn't
create/edit/delete one), and customer creation is explicitly meant to
stay available to workers per the spec. This matches Stage 20's existing
note in `optimization.md` that a restock screen shouldn't imply
supplier-management rights.

**Frontend UI gating** — `Products.jsx` and `Suppliers.jsx` already
imported `useAuth`/`isAdmin` for the Stage 13 "previous price" display;
that same flag now also gates the mutation UI itself for non-admins:

* Products — the Edit/Delete icons per row, the whole Add/Update form
  panel, and the "Add Product +" / "Undo Deleted" buttons are all
  `isAdmin`-only. A worker sees the product table (read-only) with an
  em-dash in the Actions column instead of the icons, and the whole
  right-hand form panel doesn't render (list takes the full width
  instead of 2/3).
* Suppliers — the Delete icon per row and the whole "Add Supplier" form
  panel are `isAdmin`-only. The "Record a Purchase" (restock) form below
  is untouched and stays available to everyone, matching the backend.

No change was needed to `App.jsx`/`Sidebar.jsx` routing — both pages stay
reachable by workers (they still need to browse products/suppliers and
restock), only the mutation affordances inside them are gated. This is
different from Stage 14's Audit Log pattern (fully admin-only route via
`AdminRoute`), which fits here since Stage 19 explicitly wants workers to
keep read/restock access, not be bounced from the page.

**Walk-in / Unknown customer** — a new `Walk-in / Unknown` option was
added to Billing's customer dropdown (`🚶 Walk-in / Unknown`), between
the placeholder and the real customer list. This is a plain sentinel
*string*, not a code — `WALKIN_CUSTOMER = 'Walk-in / Unknown'` is defined
identically in both `main.js` and `Billing.jsx` (with a comment on each
side pointing at the other) since the frontend already sends whatever's
in `customer` state straight through as `customerName`, same as any real
customer name. No new field, no new draft/order shape.

`POST /billing/orderDetails` now special-cases this exact value: it
skips the `Customer.findOne` lookup/404 entirely (there's nothing to
find) and skips the `Customer.updateOne $push` that records order history
against a customer (there's no customer document to push onto). Every
other part of the existing commit path — price re-verification, the
atomic stock decrement, payment/balance calculation, the Order document
itself, the audit log entry — runs unchanged; a walk-in sale is a fully
real, fully audited `Order`, it's just not attached to any `Customer`
document. Dashboard/report aggregations that group by `Order.customerName`
directly (`lib/reports.js`'s sales/refund summaries, CSV exports) will
naturally show "Walk-in / Unknown" as a bucket; the *credit*-related
aggregations (`Customer.aggregate` for total credit, the payables report
keyed off `Customer.find({'orders.balanceDue': {$gt:0}})`) never see
walk-in sales at all, since nothing was ever pushed to a Customer
document — so a walk-in sale can never accidentally create/contribute to
a credit account, per spec.

No changes were needed to `POST /billing/draft` (already accepts any
`customerName` string permissively — it just autosaves whatever's typed)
or to `PendingBill`/`Order`/`Customer` schemas.

**Verified:** `node --check` clean on every touched/adjacent backend
file. Live boot test (no MongoDB in this sandbox): unauthenticated
requests to the now-admin-gated routes → 401 (unchanged); a worker-role
JWT against `POST /api/product`, `POST /api/supplier`, `DELETE
/product/:productID`, `POST /product/undo`, `DELETE
/supplier/:supplierName` → clean 403 `Admins only.`; the same worker
token against `POST /supplier/purchase`, `POST /billing/addCustomer`,
`GET /api/products`, and `POST /billing/draft` with
`customerName: "Walk-in / Unknown"` → all pass the auth/role gate (500,
not 401/403 — the expected shape with no live DB in this sandbox); an
admin-role JWT against `POST /api/product` and `DELETE
/supplier/:supplierName` → likewise passes the gate (500, not 403).
`npm run build` and `npm run lint` clean on the frontend — same one
pre-existing unrelated `AuthContext.jsx` warning as every prior stage, no
new ones. Re-ran the full boot test against the built `frontend/dist`
afterward: `/`, `/products`, `/suppliers`, `/billing` (SPA routes) → 200,
unknown `/api/*` → clean JSON 404, `GET /api/products` with no token →
401 (regression, unchanged).

**Not verified:** no live MongoDB replica set or real browser in this
sandbox — the actual DB-backed behavior (a worker's product/supplier
mutation attempt being rejected *after* successfully authenticating, a
real walk-in order committing end-to-end and never appearing in a credit
report, the dropdown/UI rendering correctly for a logged-in worker vs.
admin) is code-reviewed and auth/role-gate-tested only, not exercised
against a real database or in a real browser. Recommend a manual pass
(log in as both roles, try Products/Suppliers mutations as a worker, run
a walk-in sale through Billing) before treating this fully closed.

## Stage 20 — Supplier Selection & `NoSupplier` / Self-Purchased Stock

`Product.supplier` (a free-text string, default `'N/A'`) is gone,
replaced by `Product.supplierID` (`ObjectId ref: 'Supplier'`, default
`null`). This is a **breaking schema change** for any pre-Stage-20 data
that had a plain string in `supplier` — there's no migration script,
since this sandbox has no live database to migrate and Stage 20's own
exit criteria explicitly calls for a real reference, not an arbitrary
string. On a real deployment, existing products will show "NoSupplier"
until an admin re-selects a real one from the new combobox. Flagging this
plainly rather than assuming it's fine — worth a quick check against real
data before merging.

**`NO_SUPPLIER = 'NoSupplier'`** is a new sentinel constant in `main.js`,
mirroring Stage 19's `WALKIN_CUSTOMER` exactly: a plain string, defined
identically in `main.js`, `Products.jsx`, and `Suppliers.jsx` (each side
comments where its counterpart lives), sent through as a normal form
value rather than a special code. It represents stock the business
bought itself, with no external supplier involved.

**`resolveSupplierId(rawSupplierId)`** (new helper in `main.js`) is the
single place that turns whatever a form submits into either a real
Supplier `_id` or `null`: empty/`undefined`/`NO_SUPPLIER` → `null`;
anything else must be a valid ObjectId that actually matches an existing
`Supplier` document, or the request 400s with "Invalid supplier
selected." — an arbitrary or stale id is rejected, not silently accepted
or silently coerced to null, per the exit criteria.

**Product create/update/undo** (`POST /api/product`, `POST
/product/undo`) now take `supplierId` instead of `supplier`, resolved
through the helper above before being written to
`existingProduct.supplierID` / `newProduct.supplierID`.

**`GET /api/products`** now `.populate('supplierID', 'supplierName')`
and returns two plain fields, `supplierId` and `supplierName` (`null` for
self-purchased products), instead of the old raw `supplier` string — the
frontend combobox doesn't need to know about Mongoose population shapes.

**Restocking (`POST /supplier/purchase`) supports both paths**:
`supplierName` naming a real supplier still runs the original flow
unchanged (Supplier lookup, `$push` into `Supplier.purchases[]`, standard
payment/balance tracking). `supplierName === NO_SUPPLIER` is the new
self-purchase path: skips the `Supplier.findOne` lookup and the
`Supplier.purchases[]` push entirely — no fake Supplier document is
created just to record the purchase (per the exit criteria) — but still
updates `Product.quantity` and pushes a `buyingPriceHistory` entry
(`supplierID: null`) for every item, inside the exact same
`session.withTransaction()` block as the real-supplier path, so a
self-purchase across several items stays atomic just like a real one.
Amount-paid/balance-due tracking is skipped for self-purchases (there's
no one to owe money to) — the response carries `selfPurchase: true`
instead of `amountPaid`/`balanceDue`, and the frontend hides the "Amount
Paid" input when `NoSupplier` is selected. Audit logging distinguishes
the two: `supplier.purchase` (existing) vs. a new `product.restocked`
action for self-purchases, targeting `'product'`/`NO_SUPPLIER` since
there's no supplier document to target.

**Deliberate scope boundary**: recording a restock — from a real
supplier or self-purchased — does **not** change `Product.supplierID`.
The product's declared "current supplier" is set only via the Products
form; restocking is inventory work, same reasoning Stage 19 already used
to keep `/supplier/purchase` worker-accessible rather than admin-gated.
This means a self-purchased restock for a product that *does* have a
declared supplier is legitimate and doesn't silently overwrite that
relationship. `Supplier.deleteOne` continuing to leave existing
`buyingPriceHistory[].supplierID` references alone (Stage 5/19 behavior,
noted again here) extends naturally to `Product.supplierID` too — deleting
a supplier a product currently points at leaves a dangling reference
rather than silently reassigning it to something else; not treated as
this stage's problem to solve, since the exit criteria's concern is
historical purchase records specifically, not the live pointer.

**Frontend**: `Products.jsx`'s Supplier field is now a `<select>`,
populated from `GET /api/suppliers` (same `allSuppliers` list-fetch
pattern `Suppliers.jsx` already used for its own dropdowns), defaulting
to the NoSupplier option; `emptyForm.supplierId` defaults to
`NO_SUPPLIER` rather than an empty required field. `Suppliers.jsx`'s
existing restock-form supplier `<select>` gained a NoSupplier option
alongside the real supplier list; the "Amount Paid" input is conditionally
hidden when it's selected, and the post-submit alert branches on
`data.selfPurchase` to skip mentioning a supplier balance that doesn't
apply.

**Verified:** `node --check` clean on `main.js` and `models/Product.js`.
`npm run build` and `npm run lint` clean on the frontend — same one
pre-existing unrelated `AuthContext.jsx` warning as every prior stage, no
new ones. Live boot test (single `bash_tool` call, no MongoDB in this
sandbox): unauthenticated → 401 unchanged; worker token against
`POST /api/product` and `DELETE /supplier/:supplierName` → 403 "Admins
only." unchanged (regression); admin token with a syntactically-invalid
`supplierId` → clean 400 "Invalid supplier selected." **before any DB
call**, confirming `resolveSupplierId()`'s reject-path doesn't depend on
a live database; admin token with `supplierId: "NoSupplier"`, worker
token with `supplierName: "NoSupplier"` against `/supplier/purchase`,
and worker token against `GET /api/products` all passed their auth/role
gates correctly and then hit the expected DB-buffering timeout (no
replica set here, same limitation as every stage since 12) — critically,
the server **stayed up and kept responding correctly** to a request made
immediately afterward, so the self-purchase transaction path doesn't
crash the process even when it can't reach a database.

**Not verified:** no live MongoDB replica set or real browser in this
sandbox — the actual DB-backed behavior (a real supplier combobox
populated and submitted end-to-end, a self-purchase restock actually
incrementing stock and appending to `buyingPriceHistory`, a real-supplier
restock still working unchanged, an invalid-but-well-formed ObjectId
correctly rejected once a live DB can actually check for existence, the
"NoSupplier" self-purchase correctly *not* appearing in any supplier's
purchase-history table) is code-reviewed and auth/validation-gate-tested
only. Recommend a manual pass against a real replica set (create a
product via the new combobox, restock it both from a real supplier and
via NoSupplier, confirm stock/price history and the Suppliers screen all
reflect it correctly) before treating this fully closed. Also recommend
double-checking any existing production products' `supplier` string
values before merging, given the breaking-schema-change note above.

## Stage 21 — Unified Product Pricing, Restock & Price Synchronization

Audit first: most of this stage's exit criteria already held before any
code changed. `getLatestSellingPrice()`/`getLatestBuyingPrice()`
(`lib/pricing.js`) already keep the two histories fully separate;
`GET /api/products` already exposes both as distinct `price`/`costPrice`
fields; Billing/Products/receipts already read only `price`
(`getLatestSellingPrice`), never `costPrice`; `POST /billing/orderDetails`
already re-verifies against `getLatestSellingPrice()`; Stage 13's
"Previous" display in `Products.jsx` was already the previous *selling*
price, not cost. The one real gap: **restocking could only ever touch
`buyingPriceHistory`** — there was no way to update a product's selling
price from the Supplier/restock flow, only from the Products edit form.

**Backend (`POST /supplier/purchase`)**: each item may now optionally
carry a `sellingPrice` alongside its required `unitCost`. Blank/omitted
means "leave the selling price alone" — not "set it to zero" — validated
the same way as `unitCost` (finite, ≥0) only when actually submitted, so
an invalid value still 400s before any DB call. Inside the existing
`session.withTransaction()` block, after the stock/`buyingPriceHistory`
update, a `sellingPriceHistory` entry is pushed **only if** a price was
submitted **and** it differs from the current one — identical "did it
actually move" guard `POST /api/product` already uses, so
`sellingPriceHistory` doesn't grow every time a restock happens to repeat
the same price. `buyingPriceHistory` and `sellingPriceHistory` remain
fully independent arrays; updating one never touches the other, in
either direction (Product edit form still never writes
`buyingPriceHistory`; restock's `unitCost` still never touches
`sellingPriceHistory` unless `sellingPrice` was separately submitted).
`Supplier.purchases[].items` sub-schema doesn't declare a `sellingPrice`
field, so Mongoose silently strips it there (intentional — a supplier's
purchase-history table records what was bought/owed, not a second place
for price changes to live; the real record is
`Product.sellingPriceHistory` plus this action's own audit-log entry,
which does retain it).

**Frontend (`Suppliers.jsx`)**: the restock form gained a "Selling Price
(optional)" input next to the existing "Cost / Buying Price" (renamed
from "Unit Cost" for clarity per the exit criteria's explicit-labeling
requirement), each showing its own distinct "Previous" line —
`previousBuyingPrice` (`costPrice`, unchanged) and the new
`previousSellingPrice` (`price`) — sourced from the same
`GET /api/products` response, so there's no ambiguity about which
"previous" is which. Left blank, the field submits nothing and the
product's selling price is untouched. `Products.jsx`'s price field/label
was renamed "Price" → "Selling Price" ("Previous:" → "Previous selling
price:") for the same explicit-labeling reason — no behavior change,
label only.

**Verified:** `node --check` clean on `main.js`. `npm run build` and
`npm run lint` clean on the frontend — same one pre-existing unrelated
`AuthContext.jsx` warning as every prior stage, no new ones. Live boot
test (single `bash_tool` call, no MongoDB in this sandbox): unauthenticated
`POST /supplier/purchase` → 401 unchanged; a negative or non-numeric
`sellingPrice` → clean 400 **before any DB call**, confirming the
validation guard doesn't depend on a live database; a worker token and an
admin token, each with a valid payload including a `sellingPrice`, both
passed the auth/validation gates and reached the expected DB-buffering
timeout (no replica set here, same limitation as every stage since 12) —
the server stayed up and kept responding correctly to requests made
immediately afterward (regression-checked `GET /api/products` → 401 no
token, `POST /api/product` worker token → 403 "Admins only.").

**Not verified:** no live MongoDB replica set or real browser in this
sandbox — the actual DB-backed behavior (a restock that submits a new
selling price actually appearing as the new `price` on `GET /api/products`
and in Billing's product list/cart, a restock that omits it leaving the
selling price untouched, `sellingPriceHistory` not growing on a repeated
same-price restock, the new form fields rendering/gating correctly for
admin vs. non-admin) is code-reviewed and validation-gate-tested only.
Recommend a manual pass against a real replica set (restock a product
both with and without a selling price, confirm Products/Billing reflect
it correctly and history arrays grow as expected) before treating this
fully closed.

## Post-Stage-21 Fix — Supplier Restock: Overpayment Credit + Auto-Filled Amount Paid

Reported while manually testing Stage 21's restock form: recording a
purchase with Amount Paid greater than the purchase total (e.g. $120
paid against a $100 total) showed "Balance due to supplier: $0.00" —
correct on its face, but the $20 overpayment wasn't tracked anywhere.
Root cause: `POST /supplier/purchase` clamped `paid` to
`Math.min(amountPaid, totalAmount)` before computing `balanceDue`, so
anything paid beyond the total was silently discarded rather than
recorded. Confirmed by reading the exact line — not a maybe-bug.

**Design decision (asked, not assumed):** offered three options —
reject overpayment outright, track it as rolling supplier credit, or
something else. Chosen: **track it as credit that automatically reduces
what's owed on the supplier's next purchase.**

**Backend (`models/Supplier.js`, `main.js`)**:
- `Supplier` gained `creditBalance` (`min: 0`, default 0) — a running
  total of what a given supplier currently owes *us* from a past
  overpayment. Purchase sub-schema gained `creditApplied` (`min: 0`,
  default 0), recorded per-purchase for audit/transparency only — never
  re-read or re-applied after the fact, it's a snapshot of what happened
  at the time.
- `POST /supplier/purchase`: `amountPaid` is no longer capped at the
  purchase total — it's now validated the same way item fields are
  (finite, ≥0 when present; blank/omitted still means "0 paid", but
  garbage input now 400s instead of silently becoming 0). Inside the
  existing `session.withTransaction()`, the supplier document is
  re-fetched via the session (not reused from the pre-transaction lookup,
  to avoid a stale `creditBalance` under concurrent purchases) and the
  math runs: existing credit is applied to the new total first
  (`creditApplied = min(existingCredit, totalAmount)`), what's left after
  that is `netOwed`, and only paying *more than netOwed* creates new
  credit (`overpay = max(0, paidInput - netOwed)`,
  `newCreditBalance = existingCredit - creditApplied + overpay`). A
  single purchase's own `balanceDue` still never goes negative — credit
  always lives on the supplier document, not as a negative number on one
  purchase row. `Supplier.creditBalance` and the new purchase (with its
  `creditApplied` snapshot) are written in a single `$set`+`$push`
  `updateOne` inside the transaction, alongside the stock/price-history
  updates from Stage 21 — same atomicity, nothing new touches a separate
  write. Self-purchases (`NO_SUPPLIER`) are unaffected — there's no
  Supplier document for them, so no credit concept applies, same as
  before.
- `GET /api/suppliers` now also returns `creditBalance` per supplier —
  deliberately separate from `totalBalanceDue` (what we owe them vs. what
  they owe us); a supplier can carry both at once if purchases happened
  in that order.

**Frontend (`Suppliers.jsx`)**: two changes, one requested alongside the
bug report —
- **Amount Paid now auto-fills** with quantity × cost (the purchase
  total) whenever either changes, defaulting the form to "pay in full"
  instead of starting blank — but stays fully editable; typing a
  different number is tracked (`autoFilledPaid` ref) so a manual edit is
  never silently overwritten by a later quantity/cost tweak, only a
  fresh, still-untouched auto-fill is.
- Supplier list gained a **Credit** column (green, only shown when > 0);
  the expandable purchase-history sub-table gained a **Credit Applied**
  column. The post-submit alert now explicitly states when existing
  credit was applied to a purchase and when a new credit balance was
  created from overpayment, instead of just showing a bare balance-due
  figure that made $0.00 look like "nothing happened."

**Verified:** `node --check` clean on `main.js` and `models/Supplier.js`.
`npm run build`/`npm run lint` clean on the frontend (same one
pre-existing unrelated `AuthContext.jsx` warning, no new ones). The
credit-math formula itself was unit-verified standalone (7 scenarios:
exact payment, underpay, the exact reported overpay bug, existing credit
exactly covering a new total, existing credit exceeding a new total and
rolling forward the remainder, existing credit plus additional cash
stacking further credit, and zero payment) — all balanceDue/creditApplied/
newCreditBalance values came out algebraically consistent
(`totalAmount = creditApplied + balanceDue + paid − overpayPortion` holds
in every case). Live boot test (single `bash_tool` call, no MongoDB in
this sandbox): a non-numeric or negative `amountPaid` → clean 400s before
any DB call (confirms the new validation guard doesn't depend on a live
database); a valid overpayment payload and a payload omitting
`amountPaid` entirely both passed every gate and reached the expected
DB-buffering timeout (no replica set here); server stayed up and kept
responding correctly to requests made immediately afterward
(`GET /api/suppliers` → 401 no token, unchanged).

**Not verified:** no live MongoDB replica set or real browser in this
sandbox — the actual DB-backed behavior (an overpayment really showing up
as `creditBalance` on `GET /api/suppliers`, that credit really being
consumed on the supplier's next restock, the new Credit/Credit Applied
columns and the auto-filled Amount Paid field rendering and behaving
correctly in a real browser) is code-reviewed, unit-math-verified, and
validation-gate-tested only. This is exactly what's being manually tested
now — recommend confirming the scenarios above against a real replica set
before treating it fully closed.

## Post-Stage-21 UI Tweak — Combined Balance/Credit Columns

Follow-up from a screenshot review of the credit fix above: the supplier
list had **both** a "We Owe" and a "Credit" column, and the
purchase-history sub-table had a separate "Credit Applied" column — in
practice a supplier only carries one side of that (owed *or* credited)
at a time, and a purchase either used credit or it didn't, so most rows
showed a bare "—" in one of those columns. Flagged as looking cluttered/
redundant.

**`Suppliers.jsx`**: the supplier list's "We Owe"/"Credit" columns are
now a single **Balance** column — red "`$X owed`" when `totalBalanceDue`
> 0, green "`$X credit`" when `creditBalance` > 0 (mutually exclusive in
practice; if a supplier somehow carried both, owed takes display
priority since that's the more actionable number), otherwise a plain
`$0.00`. Still sorts by `totalBalanceDue` under the hood — same field as
before, just relabeled. The purchase-history sub-table's "Credit
Applied" column was removed entirely; when a purchase actually applied
credit (`creditApplied > 0`), a small green note now appears inline
under that row's Balance figure instead of occupying its own column that
was blank almost everywhere. Table `colSpan`s dropped from 7 to 6
throughout to match the removed column. No backend or data-shape changes
— `creditBalance`/`totalBalanceDue`/`creditApplied` are all still
returned exactly as before, this is presentation only.

**Verified:** `npm run build` + `npm run lint` clean (same one
pre-existing unrelated `AuthContext.jsx` warning). Not re-verified
against a live database beyond that — pure layout change on data that
was already confirmed correct in the previous entry.

## Post-Stage-21 Fix — Combined Balance Column Was Hiding Credit, Not Netting It

Reported from a screenshot: a supplier showed "$1050.00 owed" with no
mention of credit at all, even though one of that supplier's purchases
in the same table clearly showed a $500 overpayment (Total $500, Paid
$1000). Root cause: the previous commit's combined Balance column picked
*either* `totalBalanceDue` *or* `creditBalance` to display, prioritizing
"owed" whenever it was nonzero — so a supplier that genuinely had both
(older unpaid purchases *and* separate credit from a different, newer
overpayment) had its credit silently hidden from this view entirely,
which looked exactly like the original overpayment bug all over again
even though the credit was correctly recorded and available in the API
response the whole time.

**Fix (`Suppliers.jsx`, display only)**: the Balance column now shows
the **net** of the two — `netBalance = totalBalanceDue - creditBalance`
— red "`$X owed`" when positive, green "`$X credit`" when negative, plain
`$0.00` at exactly zero. Whenever both figures are nonzero, a small
gray breakdown line appears underneath (e.g. "$1050.00 due − $500.00
credit") so the math is visible instead of just a number that doesn't
obviously add up from the purchase rows below it. No backend or schema
change — `totalBalanceDue` and `creditBalance` are unchanged, still
computed exactly as in the credit-fix commit above; this is purely how
they're combined for display.

Worth being explicit about what this *isn't*: the credit is still only
mechanically consumed by the supplier's *next* restock (per
`POST /supplier/purchase`'s `creditApplied` logic) — it does not
retroactively rewrite the `balanceDue` stored on the older unpaid
purchases below it in the table. The net figure at the top is an
accurate *summary* of the supplier's overall position; the per-purchase
rows underneath intentionally stay a historical record of what actually
happened on each purchase, not a live-recalculated ledger.

**Verified:** `npm run build` + `npm run lint` clean (same one
pre-existing unrelated `AuthContext.jsx` warning). Net-balance arithmetic
hand-verified against the exact numbers from the reported screenshot
(1050 due − 500 credit = 550), matches expected display.

## Post-Stage-21 Fix — Credit Was Silently Ballooning on Ordinary Restocks

Reported from a screenshot: a supplier's credit had grown to $850 across
a handful of otherwise-ordinary restocks — nobody had deliberately
overpaid on most of them, yet each one added more credit anyway (e.g. a
$200 purchase, paid exactly $200, still added $200 of *new* credit on
top of what the supplier already had). Root cause: the Amount Paid
auto-fill (added in the earlier credit-fix commit) always defaulted to
the raw purchase total — `quantity × unitCost` — with no awareness of
whatever credit the supplier already carried. Server-side, once existing
credit already fully covers a purchase (`netOwed` reaches 0), *anything*
paid beyond that is defined as pure overpayment and becomes more credit
(`overpay = max(0, paidInput - netOwed)`) — which is correct in
isolation, but the auto-filled default kept nudging admins into typing
the full total even when the real remaining balance was $0, so simply
accepting the default on a routine restock silently created more credit
every time, with nothing in the UI making that obvious.

**Fix (`Suppliers.jsx`, frontend only — the backend math from the
previous credit-fix commit was already correct and is unchanged)**:
- The Amount Paid auto-fill now computes `netOwed = max(0, total −
  selectedSupplierCredit)` instead of the raw total, mirroring exactly
  what `POST /supplier/purchase` will actually compute server-side —
  `selectedSupplierCredit` is looked up from `allSuppliers` (same
  `GET /api/suppliers` response already used for the dropdown, so no new
  request). Accepting the default on a purchase already fully covered by
  existing credit now correctly proposes $0, consuming the credit instead
  of stacking more on top of it.
- The field's helper text now explicitly states the supplier's available
  credit and that it's already been subtracted (e.g. "Auto-fills with
  what's still owed after this supplier's $550.00 credit is applied…"),
  so the reduced default doesn't look unexplained.
- Manually typing a larger amount still works exactly as before and will
  still (correctly) create additional credit — that's a deliberate
  overpayment now, not an accidental one from a default the admin didn't
  examine closely.

**Verified:** `npm run build` + `npm run lint` clean (same one
pre-existing unrelated `AuthContext.jsx` warning). Hand-simulated the
exact scenario from the report (existing credit 550, a $200 purchase) —
before the fix, accepting the old default (paid=200) left credit
unchanged at 550 despite the purchase being fully covered; after the
fix, accepting the new default (paid=0) correctly consumes credit down
to 350.

**Not verified:** no live database/browser in this sandbox — the
`allSuppliers`-driven credit lookup and the live-updating helper text
are code-reviewed and build/lint-verified only.

## Post-Stage-21 Fix — Paid Exceeding Total Looked Contradictory Without a "New Credit" Note

Reported from a screenshot: purchase-history rows where `amountPaid`
exceeded `totalAmount` (e.g. Total $200, Paid $250, with a "$200.00
credit applied" note already on the Balance cell) read as
self-contradictory — it looked like $450 of value went toward a $200
purchase. It didn't: the $200 credit-applied figure is *existing*
credit that covered the total, and the $250 paid was a *separate* amount
that, since nothing was actually owed by that point, became entirely
new credit — but nothing in the table said so, so the numbers looked
unexplained rather than merely surprising.

**Backend (`models/Supplier.js`, `main.js`)**: purchase sub-schema
gained `creditGenerated` (`min: 0`, default 0) — the mirror image of
`creditApplied`. Where `creditApplied` records how much *existing*
credit was consumed by this purchase, `creditGenerated` records how much
of *this purchase's own payment* became *new* credit (previously this
value was computed as a local `overpay` variable and used only to update
`Supplier.creditBalance` — never itself recorded on the purchase row, so
there was no way to show it after the fact). Same "only ever created
here, never re-applied" audit-snapshot pattern as `creditApplied`.
`POST /supplier/purchase`'s response now also returns `creditGenerated`
alongside the existing `creditApplied`/`creditBalance` fields.

**Frontend (`Suppliers.jsx`)**: the Paid cell now shows a small green
"`+$X new credit`" note beneath the amount when `creditGenerated > 0`,
and the existing Balance-cell credit note was reworded from "credit
applied" to "credit used" to read more clearly as the opposite of the
new note above it. Together a row like Total $200 / Paid $250 now reads:
Balance $0.00 ("$200.00 credit used") / Paid $250.00 ("+$250.00 new
credit") — making it explicit that the $200 total was paid for by
*existing* credit, and the entire $250 tendered became *new* credit
since nothing further was actually owed. The post-purchase confirmation
alert was reworded to match, now mentioning `creditGenerated`
specifically ("$X of what you paid went beyond what was owed and became
new credit") rather than only the running total.

**Verified:** `node --check` clean on `main.js`/`models/Supplier.js`.
`npm run build`/`npm run lint` clean on the frontend (same one
pre-existing unrelated `AuthContext.jsx` warning). Live boot test: a
valid overpay-on-top-of-existing-credit payload passes every gate and
reaches the expected DB-buffering timeout (no replica set in this
sandbox); no unexpected errors in the server log; regression check
(`401` no token) unchanged.

**Not verified:** no live database/browser in this sandbox — the new
field actually round-tripping through a real restock and appearing
correctly in the UI is code-reviewed and boot-tested (validation gates
only) rather than confirmed end-to-end.

## Post-Stage-21 Consolidation — Simplified Credit Display & Reverted Auto-Fill

Feedback after the last several credit-related patches: the accumulated
small fixes had made the Suppliers page inconsistent — money columns
weren't aligned, credit info was split awkwardly across two different
columns (Paid's "new credit" note vs. Balance's "credit used" note), the
top summary mixed text labels with a breakdown line, and the Amount Paid
auto-fill's credit-aware subtraction (added a few commits back to stop
credit from silently growing) was flagged as the wrong direction
entirely — the suggested payment amount should be a simple, predictable
number based purely on what's being bought, not a value that silently
shifts based on hidden supplier state.

**Amount Paid auto-fill reverted to plain `quantity × cost`** — no
longer subtracts the supplier's `creditBalance`. This is a deliberate
reversal of the immediately preceding "credit-aware auto-fill" commit,
requested explicitly: the suggested amount should reflect the literal
cost of what's being restocked, full stop. The supplier's available
credit is still shown (informationally, in the field's helper text) so
the admin can *choose* to pay less, but the form no longer guesses on
their behalf. Backend math (`POST /supplier/purchase`) is completely
unchanged — credit is still applied automatically to reduce what's
owed, and still still grows if the admin pays more than what's actually
owed after that; this only changes what number the field starts with.

**Purchase-history table**: the split "new credit" (on Paid) / "credit
used" (on Balance) notes are consolidated into a single three-state
Balance column: red `balanceDue` when something's still owed, green
`+creditGenerated` when this purchase's own payment created new credit,
plain `$0.00` when it settled exactly with nothing left over and nothing
generated. `creditApplied` (existing credit consumed) still gets a
small gray note underneath either way — informative context, not a
fourth color state. Paid is now just a plain right-aligned figure with
no attached note.

**Top summary table**: the "$X owed" / "$Y credit" text plus a
two-line breakdown is now a single signed number — red `-$X` (net
amount owed across the whole purchase history) or green `+$X` (net
credit), `$0.00` when settled — since the per-purchase breakdown is
already visible one click away in the expanded purchase history, it
doesn't need to be duplicated at the summary level too.

**Alignment**: `SortableHeader` gained an `align` prop (`'left'`
default, unchanged everywhere else) so its `<th>` can right-align to
match right-aligned numeric `<td>`s — used for Purchases/Balance on the
supplier table. Both tables' money columns (Total/Paid/Balance) are now
right-aligned throughout, header and body together, instead of the
previous inconsistent left-alignment on some cells.

**Verified:** `npm run build` + `npm run lint` clean (same one
pre-existing unrelated `AuthContext.jsx` warning). Confirmed the built
CSS actually contains the `text-right` utility (Tailwind's JIT scanner
needs the literal class string present in source, which the `align`
prop implementation preserves — no dynamically-interpolated class
names). Hand-verified the new signed top-summary value and three-state
row logic against the exact numbers from the reported screenshots — all
match expected output.

**Not verified:** no live database/browser in this sandbox.

## Route Inventory — End of Stage 15

**Public:** `POST /auth/login`, `POST /billing/orderid`
**Authenticated:** `POST /auth/refresh`, `GET /api/products`,
`GET /api/customers`, `GET /dashboard/load`, customer mutation routes,
`POST /supplier/purchase` (restock), billing reserve/release/draft/order
routes (including a `Walk-in / Unknown` `customerName`, Stage 19),
`GET /api/orders(/:orderID)`, Stage 10 export routes,
`POST /api/sync/commit`
**Authenticated + Admin:** `POST /billing/update`,
`POST /api/order/:orderID/edit`, `POST /api/order/:orderID/refund`,
`GET /api/sync/conflicts`, `POST /api/sync/conflicts/:id/resolve`,
`GET /api/audit-log`, `GET /api/products/low-stock` (Stage 15),
`POST /api/product`, `DELETE /product/:productID`, `POST /product/undo`,
`POST /api/supplier`, `DELETE /supplier/:supplierName` (Stage 19 — moved
from plain `requireAuth`; product/supplier *master-data* mutations are
now admin-only, restocking and customer creation remain worker-accessible)
**Frontend:** unmatched GET outside `/api`/`/auth` → `index.html`; React
Router owns `/`, `/dashboard`, `/billing`, `/products`, `/customers`,
`/suppliers`, `/orders`, `/reports`, `/audit-log` (admin-only). Unmatched
`/api/*`/`/auth/*` → JSON 404.

List routes support `search`/`sortBy`/`sortDir`/`page`/`limit`. Dashboard
supports `range=week|month|year`. Exports: `summary`, `sales`, `refunds`,
`credit`, `payables`.

## Current Known Cross-Cutting Gaps

1. ~~Public read routes~~ / ~~No refresh-token flow~~ — closed, Stage 12.
2. Billing receipt/cart does not display stored `discountAmount`.
3. Refund cash-back vs store-credit is not distinguished.
4. Stage 8 sort allow-list, fielded search, URL state remain absent.
5. Dashboard refund count/amount use different date scopes.
6. Offline sync not stress-tested at scale.

## Stage 22 — Batch-Based Costing & Dashboard Profit (FIFO)

New model `StockBatch` (`models/StockBatch.js`) — one document per
restock: `productID`, `supplierID` (null for self-purchase, mirrors
`buyingPriceHistory[].supplierID`), `purchaseID`, `quantityPurchased`,
`quantityRemaining`, `unitCost` (frozen at creation — a later restock
never rewrites an older batch's cost, this is what keeps historical
profit stable per exit criteria #6), `purchaseDate`. Indexed on
`{productID, purchaseDate}` for FIFO ordering.

New `lib/costing.js` — the FIFO engine, isolated from the rest of the
app the same way `lib/offlineSync.js` is:
- `createBatch()` — called from `POST /supplier/purchase`'s existing
  per-item loop (both the real-supplier and `NoSupplier` self-purchase
  paths), inside the same transaction as the stock/`buyingPriceHistory`
  update. One new batch per restock line, full stop — restocking already
  atomically updates stock, this just also drops a cost lot.
- `consumeFIFO(productID, quantity, session)` — draws from the oldest
  available batch(es) first (guarded atomic `$inc` on
  `quantityRemaining`, never read-then-write), same pattern the stock
  decrement next to it already uses. Returns exactly what it was able to
  cost (`consumption[]`, `costAmount`, `costQuantity`) plus
  `unknownQuantity` for anything beyond available batch stock — **never**
  falls back to pricing the shortfall at today's cost (exit criteria #7).
  This can never block a sale; it's a pure overlay next to the existing
  stock-decrement guard, not a new gate on checkout.
- `deriveCostSource(costQuantity, quantity)` → `'batch'` (fully costed),
  `'partial'` (a batch ran dry mid-line), or `'unknown'` (no batch
  backing at all — legacy pre-Stage-22 sales, or stock added via the
  Products admin form's plain `stock`/`already` fields, which have no
  cost input and deliberately do **not** create a batch — see the
  comment at the top of `StockBatch.js`).
- `restoreConsumption(batchConsumption, originalQuantity, restoreQty,
  session)` — the inverse, used by admin edit/refund. Gives back
  "unknown" (unbatched) units first since there's no batch to credit
  them to anyway, then works backward through the line's own
  `batchConsumption` list (most-recently-consumed batch first), so the
  oldest-batch portion of what's left keeps its cost basis intact
  through a partial edit/refund.

**`Order.products[]`** (`models/Order.js`) gained `costAmount`,
`costQuantity`, `costSource`, `batchConsumption[]` — set once at commit
time from `consumeFIFO()`'s result, then frozen. `costAmount` only ever
covers the known-cost portion (`costQuantity` of `quantity`) — the rest
is deliberately left out rather than priced at today's cost, per exit
criteria #4/#7 (discounted actual-sale-amount vs. batch cost, never the
list price).

**`POST /billing/orderDetails`** (main.js) — `consumeFIFO()` is called
once per line inside the existing stock-decrement loop, same
transaction, right after that line's stock guard succeeds. Nothing about
the existing price-reverification / reservation / draft-consumption flow
changed; this only adds the cost side-effect next to the stock one that
was already there.

**`lib/offlineSync.js`** — same `consumeFIFO()` call added to its own
stock-availability loop (separate transaction/module by design, per
CLAUDE.md — kept that way here too), so an offline-synced sale draws
down cost batches the same as a live one instead of silently staying
cost-blind and permanently excluded from profit.

**Admin edit/refund** (`applyLineReduction()` in main.js, shared by
`POST /api/order/:orderID/edit` and `POST /api/order/:orderID/refund`) —
now calls `restoreConsumption()` before mutating the line (needs the
line's *original* quantity/consumption first), then proportionally
reduces `costAmount`/`costQuantity`/`batchConsumption` by exactly what
was restored — not an estimate, the exact batch units given back. A full
refund (`newQty === 0`) still removes the line entirely as before; the
restore call still runs first so the batches get their stock back either
way. This satisfies exit criteria #11: a refunded/edited-down line can
never keep contributing its old cost/revenue to profit, because the
dashboard's profit facet (below) reads the same already-mutated
`order.products` array every other stat here already reads.

**`lib/reports.js`** — `getDashboardSummary()` gained a `totalProfit`
facet in the existing `$facet` aggregation (same date-range `$match` as
every other stat, so it's never out of sync with `overallSales`). Per
line: `profitContribution = (amount / quantity) * costQuantity -
costAmount` — i.e. only the known-cost portion of a line's revenue is
matched against its known cost; the unknown-cost portion contributes
*nothing* to profit (not revenue, not cost) rather than being priced at
today's cost. Also returns `totalCostOfGoodsSold` and
`unknownCostUnits` (sum of `quantity - costQuantity` across the range) —
the latter is Stage 22's "identify legacy/unbatched sales separately"
requirement (exit criteria #7), surfaced as a number rather than buried
silently in a profit total that just looks smaller than it should.

**`routes/export.js`** — the `/api/export/summary` CSV gained `Total
Profit`, `Total Cost of Goods Sold`, `Units Sold With Unknown Cost`
columns, matching the same `getDashboardSummary()` call it already made
(this file's own stated purpose is "the same headline numbers the
dashboard shows" — keeping it in sync is not scope creep, it's the
file's job).

**`frontend/src/pages/Dashboard.jsx`** — added a "Total Profit" stat card
next to "Total Sales" (grid widened from 4 to 5 columns on that row).
Its hint line shows "From batch/FIFO cost records" normally, or
"`N unit(s) sold have no recorded cost, excluded`" when
`unknownCostUnits > 0` for the selected range — so the simplification
(Stage 22 §8 explicitly wants this simple, not a full accounting module)
doesn't come at the cost of silently hiding that some sales aren't
represented in it.

**Deliberately unbatched stock**: `POST /api/product` (new
product/initial stock via the Products admin form) does **not** create a
`StockBatch` — that form only ever captured a selling price, never a
cost, and Stage 22 explicitly says not to invent one. Stock entered this
way (and any pre-Stage-22 stock/sales) is sold with `costSource:
'unknown'`, tracked but excluded from profit rather than misrepresented.
If a real acquisition cost needs to be attached to that stock later, the
supported path is a `POST /supplier/purchase` self-purchase
(`NoSupplier`) restock, which does create a batch.

**Verified:** `node --check` clean on every touched backend file
(`main.js`, `models/Order.js`, `models/StockBatch.js`, `lib/costing.js`,
`lib/reports.js`, `lib/offlineSync.js`, `routes/export.js`). `npm run
build` + `npm run lint` clean on the frontend (same one pre-existing
unrelated `AuthContext.jsx` warning). Live boot test: server starts
clean with the built frontend, `GET /` returns the SPA shell (200),
unmatched `/api/*` still 404s as JSON, `GET /dashboard/load` without a
token still 401s, server stays up and responsive after a login attempt
against the absent DB (no crash). Hand-traced the FIFO/profit math
against every worked example in the Stage 22 spec itself: the 10@100 +
10@120, sell-12 example → 1240 total cost (not 1200 or 1440); the
150/100/130-discount example → 30 profit (not 50); a partial-refund
scenario (3 units on one batch, refund 2) → remaining line correctly
keeps `costAmount: 100, costQuantity: 1, costSource: 'batch'` — all
match the spec's own numbers exactly.

**Not verified:** no live database/replica set in this sandbox (same
limitation as every DB-touching stage before this one) — the actual
`StockBatch` creation/consumption/restoration round-tripping through a
real MongoDB transaction, and the dashboard aggregation running against
real data, are code-reviewed and hand-traced against the spec's worked
examples rather than confirmed end-to-end. No browser available either,
so the new Dashboard stat card is code-reviewed against the existing
`StatCard` pattern rather than visually confirmed.

## Current Status

Stages 1–22 implemented (Stage 18, desktop distribution, remains
deliberately skipped/deferred — see the note at the top of its Stage 19
entry above). Stage 11 **end-to-end verified in a real browser +
database**. Stages 1–10/12–17/19–22 verified by
build/lint/`node --check`/boot-test/unit-test per stage above — DB paths
past the auth gate are code-reviewed only (no replica set in this
sandbox), Stage 16's responsive layout and Stage 17's print/preview
output are code-reviewed against Tailwind breakpoints / the reference
image rather than checked in a real browser (no browser available in
this sandbox either — see Stage 16/17 above). EJS removal complete and
verified. Remaining items are deliberate scope limitations and
security/stress-testing/manual-check follow-ups unless a new spec adds
scope.

Stage 22 also introduces a **new collection** (`StockBatch`) with no
backfill for pre-Stage-22 restocks — every unit sold before this stage
(and any stock added via the Products form rather than a supplier
restock) has no batch behind it and is deliberately excluded from
`totalProfit` (`costSource: 'unknown'`) rather than assigned an
arbitrary current cost. See the Stage 22 entry above before expecting
`totalProfit` to reflect a shop's full sales history immediately after
merging this.

Stage 20 also carries a **breaking schema change** (`Product.supplier`
string → `Product.supplierID` reference) with no migration path in this
sandbox — see the Stage 20 entry above before merging against real data.

Stage 15's browser push follow-up (real OS-level alerts) remains an
explicitly deferred stretch goal, not scheduled.

## Stage Numbering Note

Spec stages are independent of the initial React migration stage. Use
the `Spec Stage N` headings when matching supplied stage specifications.
