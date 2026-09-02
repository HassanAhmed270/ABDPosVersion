import { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { isOfflineSyncEnabled, listQueue, clearSynced } from '../lib/offlineQueue';
import { flushQueue } from '../lib/offlineSync';

const RANGE_LABEL = { week: 'This week', month: 'This month', year: 'This year' };

// Each entry is one downloadable CSV. `type` maps straight to
// /api/export/:type on the backend (routes/export.js) — see progress.md
// Stage 10 for what's in each file.
const EXPORTS = [
  { type: 'summary', label: 'Summary', description: 'One-row snapshot of the headline dashboard numbers.', ranged: true },
  { type: 'sales', label: 'Sales', description: 'Every order placed in the selected range.', ranged: true },
  { type: 'refunds', label: 'Refunds', description: 'Every refund processed in the selected range.', ranged: true },
  { type: 'losses', label: 'Losses', description: 'Every stock write-off (expired/damaged/discontinued) in the selected range.', ranged: true },
  { type: 'credit', label: 'Customer Credit', description: 'Every order with an outstanding balance, as of now.', ranged: false },
  { type: 'payables', label: 'Supplier Payables', description: 'Every purchase with an outstanding balance, as of now.', ranged: false },
];

export default function Reports() {
  const { isAdmin } = useAuth();
  const [range, setRange] = useState('month');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const offlineSyncEnabled = isOfflineSyncEnabled();

  const handleExport = async (type, format) => {
    setError('');
    setPending(`${type}-${format}`);
    try {
      await api.downloadExport(type, EXPORTS.find((e) => e.type === type).ranged ? range : undefined, format);
    } catch (err) {
      setError(err.message || 'Export failed.');
    } finally {
      setPending('');
    }
  };

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <Topbar title="Reports" />
        <main className="p-4 @min-[768px]:p-6 space-y-6 overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-2xl @min-[640px]:text-3xl font-semibold text-brand">Export data</h2>
              <p className="text-gray-600">Download CSV or PDF reports for sales, refunds, losses, credit, and payables.</p>
            </div>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
              {['week', 'month', 'year'].map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`px-3 py-1.5 text-sm rounded-md capitalize ${
                    range === r ? 'bg-brand text-white' : 'text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <div className="grid grid-cols-1 @min-[768px]:grid-cols-2 gap-6">
            {EXPORTS.map((e) => (
              <div key={e.type} className="p-5 bg-white rounded-lg shadow flex flex-col justify-between">
                <div>
                  <h3 className="font-medium text-lg text-brand">{e.label}</h3>
                  <p className="text-sm text-gray-500 mt-1">{e.description}</p>
                  {e.ranged && (
                    <p className="text-xs text-gray-400 mt-2">{RANGE_LABEL[range]}</p>
                  )}
                  {!e.ranged && <p className="text-xs text-gray-400 mt-2">Snapshot, as of now</p>}
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => handleExport(e.type, 'csv')}
                    disabled={pending === `${e.type}-csv`}
                    className="self-start px-4 py-2 bg-brand text-white rounded-md text-sm hover:bg-brand-dark disabled:opacity-60"
                  >
                    {pending === `${e.type}-csv` ? 'Downloading…' : 'Download CSV'}
                  </button>
                  <button
                    onClick={() => handleExport(e.type, 'pdf')}
                    disabled={pending === `${e.type}-pdf`}
                    className="self-start px-4 py-2 border border-brand text-brand rounded-md text-sm hover:bg-brand hover:text-white disabled:opacity-60"
                  >
                    {pending === `${e.type}-pdf` ? 'Downloading…' : 'Download PDF'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Stage 11 — only rendered when the offline sync module is on
              (VITE_ENABLE_OFFLINE_SYNC=true). This is the "export screen
              distinguishes synced vs. pending records" exit criterion:
              OfflineSalesPanel reads this device's own IndexedDB queue,
              SyncConflictsPanel (admins only) reads the server's list of
              sales that couldn't be auto-synced and need a decision. */}
          {offlineSyncEnabled && <OfflineSalesPanel />}
          {offlineSyncEnabled && isAdmin && <SyncConflictsPanel />}
        </main>
      </div>
    </div>
  );
}

const STATUS_STYLE = {
  pending: 'bg-amber-100 text-amber-800',
  synced: 'bg-green-100 text-green-800',
  conflict: 'bg-red-100 text-red-800',
};

function saleTotal(sale) {
  return sale.items.reduce((sum, it) => sum + roundMoney(it.unitPrice * it.quantity * (1 - it.discount / 100)), 0);
}

function roundMoney(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// This device's own offline queue (IndexedDB) — what got captured here
// while offline, and whether it's synced yet. A different cashier's
// device has its own separate queue; this panel only ever shows this
// browser's.
function OfflineSalesPanel() {
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const refresh = async () => {
    const all = await listQueue();
    all.sort((a, b) => new Date(b.queuedAt) - new Date(a.queuedAt));
    setQueue(all);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  const counts = queue.reduce(
    (acc, s) => ({ ...acc, [s.status]: (acc[s.status] || 0) + 1 }),
    { pending: 0, synced: 0, conflict: 0 }
  );

  const handleSyncNow = async () => {
    setSyncing(true);
    await flushQueue();
    await refresh();
    setSyncing(false);
  };

  const handleClearSynced = async () => {
    await clearSynced();
    await refresh();
  };

  return (
    <div className="bg-white rounded-lg shadow p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-medium text-lg text-brand">Offline sales on this device</h3>
          <p className="text-sm text-gray-500">
            {counts.pending} pending · {counts.synced} synced · {counts.conflict} need review
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSyncNow}
            disabled={syncing || counts.pending === 0}
            className="px-3 py-1.5 text-sm bg-brand text-white rounded-md hover:bg-brand-dark disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            onClick={handleClearSynced}
            disabled={counts.synced === 0}
            className="px-3 py-1.5 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:opacity-50"
          >
            Clear synced
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : queue.length === 0 ? (
        <p className="text-sm text-gray-400">No offline sales recorded on this device.</p>
      ) : (
        <div className="divide-y">
          {queue.map((sale) => (
            <div key={sale.idempotencyKey} className="py-2 flex items-center justify-between text-sm">
              <div>
                <span className="font-medium">{sale.customerName}</span>
                <span className="text-gray-400 mx-2">·</span>
                <span>{sale.items.length} item(s)</span>
                <span className="text-gray-400 mx-2">·</span>
                <span>Rs {saleTotal(sale).toFixed(2)}</span>
                <span className="text-gray-400 mx-2">·</span>
                <span className="text-gray-400">{new Date(sale.createdOfflineAt).toLocaleString()}</span>
                {sale.status === 'conflict' && sale.lastError && (
                  <p className="text-xs text-red-600 mt-0.5">{sale.lastError}</p>
                )}
              </div>
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[sale.status]}`}>
                {sale.status}
                {sale.status === 'synced' && sale.resultingOrderID ? ` (${sale.resultingOrderID})` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Server-side conflict queue (admin only) — offline sales that reached
// the server but couldn't be committed automatically (stock ran out,
// price changed, customer/product no longer exists) and need a human
// call: retry (e.g. after restocking) or reject outright.
function SyncConflictsPanel() {
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');

  const refresh = async () => {
    try {
      const data = await api.getSyncConflicts();
      setConflicts(data.conflicts || []);
    } catch (err) {
      setError(err.message || 'Could not load sync conflicts.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleResolve = async (id, action) => {
    setBusyId(id);
    try {
      await api.resolveSyncConflict(id, action);
      await refresh();
    } catch (err) {
      setError(err.message || 'Could not resolve this conflict.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="bg-white rounded-lg shadow p-5 space-y-4">
      <div>
        <h3 className="font-medium text-lg text-brand">Offline sync conflicts</h3>
        <p className="text-sm text-gray-500">
          Offline sales that reached the server but couldn't be auto-committed — usually stock or price changed
          while the device was offline.
        </p>
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}

      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : conflicts.length === 0 ? (
        <p className="text-sm text-gray-400">No conflicts waiting for review.</p>
      ) : (
        <div className="divide-y">
          {conflicts.map((c) => (
            <div key={c._id} className="py-3 flex items-center justify-between text-sm">
              <div>
                <span className="font-medium">{c.customerName}</span>
                <span className="text-gray-400 mx-2">·</span>
                <span>{c.items.length} item(s)</span>
                <span className="text-gray-400 mx-2">·</span>
                <span className="text-gray-400">Cashier: {c.cashier}</span>
                <p className="text-xs text-red-600 mt-0.5">{c.conflictReason}</p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleResolve(c._id, 'retry')}
                  disabled={busyId === c._id}
                  className="px-3 py-1.5 text-xs bg-brand text-white rounded-md hover:bg-brand-dark disabled:opacity-50"
                >
                  Retry
                </button>
                <button
                  onClick={() => handleResolve(c._id, 'reject')}
                  disabled={busyId === c._id}
                  className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
