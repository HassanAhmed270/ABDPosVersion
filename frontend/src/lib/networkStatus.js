// Stage 17 — app-wide "can we reach the backend" signal, distinct from
// navigator.onLine (which stays true when only the API server, not the
// network adapter, goes down). Set by lib/api.js's request() on every
// call: markOffline() on a raw fetch() failure, markOnline() on any
// response reaching the server at all, even a non-2xx one.
let offline = false;
const listeners = new Set();

export function markOffline() {
  if (offline) return;
  offline = true;
  listeners.forEach((fn) => fn(true));
}

export function markOnline() {
  if (!offline) return;
  offline = false;
  listeners.forEach((fn) => fn(false));
}

export function subscribeNetworkStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isOffline() {
  return offline;
}
