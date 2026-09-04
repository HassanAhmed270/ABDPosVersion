import { Fragment, useEffect, useState } from 'react';
import { toast } from 'sonner';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import SortableHeader from '../components/SortableHeader';
import Pagination from '../components/Pagination';
import { useAuth } from '../lib/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { api } from '../lib/api';
import { formatMoney, formatMoneyShort } from '../lib/money';
import { printReceipt } from '../lib/print';
import { SHOP_NAME, SHOP_ADDRESS, SHOP_PHONE } from '../lib/shopInfo';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { useSubmitGuard } from '../lib/useSubmitGuard';

const statusBadge = {
  paid: 'bg-green-100 text-green-700',
  partial: 'bg-yellow-100 text-yellow-700',
  unpaid: 'bg-red-100 text-red-700',
  refunded: 'bg-gray-200 text-gray-700',
};

const PAGE_SIZE = 10;
const WALKIN_CUSTOMER = 'Walk-in / Unknown';

export default function Orders() {
  const { isAdmin } = useAuth();
  const confirm = useConfirm();

  const [orders, setOrders] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [allProducts, setAllProducts] = useState([]);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [sortBy, setSortBy] = useState('orderDate');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);

  const [expandedID, setExpandedID] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [editForm, setEditForm] = useState({
    productID: '',
    removeQty: '',
    reason: '',
  });

  const [addForm, setAddForm] = useState({
    productID: '',
    quantity: '',
    reason: '',
  });

  const [convertForm, setConvertForm] = useState({
    customerName: '',
    mobileNo: '',
    email: '',
    address: '',
  });

  const [refundReason, setRefundReason] = useState('');

  // Prevent double-clicks from applying the same edit, add, convert,
  // or refund twice — each mutates the order and/or a customer
  // balance (see lib/useSubmitGuard.js).
  const { submitting: editingItem, guard: guardEditSubmit } = useSubmitGuard();
  const { submitting: addingItem, guard: guardAddSubmit } = useSubmitGuard();
  const { submitting: convertingOrder, guard: guardConvertSubmit } = useSubmitGuard();
  const { submitting: refundingOrder, guard: guardRefundSubmit } = useSubmitGuard();

  const loadOrders = async () => {
    setLoading(true);

    try {
      const data = await api.getOrders({
        search: debouncedSearch,
        sortBy,
        sortDir,
        page,
        limit: PAGE_SIZE,
      });

      setOrders(data.orders || []);
      setTotal(data.total || 0);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, sortBy, sortDir, page]);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.getProducts({ limit: 1000 });
        setAllProducts(data.products || []);
      } catch (err) {
        console.error('Failed to load products:', err.message);
      }
    })();
  }, []);

  useEffect(() => {
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, sortBy, sortDir]);

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir(field === 'orderDate' ? 'desc' : 'asc');
    }
  };

  const toggleRow = async (orderID) => {
    if (expandedID === orderID) {
      setExpandedID(null);
      setDetail(null);
      return;
    }

    setExpandedID(orderID);
    setDetail(null);
    setDetailLoading(true);

    setEditForm({
      productID: '',
      removeQty: '',
      reason: '',
    });

    setAddForm({
      productID: '',
      quantity: '',
      reason: '',
    });

    setConvertForm({
      customerName: '',
      mobileNo: '',
      email: '',
      address: '',
    });

    setRefundReason('');

    try {
      const data = await api.getOrder(orderID);
      setDetail(data);
    } catch (err) {
      toast.error('Failed to load order: ' + err.message);
      setExpandedID(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshDetail = async (orderID) => {
    const data = await api.getOrder(orderID);
    setDetail(data);
    await loadOrders();
  };

  const editWindowOpen = (order) =>
    Date.now() - new Date(order.orderDate).getTime() <=
    72 * 60 * 60 * 1000;

  const getProductName = (productID) => {
    const product = allProducts.find((p) => p.productID === productID);
    return product?.productName || productID;
  };

  const handleEditSubmit = guardEditSubmit(async (e) => {
    e.preventDefault();

    if (!editForm.productID) {
      return toast.error('Select a line item to edit.');
    }

    const removeQty = parseInt(editForm.removeQty);

    if (isNaN(removeQty) || removeQty <= 0) {
      return toast.error('Enter a quantity greater than 0 to remove.');
    }

    const product = detail.order.products.find(
      (p) => p.productID === editForm.productID
    );

    if (!product) {
      return toast.error('Selected item was not found.');
    }

    if (removeQty > product.quantity) {
      return toast.error(
        `You can remove a maximum of ${product.quantity}.`
      );
    }

    const newQty = product.quantity - removeQty;

    if (!editForm.reason.trim()) {
      return toast.error('A reason is required.');
    }

    try {
      await api.editOrderItem(expandedID, {
        productID: editForm.productID,
        newQty,
        reason: editForm.reason.trim(),
      });

      toast.success('Order updated.');

      setEditForm({
        productID: '',
        removeQty: '',
        reason: '',
      });

      await refreshDetail(expandedID);
    } catch (err) {
      toast.error('Edit failed: ' + err.message);
    }
  });

  const handleAddSubmit = guardAddSubmit(async (e) => {
    e.preventDefault();

    if (!addForm.productID) {
      return toast.error('Select a product to add.');
    }

    const quantity = parseInt(addForm.quantity);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return toast.error('Enter a valid quantity.');
    }

    if (!addForm.reason.trim()) {
      return toast.error('A reason is required.');
    }

    if (
      detail.order.products.some(
        (p) => p.productID === addForm.productID
      )
    ) {
      return toast.error(
        'This order already has a line for that product — use "Edit a line item" instead.'
      );
    }

    try {
      await api.editOrderItem(expandedID, {
        action: 'add',
        productID: addForm.productID,
        quantity,
        reason: addForm.reason.trim(),
      });

      toast.success('Item added to order.');

      setAddForm({
        productID: '',
        quantity: '',
        reason: '',
      });

      await refreshDetail(expandedID);
    } catch (err) {
      toast.error('Failed to add item: ' + err.message);
    }
  });

  const handleConvertSubmit = guardConvertSubmit(async (e) => {
    e.preventDefault();

    if (!convertForm.customerName.trim()) {
      return toast.error('Customer name is required.');
    }

    try {
      await api.createCustomer({
        customerName: convertForm.customerName.trim(),
        mobileNo: convertForm.mobileNo.trim(),
        email: convertForm.email.trim(),
        address: convertForm.address.trim(),
      });

      await api.convertWalkInOrder(
        expandedID,
        convertForm.customerName.trim()
      );

      toast.success(
        `Order attached to ${convertForm.customerName.trim()}.`
      );

      setConvertForm({
        customerName: '',
        mobileNo: '',
        email: '',
        address: '',
      });

      await refreshDetail(expandedID);
    } catch (err) {
      toast.error('Failed to convert order: ' + err.message);
    }
  });

  const handleRefundSubmit = guardRefundSubmit(async (e) => {
    e.preventDefault();

    const items = detail.order.products.map((p) => ({
      productID: p.productID,
      quantity: p.quantity,
    }));

    if (items.length === 0) {
      return toast.error('This order has no items left to refund.');
    }

    if (!refundReason.trim()) {
      return toast.error('A reason is required.');
    }

    if (
      !(await confirm(
        `Refund the full order ${expandedID} for cash back? This marks the whole order as refunded.`
      ))
    ) {
      return;
    }

    try {
      const data = await api.refundOrder(expandedID, {
        items,
        reason: refundReason.trim(),
        settlement: 'cash',
      });

      if (!data?.success || !data?.refund) {
        throw new Error(
          data?.message ||
            'Refund completed but no refund details were returned.'
        );
      }

      toast.success(
        `Cash back processed: ${formatMoney(data.refund.refundAmount)}`
      );

      setRefundReason('');

      await refreshDetail(expandedID);
    } catch (err) {
      toast.error('Refund failed: ' + err.message);
    }
  });

  const handlePrintRevised = () => {
    if (!detail) return;

    const { order, refunds } = detail;
    const now = new Date();

    const itemRows = order.products
      .map((p) => {
        const quantity = Number(p.quantity || 0);
        const retailPrice = Number(p.retailPrice || 0);
        const unitPrice = Number(p.unitPrice || 0);
        const total = Number(p.amount || 0);

        return `
          <tr>
            <td class="item-name">${getProductName(p.productID)}</td>
            <td>${formatMoneyShort(retailPrice)}</td>
            <td>${formatMoneyShort(unitPrice)}</td>
            <td>${quantity}</td>
            <td>${formatMoneyShort(total)}</td>
          </tr>
        `;
      })
      .join('');

    const editRows = (order.editHistory || [])
      .map((e) => {
        const settlementLabel =
          e.settlement === 'credit'
            ? `Store Credit: ${formatMoney(e.creditAmount || 0)}`
            : e.settlement === 'cash'
              ? `Cash Back: ${formatMoney(e.creditAmount || 0)}`
              : '—';

        return `
          <tr>
            <td>${e.productID}</td>
            <td>${e.originalQty} → ${e.newQty}</td>
            <td>${e.action}</td>
            <td>${e.editedBy}</td>
            <td>${new Date(e.editedAt).toLocaleString()}</td>
            <td>${e.reason}</td>
            <td>${settlementLabel}</td>
          </tr>
        `;
      })
      .join('');

    const refundRows = (refunds || [])
      .map(
        (r) => `
          <tr>
            <td>${formatMoney(r.refundAmount)}</td>
            <td>${r.processedBy}</td>
            <td>${new Date(r.refundDate).toLocaleString()}</td>
            <td>${r.reason || ''}</td>
            <td>${r.settlement || 'none'}</td>
          </tr>
        `
      )
      .join('');

    printReceipt(`
      <div class="receipt">
        <div class="shop-name">${SHOP_NAME}</div>
        <div class="shop-line">${SHOP_ADDRESS}</div>
        <div class="shop-line">Phone: ${SHOP_PHONE}</div>

        <hr class="sep-solid" />

        <div class="meta-row">
          <span>
            Revised Receipt${order.status === 'refunded' ? ' (REFUNDED)' : ''}
          </span>
          <span>${now.toLocaleDateString()}</span>
        </div>

        <div class="meta-row">
          <span>Order: ${order.orderID}</span>
          <span>${now.toLocaleTimeString()}</span>
        </div>

        <div>Customer Name: ${order.customerName}</div>

        ${
          order.offlineOrigin
            ? '<div class="offline-banner">OFFLINE SALE — SYNCED</div>'
            : ''
        }

        <hr class="sep" />

        <table class="items">
          <colgroup>
            <col class="col-item" />
            <col class="col-rate" />
            <col class="col-rate" />
            <col class="col-qty" />
            <col class="col-total" />
          </colgroup>

          <thead>
            <tr>
              <th>Item</th>
              <th>Retail</th>
              <th>Rate</th>
              <th>Qty</th>
              <th>Total</th>
            </tr>
          </thead>

          <tbody>
            ${itemRows}
          </tbody>
        </table>

        <hr class="sep" />

        <div class="totals-row grand">
          <span>Grand Total</span>
          <span>${formatMoney(order.totalAmount)}</span>
        </div>

        ${
          order.creditApplied > 0
            ? `
              <div class="totals-row">
                <span>Store Credit Applied</span>
                <span>${formatMoney(order.creditApplied)}</span>
              </div>
            `
            : ''
        }

        <div class="totals-row">
          <span>Paid</span>
          <span>${formatMoney(order.amountPaid)}</span>
        </div>

        <div class="totals-row">
          <span>Balance Due</span>
          <span>${formatMoney(order.balanceDue)}</span>
        </div>

        <hr class="sep-solid" />

        <div class="footer">THANK YOU! VISIT AGAIN</div>
      </div>

      ${
        editRows
          ? `
            <div class="edit-history">
              <h3>Edit History</h3>
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qty</th>
                    <th>Action</th>
                    <th>By</th>
                    <th>When</th>
                    <th>Reason</th>
                    <th>Settlement</th>
                  </tr>
                </thead>
                <tbody>${editRows}</tbody>
              </table>
            </div>
          `
          : ''
      }

      ${
        refundRows
          ? `
            <div class="edit-history">
              <h3>Refunds</h3>
              <table>
                <thead>
                  <tr>
                    <th>Amount</th>
                    <th>By</th>
                    <th>When</th>
                    <th>Reason</th>
                    <th>Settlement</th>
                  </tr>
                </thead>
                <tbody>${refundRows}</tbody>
              </table>
            </div>
          `
          : ''
      }
    `);
  };

  return (
    <div className="flex h-screen">
      <Sidebar />

      <main className="flex-1 flex flex-col overflow-hidden">
        <Topbar title="Orders" />

        <div className="p-4 @min-[768px]:p-6 overflow-y-auto flex-1">
          <input
            type="text"
            placeholder="Search by order ID or customer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border rounded px-3 py-2 w-full @min-[640px]:w-72 mb-4"
          />

          {error && (
            <p className="text-red-600 text-sm mb-4">{error}</p>
          )}

          {!isAdmin && (
            <p className="text-xs text-gray-500 mb-4">
              You're viewing orders read-only — editing and refunds are
              admin-only.
            </p>
          )}

          <div className="bg-white border rounded-lg w-full overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b bg-gray-100">
                  <SortableHeader
                    label="Order"
                    field="orderID"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />

                  <SortableHeader
                    label="Customer"
                    field="customerName"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />

                  <SortableHeader
                    label="Total"
                    field="totalAmount"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />

                  <SortableHeader
                    label="Date"
                    field="orderDate"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />

                  <SortableHeader
                    label="Avg Payment"
                    field="avgPayment"
                    sortBy={sortBy}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />

                  <th className="py-3 px-2 text-left">Status</th>
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="py-6 text-center text-gray-400"
                    >
                      Loading…
                    </td>
                  </tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="py-6 text-center text-gray-400"
                    >
                      No orders found
                    </td>
                  </tr>
                ) : (
                  orders.map((o) => (
                    <Fragment key={o.orderID}>
                      <tr
                        onClick={() => toggleRow(o.orderID)}
                        className={`border-b hover:bg-gray-50 cursor-pointer ${
                          expandedID === o.orderID ? 'bg-blue-50' : ''
                        }`}
                      >
                        <td className="py-2 px-3">{o.orderID}</td>

                        <td className="py-2 px-3">
                          {o.customerName}
                        </td>

                        <td className="py-2 px-3">
                          {formatMoney(o.totalAmount)}
                        </td>

                        <td className="py-2 px-3">
                          {new Date(
                            o.orderDate
                          ).toLocaleDateString()}
                        </td>

                        <td className="py-2 px-3">
                          {formatMoney(o.avgPayment)}
                        </td>

                        <td className="py-2 px-3">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-medium ${
                              statusBadge[o.displayStatus] || ''
                            }`}
                          >
                            {o.displayStatus}
                          </span>
                        </td>
                      </tr>

                      {expandedID === o.orderID && (
                        <tr className="bg-gray-50">
                          <td colSpan={6} className="p-4">
                            {detailLoading ? (
                              <p className="text-gray-400 text-sm">
                                Loading…
                              </p>
                            ) : !detail ? (
                              <p className="text-red-500 text-sm">
                                Could not load this order.
                              </p>
                            ) : (
                              <div className="grid grid-cols-1 @min-[768px]:grid-cols-2 gap-6 text-sm">
                                <div className="space-y-3">
                                  <div className="flex justify-between items-center">
                                    <h3 className="font-bold text-brand">
                                      Details
                                    </h3>

                                    <button
                                      onClick={handlePrintRevised}
                                      className="text-xs text-blue-600 hover:underline"
                                    >
                                      Print{' '}
                                      {detail.order.editHistory?.length
                                        ? '(Revised)'
                                        : ''}
                                    </button>
                                  </div>

                                  <div>
                                    Cashier: {detail.order.cashier}
                                  </div>

                                  <div>
                                    Date:{' '}
                                    {new Date(
                                      detail.order.orderDate
                                    ).toLocaleString()}
                                  </div>

                                  {detail.order.offlineOrigin && (
                                    <div className="bg-amber-100 text-amber-800 rounded px-3 py-2 text-xs font-medium">
                                      Offline sale — synced successfully
                                    </div>
                                  )}

                                  {detail.order.status === 'refunded' && (
                                    <div className="bg-gray-200 text-gray-700 rounded px-3 py-1 text-xs font-medium">
                                      This order has been refunded.
                                    </div>
                                  )}

                                  <table className="w-full border-collapse text-xs bg-white">
                                    <thead className="bg-gray-100">
                                      <tr>
                                        <th className="p-1 text-left border">
                                          Item
                                        </th>
                                        <th className="p-1 text-left border">
                                          Retail
                                        </th>
                                        <th className="p-1 text-left border">
                                          Rate
                                        </th>
                                        <th className="p-1 text-left border">
                                          Qty
                                        </th>
                                        <th className="p-1 text-left border">
                                          Total
                                        </th>
                                      </tr>
                                    </thead>

                                    <tbody>
                                      {detail.order.products.map((p) => (
                                        <tr key={p.productID}>
                                          <td className="p-1 border">
                                            <div className="font-medium">
                                              {getProductName(p.productID)}
                                            </div>
                                            <div className="text-gray-400">
                                              {p.productID}
                                            </div>
                                          </td>

                                          <td className="p-1 border">
                                            {formatMoney(p.retailPrice)}
                                          </td>

                                          <td className="p-1 border">
                                            {formatMoney(p.unitPrice)}
                                          </td>

                                          <td className="p-1 border">
                                            {p.quantity}
                                          </td>

                                          <td className="p-1 border">
                                            {formatMoney(p.amount)}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>

                                  <div className="flex justify-between font-semibold border-t pt-2">
                                    <span>Total</span>
                                    <span>
                                      {formatMoney(
                                        detail.order.totalAmount
                                      )}
                                    </span>
                                  </div>

                                  {detail.order.creditApplied > 0 && (
                                    <div className="flex justify-between text-green-700">
                                      <span>Store credit applied</span>
                                      <span>
                                        {formatMoney(
                                          detail.order.creditApplied
                                        )}
                                      </span>
                                    </div>
                                  )}

                                  <div className="flex justify-between">
                                    <span>Paid</span>
                                    <span>
                                      {formatMoney(
                                        detail.order.amountPaid
                                      )}
                                    </span>
                                  </div>

                                  <div className="flex justify-between">
                                    <span>Balance Due</span>
                                    <span>
                                      {formatMoney(
                                        detail.order.balanceDue
                                      )}
                                    </span>
                                  </div>

                                  {detail.order.editHistory?.length > 0 && (
                                    <div>
                                      <h3 className="font-medium text-brand-green mb-1">
                                        Edit History / Store Credit
                                        Adjustments
                                      </h3>

                                      <ul className="text-xs space-y-1">
                                        {detail.order.editHistory.map(
                                          (e, i) => (
                                            <li
                                              key={i}
                                              className="border-b pb-1"
                                            >
                                              {e.productID}:{' '}
                                              {e.originalQty} →{' '}
                                              {e.newQty} ({e.action}) by{' '}
                                              {e.editedBy} on{' '}
                                              {new Date(
                                                e.editedAt
                                              ).toLocaleString()}{' '}
                                              — "{e.reason}"

                                              {e.settlement === 'credit' && (
                                                <>
                                                  {' '}
                                                  — Store credit:{' '}
                                                  {formatMoney(
                                                    e.creditAmount || 0
                                                  )}
                                                </>
                                              )}

                                              {e.settlement === 'cash' && (
                                                <>
                                                  {' '}
                                                  — Cash back:{' '}
                                                  {formatMoney(
                                                    e.creditAmount || 0
                                                  )}
                                                </>
                                              )}
                                            </li>
                                          )
                                        )}
                                      </ul>
                                    </div>
                                  )}

                                  {detail.refunds?.length > 0 && (
                                    <div>
                                      <h3 className="font-medium text-red-600 mb-1">
                                        Refunds
                                      </h3>

                                      <ul className="text-xs space-y-1">
                                        {detail.refunds.map((r) => (
                                          <li
                                            key={r._id}
                                            className="border-b pb-1"
                                          >
                                            {formatMoney(
                                              r.refundAmount
                                            )}{' '}
                                            by {r.processedBy} on{' '}
                                            {new Date(
                                              r.refundDate
                                            ).toLocaleString()}{' '}
                                            — "{r.reason}"

                                            {r.settlement === 'credit' && (
                                              <>
                                                {' '}
                                                —{' '}
                                                {formatMoney(
                                                  r.creditGenerated
                                                )}{' '}
                                                store credit
                                              </>
                                            )}

                                            {r.settlement === 'cash' && (
                                              <> — cash back</>
                                            )}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </div>

                                {isAdmin &&
                                  detail.order.status !== 'refunded' && (
                                    <div className="space-y-3">
                                      {detail.order.customerName ===
                                        WALKIN_CUSTOMER &&
                                        editWindowOpen(detail.order) && (
                                          <div className="border border-dashed border-blue-300 rounded-lg p-3 bg-white">
                                            <h3 className="font-medium mb-2 text-blue-700">
                                              Convert to customer
                                            </h3>

                                            <p className="text-xs text-gray-500 mb-2">
                                              This is a walk-in order. Attach
                                              it to a customer so any store
                                              credit an exchange generates
                                              has an account to land in.
                                            </p>

                                            <form
                                              onSubmit={handleConvertSubmit}
                                              className="space-y-2"
                                            >
                                              <input
                                                type="text"
                                                placeholder="Customer name (required)"
                                                value={
                                                  convertForm.customerName
                                                }
                                                onChange={(e) =>
                                                  setConvertForm({
                                                    ...convertForm,
                                                    customerName:
                                                      e.target.value,
                                                  })
                                                }
                                                className="border rounded px-2 py-1 w-full text-sm"
                                              />

                                              <input
                                                type="text"
                                                placeholder="Mobile no. (optional)"
                                                value={
                                                  convertForm.mobileNo
                                                }
                                                onChange={(e) =>
                                                  setConvertForm({
                                                    ...convertForm,
                                                    mobileNo:
                                                      e.target.value,
                                                  })
                                                }
                                                className="border rounded px-2 py-1 w-full text-sm"
                                              />

                                              <input
                                                type="text"
                                                placeholder="Email (optional)"
                                                value={
                                                  convertForm.email
                                                }
                                                onChange={(e) =>
                                                  setConvertForm({
                                                    ...convertForm,
                                                    email: e.target.value,
                                                  })
                                                }
                                                className="border rounded px-2 py-1 w-full text-sm"
                                              />

                                              <input
                                                type="text"
                                                placeholder="Address (optional)"
                                                value={
                                                  convertForm.address
                                                }
                                                onChange={(e) =>
                                                  setConvertForm({
                                                    ...convertForm,
                                                    address:
                                                      e.target.value,
                                                  })
                                                }
                                                className="border rounded px-2 py-1 w-full text-sm"
                                              />

                                              <button
                                                type="submit"
                                                disabled={convertingOrder}
                                                className="w-full bg-blue-600 text-white rounded py-1.5 text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                              >
                                                {convertingOrder ? 'Converting…' : 'Convert & Attach'}
                                              </button>
                                            </form>
                                          </div>
                                        )}

                                      <div className="border border-dashed border-teal-300 rounded-lg p-3 bg-white">
                                        <h3 className="font-medium mb-1 text-teal-700">
                                          Exchange — reduce a line item
                                          (Store Credit){' '}
                                          {!editWindowOpen(
                                            detail.order
                                          ) && (
                                            <span className="text-red-500 text-xs">
                                              (72h window expired)
                                            </span>
                                          )}
                                        </h3>

                                        <p className="text-xs text-gray-500 mb-2">
                                          Any value freed up is settled as
                                          store credit, never cash back.
                                        </p>

                                        {editWindowOpen(detail.order) && (
                                          <form
                                            onSubmit={handleEditSubmit}
                                            className="space-y-2"
                                          >
                                            <select
                                              value={
                                                editForm.productID
                                              }
                                              onChange={(e) =>
                                                setEditForm({
                                                  ...editForm,
                                                  productID:
                                                    e.target.value,
                                                })
                                              }
                                              className="border rounded px-2 py-1 w-full text-sm"
                                            >
                                              <option value="">
                                                Select item
                                              </option>

                                              {detail.order.products.map(
                                                (p) => (
                                                  <option
                                                    key={p.productID}
                                                    value={p.productID}
                                                  >
                                                    {getProductName(
                                                      p.productID
                                                    )}{' '}
                                                    — {p.productID} (qty{' '}
                                                    {p.quantity})
                                                  </option>
                                                )
                                              )}
                                            </select>

                                            <input
                                              type="number"
                                              min="1"
                                              max={
                                                editForm.productID
                                                  ? detail.order.products.find(
                                                      (p) =>
                                                        p.productID ===
                                                        editForm.productID
                                                    )?.quantity
                                                  : undefined
                                              }
                                              placeholder="Quantity to remove"
                                              value={
                                                editForm.removeQty
                                              }
                                              onChange={(e) =>
                                                setEditForm({
                                                  ...editForm,
                                                  removeQty:
                                                    e.target.value,
                                                })
                                              }
                                              className="border rounded px-2 py-1 w-full text-sm"
                                            />

                                            <input
                                              type="text"
                                              placeholder="Reason (required)"
                                              value={editForm.reason}
                                              onChange={(e) =>
                                                setEditForm({
                                                  ...editForm,
                                                  reason: e.target.value,
                                                })
                                              }
                                              className="border rounded px-2 py-1 w-full text-sm"
                                            />

                                            <button
                                              type="submit"
                                              disabled={editingItem}
                                              className="w-full bg-brand text-white rounded py-1.5 text-sm hover:bg-brand-dark disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                              {editingItem ? 'Saving…' : 'Save Edit'}
                                            </button>
                                          </form>
                                        )}
                                      </div>

                                      <div className="border border-dashed border-green-300 rounded-lg p-3 bg-white">
                                        <h3 className="font-medium mb-2 text-green-700">
                                          Exchange — add a replacement item
                                        </h3>

                                        {editWindowOpen(detail.order) && (
                                          <form
                                            onSubmit={handleAddSubmit}
                                            className="space-y-2"
                                          >
                                            <select
                                              value={
                                                addForm.productID
                                              }
                                              onChange={(e) =>
                                                setAddForm({
                                                  ...addForm,
                                                  productID:
                                                    e.target.value,
                                                })
                                              }
                                              className="border rounded px-2 py-1 w-full text-sm"
                                            >
                                              <option value="">
                                                Select product to add
                                              </option>

                                              {allProducts
                                                .filter(
                                                  (p) =>
                                                    !detail.order.products.some(
                                                      (line) =>
                                                        line.productID ===
                                                        p.productID
                                                    )
                                                )
                                                .map((p) => (
                                                  <option
                                                    key={p.productID}
                                                    value={p.productID}
                                                  >
                                                    {p.productID} —{' '}
                                                    {p.productName}
                                                  </option>
                                                ))}
                                            </select>

                                            <input
                                              type="number"
                                              min="1"
                                              placeholder="Quantity"
                                              value={addForm.quantity}
                                              onChange={(e) =>
                                                setAddForm({
                                                  ...addForm,
                                                  quantity:
                                                    e.target.value,
                                                })
                                              }
                                              className="border rounded px-2 py-1 w-full text-sm"
                                            />

                                            <input
                                              type="text"
                                              placeholder="Reason (required)"
                                              value={addForm.reason}
                                              onChange={(e) =>
                                                setAddForm({
                                                  ...addForm,
                                                  reason: e.target.value,
                                                })
                                              }
                                              className="border rounded px-2 py-1 w-full text-sm"
                                            />

                                            <button
                                              type="submit"
                                              disabled={addingItem}
                                              className="w-full bg-green-600 text-white rounded py-1.5 text-sm hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                              {addingItem ? 'Adding…' : 'Add Item'}
                                            </button>
                                          </form>
                                        )}
                                      </div>

                                      <div className="border border-dashed border-red-300 rounded-lg p-3 bg-white">
                                        <h3 className="font-medium mb-1 text-red-700">
                                          Refund Full Order (Cash Back)
                                        </h3>

                                        <p className="text-xs text-gray-500 mb-2">
                                          Refunds every item on this order
                                          for cash. For a partial swap, use
                                          Exchange above instead.
                                        </p>

                                        <ul className="text-xs text-gray-600 mb-2 space-y-0.5">
                                          {detail.order.products.map(
                                            (p) => (
                                              <li key={p.productID}>
                                                {getProductName(
                                                  p.productID
                                                )}{' '}
                                                × {p.quantity}
                                              </li>
                                            )
                                          )}
                                        </ul>

                                        <form
                                          onSubmit={handleRefundSubmit}
                                          className="space-y-2"
                                        >
                                          <input
                                            type="text"
                                            placeholder="Reason (required)"
                                            value={refundReason}
                                            onChange={(e) =>
                                              setRefundReason(
                                                e.target.value
                                              )
                                            }
                                            className="border rounded px-2 py-1 w-full text-sm"
                                          />

                                          <button
                                            type="submit"
                                            disabled={refundingOrder}
                                            className="w-full bg-red-600 text-white rounded py-1.5 text-sm hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                          >
                                            {refundingOrder ? 'Refunding…' : 'Refund Full Order — Cash Back'}
                                          </button>
                                        </form>
                                      </div>
                                    </div>
                                  )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))
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
        </div>
      </main>
    </div>
  );
}