# deployment-progress.md

Append-only progress log for the deployment phase (`deployment.md`,
Stage 16+). See `CLAUDE.md` for document authority and conventions.

---

## Stage 16 — Backend cross-origin support — COMPLETE

**Changed:**
- Added `cors` npm package (`package.json`/`package-lock.json`).
- New `lib/cors.js`: builds `corsOptions` from `ALLOWED_ORIGINS` (comma-
  separated env var). Requests with no `Origin` header (same-origin,
  curl, Electron's main process) always pass; an origin not in the list
  is rejected (no CORS headers granted, so a browser blocks it).
- `main.js`: applies `cors(corsOptions)` globally, first in the
  middleware chain, before all routes.
- `.env.example`: documented `ALLOWED_ORIGINS`, defaults to empty
  (same-origin production serving needs nothing set).
- No changes to authentication, authorization, route behavior, or
  business logic. Auth is Bearer-token based (no cookies), so
  `credentials: true` was intentionally not enabled.

**Verified:**
- Backend boots cleanly with a real `.env` (`node main.js`).
- Preflight `OPTIONS` from an allowed origin
  (`Origin: http://localhost:5173`) returns
  `Access-Control-Allow-Origin: http://localhost:5173`.
- Preflight `OPTIONS` from a disallowed origin
  (`Origin: http://evil.example.com`) gets no
  `Access-Control-Allow-Origin` header — blocked client-side.
- Requests with no `Origin` header (curl, same-origin) pass through
  untouched and hit normal route validation.
- Confirmed no interference with the existing Vite dev proxy (`frontend/
  vite.config.js`), which keeps local dev same-origin from the browser's
  perspective; `ALLOWED_ORIGINS` is purely additive for Electron/direct
  cross-origin cases.
- Full `npm test`: 66/66 passing.

**Not verified (known limitations):**
- No live MongoDB replica set in the sandbox — boot test confirms route
  mounting, middleware order, and pre-DB auth/validation only, not
  full DB-backed request flows.
- Not tested against an actual Electron renderer origin yet (Stage 17
  will introduce the real Electron shell and its origin/scheme, which
  should be added to `ALLOWED_ORIGINS` at that point).
- No real hosted frontend URL exists yet to test the "future hosted
  client" path end-to-end; only the env-driven mechanism was verified.

**Flagged, not part of this stage (incidental note):**
- A stray `bpiols-stage17.bundle` file exists at the repo root, unrelated
  to Stage 16's affected areas and to this deployment phase's own
  Stage 17. Recommend Hassan remove it or confirm its purpose before the
  next stage, rather than it being silently deleted here.

---

## Stage 17 — Electron desktop application wrapper — COMPLETE

**Changed:**
- New `electron/main.js`: creates a `BrowserWindow` (1024x768 default
  and minimum — above Tailwind's `md`/768px breakpoint), loads
  `frontend/dist-electron/index.html` via `file://`.
- New `electron/preload.js`: intentionally empty; `contextIsolation:
  true`, `nodeIntegration: false`. No Node/IPC surface exposed — the
  renderer uses the existing `fetch()`-based `frontend/src/lib/api.js`
  unchanged, same as the web build.
- `frontend/vite.config.js`: added a `mode === 'electron'` branch
  setting `base: './'` (relative asset paths, required for `file://`)
  and `build.outDir: 'dist-electron'`. The default (no-mode) web build
  is untouched — verified byte-identical behavior (`base: '/'`,
  `outDir: 'dist'`).
- New `frontend/.env.electron`: `VITE_API_BASE=http://localhost:3000`,
  the local backend target for the desktop build.
- `package.json`: added `electron` as a `dependencies` entry (Stage 18
  packaging will need it available the same way); new scripts
  `build-frontend:electron`, `electron`, `electron:build`.
- `.gitignore`: added `frontend/dist/` and `frontend/dist-electron/`
  (build outputs, were already untracked; made explicit).
- `.env.example`/`CLAUDE.md`: documented that Electron's `file://`
  renderer sends a literal `"null"` Origin header on API fetches, so
  `null` must be included in `ALLOWED_ORIGINS` for the desktop build.
  This is a config-only addition — no `lib/cors.js` code change.

**Verified:**
- `npm run build-frontend:electron` succeeds; output confirmed to use
  relative (`./assets/...`) paths, correct for `file://`.
- `npm run build-frontend` (plain web build) still succeeds and still
  produces absolute (`/assets/...`) paths — Electron build does not
  affect the existing production web build.
- Backend boot-tested with a real `.env`; full CORS matrix tested with
  `curl`: `Origin: null` (Electron) passes when added to
  `ALLOWED_ORIGINS`, `http://localhost:5173` (dev) passes, an
  unlisted origin is rejected, and no-`Origin` requests pass through
  unaffected — all matching Stage 16's existing behavior plus the new
  `null` case.
- Full `npm test`: 66/66 passing.
- Electron itself was launched (headless, via `xvfb-run` + `--no-sandbox`,
  required only because this sandbox runs as root — not part of the
  shipped app) against the built `dist-electron` output and the running
  backend. Confirmed via Chrome DevTools Protocol that the window loaded
  `file:///.../frontend/dist-electron/index.html` with the correct
  document title, i.e. the packaged frontend boots correctly under
  Electron.

**Not verified (known limitations):**
- No live MongoDB replica set in the sandbox (standing limitation) — so
  authenticated flows (login, orders, billing, refunds, exchanges)
  could not be exercised end-to-end through the Electron window, only
  through the pre-DB CORS/auth boot checks above.
- Deeper interactive verification inside the Electron window (actually
  clicking through login/billing/printing) was not completed — CDP-based
  scripted interaction in this sandbox was unreliable across several
  attempts (process/job-control issues, not application issues). Only
  the initial page-load/title check succeeded. This should be spot-
  checked on a real Windows/desktop machine, ideally alongside Stage 18.
- Printing (thermal/Web USB and popup fallback) was not tested through
  Electron; Web USB device access was never exercised in this sandbox.
- Electron was not tested with a hosted (non-`localhost`) `VITE_API_BASE`
  — only the local default described in this stage.

---
