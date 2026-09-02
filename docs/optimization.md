# POS System — Optimization Plan

Continuation of `IMPROVEMENT_PLAN.md`. Stages 1–11 plus the EJS-removal pass are done (see `progress.md`). This file picks up from there: gaps found while auditing the finished work, plus new requirements given directly. Same format as the original plan — ordered by dependency, each with an exit criteria — so it can be worked the same way.

Nothing in this file has been built yet. This is planning only.

---

## Stage 12 — Close Remaining Security Gaps

*Carried over from the Stage 9/EJS-removal audit — the riskiest thing to leave sitting in production, so it goes first.*

1. Add `requireAuth` to `GET /dashboard/load`, `GET /api/products`, `GET /api/customers` — currently public. Anyone with the URL can read sales totals, customer credit exposure, and the full product/customer list with no login.

2. Add a refresh-token (or silent re-auth) flow. Currently a flat 8-hour JWT with no renewal — a cashier mid-shift gets hard-logged-out with no graceful recovery, which will get worse once the desktop/offline work (Stage 18) makes sessions live longer between server contact.

**Exit criteria:** no route returns business data without a valid token; a session can be extended without forcing a full re-login mid-shift.

---

## Stage 13 — Product Price Edit: Show Previous vs. New Amount (Admin-only)

*Depends on Stage 1 (roles) — already done. Small, self-contained.*

The data already exists (`sellingPriceHistory`/`buyingPriceHistory` are already arrays, not scalars — see `lib/pricing.js`). This is a UI gap, not a data-model gap.

1. On the Products edit form, when an admin opens a product to change its price, show the current/previous price (last entry in the history) alongside the new-price input, so the admin can see what it was vs. what they're about to set it to.

2. Same treatment for buying price on the Suppliers purchase-recording flow, since that's the other place a price gets changed.

3. Non-admin (cashier) view stays as-is — this is admin-only visibility, not a change to what cashiers see.

**Exit criteria:** an admin changing a product's price can always see the old value next to the new one before confirming, on both the selling-price (Products) and buying-price (Suppliers) sides.

---

## Stage 14 — Audit Log (Refunds, Updates, New Bills)

*Depends on Stage 1 (roles/`req.user`) and Stage 7 (existing edit/refund data to build on).*

Right now, auditability is scattered: `Order.editHistory[]` covers admin edits, the `Refund` model covers refunds, but there's no single place to answer "what happened, when, and who did it" across the app — and nothing at all logs product/customer/supplier updates or plain new-bill creation.

1. Add an `AuditLog` model: `action` (e.g. `order.created`, `order.refunded`, `order.edited`, `product.updated`, `customer.updated`, `supplier.updated`), `actor` (username + role), `targetType`/`targetId`, `before`/`after` snapshot (or diff) where it makes sense, `timestamp`.

2. Write an entry at the point each of those actions actually commits — piggyback on the existing transactions where one already exists (order commit, edit, refund) rather than adding new ones.

3. Add an admin-only Audit Log screen (list, filterable by action type / date range / actor — reuse Stage 8's search/sort/pagination pattern).

4. Decide retention: keep everything, or cap/archive old entries — flag this as a follow-up decision, not blocking for this stage.

**Exit criteria:** every refund, every admin edit, every new bill, and every product/customer/supplier update produces a durable, admin-visible record of who did it and when.

---

## Stage 15 — Low-Stock Notifications

*Depends on Stage 3's `lowStockThreshold` (already exists) — this stage is the actual notification, the red-highlight UI already covers the passive/in-context part.*

1. In-app notification first (no new infra required): a badge/bell in the header showing a count of products currently at-or-below threshold, admin-visible, checked on load and on an interval or after any stock change.

2. Clicking it lists the affected products (name, current stock, threshold) — reuse the existing product list styling.

3. Browser push notifications (real OS-level alerts) are a stretch goal, not default scope — they need a service worker, HTTPS, and explicit user permission, which is a meaningfully bigger lift. Flag as a follow-up if in-app isn't enough once it's actually used.

**Exit criteria:** an admin logging in (or already logged in when stock drops) sees a clear, unmissable signal that something needs reordering, not just a red row they have to happen to scroll past.

---

## Stage 16 — Full Responsive Design Pass

*Independent of the others — can run in parallel with any of them. Worth doing before Stage 18 (desktop exe), since that introduces more variable window sizes than a fixed browser tab.*

1. Audit every screen (Login, Dashboard, Billing, Products, Customers, Suppliers, Orders, Reports) at common breakpoints (mobile, tablet, small laptop, wide desktop) — not just "does it not break," but "is it actually usable" (tap targets, table overflow, modal sizing).

2. Billing is the highest-risk screen — it's the most element-dense (product search, cart, discount UI, payment) and the one most likely to be used on something other than a full desktop monitor.

3. Tables (Products/Customers/Orders/Suppliers) need a real mobile strategy — horizontal scroll, column priority/collapse, or a card-based layout under some width — not just letting them overflow.

4. No new dependency expected (existing Tailwind setup handles this) — this is a design/CSS pass, not an architecture change.

**Exit criteria:** every screen is fully usable — not just "not visually broken" — from phone width up through desktop, with no horizontal page-scroll and no element that's unreachable or unreadable at any supported width.

---

## Stage 17 — Real PDF Receipts

*Blocked — waiting on a template/pattern to be provided before implementation starts.*

Currently receipts are a plain `window.open()` print popup (`frontend/src/lib/print.js`) styled with inline HTML — functional, but not a real document.

1. **Waiting on input:** an actual receipt pattern/layout will be provided separately before this stage is scoped in detail.

2. Once the pattern's in hand: this is a mechanism swap, not a data change — Stage 6/7's data (discounts, edit history, payment status) is already final and already flows into the current print view: it should be a matter of pulling that same data into a real generated PDF (client-side, e.g. via a library, or server-side) instead of the browser print dialog.

3. Should stay consistent with the existing "revised" print view for edited orders (Stage 7) — a PDF receipt needs the same edit-history treatment, not a regression to a single flat receipt.

**Exit criteria:** not yet defined — depends on the provided pattern. Revisit this stage once it arrives.

---
<!-- Skipp
## Stage 18 — Desktop Distribution: Local Frontend + Hosted Backend

*Depends on Stage 11 (offline sync) — this is what makes offline sync go from "nice to have for flaky wifi" to "the normal operating mode," since the whole point is a local desktop app talking to a backend that isn't on the same network.*

The ask: the frontend should be runnable as a local desktop executable (no hosting needed for the frontend itself), while the backend stays hosted remotely (cloud-hosted MongoDB + Express). This also means offline capability matters more, not less — a request to a remote backend can fail for reasons a LAN-hosted one wouldn't (internet down, backend deployment mid-restart, DNS hiccup), and the shop still needs to be able to sell during all of those.

1. **Configurable API base.** Today, `frontend/src/lib/api.js` and `vite.config.js`'s dev proxy assume same-origin (frontend and backend served together, post EJS-removal). A desktop build needs a real, configurable base URL (e.g. `VITE_API_BASE=https://your-backend.example.com`) baked in at build time, since there's no same-origin relationship once the frontend isn't served by the same Express process.

2. **CORS.** The hosted backend needs to actually accept requests from the packaged app's origin (`file://` or a custom Electron/Tauri scheme) — currently there's no CORS configuration at all, because same-origin never needed one.

3. **Desktop wrapper.** Electron is the more mature/documented option; Tauri is meaningfully smaller and lighter-weight if a native binary size/footprint matters — needs a decision, not a default assumption. Either way: package `frontend/dist`, point it at the configured API base, produce an installable/portable `.exe`.

4. **Offline sync becomes primary, not exceptional.** Stage 11's module already does the hard part (durable queue, conflict resolution) — this stage's job is making sure it's tuned for "regularly offline for real stretches," not just "occasionally offline for a few seconds": revisit the 15-second flush interval, make the offline/pending-sync state more prominent in the UI than the current banner, and actually run the stress-testing that Stage 11 flagged as not yet done (large queue, long outage, multiple devices reconnecting at once).

5. **Auto-update.** Auto-update for the desktop app is a reasonable follow-up once the packaging itself works, not a blocker for the first version.

**Exit criteria:** the packaged desktop app runs on a machine with no local Node/Express/MongoDB installed at all, talks to the hosted backend when reachable, keeps working (queuing sales) when it isn't, and syncs cleanly when connectivity returns.

--- -->

## Stage 19 — Worker Permissions & Walk-in / Unknown Customers

*Depends on Stage 1 (roles) — the role system already exists, so this stage tightens the actual permissions around product, supplier, and customer management.*

The worker/cashier role should be restricted from managing inventory master data while still allowing normal customer handling during billing.

1. **Restrict worker product management.** Workers/cashiers must not be able to create new products, edit existing products, or delete products.

2. This restriction must exist at the **backend/API level**, not only by hiding buttons in the frontend. A worker must not be able to bypass the UI restriction by calling the product API directly.

3. **Restrict worker supplier management.** Workers/cashiers must not be able to create, edit, or delete suppliers.

4. Supplier and product management remain available to the appropriate admin role.

5. **Customer creation remains available to workers.** A worker should be able to add a customer when a real customer needs to be recorded.

6. Add a **Walk-in / Unknown Customer** option to the billing/customer flow.

7. A walk-in/unknown sale should not require creating a permanent customer database record.

8. A walk-in sale should not automatically create a customer credit account or unnecessary customer history. It should simply record the sale against the walk-in/unknown customer designation.

9. The normal customer flow must continue to support customers whose purchases, credit, and history actually need to be tracked.

10. The UI should make the distinction clear:

* **Existing Customer** — select an existing customer.
* **New Customer** — create a customer when required.
* **Walk-in / Unknown** — sell without creating a customer record.

11. Existing admin permissions must not be accidentally weakened by these changes.

**Exit criteria:** a worker can sell products, add customers, and use Walk-in/Unknown for untracked customers, but cannot create, edit, or delete products or suppliers through either the UI or direct API requests. Walk-in sales do not create unnecessary customer or credit records.

---

## Stage 20 — Supplier Selection & `NoSupplier` / Self-Purchased Stock — done, see `progress.md`

*Depends on Stage 19's permission model and the existing Product/Supplier models.*

Product and restock flows need a clearer relationship between a product and the supplier from which stock was purchased. The system also needs to support stock purchased directly by the business without a supplier.

1. When creating or editing a product, the **Supplier field must be a combobox/dropdown**, not an unrestricted text field.

2. The combobox should be populated from the actual supplier records in the database.

3. The selected supplier must reference the corresponding supplier record rather than storing an arbitrary supplier name.

4. Add a special supplier option:

   **`NoSupplier` — Buy Myself / Self Purchased**

   This represents stock purchased directly by the business without recording an external supplier.

5. The same `NoSupplier` option must be available when recording/restocking stock through the Suppliers flow.

6. The restock flow should therefore support both:

   * an actual supplier from the supplier database;
   * `NoSupplier` / self-purchased stock.

7. `NoSupplier` must not require creating a fake supplier record just to complete a purchase.

8. Existing suppliers must remain selectable without duplication.

9. If a supplier is selected for a product, the relationship should remain consistent between the Product management flow and the Supplier/restock flow.

10. Workers must not gain supplier-management permissions merely because they can access a restock-related screen. The existing role restrictions from Stage 19 continue to apply.

11. Backend validation must reject invalid supplier IDs rather than silently accepting arbitrary values.

12. Deleting or changing supplier relationships must not corrupt historical purchase/restock information. Historical stock/purchase records should retain the supplier information that existed when the transaction was made.

**Exit criteria:** product creation/editing uses a database-backed supplier combobox; restocking supports both real suppliers and `NoSupplier`; no fake supplier record is required for self-purchased stock; and supplier references remain valid and historically consistent.

---

## Stage 21 — Unified Product Pricing, Restock & Price Synchronization

*Depends on Stage 20 (supplier selection) and the existing selling/buying price history introduced earlier.*

The Product edit flow and Supplier restock flow must operate on the same underlying product information. A price or stock update made from either location must not cause the other view to become stale or inconsistent.

1. **Restock must support both prices.**

   When recording a restock, allow the user to enter:

   * Cost / Buying Price
   * Selling Price

2. The buying/cost price represents what the business paid for the stock.

3. The selling price represents what customers will be charged before any applicable discount.

4. The **selling price must be the price shown in customer-facing areas**, including:

   * Product listing
   * Billing/product selection
   * Cart
   * Receipt/print view
   * Other customer-facing product price displays

5. The cost/buying price must not accidentally appear in billing simply because it was recently added or updated.

6. **Previous selling price must mean previous selling price.**

   Wherever the application shows a previous price for comparison, it must show the previous **selling price**, not the previous cost/buying price.

7. Cost/buying-price history and selling-price history must remain logically separate.

8. When the Product edit form changes the selling price, the same current selling price must immediately become the selling price used by billing and product listings.

9. When the Supplier/restock flow changes the selling price, the Product edit flow and all other product displays must see the same updated selling price.

10. When the Supplier/restock flow changes the buying/cost price, that must update the product's current cost information without overwriting the selling-price history.

11. The reverse must also be true: editing a product must not silently create an inconsistent supplier/restock record.

12. Stock quantity changes made through restocking must update the same product inventory used by billing.

13. Price and stock updates should use appropriate atomic/transactional behavior where necessary so a partially completed update cannot leave Product and Supplier data out of sync.

14. Existing price history must be preserved. Updating the current price must not destroy the historical values needed for future profit calculations and auditability.

15. The UI should make the distinction explicit:

* **Buying/Cost Price** — internal business cost.
* **Selling Price** — normal customer sale price.
* **Previous Selling Price** — previous customer sale price.

16. This stage should also ensure that the price displayed in billing is never accidentally derived from the cost price.

17. Any existing code that currently treats buying and selling prices as interchangeable should be corrected before this stage is considered complete.

**Exit criteria:** Product editing and Supplier restocking use the same underlying product pricing and stock data. Both flows stay synchronized regardless of where the change is made. Cost price, selling price, and previous selling price remain distinct, and billing/product listings always use the correct selling price.

---

## Stage 22 — Batch-Based Costing & Dashboard Profit

*Depends on Stage 21 — the system must correctly record cost and selling prices before profit can be calculated reliably.*

The dashboard currently provides the existing overall sales figure. The new requirement is to add a simple overall profit figure without turning the dashboard into a complicated accounting system.

Because the same product can be purchased at different costs over time, profit must **not** simply use the product's latest cost price. The system will use **batch-based costing with FIFO consumption**.

### 1. Create a stock batch for each restock

Every restock should represent a distinct inventory batch containing at minimum:

* Product
* Supplier / `NoSupplier`
* Quantity purchased
* Remaining quantity
* Cost/buying price per unit
* Purchase/restock date
* Relevant reference/transaction information

For example:

* Batch A: 10 units at 100 each
* Batch B: 10 units at 120 each

The system must know that these are two different cost batches.

### 2. Use FIFO when stock is sold

When products are sold, inventory cost should be consumed from the oldest available batch first.

Example:

* 10 units purchased at 100
* 10 units later purchased at 120
* 12 units sold

The first 10 sold units use the 100 cost batch, and the remaining 2 use the 120 cost batch.

The system must not simply use the latest product cost for all 12 units.

### 3. Record the cost used by each sale

When a sale is committed, the system should retain the cost associated with the stock that was actually consumed.

This is important because future changes in product cost must not rewrite the historical cost of previously completed sales.

### 4. Calculate profit using the actual selling amount

For each sold item:

**Profit = Actual Sale Amount − Actual Batch Cost**

The actual sale amount must reflect the price actually paid by the customer.

If a product has a discount, profit must be calculated using the **discounted selling price**, not the original selling price.

For example:

* Normal selling price = 150
* Batch cost = 100
* Customer receives discount
* Actual amount paid = 130

Profit for that unit:

**130 − 100 = 30**

The system must not calculate:

**150 − 100 = 50**

because the customer actually paid 130.

### 5. Handle line-level discounts correctly

If a bill contains multiple products with different prices, quantities, or discounts, profit should be calculated at the appropriate line/item level rather than applying one global product price to the entire bill.

### 6. Preserve historical profit

Once a sale has been completed, its calculated/recorded cost basis must remain stable.

A later event such as:

* a new restock,
* a new buying price,
* a new selling price,
* editing the current product,
* changing the current supplier,

must not change the historical profit of an already completed sale.

### 7. Handle insufficient/exceptional stock safely

If there is not enough available batch stock to satisfy a sale, the system must not silently invent a cost price.

The behavior for impossible inventory states should be explicit and should not produce misleading profit figures.

Any legacy sales that predate batch-based costing should be identified separately if their exact historical cost cannot be reconstructed. They should not be silently assigned an arbitrary current cost.

### 8. Dashboard — keep it simple

The dashboard should continue showing the existing overall:

**Total Sales**

and add:

**Total Profit**

The goal is intentionally simple. This is not a full accounting module.

The dashboard should provide a single overall profit number representing the profit generated by completed sales according to the batch/FIFO cost records.

### 9. Profit must account for discounts

Dashboard profit must be based on actual completed sale amounts after discounts.

It should therefore represent:

**Total Profit = Total Actual Sale Revenue − Total Cost of Goods Sold**

where cost of goods sold comes from the batch/FIFO records.

### 10. Do not confuse sales, cost, and profit

The dashboard values must remain clearly separated:

* **Total Sales** — total amount actually received/recorded from completed sales.
* **Total Cost** — internal cost of the inventory sold, where needed for calculation.
* **Total Profit** — sales revenue minus the applicable batch costs.

Only the requested simple sales and profit totals need to be prominently displayed.

### 11. Refunds and edited orders

The profit calculation must integrate with the existing refund/edit behavior from earlier stages.

A refunded sale must not continue contributing incorrectly to total profit.

An edited order must use the application's established final sale state while preserving the historical audit information required by the earlier stages.

The exact interaction with existing refund and order-edit models should be verified before implementation so profit is never double-counted.

**Exit criteria:** every new restock creates a distinct cost batch; completed sales consume stock using FIFO; each sold item retains the cost basis actually used; discounts reduce the revenue used for profit calculation; later price/cost changes cannot rewrite historical profit; and the dashboard shows a reliable simple **Total Sales** and **Total Profit** figure.

---

## Still Deferred (from the original plan, unchanged)

* Tax handling

* Barcode scanning

* Automated test suite

* (Real PDF receipts moved from here to Stage 17 above — no longer purely deferred, just blocked on input)
