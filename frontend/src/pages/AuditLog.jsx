import { Fragment, useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import SortableHeader from '../components/SortableHeader';
import Pagination from '../components/Pagination';
import { api } from '../lib/api';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { flattenObject, lastSegment } from '../lib/flattenObject';
import { formatMoney } from '../lib/money';

const MONEY_KEY_RE = /price|amount|balance|paid|due|cost|credit/i;
const DATE_KEY_RE = /date|At$/i;
const HIDDEN_KEY_RE = /^(?:_id|__v|createdAt|updatedAt|deletedAt|batchId)$/i;

function formatFieldValue(key, value) {
  // A money-ish field explicitly set to null (e.g. a cleared selling
  // price) is meaningfully different from the field simply not existing
  // on one side of the diff — surface it instead of treating it as
  // "nothing to show", or a cleared price silently vanishes from the
  // audit trail instead of being recorded as its own event.
  if (value === null && MONEY_KEY_RE.test(key)) return 'Not set';
  if (value === undefined || value === null || value === '') return '';
  if (MONEY_KEY_RE.test(key) && typeof value === 'number') return formatMoney(value);
  if (DATE_KEY_RE.test(key) && !isNaN(Date.parse(value))) return new Date(value).toLocaleString();
  if (typeof value === 'object') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function hiddenPath(path) {
  return path.split('.').some(part =>
    HIDDEN_KEY_RE.test(part.replace(/\[\d+\]/g, ''))
  );
}

function labelFor(path) {
  const key = lastSegment(path)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\bId\b/gi, 'ID');
  return key.charAt(0).toUpperCase() + key.slice(1);
}

function diffRows(before, after, action) {
  const all = new Map();
  for (const r of flattenObject(before || {})) all.set(r.path, { ...r, after: undefined });
  for (const r of flattenObject(after || {})) {
    const old = all.get(r.path);
    all.set(r.path, old ? { ...old, after: r.value } : { path: r.path, before: undefined, after: r.value });
  }

  const edit = /\.(edited|updated)$/.test(action || '');
  return [...all.values()]
    .filter(r => !hiddenPath(r.path))
    .filter(r => formatFieldValue(lastSegment(r.path), r.before) || formatFieldValue(lastSegment(r.path), r.after))
    .filter(r => !edit || formatFieldValue(lastSegment(r.path), r.before) !== formatFieldValue(lastSegment(r.path), r.after))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function value(rows, key) {
  const row = rows.find(r => lastSegment(r.path).toLowerCase() === key.toLowerCase());
  if (!row) return '';
  const before = formatFieldValue(key, row.before);
  const after = formatFieldValue(key, row.after);
  return before && after && before !== after ? `${before} → ${after}` : after || before;
}

function compactDetails(before, after, action) {
  const rows = diffRows(before, after, action);
  const used = new Set();
  const sections = [];

  // Combine payment-related fields into one readable line.
  const payments = rows.filter(r =>
    /^payments\[\d+\]/.test(r.path) ||
    ['amountPaid', 'balanceDue', 'creditApplied', 'paymentMethod', 'paymentStatus'].includes(lastSegment(r.path))
  );
  if (payments.length) {
    const parts = [];
    const paid = value(payments, 'amountPaid');
    const due = value(payments, 'balanceDue');
    const credit = value(payments, 'creditApplied');
    const method = value(payments, 'paymentMethod') || value(payments, 'method');
    const status = value(payments, 'paymentStatus');
    if (paid) parts.push(`Paid ${paid}`);
    if (due) parts.push(`Due ${due}`);
    if (credit) parts.push(`Credit ${credit}`);
    if (method) parts.push(method);
    if (status) parts.push(status);
    if (parts.length) sections.push({ label: 'Payment', text: parts.join(' · ') });
    payments.forEach(r => used.add(r.path));
  }

  // Collapse edit/exchange history into one business event.
  const history = rows.filter(r => r.path.startsWith('editHistory['));
  if (history.length) {
    const parts = [];
    const product = value(history, 'productID');
    const oldQty = value(history, 'originalQty');
    const newQty = value(history, 'newQty');
    const credit = value(history, 'creditAmount');
    const settlement = value(history, 'settlement');
    const reason = value(history, 'reason');
    if (product) parts.push(`Product ${product}`);
    if (oldQty || newQty) parts.push(`Qty ${oldQty && newQty ? `${oldQty} → ${newQty}` : newQty || oldQty}`);
    if (credit) parts.push(`Credit ${credit}`);
    if (settlement) parts.push(settlement);
    if (reason) parts.push(`Reason: ${reason}`);
    if (parts.length) sections.push({ label: 'Adjustment', text: parts.join(' · ') });
    history.forEach(r => used.add(r.path));
  }

  // Collapse each product's useful business fields into one line.
  const productIndexes = [...new Set(rows.map(r => r.path.match(/^products\[(\d+)\]/)?.[1]).filter(Boolean))];
  productIndexes.forEach(index => {
    const productRows = rows.filter(r => r.path.startsWith(`products[${index}]`));
    const parts = [];
    const name = value(productRows, 'name') || value(productRows, 'productName') || value(productRows, 'productID');
    const qty = value(productRows, 'quantity') || value(productRows, 'qty');
    const price = value(productRows, 'sellingPrice') || value(productRows, 'salePrice') || value(productRows, 'price');
    const amount = value(productRows, 'amount');
    if (name) parts.push(name);
    if (qty) parts.push(`Qty ${qty}`);
    if (price) parts.push(`Price ${price}`);
    if (amount) parts.push(`Amount ${amount}`);
    if (parts.length) sections.push({ label: `Product ${Number(index) + 1}`, text: parts.join(' · ') });
    productRows.forEach(r => used.add(r.path));
  });

  // Keep remaining meaningful fields, but combine them into one compact Details section.
  const remaining = rows.filter(r => !used.has(r.path));
  const details = remaining.map(r => {
    const key = lastSegment(r.path);
    const v = value(remaining, key);
    return v ? `${labelFor(r.path)}: ${v}` : '';
  }).filter(Boolean);

  if (details.length) sections.push({ label: 'Details', text: details.join(' · ') });
  return sections;
}

const PAGE_SIZE = 20;

const ACTION_LABELS = {
  'order.created': 'Order created',
  'order.edited': 'Order edited',
  'order.refunded': 'Order refunded',
  'product.created': 'Product created',
  'product.updated': 'Product updated',
  'product.deleted': 'Product deleted',
  'product.restored': 'Product restored',
  'customer.updated': 'Customer updated',
  'customer.deleted': 'Customer deleted',
  'customer.restored': 'Customer restored',
  'supplier.created': 'Supplier created',
  'supplier.updated': 'Supplier updated',
  'supplier.deleted': 'Supplier deleted',
  'supplier.purchase': 'Supplier purchase recorded',
  'supplier.payment.adjusted': 'Supplier payment adjusted',
  'user.created': 'Worker added',
  'user.deleted': 'Worker removed',
  'user.password_reset': 'Worker password reset',
  'user.password_changed': 'Password changed',
};

const ACTION_BADGE = {
  'order.created': 'bg-green-100 text-green-700',
  'order.edited': 'bg-yellow-100 text-yellow-700',
  'order.refunded': 'bg-red-100 text-red-700',
  'product.created': 'bg-blue-100 text-blue-700',
  'product.updated': 'bg-blue-100 text-blue-700',
  'product.deleted': 'bg-red-100 text-red-700',
  'product.restored': 'bg-green-100 text-green-700',
  'customer.updated': 'bg-purple-100 text-purple-700',
  'customer.deleted': 'bg-red-100 text-red-700',
  'customer.restored': 'bg-green-100 text-green-700',
  'supplier.created': 'bg-teal-100 text-teal-700',
  'supplier.updated': 'bg-teal-100 text-teal-700',
  'supplier.deleted': 'bg-red-100 text-red-700',
  'supplier.purchase': 'bg-teal-100 text-teal-700',
  'supplier.payment.adjusted': 'bg-teal-100 text-teal-700',
  'user.created': 'bg-indigo-100 text-indigo-700',
  'user.deleted': 'bg-red-100 text-red-700',
  'user.password_reset': 'bg-indigo-100 text-indigo-700',
  'user.password_changed': 'bg-indigo-100 text-indigo-700',
};

export default function AuditLog() {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [actionFilter, setActionFilter] = useState('');
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);

  const [expandedId, setExpandedId] = useState(null);

  const loadEntries = async () => {
    setLoading(true);
    try {
      const data = await api.getAuditLog({
        search: debouncedSearch,
        action: actionFilter,
        sortBy,
        sortDir,
        page,
        limit: PAGE_SIZE,
      });
      setEntries(data.entries || []);
      setTotal(data.total || 0);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEntries();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, actionFilter, sortBy, sortDir, page]);

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortDir('desc');
    }
    setPage(1);
  };

  return (
    <div className="flex h-screen bg-gray-100">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Topbar title="Audit Log" />
        <main className="flex-1 overflow-y-auto p-4 @min-[768px]:p-6">
          <p className="text-sm text-gray-500 mb-4">
            A durable, read-only record of every order, product, customer, and supplier
            change — who did it and when. Kept to the most recent {' '}
            <span className="font-medium">entries only</span>; older entries are dropped
            automatically as new ones come in.
          </p>

          <div className="flex flex-wrap gap-3 mb-4">
            <input
              type="text"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by user, action, or ID…"
              className="border rounded px-3 py-2 flex-1 min-w-[220px]"
            />
            <select
              value={actionFilter}
              onChange={(e) => { setActionFilter(e.target.value); setPage(1); }}
              className="border rounded px-3 py-2"
            >
              <option value="">All actions</option>
              {Object.entries(ACTION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {error && <p className="text-red-600 mb-3">{error}</p>}

          <div className="bg-white rounded shadow overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead className="bg-gray-100 text-gray-600 uppercase text-xs">
                <tr>
                  <SortableHeader label="When" field="date" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="py-3 px-2 text-left">Action</th>
                  <th className="py-3 px-2 text-left">By</th>
                  <th className="py-3 px-2 text-left">Target</th>
                  <th className="py-3 px-2 text-left"></th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className="py-6 text-center text-gray-400">Loading…</td></tr>
                ) : entries.length === 0 ? (
                  <tr><td colSpan={5} className="py-6 text-center text-gray-400">No audit entries found.</td></tr>
                ) : (
                  entries.map((entry) => (
                    <Fragment key={entry._id}>
                      <tr
                        className="border-t hover:bg-gray-50 cursor-pointer"
                        onClick={() => setExpandedId(expandedId === entry._id ? null : entry._id)}
                      >
                        <td className="py-2 px-2 whitespace-nowrap">{new Date(entry.date).toLocaleString()}</td>
                        <td className="py-2 px-2">
                          <span className={`px-2 py-1 rounded text-xs font-medium ${ACTION_BADGE[entry.action] || 'bg-gray-100 text-gray-700'}`}>
                            {ACTION_LABELS[entry.action] || entry.action}
                          </span>
                        </td>
                        <td className="py-2 px-2">{entry.actor?.username} <span className="text-gray-400">({entry.actor?.role})</span></td>
                        <td className="py-2 px-2">{entry.targetType}: {entry.targetId}</td>
                        <td className="py-2 px-2 text-brand text-xs">{expandedId === entry._id ? 'Hide details ▲' : 'View details ▼'}</td>
                      </tr>
                      {expandedId === entry._id && (
                        <tr className="border-t bg-gray-50">
                          <td colSpan={5} className="p-4">
                            <div className="bg-white border rounded overflow-hidden">
                              {compactDetails(entry.before, entry.after, entry.action).map((section) => (
                                <div key={section.label} className="px-3 py-2 border-b last:border-b-0">
                                  <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                                    {section.label}
                                  </div>
                                  <div className="text-sm text-gray-800 mt-0.5">{section.text}</div>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
            <Pagination page={page} limit={PAGE_SIZE} total={total} onPageChange={setPage} />
          </div>
        </main>
      </div>
    </div>
  );
}