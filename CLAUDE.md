# CLAUDE.md — BPIOLS Deployment Phase

`production.md` (Stage 1–8) and `final.md` (Stage 1–19) are complete,
merged, and historical. The app is feature-complete; this repo is now in
a **deployment phase**, defined by `deployment.md` (CORS, Electron
packaging, the Windows installer, hosted-production readiness), with
stage numbering continuing from prior phases starting at **Stage 16**.

## Document authority

- `deployment.md` — authoritative plan. `CLAUDE.md` — architecture/
  working rules. `deployment-progress.md` — append-only log.
- `production.md`/`production-progress.md`/`final.md`/`final-progress.md`
  — earlier phases, complete/historical, different numbering, don't reuse.

## Start every task by syncing

1. Clone `https://github.com/HassanAhmed270/BPIOLS.git`, or
   `git fetch origin main && git reset --hard origin/main` if already
   cloned this session. Never trust an earlier session's clone.
2. Read `deployment.md`, this file, and `deployment-progress.md` in full.
3. Identify the next incomplete `deployment.md` stage and work only on it.

## Scope rules

- Work one `deployment.md` stage at a time, in order, from Stage 16.
- Touch only the stage's listed **Affected areas**; a small, clearly-
  necessary addition a stage's own task list implies may proceed but
  must be flagged in `deployment-progress.md`.
- An unrelated one-line, obviously-correct fix may be made inline,
  stated as incidental. Otherwise flag instead of fixing.
- Do not refactor or "improve while you're here."
- If a stage becomes too large, flag it and split (e.g. Stage 17 →
  17a/17b).

## Existing conventions

Check for an existing helper before creating new logic.
- Money: `lib/money.js` → `roundMoney()`; frontend mirror at
  `frontend/src/lib/money.js` → `roundMoney()`/`formatMoney()` (PKR,
  `Rs 1,234.50`, comma-grouped, `-Rs X.XX` for negatives). Prices:
  `lib/pricing.js` (`getLatestSellingPrice`/`getLatestBuyingPrice`).
  Validation: `lib/validators.js`. Pagination/sorting: `lib/query.js`.
- Errors: `lib/errors.js` → `AppError` + `asyncHandler`. Audit logging:
  `lib/auditLog.js` → `logAudit()`.
- FIFO costing: `lib/costing.js` (`createBatch`, `consumeFIFO`,
  `consumeSpecificBatch`, `listRemainingBatches`, `restoreConsumption`,
  `generateUniquePurchaseId`), `models/StockBatch.js`. Deduct Stock uses
  `consumeSpecificBatch` only on an explicit batch pick (Stage 15);
  checkout/offline sync always use plain `consumeFIFO`.
- Sequential IDs: `models/Counter.js` (`{_id, seq}`, atomic); first
  consumer is `routes/products.js`'s `nextProductId()`. Frontend API
  calls: `frontend/src/lib/api.js`.
- Toasts/confirms (Stage 5/6): `sonner`'s `<Toaster>` mounted in
  `App.jsx`, use `toast()`/`.success()`/`.error()`; `ConfirmDialog.jsx`
  exports `ConfirmProvider` + `useConfirm()` — `if (await confirm('Delete
  this?')) { ... }`. No raw `alert()`/`confirm()` remain in `pages/`.
When inside an existing MongoDB transaction, pass its session to helpers
that support sessions.

### Code style

No comments, no extra blank-line padding, in new code and in any existing
function/file directly touched for a fix (strip comments there too). Do
not separately strip comments from files a stage doesn't otherwise touch.

## Verification

- Backend change: boot-test before calling it done — install deps, start
  the server with a real `.env`, hit relevant routes with `curl`, all in
  one shell/tool call. No live MongoDB replica set in the sandbox, so
  boot tests confirm mounting and pre-DB auth/validation only.
- Frontend change: `npm run build` (Vite) before calling it done. Unit
  tests (Stage 12, `fake-indexeddb`-backed) run via `npm --prefix
  frontend test`, separate from root `npm test`.
- `npm test` before calling any stage done — breaking an existing test
  means it's not complete. Clean up artifacts (`node_modules`, `.env`,
  `dist/`, logs) before packaging. No push credentials exist for this
  repo — never claim a change is pushed/live; only Hassan merges it.

## End-of-stage requirements

A stage is not complete until: `deployment-progress.md` is appended;
`CLAUDE.md` is updated if architecture/conventions changed; both docs are
delivered; code is packaged (`git bundle create output.bundle main`, or a
`.patch` file) with exact pull/merge commands; verified vs. unverified
items are stated plainly. Do not begin the next stage until the current
one is done.

## Project architecture

BPIOLS is a single-shop MERN POS/billing system for one desktop.
- Backend: Express + Mongoose at repository root, entry point `main.js`.
- All domain routes live under `routes/`: `auth.js`, `export.js`,
  `sync.js`, `products.js`, `customers.js`, `billing.js` (incl.
  `orderDetails` checkout), `suppliers.js` (incl. `supplier/purchase`),
  `orders.js` (incl. edit/refund, `recomputeOrderTotals`/
  `applyLineReduction`, `GET /dashboard/load`, `GET /api/orders/:id`),
  `audit.js`, `users.js` (`/api/users*` + self-service
  `/api/users/me/password`). Each mounts at `app.use('/', ...)`,
  keeping original full paths. `main.js` only does app setup, DB
  connection, middleware, route mounting, static frontend serving, the
  error handler, and the draft-sweep interval.
- Frontend: React + Vite + Tailwind under `frontend/`. Pages: `Billing.jsx`,
  `Products.jsx`, `Customers.jsx`, `Suppliers.jsx`, `Orders.jsx`,
  `Reports.jsx`, `Dashboard.jsx`, `AuditLog.jsx`, `Users.jsx`, `Login.jsx`.
  `sonner` (toasts) and a hand-rolled `ConfirmDialog` are the only UI
  libs/components beyond Tailwind (Stage 5) — see "Existing conventions".
- Production backend serves `frontend/dist`.
- MongoDB **must run as a replica set** because checkout and other
  inventory mutations use multi-document transactions.
- `.env` is required; `JWT_SECRET` is required for boot and the server
  refuses to boot if it still matches the placeholder in `.env.example`
  (checked in `middleware/auth.js`).
- **CORS** (Stage 16): `lib/cors.js` builds `corsOptions` from
  `ALLOWED_ORIGINS` (comma-separated env var, empty by default —
  same-origin serving needs nothing). `main.js` applies it globally
  before all routes. No `Origin` header (same-origin, curl) always
  passes; unlisted origins get no `Access-Control-Allow-Origin` header.
  Bearer auth (no cookies), so no `credentials: true`. Electron's
  `file://` renderer sends a literal `"null"` Origin — include `null` in
  `ALLOWED_ORIGINS` for the desktop build (see `.env.example`).
- **Electron wrapper** (Stage 17): `electron/main.js` loads `frontend/
  dist-electron/index.html`; 1024x768 min/default window (above
  Tailwind `md`/768px). `electron/preload.js` empty —
  `contextIsolation: true`, no Node/IPC; renderer uses the same
  `fetch()`-based `lib/api.js` as the web build. `vite.config.js`'s
  `mode === 'electron'` branch sets `base: './'` (file:// asset
  resolution) + `outDir: 'dist-electron'`, kept separate from the normal
  `dist` web build. `frontend/.env.electron` sets `VITE_API_BASE=
  http://localhost:3000` — edit this file, not app code, for a future
  hosted-API build. Root scripts: `build-frontend:electron`, `electron`,
  `electron:build`. `electron` is a `dependencies` entry (Stage 18
  packaging needs it available the same way).
- `User.passwordChangedAt` is embedded into every issued JWT (`pwdTs`
  claim). `requireAuth` re-reads it from the DB on every request and
  rejects the token if it's older than the current value — a password
  change invalidates all previously issued tokens. Any code path that
  changes a password must refresh `passwordChangedAt`.

Core models: `Product`, `Customer`, `Order`, `Supplier`, `Refund`,
`PendingBill`, `OfflineSale`, `AuditLog`, `StockBatch`, `User`,
`Counter` (Stage 2), `Loss` (Stage 9). Invariants below:
- Product/order IDs use `#0000`-style identifiers, distinct from Mongo
  `_id`. Add Product generates `#000N` via `nextProductId()` (deleted IDs
  never reissued).
- Product prices are history arrays; read them through `lib/pricing.js`.
  Stock availability accounts for `reserved`. Checkout uses persisted
  `PendingBill` data and server-side verification. Walk-in sales use the
  `Walk-in / Unknown` sentinel and remain real, audited orders without a
  customer credit record.
- `Product.supplierID` is an optional `Supplier` ObjectId; `NoSupplier`
  is the self-purchase sentinel, set only at product creation (Stage 9a
  removed it from Supplier Purchase; Update Product never changes it).
  Restocking/checkout use transactions; FIFO costing via `StockBatch`/
  `lib/costing.js`. Update Product has no stock field; restocking goes
  through **Add Stock** (admin-only, cost+quantity, always self-buying/
  `NoSupplier`) or **Deduct Stock** (required reason + note, via
  `consumeFIFO()`) — `returned_to_supplier` credits supplier
  `creditBalance` (no `Loss`), every other reason writes one `Loss` doc.
- **Zero-stock auto-disable/hard delete** (Stage 9a/9c):
  `disableIfDepleted()` (`lib/costing.js`) sets `Product.disabled` true
  at `quantity` 0 (checkout/offline sync/Deduct Stock; only Add Stock
  clears it) — stays visible, greyed out, won't reserve. `DELETE
  /product/:productID` needs `{reason, note}`, 400s if `quantity > 0`.
- **UI polish** (Stage 10): Products form blue=Add/yellow=Update,
  2-column grid. Billing's cart preview shows a "Customer Balance" line
  (Stage 11). Special Bill removed (final.md Stage 16) —
  `printReceiptFor` is the only receipt path.
- Audit records go through `logAudit()`; `AuditLog.jsx` shows a
  flattened table (`lib/flattenObject.js`, Stage 3). Every export route
  supports `?format=pdf` (`lib/pdf.js`'s `sendTablePDF()`; Stage 9b added
  `/api/export/losses`), driven by `Reports.jsx`'s `EXPORTS` array.
  Indexed: `Order.orderDate`/`customerName`, `Product.category`;
  `Supplier.supplierName` is `unique: true`.
- Customer store credit: `Customer.creditBalance` mirrors
  `Supplier.creditBalance` — money owed to the customer from a past
  refund/edit-down settled as credit. An **edit** always settles freed-up
  overpayment as credit; a **refund** takes explicit
  `settlement: 'cash'|'credit'` (default `'cash'`). `POST
  /billing/orderDetails` auto-applies existing credit against a new
  order's total, mirroring supplier-credit auto-apply. `recomputeOrderTotals`
  returns the freed settlement rather than letting it vanish behind
  `balanceDue`'s clamp-to-zero. Stage 9a's `returned_to_supplier` reason
  adjusts *supplier* credit instead — keep the two paths separate.
  **Overpayment→balance** (Stage 19): `PendingBill.overpaymentChoice`
  (`'change'|'balance'`, default `'change'`) — `POST
  /billing/orderDetails` only credits excess onto `newCreditBalance`
  when non-walk-in and explicitly `'balance'`; offline sync always
  gives change.
- **Order edits & walk-in conversion** (Stage 14): `POST
  /api/order/:orderID/edit` branches on `action` — no `action` is
  `applyLineReduction`; `action: 'add'` is `applyLineAddition`, a new
  line at current selling price via `consumeFIFO`/`disableIfDepleted`,
  no discount. `POST /customer/create` + `POST
  /api/order/:orderID/convert-customer` reattach a
  `WALKIN_CUSTOMER`-sentinel order to a newly created customer.
- **Refund = Cash Back, Exchange = Store Credit** (final.md Stage 16,
  UI only). `Orders.jsx`'s Refund box refunds every line at full
  quantity; the two "Exchange" boxes are the only path touching store
  credit. `Suppliers.jsx` purchase-history rows use a `Status` column
  (`Due`/`Credit`/`Settled`) + `Credit Used`.
- User management: `routes/users.js` covers admin create/delete/
  reset-password + self-service password change (refreshes
  `passwordChangedAt`). Deleting your own account or the last admin is
  blocked. `Users.jsx` at `/workers` (admin-only). `POST /product/undo`
  validates via `isValidProductId()`. `loginLimiter`: `max: 20`/15min,
  `skipSuccessfulRequests: true`.
- Offline sync: `lib/offlineSync.js`'s `syncOfflineSale()` mirrors
  `routes/billing.js`'s `isWalkIn` skip for `WALKIN_CUSTOMER` and its
  zero-stock auto-disable — keep in sync if either changes. Does not
  apply customer credit. Sets `Order.offlineOrigin: true` at creation
  (sole writer); `getDashboardSummary` counts it as `offlineOrders`.
  Stage 13 also added a 60s debounced reconnect delay
  (`RECONNECT_DELAY_MS`), an auto-sync pub-sub (`subscribeAutoSync`/
  `isAutoSyncing`) driving `SyncOverlay.jsx`, and `verifyOrderExists()`
  before trusting a "synced" result.
- Draft persistence has two layers in `Billing.jsx` — don't conflate.
  Server-side (`PendingBill`, 7s-debounced `api.saveDraft`) fails
  silently offline. Local (Stage 12, `offlineQueue.js`'s `drafts` store,
  `DB_VERSION` 2) writes on every cart change, not debounced. Local
  draft checked first on mount; both cleared via `resetBill()`.
- **App-wide offline signal** (final.md Stage 17): `lib/networkStatus.js`
  — a pub-sub `lib/api.js`'s `request()`/`downloadExport()` drive:
  `markOffline()` + throw a `TypeError` on a raw `fetch()` failure or a
  non-`ok`, non-JSON response; `markOnline()` otherwise. Keep throwing
  the *same* `TypeError` — `isNetworkError()`'s `instanceof TypeError`
  check and Billing's offline-queue fallback depend on it.
  `NetworkStatusBanner.jsx` shows a banner while `isOffline()` is true.
- **Thermal printing, Web USB** (final.md Stage 18): `frontend/src/lib/
  thermalPrint.js` — `pairThermalPrinter()` needs a real click
  (`navigator.usb.requestDevice`) vs. silent `getPairedPrinter()`/
  `tryThermalPrint()` (`getDevices()`, never prompts). `Billing.jsx`'s
  `printReceiptFor` is async: tries thermal first, falls back to the
  unchanged popup `printReceipt()`. USB only; `Orders.jsx` untouched.

## Request flow

`/auth/*` → `routes/auth.js`. `/api/export/*`/`/api/sync/*` → optional
feature-flagged modules. Other `/api`, `/billing`, `/product`,
`/customer`, `/supplier`, `/dashboard/load` → domain route files. Other
GET → built React SPA. Unmatched `/api/*`/`/auth/*` → JSON 404. Backend
authorization is the real boundary; frontend gating is UX only.

## Working principles

Preserve existing behavior unless the current `deployment.md` stage
explicitly requires changing it. Do not add features simply because they
appear useful. When a change conflicts with historical assumptions,
follow the repository plus `deployment.md`, then document it in
`deployment-progress.md`.