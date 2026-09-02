import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

// Stage 15 — Low-Stock Notifications. Admin-only bell in the header:
// checked on mount and on an interval (see POLL_INTERVAL_MS below), so an
// admin sees the count update whether they just logged in or have been on
// the app for a while when stock crosses the threshold. Clicking it lists
// the affected products, reusing the same red/⚠-low treatment Products.jsx
// already uses for the equivalent row highlight.
const POLL_INTERVAL_MS = 60 * 1000;

export default function LowStockBell() {
  const [products, setProducts] = useState([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const data = await api.getLowStockProducts();
        if (!cancelled && data.success) {
          setProducts(data.products);
          setError('');
        }
      } catch {
        // Silent on interval ticks (transient network hiccup shouldn't spam
        // the header); the bell just keeps showing its last-known count.
        if (!cancelled) setError('Could not check stock levels.');
      }
    };

    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const count = products.length;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative h-9 w-9 flex items-center justify-center rounded-full hover:bg-brand/10 text-brand"
        aria-label={count > 0 ? `${count} products low on stock` : 'Stock levels normal'}
        title="Low-stock alerts"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0 1 18 14.2V11a6 6 0 1 0-12 0v3.2a2 2 0 0 1-.6 1.4L4 17h5m6 0v1a3 3 0 1 1-6 0v-1m6 0H9" />
        </svg>
        {count > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[11px] leading-[18px] font-semibold text-center">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-white rounded-lg shadow-lg border z-50">
          <div className="px-4 py-2 border-b font-semibold text-sm text-gray-700">
            {count > 0 ? `${count} product${count === 1 ? '' : 's'} low on stock` : 'Stock levels normal'}
          </div>
          {error && <div className="px-4 py-2 text-xs text-red-600">{error}</div>}
          {count === 0 ? (
            <div className="px-4 py-3 text-sm text-gray-500">Nothing at or below threshold right now.</div>
          ) : (
            <ul>
              {products.map((p) => (
                <li key={p.productID} className="px-4 py-2 border-b last:border-b-0 bg-red-50">
                  <div className="flex justify-between items-baseline">
                    <span className="font-medium text-gray-800">{p.productName}</span>
                    <span className="text-xs text-gray-500">{p.productID}</span>
                  </div>
                  <div className="text-sm text-red-700 font-semibold">
                    {p.available} available <span className="font-normal text-gray-500">/ threshold {p.lowStockThreshold}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <Link
            to="/products"
            onClick={() => setOpen(false)}
            className="block text-center text-sm text-brand hover:bg-gray-50 py-2 border-t"
          >
            Go to Products
          </Link>
        </div>
      )}
    </div>
  );
}
