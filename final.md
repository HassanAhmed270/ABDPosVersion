# Final Fixes Plan — BPIOLS

Agreed after review of Hassan's handwritten notes and screenshots,
discussed item-by-item in conversation before any code was written. This
plan is independent of `production.md` — stage numbering here starts
fresh at **Stage 1** and has no relation to `production.md`'s Stage 1–8
or the original build's `progress.md` numbering.

Each stage is scoped to be small, self-contained, and safe to verify on
its own. Do not start a stage until the previous one is complete and
validated. Several stages have real dependencies on earlier ones in this
list (noted per stage) — respect that order even though it's not always
the order items were originally raised in.

Some items from Hassan's original notes are **not** in this plan yet —
see "Deferred — not yet scoped" at the end. Do not start those; they will
be added as their own stage(s) once Hassan provides the flow.

---

## Stage 1 — Currency: PKR

**Goal:** replace all `$` display formatting with PKR, with proper
thousands-grouping.

**Issues addressed:** app displays all money as `$X.XX`; Hassan wants
PKR, not USD, and wants thousands separators added (not present today).

**Implementation tasks:**
- Update `frontend/src/lib/money.js`'s `formatMoney()` to output PKR
  (`Rs` prefix) with comma thousands-grouping, e.g. `Rs 1,234.50`.
- No other file should need changes — every money display in the app
  already goes through this one function (`Billing.jsx`, `Orders.jsx`,
  `Customers.jsx`, `Products.jsx`, `Suppliers.jsx`, `Dashboard.jsx`).
  Confirm this during implementation; if any hardcoded `$` is found
  outside `formatMoney()`, fix it here too and note it.

**Affected areas:** `frontend/src/lib/money.js` only (unless a stray
hardcoded `$` is found, per above).

**Testing/validation:** `npm run build` clean. Manual visual check
recommended (no live-browser verification available in the sandbox).

**Completion criteria:** every money value in the UI displays as
`Rs X,XXX.XX`.

---

## Stage 2 — Product ID auto-generation

**Goal:** remove manual Product ID entry from Add Product; auto-generate
sequential IDs server-side.

**Issues addressed:** Product ID is currently a free-text field on Add
Product with no uniqueness check before submit — typing an ID that
matches an existing product silently merges into that product instead of
erroring. Hassan also just doesn't want to type IDs at all.

**Implementation tasks:**
- `POST /api/product` (create path only — the `existingProduct` branch is
  unaffected): when creating a new product, ignore any submitted
  `productId` and instead generate the next sequential `#000N` server-side
  (find the highest existing numeric ID and add 1; do not reuse deleted
  IDs — see Stage 8 for why deletion no longer frees up IDs in the normal
  case).
- Remove the Product ID input field from the Add Product form entirely
  (`frontend/src/pages/Products.jsx`, `mode === 'add'`). Show the
  generated ID to the user after creation (e.g. in a success toast, once
  Stage 5 lands — for now, a plain success message is fine).
- Edit/Update Product: unchanged. ID field stays disabled/display-only,
  keyed off the selected row, never typed.

**Affected areas:** `routes/products.js`, `frontend/src/pages/Products.jsx`.

**Testing/validation:** boot test — create two products back-to-back with
no ID supplied, confirm sequential IDs assigned and no collision;
`npm test`; `npm run build`.

**Completion criteria:** Add Product never asks for or accepts a
Product ID; IDs are sequential and collision-free.

---

## Stage 3 — Audit log: flattened readable table

**Goal:** replace the raw JSON dump in the Audit Log screen with a
human-readable table.

**Issues addressed:** `frontend/src/pages/AuditLog.jsx` currently renders
`entry.before`/`entry.after` as `JSON.stringify(..., null, 2)` inside a
`<pre>` block — raw JSON, unreadable to a non-technical user.

**Implementation tasks:**
- Write a generic flatten helper (new file, e.g.
  `frontend/src/lib/flattenObject.js`): given an object (including nested
  objects/arrays), produce a flat list of `{ path, value }` pairs using
  dot/bracket-path keys (e.g. `items[0].productName`).
- Render each audit entry's detail as a table: **Field | Before | After**,
  one row per flattened path found in either snapshot. For a `create`
  entry (`before === null`), the Before column is blank for every row.
- Highlight rows where Before ≠ After (e.g. background tint or bold) so
  changes are still easy to spot even though nothing is hidden.
- Format money-looking fields (keys containing `price`, `amount`,
  `balance`, `paid`, `due`, `cost`) through `formatMoney()`. Format
  date-looking fields (keys containing `date`, `At`) as a locale string.
  Everything else renders as-is (stringified).

**Affected areas:** `frontend/src/pages/AuditLog.jsx`, new
`frontend/src/lib/flattenObject.js`. No backend changes — `before`/`after`
snapshots already contain everything needed.

**Testing/validation:** `npm run build` clean. Manual check recommended
against a few real audit entries of different action types once merged
(sandbox has no live Mongo to generate real entries against).

**Completion criteria:** Audit Log detail view shows a Field/Before/After
table for every entry, no raw JSON visible anywhere on the page.

---

## Stage 4 — PDF export alongside CSV

**Goal:** add a PDF download option next to each of the 5 existing CSV
export buttons.

**Issues addressed:** `routes/export.js` only produces CSV
(`sales`, `refunds`, `customer-credit`, `supplier-payables`, `summary`).
Hassan wants PDF too, for all 5, as a separate button alongside the
existing CSV button — not replacing it.

**Implementation tasks:**
- Add `pdfkit` as a new backend dependency.
- Add a `POST`/`GET` PDF variant for each of the 5 existing export
  routes (or a `format` query param on the existing routes — implementer's
  choice, whichever keeps `routes/export.js` cleanest), producing a
  formatted table: report title, date range (where applicable), column
  headers, and rows — not a raw data dump.
- `frontend/src/pages/Reports.jsx`: add a second "PDF" button next to each
  existing "CSV" button for all 5 report types.

**Affected areas:** `routes/export.js`, `package.json` (new dependency),
`frontend/src/pages/Reports.jsx`.

**Testing/validation:** boot test — hit each of the 5 PDF endpoints,
confirm a valid PDF is returned (`file` command / header check is enough
given no live Mongo for real data — confirm the route at least generates
a structurally valid empty-data PDF without throwing); `npm run build`.

**Completion criteria:** all 5 reports have a working PDF button
alongside their CSV button.

---

## Stage 5 — Toast & confirm-dialog infrastructure

**Goal:** build the reusable components that Stage 6 will migrate all
`alert()`/`confirm()` call sites onto. No call sites are touched in this
stage.

**Issues addressed:** the app uses browser-native `alert()`/`confirm()`
throughout (64 call sites across 6 files) — jarring, blocks the whole
page, not stylable.

**Implementation tasks:**
- Add `sonner` as a new frontend dependency for toast notifications; wire
  up its provider once at the app root.
- Build a hand-rolled `ConfirmDialog` component (new file, e.g.
  `frontend/src/components/ConfirmDialog.jsx`) for yes/no confirmations,
  reusing the existing fixed-modal Tailwind pattern already used
  elsewhere in the app (e.g. the Add Customer popup) for visual
  consistency. Expose it via a simple hook/context (e.g. `useConfirm()`
  returning a promise) so call sites can do
  `if (await confirm('Delete this?')) { ... }` instead of
  `if (window.confirm('Delete this?')) { ... }`.

**Affected areas:** new `frontend/src/components/ConfirmDialog.jsx` (or
similar), a toast provider wired into the app root (likely `App.jsx` or
`main.jsx`), `package.json` (new dependency). No page files touched yet.

**Testing/validation:** `npm run build` clean. A minimal manual smoke
test of both components (e.g. temporarily wire one into a single button)
is reasonable to prove they render, then removed before calling this
stage done — the real wiring is Stage 6.

**Completion criteria:** both components exist, build clean, ready for
Stage 6 to consume.

---

## Stage 6 — Migrate all alert()/confirm() call sites

**Depends on Stage 5.**

**Goal:** replace all 64 `alert()`/`confirm()` calls across the app with
the Stage 5 components.

**Issues addressed:** see Stage 5.

**Implementation tasks:**
- Replace every `alert()` call with a `sonner` toast (success/error
  styled appropriately based on context).
- Replace every `confirm()` call with the Stage 5 `ConfirmDialog`/
  `useConfirm()`.
- Files affected (call-site counts as of this plan, re-verify at start of
  stage since the repo may have moved on): `Billing.jsx` (23),
  `Orders.jsx` (11), `Suppliers.jsx` (9), `Customers.jsx` (8),
  `Users.jsx` (8), `Products.jsx` (5, plus any new ones this plan's other
  Products-page stages introduce).

**Affected areas:** `frontend/src/pages/Billing.jsx`, `Orders.jsx`,
`Suppliers.jsx`, `Customers.jsx`, `Users.jsx`, `Products.jsx`. No backend
changes.

**Testing/validation:** `npm run build` clean; grep for `alert(`/
`confirm(` across `frontend/src/pages/` to confirm zero remaining
call sites (excluding any intentionally left `window.confirm` if a case
is found where it's genuinely appropriate — flag any such case rather
than silently leaving it).

**Completion criteria:** zero `alert()`/`confirm()` calls remain in
`frontend/src/pages/`; all replaced with the Stage 5 components.

---

## Stage 7 — Add Product: required cost, real StockBatch (self-buying only)

**Depends on:** none directly, but sets the pattern Stage 9 extends.

**Goal:** close the gap where a product added via Add Product has no
cost basis at all until a separate supplier purchase is recorded against
it.

**Issues addressed:** `models/StockBatch.js`'s existing Stage-22 design
intentionally leaves plain Product-form stock additions un-batched (no
cost input existed on that form). Hassan wants Add Product to always
capture a real cost and be properly FIFO/profit-tracked from day one —
not just record a `buyingPriceHistory` entry with no batch backing it.

**Implementation tasks:**
- Add a **required** Cost field to the Add Product form
  (`frontend/src/pages/Products.jsx`, `mode === 'add'` only — Edit is
  unaffected).
- `POST /api/product` (create path): route the submitted cost through the
  same batch-creation logic `POST /supplier/purchase` already uses for a
  self-purchase (`NoSupplier`) — i.e. Add Product's cost entry always
  creates a `NoSupplier`-tagged `StockBatch`, never a real-supplier one.
  There is intentionally no supplier picker on this form (see Stage 9's
  "self-buying only" rule, which this stage establishes for Add Product
  specifically).
- Update `lib/costing.js`/`StockBatch` model comments if this changes the
  documented Stage-22 invariant about plain-form additions never being
  batched — this stage supersedes that specific note for the Add Product
  path only (Update Product still has no stock field after Stage 9, so
  there's nothing left there to reconcile).

**Affected areas:** `routes/products.js`, `frontend/src/pages/Products.jsx`,
possibly `routes/suppliers.js` if the self-purchase batch-creation logic
needs extracting into a shared helper rather than duplicating it.
`models/StockBatch.js` / `lib/costing.js` comments if the Stage-22 note
needs updating.

**Testing/validation:** boot test — create a product with a cost, confirm
a `StockBatch` exists for it tagged `NoSupplier`; `npm test`; `npm run
build`.

**Completion criteria:** every product created via Add Product has a real
cost basis and a matching `StockBatch` from the moment it's created.

---

## Stage 8 — Billing: show last-purchased cost (admin-only)

**Goal:** show a product's last-purchased cost next to its selling price
when adding it to a bill, visible to admins only.

**Issues addressed:** cashiers/admins currently have no visibility into
cost while deciding whether a discount makes sense on that line.
`lib/pricing.js`'s `getLatestBuyingPrice()` already exists and
`GET /api/products` already returns `costPrice` per product — this data
already reaches the frontend, it's just never displayed.

**Implementation tasks:**
- In `frontend/src/pages/Billing.jsx`'s `handleSelectProduct` / item-entry
  form, display the selected product's `costPrice` next to its selling
  price.
- Gate this display to admin role only (the app's existing `isAdmin`
  pattern, same as elsewhere).

**Affected areas:** `frontend/src/pages/Billing.jsx` only. No backend
changes — the data already exists in the API response.

**Testing/validation:** `npm run build` clean.

**Completion criteria:** cost shows next to selling price when a product
is selected on Billing, visible only when logged in as admin.

---

## Stage 9 — Product stock management redesign (add/deduct, reason-coded)

**Depends on Stage 7** (establishes the self-buying-only batch-creation
pattern this stage extends to a second, dedicated flow).

**Goal:** replace the current silent, reason-less stock editing with
three clearly separated actions — a name/price-only Update form, a
dedicated Add Stock action, and a dedicated Deduct Stock action — plus
require a real supplier on Supplier Purchase (remove self-buying from
there, since it now lives on the two new Products-page actions instead).

**Issues addressed:** today, Update Product's stock field can only ever
*add* to quantity, with no cost captured and no `StockBatch` created;
there is no way to deduct/write off stock at all, so no reason is ever
captured for shrinkage, damage, expiry, or supplier returns; Supplier
Purchase's dropdown currently offers a `NoSupplier`/self-buying option
that Hassan wants moved out of that flow entirely.

**Implementation tasks:**
- **Update Product form**: trim to **name and price only**. Remove the
  stock/quantity field entirely from this form and its submit handler.
- **New "Add Stock" action** (dedicated button/form on the Products page,
  separate from Update Product): requires cost, self-buying only (same
  `NoSupplier`-tagged `StockBatch` pattern Stage 7 established for Add
  Product) — no supplier picker here at all.
- **New "Deduct Stock" action** (dedicated button/form on the Products
  page): opens a reason form —
  - Fixed reason categories: Expired / Returned to Supplier /
    Damaged-Lost / Discontinued, each with a required free-text note.
  - If reason is **Returned to Supplier**: adjust that supplier's credit
    balance to reflect cost recovered; **no Loss entry is created** in
    this case (cost was recovered, not written off).
  - If reason is anything else (Expired / Damaged-Lost / Discontinued):
    record a **Loss** entry — a new small model/collection (or an
    extension of an existing one, implementer's judgment during
    implementation) capturing product, quantity, cost value, reason,
    note, actor, timestamp. Surface this as a new "Losses" figure on the
    Dashboard and as a line item in Reports (new export type or folded
    into an existing one — flag if this needs a 6th CSV/PDF export type,
    which would be a small addition to Stage 4's work if that stage is
    already done, or scoped into this stage if not).
- **Zero-stock auto-disable**: whenever a product's `quantity` reaches
  zero (via any path — sale, deduction, etc.), mark it disabled. Disabled
  products remain visible in the Products list (grayed out,
  non-interactive) and remain fully intact in historical order data, but
  cannot be selected for billing, refund, or exchange going forward.
- **Auto-restore on restock**: adding stock to a disabled product (via
  the new Add Stock action) automatically re-enables it. No separate
  restore button.
- **Hard delete** (existing `DELETE /product/:productID`, admin-only):
  becomes reachable only once a product's stock is fully accounted for
  (zero remaining, via the Deduct Stock reason flow above for any
  residual quantity). Opens the same reason form as Deduct Stock. Once
  confirmed, performs a true, permanent removal from the database — this
  is genuinely destructive and only reachable via this explicit,
  reason-logged path.
- **Supplier Purchase form** (`frontend/src/pages/Suppliers.jsx` /
  `routes/suppliers.js`): remove the `NoSupplier`/"Buy Myself / Self
  Purchased" option from the supplier dropdown. This form now requires
  selecting a real, existing supplier.

**Affected areas:** `routes/products.js`, `frontend/src/pages/Products.jsx`,
`routes/suppliers.js`, `frontend/src/pages/Suppliers.jsx`,
`models/Product.js` (disabled flag), possibly a new `models/Loss.js` (or
similar), `frontend/src/pages/Dashboard.jsx` (Losses figure),
`lib/reports.js` (Losses in reports, if folded into an existing report
rather than a new export type).

**Testing/validation:** boot test covering: create product → deduct all
stock with reason "Damaged-Lost" → confirm disabled + Loss entry created;
restock same product → confirm re-enabled; deduct with reason "Returned
to Supplier" → confirm supplier credit adjusted, no Loss entry; hard
delete a zero-stock product → confirm permanent removal; attempt hard
delete on a product with remaining stock → confirm blocked. `npm test`;
`npm run build`.

**Completion criteria:** all of the above flows work as described; no
plain quantity field exists anywhere that bypasses the reason
requirement; Supplier Purchase no longer offers self-buying.

**Note:** this is the largest stage in this plan. If it proves too large
once implementation starts, flag it and we'll split it (e.g. Add Stock +
Deduct Stock as one stage, Loss/Dashboard/Reports surfacing as a second,
hard-delete rework as a third) rather than pushing through oversized.

---

## Stage 10 — UI polish: Products form, Billing preview

**Goal:** fix the two concrete visual issues Hassan flagged from
screenshots — Products' form color/height, Billing's cramped preview
table. Customers/Suppliers pages need no change (already confirmed good).

**Issues addressed:**
- Products' Add/Update form header and submit button use
  `text-green-600`/`bg-green-600`, inconsistent with the blue
  (`text-blue-600`) used for the same "Add" state on Customers and
  Suppliers.
- Products' Add/Update form is a single stacked column of 7+ fields
  inside a `1/3`-width sidebar, tall enough to force an internal scroll.
- Billing's on-screen cart/bill preview renders an 8-column table
  (`#`, Code, Product, Price, Qty, Total, Save, Net) inside a `max-w-md`
  panel, causing horizontal overflow and overlapping text.

**Implementation tasks:**
- `frontend/src/pages/Products.jsx`: change `text-green-600`/
  `bg-green-600` to the blue used elsewhere for Add mode.
- `frontend/src/pages/Products.jsx`: restructure the Add/Update form into
  a 2-column grid within the existing sidebar panel (stays a sidebar
  panel, not a modal) to reduce vertical height. Field pairing is
  implementer's judgment (e.g. Category+Selling Price, Stock+Threshold —
  noting Stage 9 removes Stock from this form, so re-derive sensible
  pairings against the post-Stage-9 field list).
- `frontend/src/pages/Billing.jsx`: replace the 8-column on-screen
  cart/bill preview table with a stacked receipt-line layout — each item
  becomes two lines (e.g. `#1  #0001  PowerSocket` then
  `1 × Rs 500.00   -0%   = Rs 500.00`) instead of one row across 8
  columns, so it fits the panel width without horizontal scroll. Only the
  **on-screen** preview changes — the printed receipt and the Special
  Bill layout are explicitly out of scope for this stage.

**Affected areas:** `frontend/src/pages/Products.jsx`,
`frontend/src/pages/Billing.jsx` (on-screen cart summary only, not
`printReceiptFor` or the Special Bill markup).

**Testing/validation:** `npm run build` clean.

**Completion criteria:** Products' Add/Update form uses blue consistently
and fits without an internal scrollbar in normal use; Billing's on-screen
preview shows items as stacked lines with no horizontal overflow.

---

## Stage 11 — Bill preview: customer balance

**Goal:** show the selected customer's pre-sale balance in the bill
preview.

**Issues addressed:** the bill preview shows store credit available but
not the customer's outstanding balance owed (or vice versa) from before
this sale — Hassan wants this visible so it can be discussed with the
customer at time of billing.

**Implementation tasks:**
- `GET /api/customers` already returns `totalBalanceDue` per customer;
  `frontend/src/pages/Billing.jsx`'s `customerDirectory` currently only
  pulls in `creditBalance` — add `totalBalanceDue` to what's stored per
  customer.
- Display a single "Customer Balance" line (positive = owes, negative =
  in credit) reflecting the customer's balance **before this sale** (not
  mixed with the bill currently being built) — placed **after** all
  calculation fields (Grand Total, Paid, Change/Balance Due), at the
  bottom of the preview.

**Affected areas:** `frontend/src/pages/Billing.jsx` only. No backend
changes — the data already exists in the API response.

**Testing/validation:** `npm run build` clean.

**Completion criteria:** customer's pre-sale balance is visible at the
bottom of the bill preview whenever a customer (not walk-in) is selected.

---

## Stage 12 — Offline: continuous draft persistence

**Goal:** stop losing an in-progress cart on reload while offline — the
actual bug behind "offline doesn't persist."

**Issues addressed:** verified in code — cart state while being *built*
offline lives only in React `useState` in `Billing.jsx`. It's written to
IndexedDB only at the moment "Generate Bill" is submitted and a network
error is caught (`enqueueSale()`). A reload before that point loses the
in-progress cart entirely. This is not a flaw in IndexedDB itself — it
already proves reliable for completed-but-unsynced sales via the
existing `sales` object store; the gap is that nothing persists the
*draft* before it becomes a finished sale.

**Implementation tasks:**
- Add a new IndexedDB object store, `drafts`, in
  `frontend/src/lib/offlineQueue.js` (database `pos-offline-queue`,
  alongside the existing `sales` store) — kept separate from `sales`
  since a draft isn't a sale yet and shouldn't be touched by the
  `pending → synced/conflict` sync machinery.
- Write the current cart state into `drafts` on every meaningful change
  in `Billing.jsx`: item add/remove, quantity/discount edit, customer
  switch, amount-paid edit.
- On app load, check `drafts` for an unfinished entry and restore it
  directly into cart state if found.
- Stay local until deliberately finalized: even if connectivity returns
  mid-edit, keep editing against the local draft — no automatic handoff
  to the live server-side `PendingBill` flow. Handoff only happens when
  the cashier hits "Generate Bill", which already tries the live API
  first and falls back to `enqueueSale()` on a real network error,
  unchanged from today.
- Clear the draft once the sale is queued into `sales` (or completes live
  because connectivity came back by finalize time).
- Deletion of *synced* entries stays exactly as today — manual only, via
  the existing "Clear synced" button on `Reports.jsx`. Nothing auto-
  deletes a synced entry; not touched by this stage.

**Design decisions carried into this stage, not re-litigated:**
- **72-hour retention** — read as a minimum-guarantee requirement ("must
  survive at least 72h offline"), not a cutoff/lockout. Already satisfied
  by IndexedDB, which has no built-in expiry. No implementation task
  needed for this specifically.
- **Storage technology stays IndexedDB** — Excel-as-datastore was
  considered and rejected (browsers can't repeatedly write to a file on
  disk without re-granting permission via the File System Access API,
  Chromium-only, no real querying — strictly worse than IndexedDB here).
  Redux Toolkit alone, without a persistence layer like `redux-persist`
  (itself backed by `localStorage`/IndexedDB), would not survive a
  reload at all. This stage's `drafts` store is the resolution of that
  open question, not a new one.
- **"Where is offline data saved on the device?"** — answered directly
  from existing code, not a fix: IndexedDB, database
  `pos-offline-queue`, object store `sales` (existing), keyed by
  `idempotencyKey`, carrying local status (`pending | synced | conflict`),
  `queuedAt`, `lastError`, `resultingOrderID`. Survives tab close,
  browser crash, and device restart. This stage adds the `drafts` store
  alongside it for the same database.

**Affected areas:** `frontend/src/lib/offlineQueue.js`,
`frontend/src/pages/Billing.jsx`.

**Testing/validation:** manual/simulated — build a cart, simulate a
reload (or actually reload in a dev build) before submitting, confirm
the cart restores from `drafts`; confirm `drafts` clears once the sale is
queued or completes; `npm run build`.

**Completion criteria:** an in-progress cart survives a reload at any
point while it's being built, not just after "Generate Bill" is pressed.

---

## Stage 13 — Offline: sync reliability & dashboard visibility

**Depends on Stage 12** (shares the same `lib/offlineSync.js` surface;
sequencing avoids two stages editing the sync flush logic at once).

**Goal:** make the existing completed-sale sync pipeline more robust and
give offline sales a visible marker once synced, without changing its
core correctness logic.

**Issues addressed:** the sync queue itself (idempotent commit,
transactional write, FIFO replay order) is already correct and is
**unchanged by this stage** — these are additive reliability/visibility
improvements only.

**Implementation tasks:**
- **Reconnect delay.** On the browser's `online` event
  (`frontend/src/lib/offlineSync.js`), wait ~1 minute before attempting
  to flush the `sales` queue, instead of firing instantly as it does
  today. Avoids syncing into a connection that's still flapping.
- **Sync UX overlay.** Show a blocking overlay while an *automatic*
  background flush is actively running — today a blocking state only
  exists for the manual "Sync Now" button on `Reports.jsx`. Keep the
  overlay up briefly after the flush call resolves rather than dismissing
  it instantly.
- **Post-sync verification.** After the server reports a queued sale as
  `synced`, do one independent check that the resulting order actually
  exists server-side before marking the local entry `synced`. If that
  verification call itself fails (network/timeout — not a genuine "not
  found"), retry up to 3 times with backoff; succeed and stop retrying as
  soon as one attempt succeeds, rather than always running all 3
  regardless of outcome.
- **Dashboard visibility — historical marker.** At sync time
  (`lib/offlineSync.js`), tag the resulting `Order` with a new
  `offlineOrigin: true` field. This lets Dashboard/Reports later
  surface "X sales this period were made offline" as a simple query
  against that field — the actual Dashboard/Reports display of this
  figure can be a small follow-up once the field exists, or included
  here if it's a one-line addition once the field is in place (flag
  during implementation if it turns out bigger than that).

**Explicitly not in scope for this stage:**
- Live, cross-device visibility of another terminal's still-unsynced
  offline sales — that data only exists on the originating device until
  it syncs; building real-time cross-device visibility is a materially
  bigger feature than this item and was deliberately excluded.
- Any change to the `sales` queue's own commit/transaction/replay logic.

**Affected areas:** `frontend/src/lib/offlineSync.js`,
`frontend/src/pages/Reports.jsx` (overlay), `models/Order.js`
(`offlineOrigin` field), possibly `frontend/src/pages/Dashboard.jsx` if
the follow-up display is folded in here.

**Testing/validation:** boot test where feasible (no live Mongo, so the
`offlineOrigin` field write itself can only be confirmed via code review
+ a schema check, not an end-to-end sync); `npm run build`.

**Completion criteria:** reconnect flush waits ~1 minute; an automatic
background flush shows a blocking overlay; a synced entry has passed one
independent existence check (with bounded retry) before being marked
`synced`; synced offline orders carry `offlineOrigin: true`.

---

## Stage 14 — Exchange process improvements

**Goal:** allow adding a new item during an exchange (not just reducing an existing line), and let a walk-in order be reattached to a real customer inline during that flow.

**Already working today — verified in code, no build needed:**

* **Current exchange settlement:** The existing edit flow currently sends any value freed by an edit to the customer's store credit. Stage 14 will extend this behavior so the exchange value can also be applied toward a newly added replacement item, with any remaining value going to store credit or any additional amount becoming payable by the customer.

* **"Revised" receipt already printable.** `Orders.jsx`'s "Print (Revised)" button already produces a full edit-history table (item, qty change, action, editor, timestamp, reason) plus any refund rows.

**Implementation tasks:**

* **Allow adding a new item during an exchange.** Today `applyLineReduction` (`routes/orders.js`) only accepts a `newQty` less than or equal to an existing line's current quantity — there's no path to add a different product to an order via edit. Add that path: reason required (same as existing edits), logged to `editHistory` with a new `action: 'add'` alongside the existing reduction actions, stock decremented through the same FIFO batch-consumption logic (`consumeFIFO`) checkout already uses, so cost basis stays correct.

* **Net balance and exchange settlement.** The value of the removed/reduced item becomes the exchange amount. The admin can either keep this value as store credit or use it toward an added replacement item. If the replacement item costs less than the exchange amount, the remaining value is added to the customer's store credit. If the replacement item costs more, the exchange amount is applied toward the new item and the customer pays the remaining difference. The revised bill must clearly show the exchange value, amount applied to the replacement item, any remaining store credit, or any additional payment due.

* **Walk-in → customer conversion, inline in the exchange flow.** If the order being exchanged belongs to the `WALKIN_CUSTOMER` sentinel, allow creating a real `Customer` record on the spot (name + optional details) from within the exchange UI and reattaching the order to that new customer, so any credit generated by the exchange has an account to land in. Today there is no upsert-style customer creation anywhere — even normal checkout requires the `Customer` document to pre-exist (`routes/billing.js`), and `routes/customers.js`'s `updateCustomer` 404s if the customer isn't already there — so this is new server-side logic, not a UI-only change. The conversion will be handled transactionally in `routes/orders.js`, reusing the existing customer creation/validation patterns where appropriate.

**Affected areas:** `routes/orders.js` (`applyLineReduction`, the edit route, and walk-in conversion), `frontend/src/pages/Orders.jsx`, `routes/customers.js` (reusable customer validation/create logic), `models/Order.js` (allow `editHistory.action: 'add'`).

**Testing/validation:** boot test — edit an order to add a new line item, confirm stock decrements via FIFO and `editHistory` records the `add` action; convert a walk-in order to a real customer mid-exchange, confirm the order's customer reference updates and any freed credit lands on the new customer record; `npm test`; `npm run build`.

**Completion criteria:** an exchange can add a new item, not just reduce existing ones; a walk-in order can be converted to a real customer in-flow without leaving the exchange screen.

---

## Stage 15 — Deduct Stock: batch selection when cost differs

**Raised 2026-08-25**, after seeing Stage 9's Deduct Stock in practice:
a deduction's `costValue` came out lower than `quantity × latest cost`
because `consumeFIFO()` (`lib/costing.js`) silently draws from the
*oldest* remaining `StockBatch` first, which can have a different,
older `unitCost` than what's shown as the product's current price. Not
a bug — real FIFO cost accounting — but invisible to the admin doing the
deduction, who has no way to know or choose which batch's cost applies.

**Scope:** when a product has more than one distinct-cost batch with
stock remaining, Deduct Stock must show them (e.g. "12 units @ Rs 350
(bought 12 Jun)" vs "6 units @ Rs 550 (bought 20 Aug)") and require the
admin to pick which one to draw from, capping the deduction quantity to
that batch's remaining. When there's only one batch (or none — legacy
unbatched stock), skip the picker; behavior is unchanged and automatic,
exactly as Stage 9 shipped it.

**Affected areas:** `lib/costing.js` (new `consumeSpecificBatches()`,
alongside the existing `consumeFIFO()` — not a replacement, since
checkout/offline sale still need pure oldest-first FIFO and are out of
scope here), `routes/products.js` (new `GET
/api/product/:productID/batches`; `deduct-stock` accepts an optional
`batchId`), `frontend/src/pages/Products.jsx` (Deduct Stock form fetches
and shows the batch picker conditionally), `frontend/src/lib/api.js`.

**Completion criteria:** a product with two differently-priced batches
shows a picker on Deduct Stock and the resulting `Loss`/supplier-credit
`costValue` matches the chosen batch's `unitCost × quantity` exactly; a
product with one batch (or none) shows no picker and behaves exactly as
Stage 9 already verified. `npm test` still passes; boot-tested;
`final-progress.md` updated.

## Stage 16 — Supplier/Orders UI clarity, Special Bill removal

**Raised 2026-08-29**, directly by Hassan, frontend-only, three
independent parts landed together since each is small.

**16a — Supplier purchase history UI.** `Suppliers.jsx`'s expanded
purchase-history table folded a purchase's settlement status and its
"existing credit used" note into one `Balance` cell (color + sign +
small text underneath) — confusing, and not the same shape as the
top-level per-supplier `Balance` column. Replaced with a `Status`
column using plain labels (`Due Rs X` / `Credit +Rs X` / `Settled`) and
a separate `Credit Used` column. No calculation changed — same
`p.balanceDue`/`p.creditGenerated`/`p.creditApplied` fields, relabeled
and split, not recomputed.

**16b — Orders refund/exchange UI + flow.** The "Refund items" box let
an admin check individual items and edit quantities before submitting —
functionally a second line-item-editor duplicating "Edit a line item"
above it, even though a refund's `settlement` was already hardcoded
`'cash'` and always finalized the whole order (`status: 'refunded'`).
Replaced with a fixed **Refund Full Order (Cash Back)** action: every
line at its full order quantity, no per-item picker, same `settlement:
'cash'`. "Edit a line item" relabeled **Exchange — reduce a line item
(Store Credit)** and "Add a new item" relabeled **Exchange — add a
replacement item (Store Credit)** — no behavior change, both already
settle via store credit only (backend ignores any `settlement` sent on
`/api/order/:orderID/edit` and always resolves credit-or-none itself).
The printed "Revised Receipt" edit-history rows previously always
printed `Store Credit: Rs X` regardless of what that row actually
settled as (including `Rs 0.00` on rows that settled nothing, and on
refund-sourced rows that were actually cash) — now labels each row
`Exchange — Store Credit: Rs X` / `Cash Back: Rs X` / `—` to match what
the on-screen Edit History already did.

**16c — Special Bill removed.** The whole "Special Bill" (catering-
invoice-style second receipt layout, `Stage 17` in the old
`production.md` numbering) is gone: the button, its preview modal, the
`showSpecialPreview` state, and `printSpecialReceiptFor` in
`Billing.jsx`. Generate Bill only ever produces the standard
`printReceiptFor` receipt now. `customerDirectory` (the
mobile/address/email/credit lookup Special Bill also read from) stays —
it's still what backs the Customer Balance line and the store-credit
note, unrelated to Special Bill's removal.

**Affected areas:** `frontend/src/pages/Suppliers.jsx`,
`frontend/src/pages/Orders.jsx`, `frontend/src/pages/Billing.jsx`. No
backend routes touched — all three parts are presentation-layer only,
confirmed against `routes/suppliers.js` and `routes/orders.js` before
starting that no calculation needed to change.

**Incidental (one-line, obviously correct):** removed a leftover debug
`console.log('REFUND RESPONSE:', data)` in `Orders.jsx`'s refund
handler, pre-existing, no functional effect.

**Testing/validation:** `npm run build` clean; `oxlint` on all three
touched files, 0 errors; boot-tested (`GET /api/orders`, `GET
/api/products`, `POST /supplier/purchase`, `POST
/api/order/:id/refund`, `POST /api/order/:id/edit` all 401 with no
token); root `npm test` 66/66; `frontend npm test` 10/10.

**Completion criteria:** Supplier purchase history shows Due/Credit/
Settled plus a separate Credit Used column, nothing folded together;
Orders' Refund box always refunds the full order for cash with no
per-item picker, Exchange stays store-credit-only and is labeled as
such, the printed revised receipt matches; no Special Bill button,
modal, or handler remains anywhere in `Billing.jsx`.

---

## Stage 17 — App-wide friendly offline/unreachable-server handling

**Raised 2026-08-29** by Hassan, after observing that killing the
backend (`node main.js` on :3000) while the frontend dev server (:5173)
stays up floods the terminal with Vite proxy `ECONNREFUSED` errors, and
asking that "our billing pos should survive properly if its already
logged in once."

**Confirmed already correct, untouched:**
- An already-logged-in session is never force-logged-out by a
  connectivity failure. `AuthContext.jsx`'s silent refresh interval
  already swallows a failed `api.refresh()` silently (no `res.status`
  is ever available for a raw `fetch()` failure, so the shared
  `auth:unauthorized` 401 path never fires); only a genuine 401 from a
  reachable server logs someone out.
- `Billing.jsx`'s core save flow (`handleAddToBill`/`handleGenerateBill`)
  already falls back to the IndexedDB offline queue using
  `isNetworkError(err)` (`lib/offlineSync.js`) — `err instanceof
  TypeError`, independent of `navigator.onLine` — so it already survives
  exactly this scenario (backend down, network adapter still up, so
  `navigator.onLine` never flips).
- Every other page (`Products.jsx`, `Customers.jsx`, `Suppliers.jsx`,
  `Orders.jsx`, `AuditLog.jsx`, `Reports.jsx`, `Dashboard.jsx`,
  `LowStockBell.jsx`) already wraps its data loads in try/catch and sets
  an error state rather than crashing.

**The actual gap, and what this stage fixes:** none of the above is
*friendly*. A failed load anywhere shows the browser's raw error text
("Failed to fetch") instead of a clear message, and there's no shared,
app-wide signal that the backend is unreachable — only `Billing.jsx` has
its own local (and `navigator.onLine`-based, so unreliable for this
exact scenario) banner.

**Affected areas:**
- New `frontend/src/lib/networkStatus.js` — a tiny pub-sub
  (`markOffline()`/`markOnline()`/`subscribeNetworkStatus(fn)`/
  `isOffline()`), mirroring the existing `subscribeAutoSync` pattern in
  `lib/offlineSync.js`.
- `frontend/src/lib/api.js`'s `request()` — on a raw `fetch()` failure,
  call `markOffline()` and set a friendlier `.message` on the *same*
  `TypeError` object (never replace it with a new `Error`) so
  `isNetworkError()`'s `err instanceof TypeError` check in
  `offlineSync.js` still matches it — Billing's offline-queue fallback
  must not regress. Call `markOnline()` on any response reaching the
  server at all (even a non-2xx one).
- New `frontend/src/components/NetworkStatusBanner.jsx`, mounted once in
  `App.jsx` next to `SyncOverlay`, subscribing to
  `subscribeNetworkStatus`.

**Explicitly out of scope:** making Products/Customers/Suppliers/Orders/
Reports/AuditLog/Dashboard actually *usable* while the backend is down
(cached lists, queued writes for those pages) — a much larger feature
than "survive gracefully," not what was asked. `Billing.jsx`'s own
offline-queue mechanism (Stages 11–13) and `offlineSync.js` are not
touched.

**Completion criteria:** with the backend stopped and the frontend dev
server still running, every page's existing error display shows the new
friendly message instead of "Failed to fetch"; a small banner appears
app-wide indicating the server is unreachable and clears once a request
succeeds again; an already-logged-in session is not force-logged-out;
Billing's offline queue/sync behavior is unchanged and still verified by
its own existing tests.

**Correction, 2026-08-29 (same day):** the fix above only caught a raw
`fetch()` *throw*. Reproduced live (backend on :3000 killed, Vite dev
server on :5173 left running): Vite's own dev proxy answers with a
resolved **HTTP 502**, not a connection-level failure — so `fetch()`
never throws at all, `isNetworkError()` never matches, and the entire
offline-queue fallback (the actual "survive properly" behavior Hassan
asked for) silently never engaged. Worse, the pre-existing code's
`!res.ok && typeof body === 'object' && body?.message` check silently
swallowed *any* non-JSON error response (502's body is plain text) and
returned it as if it were a successful JSON result. Fixed in
`request()`/`downloadExport()`: a non-`ok`, non-JSON response is now
treated exactly like a raw `fetch()` throw — `markOffline()` plus a
thrown `TypeError` — since every genuine app response (success or
error) already goes through `asyncHandler`/`AppError` and is always
JSON, so "non-JSON error" reliably means an infra-level gateway failure
(a dev-proxy 502/503/504, or an equivalent reverse-proxy failure in a
real production deployment), not an app error. Verified live against
the actual 502 from a killed backend (not just code review) — see
`final-progress.md`.

---

## Stage 18 — Thermal receipt printing, with manual-print fallback

**Raised 2026-08-29** by Hassan: bills should print on a thermal
receipt printer (the kind used at supermarket checkouts) automatically
when generating a bill. If no thermal printer is available or
connected, the system should fall back to the existing manual/browser
print flow — not fail silently and not block the sale.

**Current state:** `printReceiptFor()` in `Billing.jsx` always calls the
shared `printReceipt(html)` helper (`frontend/src/lib/print.js`), which
opens a popup window and calls `window.print()` — a manual, OS
print-dialog flow. This is the "manual print" path that must remain as
the fallback; it is not being replaced.

**Affected areas:**
- New `frontend/src/lib/thermalPrint.js` — attempts a direct print to a
  connected thermal printer first. Likely approach: Web Serial API
  (`navigator.serial`) or Web USB API (`navigator.usb`) for a
  locally-connected ESC/POS printer, generating raw ESC/POS commands for
  a plain-text/monospace receipt layout (no HTML/CSS, thermal printers
  don't render either). Exposes something like
  `tryThermalPrint(receiptData) → Promise<boolean>` (resolves `true` on
  success, `false`/rejects if no printer is available, permission is
  denied, or the write fails) so the caller can fall back cleanly.
- `Billing.jsx`'s `printReceiptFor()` — try `tryThermalPrint()` first;
  on `false`/rejection, fall through to the existing `printReceipt(html)`
  popup path unchanged. No change to what data is in the receipt, only
  how/where it's sent.
- A visible-but-quiet indicator of which path was used (e.g. a toast
  "Printed to thermal printer" vs. no toast, silently falling back to
  the browser print dialog) — exact UX to confirm with Hassan once this
  stage starts, not fixed here.

**Explicitly out of scope:** printer configuration UI (selecting a
printer, saving a chosen device across sessions) beyond whatever the
browser's own pairing prompt requires; support for network/Bluetooth
thermal printers (Serial/USB only, matching a typical single-shop
desktop setup); receipt template redesign — the printed content mirrors
the existing HTML receipt's data, just re-rendered for a thermal
printer's width and font.

**Open questions to confirm before starting:** exact thermal printer
model/interface Hassan's client has (Serial/USB, ESC/POS-compatible),
and whether this needs to work inside the Electron desktop build only
or also in an ordinary browser tab during development — Web Serial/USB
support differs between the two.

**Completion criteria:** with a supported thermal printer connected,
generating a bill prints directly to it with no popup/print-dialog
shown; with no thermal printer connected (or the browser lacks
Serial/USB support), generating a bill falls back to exactly today's
manual popup-print flow, unchanged; a rejected/cancelled browser
permission prompt for the printer is treated the same as "not
available" and falls back, it does not block or fail the sale.

---

## Stage 19 — Overpayment prompt: change back vs. customer balance

**Raised 2026-08-29** by Hassan: when a customer pays more than the
bill total, the cashier should be prompted (via toast) to choose
whether the excess is handed back as cash change or stored as credit on
the customer's account — and whichever is chosen should actually take
effect, not just be displayed.

**Current state, confirmed in `routes/billing.js`'s draft-commit
handler:** `amountPaid` is deliberately capped at `netOwed`
(`Math.min(Math.max(draft.paidInput || 0, 0), netOwed)`) — this is an
explicit existing decision, documented inline, that any excess is
"change handed back to the customer, not credit applied to the order."
The overpaid amount is never persisted anywhere today; it's only shown
on the printed receipt as a "Change" line
(`printReceiptFor()`/`Billing.jsx`). Overpayment *is* already turned
into `creditBalance` elsewhere in the app, but only when it's freed up
by an **edit or refund** on an existing order (`routes/orders.js`), not
at initial checkout — that mechanism is not being changed here.

**Affected areas:**
- `Billing.jsx` — when `paidNum > grandTotal` at the point
  `handleGenerateBill` would otherwise proceed, show a toast (`sonner`,
  matching the Stage 5/6 toast/confirm conventions already in place)
  asking the cashier to choose "Give change" or "Add to customer
  balance" for the overpaid amount, before the order is saved. A
  walk-in sale (`customer === 'unknown'`) cannot carry a balance, so
  this prompt only makes sense for a real selected customer — confirm
  with Hassan what should happen for walk-in overpayment (most likely:
  always change, no prompt, since there's no account to credit).
- The cashier's choice needs to reach the backend alongside the
  existing draft-commit call — likely a new field on the draft
  (`draft.overpaymentChoice` or similar) set via a small API call before
  `api.saveOrder()`, mirroring how `paidInput`/`paymentMethod` are
  already persisted to the draft rather than sent as a trusted request
  param (see Stage 4's tamper-resistance note in `routes/billing.js`).
- `routes/billing.js`'s draft-commit handler — if "Add to customer
  balance" was chosen, credit `customerDoc.creditBalance` by the
  overpaid amount (`draft.paidInput - netOwed`) inside the same
  transaction that already reads/updates `creditBalance` for credit
  auto-apply, instead of silently discarding it. If "Give change" was
  chosen (or no customer, or no choice needed because paid ≤ total),
  behavior is exactly what it is today — no `creditBalance` change.
- Receipt output (`printReceiptFor()`) should reflect which happened —
  "Change: Rs X" vs. "Rs X added to customer balance" — instead of
  always labeling it "Change" for any overpayment.

**Explicitly out of scope:** touching the existing edit/refund
overpayment-to-credit logic in `routes/orders.js` (Stage 5's mechanism)
— that flow doesn't involve a cashier choice today and this stage isn't
asking it to; retroactively offering the choice for offline-queued
sales synced later (`lib/offlineSync.js`) — confirm with Hassan whether
offline overpayment should default to change (matching today's
behavior) or need its own prompt on reconnect, since the cashier isn't
present at sync time.

**Completion criteria:** paying more than the total for a real customer
triggers a toast asking change-vs-balance before the sale commits;
choosing "balance" increases that customer's `creditBalance` by exactly
the overpaid amount and the printed receipt says so; choosing "change"
(or a walk-in sale) behaves exactly as today — nothing persisted, "Change"
shown on the receipt; no double-counting against the existing edit/
refund credit mechanism.

---



Stages 18–19 above were raised directly by Hassan on 2026-08-29 and
scoped straight into numbered stages, same as Stage 16. Nothing else
remains deferred as of this update. This section is kept as a
placeholder — if new unscoped items come up, they belong here until
triaged into a numbered stage.

## Already covered, no work needed

- **Admin-only version** — reviewed against the existing codebase:
  Workers tab is already hidden from non-admins (`Sidebar.jsx`'s
  `adminOnlyLinks`), `/workers` is already guarded by `AdminRoute.jsx`
  client-side, and every `/api/users` route already requires
  `requireAuth + requireAdmin` server-side. Hassan confirmed this already
  satisfies the original ask. No stage needed.

---

## Coverage audit — all 16 original handwritten notebook items

Cross-checked against the original two-page "Bugs & Issues" notebook
transcription this whole plan was triaged from. All 16 original items
are accounted for as of this update — 15 have a resolution below, one
(#7) was deliberately merged into another item's resolution rather than
kept as its own line.

| # | Original note (paraphrased) | Resolution |
|---|---|---|
| 1 | Offline data tracked/entered while offline; should show in dashboard | Stages 12–13 |
| 2 | Admin-only version | Already covered, no work needed |
| 3 | Product ID bug fix | Stage 2 |
| 4 | Product deletion management | Stage 9 |
| 5 | Toast/message dialogs instead of `alert()`/`confirm()` | Stages 5–6 |
| 6 | Add Product needs cost & selling price captured | Stage 7 |
| 7 | Stock deduction with reason; supplier return handling; quantity+supplier record consistency | Merged into Stage 9 (Add Stock / Deduct Stock / hard-delete redesign) |
| 8 | Billing should show last-purchased cost | Stage 8 |
| 9 | Remove `$`, use PKR | Stage 1 |
| 10 | Exchange process should be better | Stage 14 |
| 11 | Supplier window looks good; Customer/Product/Billing don't | Stage 10 (Customers confirmed already fine, no change) |
| 12 | Audit log should be human-readable, not raw JSON | Stage 3 |
| 13 | PDF export alongside Excel/CSV | Stage 4 |
| 14 | Where is offline data saved when offline? | Closed as a question, answered in Stage 12 — IndexedDB, `pos-offline-queue` database |
| 15 | Offline management: Excel vs. Redux Toolkit, 72h persistence, sync-on-reconnect | Stages 12–13 (resolved as neither Excel nor Redux — stays on IndexedDB) |
| 16 | Bill preview should show customer balance | Stage 11 |

**Note on #7:** the original note bundled "reason for stock deduction,"
"supplier return credit handling," and "quantity+supplier record
consistency" into one paragraph, and #4 ("product deletion management")
turned out to be the same underlying mechanism — remove some or all of a
product's quantity for a reason, categorized as either a supplier return
(adjust their credit) or a loss (write it off) — just triggered two
different ways (a partial adjustment vs. deleting the whole product).
These were deliberately consolidated into a single system in Stage 9
during triage, rather than built as two mechanisms that could drift
apart. This is why #7 doesn't have its own stage number — it isn't
missing, it's inside Stage 9.

**No open items remain from the original 16.** Any further items Hassan
raises going forward (from untriaged parts of the same notebook, or new
notes) get added to "Deferred — not yet scoped" above, then promoted to
their own numbered stage the same way #1/#10/#14 were in this update.