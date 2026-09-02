# Production Readiness Plan — BPIOLS

Agreed after a full-codebase review and stage-by-stage discussion of every
finding. Each stage is scoped to be small, self-contained, and safe to
verify on its own — no stage should require touching areas outside its
stated scope. Do not start a stage until the previous one is complete and
validated.

---

## Stage 1 — Automated Test Foundation

**Goal:** establish a minimal, dependency-free-of-a-live-database test
harness covering the pure-logic modules, so every later stage has a real
way to detect regressions instead of relying on manual re-reading.

**Issues addressed:** no automated tests exist anywhere in the repo;
every prior verification has been `node --check` / lint / boot-test only.

**Implementation tasks:**
- Add a test runner (Jest or Node's built-in `node:test`) and a `test`
  script in `package.json`.
- Write unit tests for `lib/money.js` (`roundMoney` edge cases: negative,
  non-numeric, floating-point drift).
- Write unit tests for `lib/pricing.js` (`getLatestSellingPrice`/
  `getLatestBuyingPrice` against empty/single/multi-entry histories).
- Write unit tests for `lib/validators.js` (every validator, valid and
  invalid inputs).
- Write unit tests for `lib/costing.js`'s pure math paths that don't
  require a live Mongo session where feasible; otherwise test
  `deriveCostSource` directly and document what still needs a live DB.
- Write unit tests for discount/total calculation logic used in order
  commit and refund/edit (extracted or exercised as pure functions).

**Affected areas:** new `tests/` (or `__tests__/`) directory, `package.json`
only. No production code logic changes.

**Testing/validation:** `npm test` runs clean, all new tests pass,
`npm run build`/lint on frontend unaffected (no frontend changes this
stage).

**Completion criteria:** a working `npm test` command exists, covers the
modules listed above, and passes.

---

## Stage 2 — Security & Config Hardening

**Goal:** close the low-effort, high-impact security/config gaps found
during review, independent of any feature work.

**Issues addressed:** functional `.env.example` `JWT_SECRET` value that
works if copied as-is; password changes don't revoke prior sessions.

**Implementation tasks:**
- Replace the `JWT_SECRET` value in `.env.example` with an obviously
  non-functional placeholder.
- Add a boot-time check in `main.js`/`middleware/auth.js` that refuses to
  start if `JWT_SECRET` matches the known example value.
- Add a `passwordChangedAt` (or equivalent) field to the `User` model;
  embed it in the JWT at login; check it in `requireAuth` against the
  current DB value so a password change invalidates any previously issued
  token for that account.

**Affected areas:** `.env.example`, `main.js` (boot check), `models/user.js`,
`middleware/auth.js`, `routes/auth.js`.

**Testing/validation:** boot test confirms the server refuses to start
with the placeholder secret; a token issued before a password change is
confirmed rejected after the change (unit/integration test using Stage 1's
harness where possible, otherwise a manual boot-tested check).

**Completion criteria:** server will not boot with the example secret;
changing a password invalidates old tokens.

---

## Stage 3 — Structural Cleanup: Route Module Split + Indexes

**Goal:** break `main.js` into domain-based route modules (finishing the
pattern `routes/auth.js`/`export.js`/`sync.js` already use) and add
indexes on the fields actually queried/sorted/filtered most, with **zero
logic changes** — this is a pure move-and-organize stage.

**Issues addressed:** `main.js` at 1,600+ lines mixing every domain
inline; no indexes on `Order.orderDate`, `Order.customerName`,
`Product.category`, `Supplier.supplierName` beyond uniqueness.

**Implementation tasks:**
- Create `routes/products.js`, `routes/customers.js`, `routes/billing.js`,
  `routes/suppliers.js`, `routes/orders.js` (includes
  `applyLineReduction`/`recomputeOrderTotals`, kept alongside the
  edit/refund routes per agreed convention), `routes/audit.js`.
- Move each route handler verbatim — no logic edits during the move.
- Mount each new router in `main.js`; `main.js` reduces to: app setup, DB
  connection, middleware, route mounting, static frontend serving, error
  handler, draft-sweep interval.
- Add indexes: `Order.orderDate`, `Order.customerName`, `Product.category`,
  `Supplier.supplierName` (beyond its existing uniqueness index) — evaluate
  each against actual query patterns before adding.

**Affected areas:** `main.js`, new `routes/*.js` files, `models/Order.js`,
`models/Product.js`, `models/Supplier.js`.

**Testing/validation:** full route inventory boot-tested before and after
the split — every route hit with the same request, same expected status
code/response shape pre- and post-move (single `bash_tool` call per the
established convention). `npm run build`/lint clean. `npm test` still
passes.

**Completion criteria:** every route responds identically to before the
split; `main.js` contains no inline business route handlers; new indexes
exist and don't change any query result, only performance.

---

## Stage 4 — Customer Data Integrity & Access Control

**Goal:** close the customer-deletion access-control gap and make sure a
customer's outstanding balance can never silently disappear from
reporting.

**Issues addressed:** `/customer/deleteCustomer` has no `requireAdmin`;
deleting a customer erases their `orders[].balanceDue` from every credit
report even though the underlying `Order` documents still exist.

**Implementation tasks:**
- Add `requireAdmin` to the customer delete route.
- Block (or require explicit forced confirmation, per final design) deletion
  when any `orders[].balanceDue > 0`.
- Add a reconciliation check ensuring `Customer.orders[]` entries and their
  source `Order` documents stay in sync — verify no code path can leave
  them diverged (e.g. after Stage 5's refund/edit changes).

**Affected areas:** `routes/customers.js` (post Stage 3), `models/Customers.js`.

**Testing/validation:** attempt to delete a customer with an outstanding
balance as both admin and worker — worker is rejected at auth, admin is
rejected/blocked by the balance check; deleting a zero-balance customer as
admin still works; audit log entry confirmed for the deletion.

**Completion criteria:** only an admin can delete a customer; a customer
with any outstanding balance cannot be deleted without an explicit,
deliberate override; audit trail reflects the action.

---

## Stage 5 — Refund & Edit Financial Correctness

**Goal:** make order edits/refunds keep `amountPaid`, `balanceDue`,
`paymentStatus`, and any generated credit fully reconciled with reality,
mirroring the supplier-credit design already in place.

**Issues addressed:** editing/refunding a paid order down doesn't reduce
`amountPaid`, so overpayment silently disappears instead of being tracked
as cash returned or store credit.

**Implementation tasks:**
- Default behavior: refund/edit reduces `order.amountPaid` to reflect cash
  actually handed back, keeping the order's own numbers internally
  consistent.
- Add an explicit per-refund choice: cash-back (default) vs. issue as
  store credit.
- If store credit is chosen, add a customer-side credit balance (mirroring
  `Supplier.creditBalance`/`creditApplied`/`creditGenerated`), applied
  automatically to reduce what's owed on the customer's next order.
- Ensure discount amounts, `amountPaid`, `balanceDue`, `paymentStatus`,
  the `Refund` record, the customer credit ledger (if used), and the audit
  log entry all agree with each other for every scenario (full refund,
  partial refund, edit-down, edit-down-then-refund).
- Update the Orders/Customers screens to surface the new credit field
  where relevant, matching the Suppliers screen's existing pattern.

**Affected areas:** `routes/orders.js`, `models/Order.js`, `models/Customers.js`,
`lib/reports.js` (if credit reporting needs to reflect this), frontend
`Orders.jsx`/`Customers.jsx`/`Billing.jsx` as needed.

**Testing/validation:** unit-test the reconciliation math (mirroring the
7-scenario verification already done for the supplier credit fix) using
Stage 1's harness; boot-test the routes; hand-trace at least: full refund
of a paid-in-full order, partial refund, edit-down with cash-back, edit-down
with store credit, edit-down-then-later-refund.

**Completion criteria:** no scenario leaves `amountPaid` overstating what
was actually retained; every refund/edit is either cash-back or store
credit, never silently absorbed; all money fields reconcile in every
tested scenario.

---

## Stage 6 — In-App User & Worker Management

**Goal:** replace CLI-only account management with proper in-app,
admin-facing worker management, including password changes.

**Issues addressed:** no `/api/users` routes or UI exist; account
creation/deletion/password changes require terminal access to
`scripts/createUser.js`.

**Implementation tasks:**
- Add `GET/POST/DELETE /api/users` (admin-only), covering create, delete,
  role assignment, and admin-initiated password reset.
- Add a self-service "change my own password" endpoint for a logged-in
  user of any role.
- Wire password changes (both self-service and admin-reset) into Stage 2's
  `passwordChangedAt` mechanism so they revoke existing sessions.
- Add a "Users" admin-only screen (same `AdminRoute` pattern as Audit Log).
- Log every user-management action to the audit log.

**Affected areas:** new `routes/users.js`, `models/user.js`,
`middleware/auth.js`, new frontend `Users.jsx` + routing/sidebar entry.

**Testing/validation:** boot-test every new route for auth/role gating
(401 no token, 403 non-admin where required); confirm a password change
via both the new self-service and admin-reset paths actually invalidates a
previously issued token; frontend build/lint clean.

**Completion criteria:** an admin can add/remove a worker and reset a
password entirely from the app; a worker can change their own password;
every such action revokes old sessions and is audit-logged.

---

## Stage 7 — Offline Sync: Walk-in Customer Support

**Goal:** make an offline walk-in sale sync successfully instead of always
landing in the conflict queue.

**Issues addressed:** `lib/offlineSync.js`'s `syncOfflineSale()` has no
awareness of the `WALKIN_CUSTOMER` sentinel and unconditionally requires a
matching `Customer` document.

**Implementation tasks:**
- Mirror the same `isWalkIn` skip `POST /billing/orderDetails` already
  applies: when `offlineSale.customerName === WALKIN_CUSTOMER`, skip the
  `Customer` lookup/404 and the customer order-history push.

**Affected areas:** `lib/offlineSync.js` only.

**Testing/validation:** queue and sync an offline walk-in sale end-to-end
(or as close to end-to-end as the environment allows); confirm it produces
a real `Order` rather than a conflict-queue entry; regression-check a
normal (non-walk-in) offline sale still requires and finds its customer.

**Completion criteria:** an offline walk-in sale syncs cleanly on
reconnect, same as a live walk-in sale does today.

---

## Stage 8 — Final Cleanup Pass

**Goal:** close the remaining small, low-severity inconsistencies
identified during the review.

**Issues addressed:**
- `/product/undo` doesn't call `isValidProductId()`, unlike `/api/product`.
- Login rate limiting is per-IP, which is fine for a single-desktop
  deployment but worth a sanity check on the current limit.
- Billing receipt/cart doesn't display the stored `discountAmount`.
- Dashboard refund count vs. refund amount use different date scopes.

**Implementation tasks:**
- Add `isValidProductId()` validation to `/product/undo`, matching
  `/api/product`'s pattern.
- Review and, if needed, adjust the login rate limiter's `max`/`windowMs`
  for a single-shared-IP deployment.
- Surface `discountAmount` on the Billing receipt/cart display.
- Align the dashboard's refund count and refund amount to use the same
  date scope.

**Affected areas:** `routes/products.js` (post Stage 3), `middleware/rateLimit.js`,
frontend `Billing.jsx`, `lib/reports.js`.

**Testing/validation:** boot-test the corrected validation path; manual/
unit check that the discount now displays; confirm refund count and amount
agree over the same range in the dashboard response.

**Completion criteria:** all four items closed with no regression to
surrounding behavior.

---

## Notes carried over from the review, not requiring a stage

- Pre-Stage-20/22 legacy data inconsistencies (old `Product.supplier`
  string field, unbatched historical stock) are explicitly **not** being
  migrated — confirmed as test-phase data, out of scope. All work above
  focuses on ensuring every *future* transaction stays consistent.
- Code style going forward (all stages above): no comments, no extra
  blank-line padding, tightly formatted. Applies to new code and to any
  function/file directly touched for a fix. Files not otherwise touched
  by a stage are left as-is — no repo-wide reformatting pass.
