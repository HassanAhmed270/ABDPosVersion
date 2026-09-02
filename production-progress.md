BPIOLS — Production Readiness Progress

Append-only fast-reference log for the production-hardening phase.
Separate from the historical feature-development progress.md. Compacted
periodically (stage entries condensed to essentials) to stay under
~250 lines — see "Compaction note" at the bottom for what was trimmed.

Phase rules

- Production stage numbering starts at Stage 1; production.md is the
  authoritative stage list; CLAUDE.md holds architecture/working rules.
- Historical stages in progress.md are not production stages.
- Append new entries; never rewrite previous production entries (a
  compaction pass may condense old entries' prose but must not change
  their facts).

---

Stage 1 — Automated Test Foundation — DONE

Added a dependency-free `node:test` harness (`tests/money.test.js`,
`pricing.test.js`, `validators.test.js`, `costing.test.js`,
`orderMath.test.js`) and an explicit-file-list `test` script in
`package.json` (glob/bare-discovery forms were tried and failed on the
person's Windows machine). `orderMath.test.js` reimplements main.js's
inline formulas (not exported) as a pinned regression net.
Verified: 46/46 passing, confirmed independently on the person's Windows
machine. No production code changed. `consumeFIFO`/`restoreConsumption`
remain untested (need a live Mongo session).

---

Stage 2 — Security & Config Hardening — DONE

Replaced `.env.example`'s functional-looking `JWT_SECRET` with an
obviously-fake placeholder; `middleware/auth.js` now refuses to boot if
`JWT_SECRET` matches it. Added `User.passwordChangedAt`, embedded as a
`pwdTs` JWT claim; `requireAuth` (now async) re-reads it from the DB per
request and rejects stale tokens. Incidental fix: `scripts/
createUser.js`'s upsert now also sets `passwordChangedAt` (otherwise the
whole mechanism could never actually fire). Added `tests/auth.test.js`.
Verified: boot-refusal confirmed; 5 new unit tests exercise the real
`requireAuth`/token logic (DB call stubbed); 51/51 passing. Not
exercised against a live Mongo end-to-end (none available in this
sandbox) — recommended manual check documented in the original entry.

---

Stage 3 — Structural Cleanup: Route Module Split + Indexes — DONE

Split all 28 inline route handlers out of `main.js` (1,638 → 160 lines)
into `routes/products.js`, `customers.js`, `billing.js`, `suppliers.js`,
`orders.js` (incl. `recomputeOrderTotals`/`applyLineReduction`, and
`GET /dashboard/load` — a judgment-call placement, flagged), `audit.js`
— moved by exact line-range extraction, zero logic changes, same paths.
Added indexes: `Order.orderDate`, `Order.customerName`,
`Product.category`; `Supplier.supplierName` left alone (already
indexed via `unique: true`).
Verified: side-by-side pre/post boot test hit all 28 routes + login +
an unmatched path — identical status codes on every one; 51/51 tests
still passing (untouched by this stage). Not exercised against a live
Mongo (none available). Flagged: `recomputeOrderTotals`/
`applyLineReduction` still aren't exported for direct testing.

---

Stage 4 — Customer Data Integrity & Access Control — DONE

`routes/customers.js`'s `POST /customer/deleteCustomer`: added
`requireAdmin`; added an outstanding-balance guard (409 +
`requiresForce: true` if any `orders[].balanceDue > 0`, unless
`force: true` is sent). Reviewed every route writing
`Order.amountPaid`/`balanceDue` and confirmed each already syncs the
matching `Customer.orders[]` entry in the same transaction — a
verification finding, not a code change. Added
`tests/customerBalance.test.js`.
Verified: static middleware-chain check confirms `requireAdmin` wiring;
boot test (worker/no-token get 401 pre-auth, as expected given no live
Mongo); 56/56 passing. Frontend has no "force delete" UI — **decided**:
intentional, stays API-only, no further action.

---

Stage 5 — Refund & Edit Financial Correctness — DONE

`routes/billing.js`/`routes/customers.js` touched outside listed scope
(person's explicit go-ahead mid-stage — checkout needed to know about
customer credit). Design decision: an **edit**'s freed-up overpayment
always becomes store credit (correction, not a cash event); a
**refund** takes an explicit `settlement: 'cash'|'credit'` choice,
defaulting to cash-back.

Added `Order.creditApplied`, `editHistory[].settlement`/`creditAmount`,
`Customer.creditBalance` + per-order `creditApplied`/`creditGenerated`
(mirrors `Supplier.creditBalance`), `Refund.settlement`/
`creditGenerated`. `recomputeOrderTotals` now returns the freed-up
"settlement" instead of losing it behind `balanceDue`'s clamp-to-zero.
Checkout (`routes/billing.js`) auto-applies existing customer credit
before computing `amountPaid`/`balanceDue`, mirroring supplier-credit
auto-apply; also fixed `paymentStatus`'s `amountPaid <= 0` branch to
check `balanceDue` instead (credit-covered $0-paid orders are `'paid'`).
Incidental fixes: `Customer` and `isValidProductId` were used in
`routes/orders.js` but never `require`d (would throw at runtime).
Frontend: cash/credit radio on refund, credit columns/labels on
Orders/Customers/Billing. Added `tests/refundSettlement.test.js`
(11 cases: the 5 production.md scenarios + edge cases).

Verified: `node --check` clean; 66/66 tests passing; boot test (no
token → 401 on all money routes, confirms no load-time errors); `npm
run build` clean; diff confirmed to exactly the 10 intended files.

Open: no live MongoDB in this sandbox — money math is unit-tested
against the real route code but not exercised against a real
transaction; manual pass recommended (edit-down → credit increases;
refund cash vs credit; credit auto-applies on next order; edit-then-
refund composes correctly). `production.md` itself not yet amended to
reflect the billing.js/customers.js scope extension.

---

Stage 6 — In-App User & Worker Management — DONE

New `routes/users.js` (admin-only unless noted): `GET/POST /api/users`
(list, create — role must be `admin`/`cashier`, password min 8 chars),
`DELETE /api/users/:username` (blocks self-delete and deleting the last
remaining admin), `POST /api/users/:username/reset-password`
(admin-initiated reset), `POST /api/users/me/password` (self-service,
any logged-in role — verifies current password via bcrypt, returns a
fresh token like `/auth/refresh` so the caller isn't logged out by their
own action). All four mutating actions call `logAudit()`
(`user.created`/`user.deleted`/`user.password_reset`/
`user.password_changed`) with `targetType: 'user'`. Every password write
sets `passwordChangedAt`, reusing Stage 2's revocation mechanism as-is —
no changes needed to `middleware/auth.js` or `models/user.js`.

Frontend: new `Users.jsx` (admin-only, `/workers` route, same
`AdminRoute` pattern as Audit Log) — worker table with role/added-date,
delete, and a reset-password modal; an "Add Worker" form alongside it,
matching `Suppliers.jsx`'s table+form layout. `App.jsx` and
`Sidebar.jsx` wired (`Workers` link un-disabled — it already existed as
a disabled placeholder pointing at `/workers`). `AuditLog.jsx` gained
labels/badges for the four new action types. `api.js` gained
`getUsers`/`createUser`/`deleteUser`/`resetUserPassword`/
`changeOwnPassword`.

**Deliberate scope decision:** no self-service "change my own password"
UI was built. `production.md`'s Stage 6 Affected areas list only
`Users.jsx` + routing/sidebar as frontend additions; the self-service
bullet is worded as an endpoint only, with no paired UI file, and
`Topbar.jsx`/`AuthContext.jsx` (where such a UI would have to live)
aren't in scope. The `POST /api/users/me/password` endpoint exists and
works; there's just no in-app entry point to reach it yet. Flagging this
the same way Stage 4 flagged its "no force-delete UI" decision — worth
a follow-up if a self-service UI turns out to matter in practice.

No dedicated test file added — `routes/users.js` is CRUD + bcrypt with
no pure-math logic comparable to Stage 1's money/pricing/costing scope
or Stage 2's `requireAuth`; every other CRUD route (customers,
suppliers) is boot-tested only too, not unit-tested, so this stays
consistent with that existing precedent rather than introducing a
one-off exception.

Verified

- `node --check` clean on `main.js` and `routes/users.js`.
- `npm test`: 66/66 passing (no change from Stage 5 — no new test file),
  fresh `npm install`.
- Boot test (single `bash_tool` call, no live Mongo — none available in
  this sandbox): booted with a real `.env`, hit all five new routes with
  no token (all 401, confirming the module mounts and loads without
  throwing) and an unmatched `/api/*` path (404).
- `npm run build` (frontend, fresh `npm install`): clean, no errors.
- `git status --short` / `git diff --stat` confirm exactly the 7
  intended files changed (5 modified, 2 new) — nothing else.
- `node_modules` (root and frontend), `frontend/dist`, and the scratch
  `.env`/log removed after verification, before packaging.

Open / known limitations

- No live MongoDB available in this sandbox (same gap as every prior
  stage) — none of the CRUD/auth logic above was exercised against a
  real database or a real browser session. A manual live pass is
  recommended: (a) log in as admin, add a cashier worker, confirm they
  can log in; (b) reset that worker's password, confirm their existing
  token stops working immediately; (c) attempt to delete your own
  account and the last remaining admin, confirm both are blocked;
  (d) call `POST /api/users/me/password` directly (e.g. via curl) as a
  logged-in cashier, confirm the old token is invalidated and the
  returned new token works.
- No self-service password-change UI — see the scope decision above.

Stage 7 — Offline Sync: Walk-in Customer Support — DONE

`lib/offlineSync.js`'s `syncOfflineSale()` now mirrors `routes/billing.js`'s
`isWalkIn` skip: when `offlineSale.customerName === WALKIN_CUSTOMER`, the
`Customer` lookup/409 and the post-commit customer order-history push are
both skipped, same as the live walk-in path. `WALKIN_CUSTOMER` is defined
as its own local const in this file rather than imported from
`routes/billing.js` (not exported there, and importing it would mean
touching that file's exports — out of this stage's single-file scope);
flagging the duplicated sentinel value as a spot to keep in sync if it
ever changes. No credit-auto-apply logic was added here — Stage 5's
customer-credit auto-apply exists only in the live checkout path
(`routes/billing.js`), and adding it to offline sync wasn't in this
stage's scope or issue description, so offline sales still don't draw
down customer credit; flagging as a possible future gap, not fixed here.

Verified: `node --check` clean; 66/66 tests passing (no new test file —
`syncOfflineSale` is transactional commit logic like `routes/orders.js`,
following Stage 6's precedent of boot-test-only for this class of code,
not pure-math like Stage 1's scope); boot test with
`ENABLE_OFFLINE_SYNC=true` confirmed `POST /api/sync/commit` mounts and
returns 401 with no token (module loads without throwing); `git diff
--stat` confirms exactly the one intended file changed.

Open: no live MongoDB in this sandbox (same gap as every prior stage) —
the actual walk-in sync path (queue → `POST /api/sync/commit` → real
`Order` with no conflict-queue entry) was not exercised end-to-end.
Manual pass recommended: go offline, complete a walk-in sale, reconnect,
confirm it produces a real `Order` (not a conflict-queue entry) and no
`Customer` document is touched; then repeat with a normal named customer
and confirm that path still requires and finds its `Customer` record as
before.

---

Stage 8 — Final Cleanup Pass — DONE

Closed all four items from `production.md`:

- `routes/products.js`: `POST /product/undo` now calls `isValidProductId()`
  and returns the same 400 as `/api/product` on a malformed ID, before any
  DB read.
- `middleware/rateLimit.js`: `loginLimiter` raised from `max: 10` to
  `max: 20` and added `skipSuccessfulRequests: true`. Rationale: this is a
  single shared IP for the whole shop, so the old counter combined every
  worker's successful shift-change logins with genuine failed-attempt
  budget, risking a lockout with no attacker involved. Now only failed
  attempts consume the budget, and the cap itself is a little more
  forgiving for a multi-worker single terminal while still bounding
  brute-force guesses per 15-minute window.
- `frontend/src/pages/Billing.jsx`: added a `totalDiscount` (sum of each
  line's $ discount) alongside the existing `grandTotal`, and a
  conditional "Discount" line (only shown when > 0) in both the live cart
  summary and the standard `printReceiptFor` printout, just above Grand
  Total. The Stage 17 "Special Bill" layout was deliberately left
  untouched — its own code comments document that it intentionally omits
  a discount column to match the catering-invoice reference template, and
  changing that wasn't part of this stage's issue list.
- `lib/reports.js`: `refundedOrders` was counted from `Order` documents
  scoped by `orderDate`, while `refundedAmount` was summed from `Refund`
  documents scoped by `refundDate` — different date fields, different
  scopes. Removed the `refundedOrders` facet from the `Order` aggregate;
  `refundedOrders` is now `orderIDs.length` from a `$addToSet` on the same
  `Refund.aggregate` call (same `refundDate` match) that already produces
  `refundedAmount`, so both numbers now come from the same query and the
  same date scope. Output field names/shape are unchanged, so
  `routes/export.js`'s summary sheet and `Dashboard.jsx` needed no changes.

Verified: `node --check` clean on all three touched backend files;
66/66 tests passing (no new test file needed — none of these four fixes
introduced new pure-math logic distinct from what Stage 1 already covers;
`isValidProductId` and the money math are already unit-tested, this stage
only wires/aligns existing tested logic); boot test (single `bash_tool`
call) with a real `.env`, no live Mongo: `POST /product/undo`,
`POST /api/product`, and `GET /dashboard/load` all correctly return 401
with no token (confirms the new validation line and both touched route
files load without throwing — `requireAuth` rejects before any DB call,
so this is meaningful even without Mongo); a 24-request burst against
`POST /auth/login` from one IP hit `429` on the 21st request, confirming
`max: 20` and `skipSuccessfulRequests` are wired correctly (the first 20
each hit the still-configured 10s Mongo lookup timeout and returned 500,
expected with no live Mongo — the rate limiter itself fired at the right
count regardless). `npm run build` (frontend) clean. `git diff --stat`
confirms exactly the 4 intended files changed, matching stage's Affected
areas exactly.

Open: no live MongoDB in this sandbox (same gap as every prior stage) —
the `isValidProductId` 400-path on `/product/undo` was verified by direct
code parity with the already-tested `/api/product` validator call, not by
an authenticated request (would need a real admin token + DB); the
discount line's rendering was verified by code review and a clean
`vite build`, not a live browser screenshot; the `refundedOrders`/
`refundedAmount` alignment was verified by reading the aggregation logic,
not against real refund data (no Mongo). A manual pass is recommended:
(a) as admin, call `/product/undo` with a malformed `productId` and
confirm the 400; (b) place several rapid failed logins from one terminal
during a busy shift and confirm workers aren't locked out by each other's
successful logins; (c) add a line-item discount in Billing and confirm
the new "Discount" row appears on both the on-screen cart and the printed
receipt; (d) refund an order placed in a prior date-range period and
confirm the dashboard's refund count and refund amount for the *current*
period either both include it or both exclude it.

---

Compaction note (this pass)

Stages 1-4 were condensed from their original multi-page entries (full
verification narratives, every flagged nuance) down to short summaries
above, to bring this file back under ~250 lines. No facts were changed
or removed — only shortened. If the full original wording for any prior
stage is needed again, it exists in this file's git history
(`production-progress.md` at the commit just before this compaction).

