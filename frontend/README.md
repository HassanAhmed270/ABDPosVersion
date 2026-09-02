# Billing System — Frontend (React + Vite + Tailwind)

This is the React frontend for the POS billing system — the only UI the
app has. The Express + MongoDB backend (`../main.js`) owns all data and
never renders HTML itself; this app talks to it over JSON only, and in
production `../main.js` serves this app's build output directly (see
`../CLAUDE.md` → "How a request is served").

Tailwind is installed as a package (`@tailwindcss/vite`), **not** loaded
from a CDN — see `src/index.css` (`@import "tailwindcss"`) and
`vite.config.js`.

## Structure

```
frontend/
  src/
    pages/        One file per screen: Login, Dashboard, Billing, Products,
                   Customers, Suppliers, Orders, Reports
    components/   Shared UI: Sidebar, Topbar, ProtectedRoute
    lib/
      api.js            Single place every backend call goes through
      AuthContext.jsx   Client-side session (JWT + user, both in localStorage) —
                         see useAuth()'s isAdmin
      offlineQueue.js   Stage 11 — IndexedDB durable write queue (optional)
      offlineSync.js    Stage 11 — connectivity watcher / auto-flush (optional)
    index.css      Tailwind entry + theme tokens (brand colors)
    App.jsx         Routes
    main.jsx        React entry point
  vite.config.js    Dev proxy -> backend on :3000, Tailwind plugin
```

## Running it

You need the backend running first (from the repo root):

```bash
npm install
cp .env.example .env   # set JWT_SECRET at minimum
npm start               # starts Express + Mongo on :3000
```

Then, in this folder, for **development**:

```bash
npm install
npm run dev              # Vite dev server on :5173, proxies API calls to :3000
```

For **production** (single server, `main.js` serves this build):

```bash
npm run build            # outputs to frontend/dist
# then run `npm start` from the repo root as usual — main.js serves
# frontend/dist automatically once it exists (no extra config)
```

Stage 11's offline sync module additionally needs `VITE_ENABLE_OFFLINE_SYNC=true`
in a `frontend/.env` file (build-time), matching the backend's
`ENABLE_OFFLINE_SYNC=true` — both must agree or the feature stays off on
one side.

## Where data comes from

Every read/write goes through `src/lib/api.js`. It talks to the same JSON
API described in `../CLAUDE.md` — `/api/*`, `/billing/*`, `/customer/*`,
`/product/*`, `/supplier/*`, `/dashboard/load`, plus the optional
`/api/export/*` and `/api/sync/*` modules. If you add a call under a new
path prefix, also add that prefix to `vite.config.js`'s dev proxy list.

