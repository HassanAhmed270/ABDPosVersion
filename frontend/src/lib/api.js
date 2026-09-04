// Thin fetch wrapper. In dev, Vite proxies these paths to the Express
// backend (main.js) on http://localhost:3000 — see vite.config.js.
// In production, serve the built frontend behind the same host as the
// backend (or set VITE_API_BASE) so these relative paths still resolve.
import { markOffline, markOnline } from './networkStatus';

const BASE = import.meta.env.VITE_API_BASE || '';
const TOKEN_KEY = 'pos.token';

// Token storage lives here (not AuthContext) so api.js has no import cycle
// with the context and can attach the header to every request itself.
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (token) => localStorage.setItem(TOKEN_KEY, token),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function request(path, options = {}) {
  const token = tokenStore.get();
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
      ...options,
    });
  } catch (err) {
    // Stage 17 — a raw fetch() failure (backend unreachable) means we
    // never got a Response at all. Mutate the message on the same
    // TypeError object rather than throwing a new Error — lib/offlineSync.js's
    // isNetworkError() checks `err instanceof TypeError`, and Billing's
    // offline-queue fallback depends on that check still matching.
    markOffline();
    if (err instanceof TypeError) {
      err.message = "Can't reach the server — check your connection.";
    }
    throw err;
  }
  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');

  if (!res.ok && !isJson) {
    // Stage 17 correction — a non-JSON error response isn't a genuine app
    // error (every real route response, success or failure, goes through
    // asyncHandler/AppError and is always JSON). It's an infra-level
    // gateway failure instead: in dev, Vite's own proxy answers with a
    // resolved 502/503/504 (not a thrown fetch() error) the moment the
    // backend process isn't listening, so the raw-fetch-throw branch
    // above never sees it and the offline-queue fallback never engaged.
    // Treat it exactly the same way: mark offline and throw a genuine
    // TypeError so isNetworkError() (`err instanceof TypeError`) matches.
    markOffline();
    throw new TypeError("Can't reach the server — check your connection.");
  }
  markOnline();

  if (res.status === 401) {
    // Token missing/expired/invalid — clear it and let any listener (the
    // AuthContext) know so the app can drop back to the login screen.
    tokenStore.clear();
    window.dispatchEvent(new CustomEvent('auth:unauthorized'));
  }

  const body = isJson ? await res.json() : await res.text();

  if (!res.ok && typeof body === 'object' && body?.message) {
    throw new Error(body.message);
  }
  return body;
}

export const api = {
  // Auth
  login: (username, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  // Stage 12: silent re-auth — call while a session is still valid to get
  // a fresh token before the current one expires. See AuthContext.jsx for
  // the interval that drives this.
  refresh: () => request('/auth/refresh', { method: 'POST' }),

  // Products
  getProducts: (params = {}) => request(`/api/products?${new URLSearchParams(params)}`),
  // Stage 15 — admin-only, unpaginated: every product at-or-below its
  // lowStockThreshold, for the header notification bell.
  getLowStockProducts: () => request('/api/products/low-stock'),
  saveProduct: (payload) => request('/api/product', { method: 'POST', body: JSON.stringify(payload) }),
  undoProduct: (payload) => request('/product/undo', { method: 'POST', body: JSON.stringify(payload) }),
  deleteProduct: (productId, payload) => request(`/product/${encodeURIComponent(productId)}`, { method: 'DELETE', body: JSON.stringify(payload) }),
  // Stage 9 (final.md) — dedicated restock/write-off actions, replacing
  // Update Product's old stock field.
  addStock: (productId, payload) => request(`/api/product/${encodeURIComponent(productId)}/add-stock`, { method: 'POST', body: JSON.stringify(payload) }),
  getProductBatches: (productId) => request(`/api/product/${encodeURIComponent(productId)}/batches`),
  deductStock: (productId, payload) => request(`/api/product/${encodeURIComponent(productId)}/deduct-stock`, { method: 'POST', body: JSON.stringify(payload) }),
  reserveStock: (productId, quantity) => request('/billing/reserve', { method: 'POST', body: JSON.stringify({ productId, quantity }) }),
  releaseStock: (productId, quantity) => request('/billing/release', { method: 'POST', body: JSON.stringify({ productId, quantity }) }),

  // Customers
  getCustomers: (params = {}) => request(`/api/customers?${new URLSearchParams(params)}`),
  addCustomer: (payload) => request('/billing/addCustomer', { method: 'POST', body: JSON.stringify(payload) }),
  updateCustomer: (payload) => request('/customer/updateCustomer', { method: 'POST', body: JSON.stringify(payload) }),
  // History of PINV-#### balance-payment receipts for one customer —
  // powers the "Payment History" list + reprint on the Customers page.
  getPaymentInvoices: (customerName) => request(`/customer/paymentInvoices?${new URLSearchParams({ customerName })}`),
  deleteCustomer: (customerName) => request('/customer/deleteCustomer', { method: 'POST', body: JSON.stringify({ customerName }) }),
  undoCustomer: (payload) => request('/customer/undoCustomer', { method: 'POST', body: JSON.stringify(payload) }),

  // Billing / orders
  getUniqueOrderId: (billId) => request('/billing/orderid', { method: 'POST', body: JSON.stringify({ billId }) }),
  // Allocates the next sequential "INV-0001", "INV-0002", ... invoice
  // number (server-side, atomic — see lib/orderId.js). Called once per
  // bill, from handlePreview.
  nextInvoiceId: () => request('/billing/nextInvoiceId', { method: 'POST' }),
  // NOTE: no payload — the server commits from the cashier's persisted
  // draft (POST /billing/draft), not from anything sent here. See
  // CLAUDE.md Stage 4.
  saveOrder: () => request('/billing/orderDetails', { method: 'POST' }),
  getDraft: () => request('/billing/draft'),
  saveDraft: (payload) => request('/billing/draft', { method: 'POST', body: JSON.stringify(payload) }),
  discardDraft: () => request('/billing/draft', { method: 'DELETE' }),

  // Offline sync (Stage 11) — optional module, see lib/offlineQueue.js /
  // lib/offlineSync.js for the client-side queue this talks to.
  syncOfflineSale: (payload) => request('/api/sync/commit', { method: 'POST', body: JSON.stringify(payload) }),
  getSyncConflicts: () => request('/api/sync/conflicts'),
  resolveSyncConflict: (id, action, reason) =>
    request(`/api/sync/conflicts/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action, reason }),
    }),

  // Dashboard
  getDashboard: (range = 'month') => request(`/dashboard/load?range=${encodeURIComponent(range)}`),

  // Exports (Stage 10) — these return CSV, not JSON, so they bypass the
  // shared `request()` helper (which assumes JSON/text-parsed bodies) anda
  // are triggered as a real browser download instead.
  downloadExport: async (type, range, format = 'csv') => {
    const params = new URLSearchParams();
    if (range) params.set('range', range);
    if (format === 'pdf') params.set('format', 'pdf');
    const query = params.toString() ? `?${params.toString()}` : '';
    const token = tokenStore.get();
    let res;
    try {
      res = await fetch(`${BASE}/api/export/${type}${query}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (err) {
      markOffline();
      if (err instanceof TypeError) {
        err.message = "Can't reach the server — check your connection.";
      }
      throw err;
    }
    markOnline();
    if (res.status === 401) {
      tokenStore.clear();
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    }
    if (!res.ok) {
      const contentType = res.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');
      if (!isJson) {
        // Stage 17 correction — same gateway-failure case as request():
        // a non-JSON error here means Vite's dev proxy (or an equivalent
        // reverse proxy) answered on the backend's behalf, not the app.
        // Re-mark offline even though markOnline() ran above — reaching
        // Vite isn't the same as reaching the real backend.
        markOffline();
        throw new TypeError("Can't reach the server — check your connection.");
      }
      const body = await res.json();
      throw new Error(body?.message || 'Export failed.');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `${type}.${format === 'pdf' ? 'pdf' : 'csv'}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Suppliers (Stage 5)
  getSuppliers: (params = {}) => request(`/api/suppliers?${new URLSearchParams(params)}`),
  saveSupplier: (payload) => request('/api/supplier', { method: 'POST', body: JSON.stringify(payload) }),
  deleteSupplier: (supplierName) => request(`/supplier/${encodeURIComponent(supplierName)}`, { method: 'DELETE' }),
  recordPurchase: (payload) => request('/supplier/purchase', { method: 'POST', body: JSON.stringify(payload) }),

  // Audit Log (Stage 14, admin-only — backend also enforces this via requireAdmin)
  getAuditLog: (params = {}) => request(`/api/audit-log?${new URLSearchParams(params)}`),

  // Users (Stage 6, admin-only except changeOwnPassword)
  getUsers: () => request('/api/users'),
  createUser: (payload) => request('/api/users', { method: 'POST', body: JSON.stringify(payload) }),
  deleteUser: (username) => request(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  resetUserPassword: (username, password) =>
    request(`/api/users/${encodeURIComponent(username)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  changeOwnPassword: (currentPassword, newPassword) =>
    request('/api/users/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),

  // Orders, admin edit & refund (Stage 7)
  getOrders: (params = {}) => request(`/api/orders?${new URLSearchParams(params)}`),
  getOrder: (orderID) => request(`/api/orders/${encodeURIComponent(orderID)}`),
 editOrderItem: (orderID, payload) =>
  request(`/api/order/${encodeURIComponent(orderID)}/edit`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  convertWalkInOrder: (orderID, customerName) =>
    request(`/api/order/${encodeURIComponent(orderID)}/convert-customer`, {
      method: 'POST',
      body: JSON.stringify({ customerName }),
    }),
  createCustomer: (payload) => request('/customer/create', { method: 'POST', body: JSON.stringify(payload) }),
  refundOrder: (orderID, payload) =>
    request(`/api/order/${encodeURIComponent(orderID)}/refund`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};