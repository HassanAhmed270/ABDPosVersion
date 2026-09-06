import { Fragment, useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import SortableHeader from '../components/SortableHeader';
import Pagination from '../components/Pagination';
import { api } from '../lib/api';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { flattenObject, lastSegment } from '../lib/flattenObject';
import { formatMoney } from '../lib/money';

const PAGE_SIZE = 20;

const MONEY_KEY_RE =
  /price|amount|balance|paid|due|cost|credit|total|subtotal|payment/i;

const DATE_KEY_RE = /date|At$/i;
const HIDDEN_KEY_RE = /^(?:_id|__v|createdAt|updatedAt|deletedAt|batchId)$/i;

const ACTIONS = {
  'order.created': ['Order created', 'green'],
  'order.edited': ['Order edited', 'yellow'],
  'order.refunded': ['Order refunded', 'red'],

  'product.created': ['Product created', 'blue'],
  'product.updated': ['Product updated', 'blue'],
  'product.deleted': ['Product deleted', 'red'],
  'product.restored': ['Product restored', 'green'],

  'customer.updated': ['Customer updated', 'purple'],
  'customer.deleted': ['Customer deleted', 'red'],
  'customer.restored': ['Customer restored', 'green'],

  'supplier.created': ['Supplier created', 'teal'],
  'supplier.updated': ['Supplier updated', 'teal'],
  'supplier.deleted': ['Supplier deleted', 'red'],
  'supplier.purchase': ['Supplier purchase recorded', 'teal'],
  'supplier.payment.adjusted': ['Supplier payment adjusted', 'teal'],

  'user.created': ['Worker added', 'indigo'],
  'user.deleted': ['Worker removed', 'red'],
  'user.password_reset': ['Worker password reset', 'indigo'],
  'user.password_changed': ['Password changed', 'indigo'],
};

const BADGES = {
  green: 'bg-green-100 text-green-700',
  yellow: 'bg-yellow-100 text-yellow-700',
  red: 'bg-red-100 text-red-700',
  blue: 'bg-blue-100 text-blue-700',
  purple: 'bg-purple-100 text-purple-700',
  teal: 'bg-teal-100 text-teal-700',
  indigo: 'bg-indigo-100 text-indigo-700',
};

function formatBalance(value) {
  if (value === undefined || value === null || value === '') return '';

  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);

  const rounded = Math.round((amount + Number.EPSILON) * 100) / 100;

  if (rounded > 0) return `Due ${formatMoney(rounded)}`;
  if (rounded < 0) return `Credit ${formatMoney(Math.abs(rounded))}`;
  return 'Settled';
}

function formatField(key, value) {
  const name = String(key || '');

  if (name.toLowerCase() === 'accountbalance') {
    return formatBalance(value);
  }

  if (value === null && MONEY_KEY_RE.test(name)) return 'Not set';
  if (value === undefined || value === null || value === '') return '';

  if (MONEY_KEY_RE.test(name) && typeof value === 'number') {
    return formatMoney(value);
  }

  if (
    DATE_KEY_RE.test(name) &&
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value))
  ) {
    return new Date(value).toLocaleString();
  }

  if (
    DATE_KEY_RE.test(name) &&
    value instanceof Date &&
    !Number.isNaN(value.getTime())
  ) {
    return value.toLocaleString();
  }

  if (typeof value === 'object') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  return String(value);
}

function changedValue(before, after, key) {
  const oldValue = formatField(key, before);
  const newValue = formatField(key, after);

  if (oldValue && newValue && oldValue !== newValue) {
    return `${oldValue} → ${newValue}`;
  }

  return newValue || oldValue;
}

function balanceChange(before, after) {
  const beforeExists = before !== undefined && before !== null && before !== '';
  const afterExists = after !== undefined && after !== null && after !== '';

  if (!beforeExists && !afterExists) return '';

  const oldValue = beforeExists ? formatBalance(before) : 'Not set';
  const newValue = afterExists ? formatBalance(after) : 'Not set';

  return oldValue === newValue ? newValue : `${oldValue} → ${newValue}`;
}

function hiddenPath(path) {
  return path.split('.').some((part) =>
    HIDDEN_KEY_RE.test(part.replace(/\(\d+\)/g, ''))
  );
}

function labelFor(path) {
  const key = lastSegment(path)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\bId\b/gi, 'ID');

  return key.charAt(0).toUpperCase() + key.slice(1);
}

function getRows(before, after, action) {
  const map = new Map();

  for (const row of flattenObject(before || {})) {
    map.set(row.path, { ...row, after: undefined });
  }

  for (const row of flattenObject(after || {})) {
    const old = map.get(row.path);

    map.set(
      row.path,
      old
        ? { ...old, after: row.value }
        : { path: row.path, before: undefined, after: row.value }
    );
  }

  const edited = /.(edited|updated)$/.test(action || '');

  return [...map.values()]
    .filter((row) => !hiddenPath(row.path))
    .filter(
      (row) =>
        formatField(lastSegment(row.path), row.before) ||
        formatField(lastSegment(row.path), row.after)
    )
    .filter((row) => {
      if (!edited) return true;

      return (
        formatField(lastSegment(row.path), row.before) !==
        formatField(lastSegment(row.path), row.after)
      );
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function findValue(rows, key) {
  const row = rows.find(
    (item) => lastSegment(item.path).toLowerCase() === key.toLowerCase()
  );

  if (!row) return '';

  if (key.toLowerCase() === 'accountbalance') {
    return balanceChange(row.before, row.after);
  }

  return changedValue(row.before, row.after, key);
}

function makeSection(label, text) {
  return text ? { label, text } : null;
}

function transactionSection(rows) {
  const parts = [
    findValue(rows, 'amountPaid') && `Paid ${findValue(rows, 'amountPaid')}`,
    findValue(rows, 'balanceDue') &&
      `Order due ${findValue(rows, 'balanceDue')}`,
    findValue(rows, 'creditApplied') &&
      `Credit applied ${findValue(rows, 'creditApplied')}`,
    findValue(rows, 'creditGenerated') &&
      `Credit generated ${findValue(rows, 'creditGenerated')}`,
    findValue(rows, 'paymentMethod') || findValue(rows, 'method'),
    findValue(rows, 'paymentStatus'),
  ].filter(Boolean);

  return makeSection('Transaction', parts.join(' · '));
}

function adjustmentSection(rows) {
  const product = findValue(rows, 'productID');
  const oldQty = findValue(rows, 'originalQty');
  const newQty = findValue(rows, 'newQty');
  const credit = findValue(rows, 'creditAmount');
  const settlement = findValue(rows, 'settlement');
  const action = findValue(rows, 'action');
  const reason = findValue(rows, 'reason');

  const quantity =
    oldQty && newQty
      ? `${oldQty} → ${newQty}`
      : newQty || oldQty;

  const parts = [
    product && `Product ${product}`,
    quantity && `Qty ${quantity}`,
    credit && `Credit ${credit}`,
    settlement && `Settlement ${settlement}`,
    action && `Action ${action}`,
    reason && `Reason: ${reason}`,
  ].filter(Boolean);

  return makeSection('Adjustment', parts.join(' · '));
}

function productSections(rows, used) {
  const indexes = [
    ...new Set(
      rows
        .map((row) => row.path.match(/^products\((\d+)\)/)?.[1])
        .filter((index) => index !== undefined)
    ),
  ];

  return indexes
    .map((index) => {
      const productRows = rows.filter((row) =>
        row.path.startsWith(`products[${index}]`)
      );

      productRows.forEach((row) => used.add(row.path));

      const name =
        findValue(productRows, 'name') ||
        findValue(productRows, 'productName') ||
        findValue(productRows, 'productID');

      const quantity =
        findValue(productRows, 'quantity') ||
        findValue(productRows, 'qty');

      const retail = findValue(productRows, 'retailPrice');
      const price =
        findValue(productRows, 'sellingPrice') ||
        findValue(productRows, 'salePrice') ||
        findValue(productRows, 'unitPrice') ||
        findValue(productRows, 'price');

      const amount = findValue(productRows, 'amount');

      const parts = [
        name,
        quantity && `Qty ${quantity}`,
        retail && `Retail ${retail}`,
        price && `Price ${price}`,
        amount && `Amount ${amount}`,
      ].filter(Boolean);

      return makeSection(`Product ${Number(index) + 1}`, parts.join(' · '));
    })
    .filter(Boolean);
}

function compactDetails(before, after, action) {
  const rows = getRows(before, after, action);
  const used = new Set();
  const sections = [];

  const account = rows.find(
    (row) => lastSegment(row.path).toLowerCase() === 'accountbalance'
  );

  if (account) {
    const balance = balanceChange(account.before, account.after);

    if (balance) {
      sections.push(
        makeSection('Customer Account', `Actual balance: ${balance}`)
      );
    }

    used.add(account.path);
  }

  const supplier = rows.find(
    (row) => lastSegment(row.path).toLowerCase() === 'creditbalance'
  );

  if (supplier) {
    const balance = findValue(rows, 'creditBalance');

    if (balance) {
      sections.push(
        makeSection('Supplier Account', `Credit balance: ${balance}`)
      );
    }

    used.add(supplier.path);
  }

  const paymentRows = rows.filter(
    (row) =>
      /^payments\[\d+\]/.test(row.path) ||
      [
        'amountPaid',
        'balanceDue',
        'creditApplied',
        'creditGenerated',
        'paymentMethod',
        'paymentStatus',
      ].includes(lastSegment(row.path))
  );

  if (paymentRows.length) {
    paymentRows.forEach((row) => used.add(row.path));

    const section = transactionSection(paymentRows);
    if (section) sections.push(section);
  }

  const historyRows = rows.filter((row) =>
    row.path.startsWith('editHistory[')
  );

  if (historyRows.length) {
    historyRows.forEach((row) => used.add(row.path));

    const section = adjustmentSection(historyRows);
    if (section) sections.push(section);
  }

  sections.push(...productSections(rows, used));

  const remaining = rows
    .filter((row) => !used.has(row.path))
    .map((row) => {
      const key = lastSegment(row.path);
      const text = findValue([row], key);

      return text ? `${labelFor(row.path)}: ${text}` : '';
    })
    .filter(Boolean);

  if (remaining.length) {
    sections.push(makeSection('Details', remaining.join(' · ')));
  }

  if (!sections.length && (before || after)) {
    sections.push(
      makeSection('Details', 'No displayable changes recorded.')
    );
  }

  return sections;
}

export default function AuditLog() {
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState(null);

  const debouncedSearch = useDebouncedValue(search, 300);

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
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('desc');
    }

    setPage(1);
  };

  const actionLabel = (action) => ACTIONS[action]?.[0] || action;
  const actionBadge = (action) =>
    BADGES[ACTIONS[action]?.[1]] || 'bg-gray-100 text-gray-700';

  return (
    <div className="flex h-screen bg-gray-100">
      <Sidebar />

      <div className="flex-1 flex flex-col overflow-hidden">
        <Topbar title="Audit Log" />

        <main className="flex-1 overflow-y-auto p-4 @min-[768px]:p-6">
          <p className="text-sm text-gray-500 mb-4">
            A durable, read-only record of every order, product, customer,
            and supplier change — who did it and when. Kept to the most
            recent <span className="font-medium">entries only</span>;
            older entries are dropped automatically as new ones come in.
          </p>

          <div className="flex flex-wrap gap-3 mb-4">
            <input
              type="text"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search by user, action, or ID…"
              className="border rounded px-3 py-2 flex-1 min-w-[220px]"
            />

            <select
              value={actionFilter}
              onChange={(event) => {
                setActionFilter(event.target.value);
                setPage(1);
              }}
              className="border rounded px-3 py-2"
            >
              <option value="">All actions</option>

              {Object.entries(ACTIONS).map(([value, [label]]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="text-red-600 mb-3">{error}</p>}

          <div className="bg-white rounded shadow overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead className="bg-gray-100 text-gray-600 uppercase text-xs">
                <tr>
                  <SortableHeader
                    label="When"
                    field="date"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />

                  <th className="py-3 px-2 text-left">Action</th>
                  <th className="py-3 px-2 text-left">By</th>
                  <th className="py-3 px-2 text-left">Target</th>
                  <th className="py-3 px-2 text-left">Details</th>
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-gray-400">
                      Loading…
                    </td>
                  </tr>
                ) : entries.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-gray-400">
                      No audit entries found.
                    </td>
                  </tr>
                ) : (
                  entries.map((entry) => {
                    const expanded = expandedId === entry._id;

                    return (
                      <Fragment key={entry._id}>
                        <tr
                          className="border-t hover:bg-gray-50 cursor-pointer"
                          onClick={() =>
                            setExpandedId(expanded ? null : entry._id)
                          }
                        >
                          <td className="py-2 px-2 whitespace-nowrap">
                            {new Date(entry.date).toLocaleString()}
                          </td>

                          <td className="py-2 px-2">
                            <span
                              className={`px-2 py-1 rounded text-xs font-medium ${actionBadge(
                                entry.action
                              )}`}
                            >
                              {actionLabel(entry.action)}
                            </span>
                          </td>

                          <td className="py-2 px-2">
                            {entry.actor?.username}
                            <span className="text-gray-400">
                              {' '}
                              ({entry.actor?.role})
                            </span>
                          </td>

                          <td className="py-2 px-2">
                            {entry.targetType}: {entry.targetId}
                          </td>

                          <td className="py-2 px-2 text-brand text-xs">
                            {expanded
                              ? 'Hide details ▲'
                              : 'View details ▼'}
                          </td>
                        </tr>

                        {expanded && (
                          <tr className="border-t bg-gray-50">
                            <td colSpan={5} className="p-4">
                              <div className="bg-white border rounded overflow-hidden">
                                {compactDetails(
                                  entry.before,
                                  entry.after,
                                  entry.action
                                ).map((section) => (
                                  <div
                                    key={section.label}
                                    className="px-3 py-2 border-b last:border-b-0"
                                  >
                                    <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                                      {section.label}
                                    </div>

                                    <div className="text-sm text-gray-800 mt-0.5 whitespace-pre-wrap">
                                      {section.text}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>

            <Pagination
              page={page}
              limit={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </div>
        </main>
      </div>
    </div>
  );
}