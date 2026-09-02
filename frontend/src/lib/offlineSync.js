// Stage 11 — watches connectivity and drains offlineQueue.js whenever the
// server is reachable. Mounted once, app-wide (see App.jsx), so a sale
// queued on the Billing page still syncs even if the cashier has since
// navigated elsewhere — the point of a background flush, not a
// page-local one.
import { api } from './api';
import { listQueue, updateSale, isOfflineSyncEnabled } from './offlineQueue';

const FLUSH_INTERVAL_MS = 15000;
// Stage 13 — wait this long after an 'online' event before flushing, so a
// still-flapping connection doesn't get synced into mid-reconnect.
const RECONNECT_DELAY_MS = 60000;
const VERIFY_RETRIES = 3;
const VERIFY_BACKOFF_MS = 500;

// A failed fetch (offline, DNS, server down) throws a TypeError from the
// browser's fetch implementation with no HTTP status attached — that's
// how we tell "couldn't reach the server, try again later" apart from
// "reached the server, it said no" (400/401/409), which resolves the
// queue entry one way or the other instead of retrying forever.
function isNetworkError(err) {
  return err instanceof TypeError || err?.message === 'Failed to fetch';
}
export { isNetworkError };

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stage 13 — one independent existence check before trusting a "synced"
// result. Returns 'ok' (order confirmed), 'not-found' (server said synced
// but the order genuinely isn't there — a real problem, flag it), or
// 'unverified' (network/timeout on every attempt — leave the sale pending
// so the next flush retries the whole commit+verify cycle; syncOfflineSale
// is idempotent, so re-sending it is safe).
async function verifyOrderExists(orderID) {
  for (let attempt = 1; attempt <= VERIFY_RETRIES; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await api.getOrder(orderID);
      return 'ok';
    } catch (err) {
      if (!isNetworkError(err)) return 'not-found';
      if (attempt < VERIFY_RETRIES) {
        // eslint-disable-next-line no-await-in-loop
        await wait(VERIFY_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  }
  return 'unverified';
}

async function flushOne(sale) {
  try {
    const result = await api.syncOfflineSale(sale);
    // A 200 here only ever means the server actually synced it (or it
    // was already synced by an earlier attempt) — see routes/sync.js.
    if (result.status === 'synced') {
      const verification = await verifyOrderExists(result.orderID);
      if (verification === 'ok') {
        await updateSale(sale.idempotencyKey, { status: 'synced', resultingOrderID: result.orderID, lastError: null });
      } else if (verification === 'not-found') {
        await updateSale(sale.idempotencyKey, {
          status: 'conflict',
          lastError: `Server reported ${result.orderID} as synced, but the order could not be found.`,
        });
      }
      // 'unverified' — leave the entry pending, next flush retries.
    } else {
      await updateSale(sale.idempotencyKey, { status: 'conflict', lastError: result.message || 'Sync conflict.' });
    }
  } catch (err) {
    // request() (lib/api.js) throws on any non-2xx response, so a 409
    // conflict/already-flagged reply from the server lands here, not in
    // the try block above.
    if (isNetworkError(err)) {
      // Still offline (or the server's unreachable) — leave it pending,
      // the next tick or the next 'online' event will retry.
      return;
    }
    // A genuine server-side rejection reached us (bad request shape,
    // auth issue, stock/price conflict, etc.) — record it as a conflict
    // rather than retrying an attempt that won't succeed unattended.
    await updateSale(sale.idempotencyKey, { status: 'conflict', lastError: err.message || 'Sync failed.' });
  }
}

export async function flushQueue() {
  if (!isOfflineSyncEnabled()) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const queue = await listQueue();
  const pending = queue.filter((s) => s.status === 'pending');
  // Sequential, not Promise.all — sales replay in the order they were
  // made offline, and it keeps this gentle on the server instead of
  // firing a burst of concurrent commits after a long offline stretch.
  for (const sale of pending) {
    // eslint-disable-next-line no-await-in-loop
    await flushOne(sale);
  }
}

// Stage 13 — a blocking overlay (SyncOverlay.jsx) subscribes to this so it
// only shows during an *automatic* background flush, not the manual
// "Sync Now" button on Reports.jsx (which already has its own "Syncing…"
// button state and calls flushQueue() directly, bypassing this flag).
let autoSyncing = false;
const autoSyncListeners = new Set();

function setAutoSyncing(value) {
  if (autoSyncing === value) return;
  autoSyncing = value;
  autoSyncListeners.forEach((fn) => fn(value));
}

export function subscribeAutoSync(fn) {
  autoSyncListeners.add(fn);
  return () => autoSyncListeners.delete(fn);
}

export function isAutoSyncing() {
  return autoSyncing;
}

async function autoFlush() {
  setAutoSyncing(true);
  try {
    await flushQueue();
  } finally {
    setAutoSyncing(false);
  }
}

let started = false;
let reconnectTimer = null;

function scheduleReconnectFlush() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    autoFlush();
  }, RECONNECT_DELAY_MS);
}

// Call once, near the app root. Safe to call multiple times — only the
// first call actually starts the interval/listeners.
export function startOfflineSyncWatcher() {
  if (started || !isOfflineSyncEnabled()) return;
  started = true;

  autoFlush();
  const interval = setInterval(autoFlush, FLUSH_INTERVAL_MS);
  window.addEventListener('online', scheduleReconnectFlush);

  return () => {
    clearInterval(interval);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    window.removeEventListener('online', scheduleReconnectFlush);
    started = false;
  };
}
