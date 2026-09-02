// Stage 11 — the client-side half of the offline sync module. A thin,
// dependency-free wrapper around the browser's own IndexedDB (no library
// pulled in, same "modular means no extra baggage" spirit as Stage 10's
// CSV writer) — this is what makes a queued sale durable across a tab
// close, browser crash, or device restart, which is the whole point of
// "offline" meaning "no data loss" rather than just "works while
// disconnected".
//
// Each queue entry mirrors what POST /api/sync/commit expects (see
// routes/sync.js) plus local-only bookkeeping (`status`, `queuedAt`,
// `lastError`). Nothing in here talks to the network — see
// offlineSync.js for the connectivity watcher and flush loop that reads
// from this queue.

const DB_NAME = 'pos-offline-queue';
const DB_VERSION = 2;
const STORE = 'sales';
// Stage 12 — a separate store for the cart *while it's being built*, not
// yet a finished sale. Kept apart from `sales` so it's never touched by
// the pending → synced/conflict sync machinery. Single-shop/single-cart
// app, so one fixed record (`DRAFT_KEY`) is enough — no idempotencyKey
// exists yet at this point, unlike a queued sale.
const DRAFT_STORE = 'drafts';
const DRAFT_KEY = 'current';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'idempotencyKey' });
        store.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        db.createObjectStore(DRAFT_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    Promise.resolve(fn(store))
      .then((r) => {
        result = r;
      })
      .catch(reject);
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Queue one offline sale. `sale` should already have every field
// POST /api/sync/commit needs (idempotencyKey, customerName, items,
// paidInput, paymentMethod, clientBillID, createdOfflineAt) — this just
// adds local bookkeeping and persists it.
export async function enqueueSale(sale) {
  const record = {
    ...sale,
    status: 'pending', // pending | synced | conflict
    queuedAt: new Date().toISOString(),
    lastError: null,
    resultingOrderID: null,
  };
  await withStore(STORE, 'readwrite', (store) => requestToPromise(store.add(record)));
  return record;
}

export async function listQueue() {
  return withStore(STORE, 'readonly', (store) => requestToPromise(store.getAll()));
}

export async function updateSale(idempotencyKey, patch) {
  return withStore(STORE, 'readwrite', async (store) => {
    const existing = await requestToPromise(store.get(idempotencyKey));
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    await requestToPromise(store.put(updated));
    return updated;
  });
}

// Only ever called on sales already marked 'synced' — a queue entry is
// evidence of an offline sale and stays around (as history) even after
// a successful sync, until explicitly cleared. Never deletes 'pending' or
// 'conflict' entries, so a sale can't silently disappear before it's
// actually accounted for server-side.
export async function clearSynced() {
  return withStore(STORE, 'readwrite', async (store) => {
    const all = await requestToPromise(store.getAll());
    await Promise.all(
      all.filter((s) => s.status === 'synced').map((s) => requestToPromise(store.delete(s.idempotencyKey)))
    );
  });
}

export function isOfflineSyncEnabled() {
  return import.meta.env.VITE_ENABLE_OFFLINE_SYNC === 'true';
}

// Stage 12 — draft (in-progress, unfinished cart) persistence. Separate
// from enqueueSale/the `sales` store above: a draft isn't a sale yet, so
// it shouldn't be touched by the pending/synced/conflict sync loop, and
// it's meaningful even when offline sync itself is disabled (a reload
// losing the cart is a bug regardless of VITE_ENABLE_OFFLINE_SYNC).
export async function saveLocalDraft(draft) {
  const record = { id: DRAFT_KEY, ...draft, savedAt: new Date().toISOString() };
  await withStore(DRAFT_STORE, 'readwrite', (store) => requestToPromise(store.put(record)));
  return record;
}

export async function getLocalDraft() {
  return withStore(DRAFT_STORE, 'readonly', (store) => requestToPromise(store.get(DRAFT_KEY)));
}

export async function clearLocalDraft() {
  return withStore(DRAFT_STORE, 'readwrite', (store) => requestToPromise(store.delete(DRAFT_KEY)));
}
