import { Fragment, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import SortableHeader from '../components/SortableHeader';
import Pagination from '../components/Pagination';
import { api } from '../lib/api';
import { formatMoney, roundMoney } from '../lib/money';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { useAuth } from '../lib/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';

const emptySupplierForm = {
  supplierName: '',
  contactPerson: '',
  phone: '',
  email: '',
  address: '',
  paymentAmount: '',
};

const emptyPurchaseForm = {
  supplierName: '',
  billID: '',
  productId: '',
  quantity: '',
  unitCost: '',
  sellingPrice: '',
  amountPaid: '',
};

const PAGE_SIZE = 10;

export default function Suppliers() {
  const { isAdmin } = useAuth();
  const confirm = useConfirm();

  const [suppliers, setSuppliers] = useState([]);
  const [total, setTotal] = useState(0);

  const [allSuppliers, setAllSuppliers] = useState([]);
  const [allProducts, setAllProducts] = useState([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [sortBy, setSortBy] = useState('supplierName');
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(1);
  const [expandedName, setExpandedName] = useState(null);

  const [supplierForm, setSupplierForm] = useState(emptySupplierForm);
  const [purchaseForm, setPurchaseForm] = useState(emptyPurchaseForm);

  const [editingSupplierName, setEditingSupplierName] = useState(null);

  const selectedPurchaseProduct = allProducts.find(
    (p) => p.productID === purchaseForm.productId
  );

  const previousBuyingPrice = selectedPurchaseProduct?.costPrice ?? null;

  const previousSellingPrice = selectedPurchaseProduct?.price ?? null;

  const amountPaidManualRef = useRef(false);

  const editingSupplier = editingSupplierName
    ? allSuppliers.find(
      (s) => s.supplierName === editingSupplierName
    )
    : null;

  const editingSupplierBalance = roundMoney(
    editingSupplier?.totalBalanceDue || 0
  );

  const canAdjustSupplierBalance = editingSupplierBalance > 0;

  useEffect(() => {
    if (amountPaidManualRef.current) return;

    const qty = parseInt(purchaseForm.quantity, 10);
    const cost = parseFloat(purchaseForm.unitCost);

    const computedTotal =
      Number.isInteger(qty) &&
        qty > 0 &&
        Number.isFinite(cost) &&
        cost >= 0
        ? roundMoney(qty * cost)
        : '';

    setPurchaseForm((prev) => ({
      ...prev,
      amountPaid: computedTotal === '' ? '' : String(computedTotal),
    }));
  }, [purchaseForm.quantity, purchaseForm.unitCost]);

  const selectedSupplierCredit = purchaseForm.supplierName
    ? allSuppliers.find(
      (s) => s.supplierName === purchaseForm.supplierName
    )?.creditBalance ?? 0
    : 0;

  const loadSuppliers = async () => {
    setLoading(true);

    try {
      const data = await api.getSuppliers({
        search: debouncedSearch,
        sortBy,
        sortDir,
        page,
        limit: PAGE_SIZE,
      });

      setSuppliers(data.suppliers || []);
      setTotal(data.total || 0);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load suppliers');
    } finally {
      setLoading(false);
    }
  };

  const loadDropdownData = async () => {
    try {
      const [s, p] = await Promise.all([
        api.getSuppliers({ limit: 1000 }),
        api.getProducts({ limit: 1000 }),
      ]);

      setAllSuppliers(s.suppliers || []);
      setAllProducts(p.products || []);
    } catch (err) {
      console.error('Failed to load dropdown data:', err.message);
    }
  };

  useEffect(() => {
    loadDropdownData();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (params.get('action') !== 'restock') return;

    const productId = params.get('productId');

    if (!productId) return;

    setPurchaseForm((prev) => ({
      ...prev,
      productId,
    }));

    window.history.replaceState({}, '', '/suppliers');
  }, []);

  useEffect(() => {
    loadSuppliers();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, sortBy, sortDir, page]);

  useEffect(() => {
    setPage(1);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, sortBy, sortDir]);

  const handleSort = (field) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  };

  const reloadEverything = async () => {
    await Promise.all([loadSuppliers(), loadDropdownData()]);
  };

  const resetSupplierForm = () => {
    setSupplierForm(emptySupplierForm);
    setEditingSupplierName(null);
  };

  const handleStartEditSupplier = (supplier) => {
    setEditingSupplierName(supplier.supplierName);

    setSupplierForm({
      supplierName: supplier.supplierName,
      contactPerson: supplier.contactPerson || '',
      phone: supplier.phone || '',
      email: supplier.email || '',
      address: supplier.address || '',
      paymentAmount: '',
    });
  };

  const handleAddSupplier = async (e) => {
    e.preventDefault();

    if (!supplierForm.supplierName.trim()) {
      toast.error('Supplier name is required.');
      return;
    }

    const isEditing = Boolean(editingSupplierName);

    try {
      if (!isEditing) {
        await api.saveSupplier({
          supplierName: supplierForm.supplierName,
          contactPerson: supplierForm.contactPerson,
          phone: supplierForm.phone,
          email: supplierForm.email,
          address: supplierForm.address,
        });

        toast.success('Supplier added successfully.');

        resetSupplierForm();
        await reloadEverything();
        return;
      }

      const trimmedPayment = String(
        supplierForm.paymentAmount ?? ''
      ).trim();

      let paymentAmount = 0;

      if (trimmedPayment !== '') {
        paymentAmount = Number(trimmedPayment);

        if (
          !Number.isFinite(paymentAmount) ||
          paymentAmount < 0
        ) {
          toast.error(
            'Amount Paid / Balance Adjustment must be a valid non-negative number.'
          );
          return;
        }

        paymentAmount = roundMoney(paymentAmount);
      }

      const data = await api.saveSupplier({
        supplierName: editingSupplierName,
        contactPerson: supplierForm.contactPerson,
        phone: supplierForm.phone,
        email: supplierForm.email,
        address: supplierForm.address,
        ...(canAdjustSupplierBalance
          ? { amountPaid: paymentAmount }
          : {}),
      });

      if (paymentAmount > 0 && canAdjustSupplierBalance) {
        const unappliedAmount = roundMoney(
          Number(data?.unappliedAmount || 0)
        );

        if (unappliedAmount > 0) {
          toast.success(
            `Supplier updated. ${formatMoney(
              paymentAmount - unappliedAmount
            )} was applied to outstanding purchases. ${formatMoney(
              unappliedAmount
            )} could not be applied because there was no remaining outstanding balance.`
          );
        } else {
          toast.success(
            `Supplier updated. ${formatMoney(
              paymentAmount
            )} payment was applied to outstanding purchases.`
          );
        }
      } else {
        toast.success('Supplier updated successfully.');
      }

      resetSupplierForm();
      await reloadEverything();
    } catch (err) {
      toast.error('Error saving supplier: ' + err.message);
    }
  };

  const handleCancelEdit = () => {
    resetSupplierForm();
  };

  const handleDeleteSupplier = async (s) => {
    if (
      !(await confirm(
        `Delete supplier ${s.supplierName}? Its purchase history will be lost.`
      ))
    ) {
      return;
    }

    try {
      await api.deleteSupplier(s.supplierName);

      if (expandedName === s.supplierName) {
        setExpandedName(null);
      }

      if (editingSupplierName === s.supplierName) {
        resetSupplierForm();
      }

      await reloadEverything();
    } catch (err) {
      toast.error('Failed to delete supplier: ' + err.message);
    }
  };

  const handleRecordPurchase = async (e) => {
    e.preventDefault();

    const {
      supplierName,
      productId,
      quantity,
      unitCost,
      sellingPrice,
      amountPaid,
    } = purchaseForm;

    const qty = parseInt(quantity);
    const cost = parseFloat(unitCost);

    if (
      !supplierName ||
      !productId ||
      isNaN(qty) ||
      qty <= 0 ||
      isNaN(cost) ||
      cost < 0
    ) {
      toast.error(
        'Please fill in supplier, product, a valid quantity, and a valid unit cost.'
      );
      return;
    }

    const trimmedSellingPrice = String(
      sellingPrice ?? ''
    ).trim();

    let sp;

    if (trimmedSellingPrice !== '') {
      sp = parseFloat(trimmedSellingPrice);

      if (isNaN(sp) || sp < 0) {
        toast.error(
          'Retail price Optional'
        );
        return;
      }
    }

    try {
      const data = await api.recordPurchase({
        supplierName,
        billID: purchaseForm.billID.trim(),
        items: [{
          productID: productId,
          quantity: qty,
          unitCost: cost,
          ...(sp !== undefined ? { sellingPrice: sp } : {}),
        }],
        amountPaid: parseFloat(amountPaid) || 0,
      })
      const lines = [
        `Purchase ${data.purchaseID} recorded.`,
      ];

      if (data.creditApplied > 0) {
        lines.push(
          `${formatMoney(
            data.creditApplied
          )} of existing credit was used toward this purchase.`
        );
      }

      lines.push(
        `Balance due to supplier: ${formatMoney(data.balanceDue)}`
      );

      if (data.creditGenerated > 0) {
        lines.push(
          `${formatMoney(
            data.creditGenerated
          )} of what you paid went beyond what was owed and became new credit.`
        );
      }

      if (data.creditBalance > 0) {
        lines.push(
          `Supplier now has ${formatMoney(
            data.creditBalance
          )} credit total, which will reduce their next purchase automatically.`
        );
      }

      toast.success(lines.join(' '));

      amountPaidManualRef.current = false;
      setPurchaseForm(emptyPurchaseForm);

      await reloadEverything();
    } catch (err) {
      toast.error('Error recording purchase: ' + err.message);
    }
  };

  return (
    <div className="flex h-screen">
      <Sidebar />

      <main className="flex-1 flex flex-col overflow-hidden">
        <Topbar title="Supplier Management" />

        <div className="p-4 md:p-6 overflow-y-auto flex-1 space-y-6">
          <input
            type="text"
            placeholder="Search suppliers..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border rounded px-3 py-2 w-full sm:w-64"
          />

          {error && (
            <p className="text-red-600 text-sm">{error}</p>
          )}

          <div className="bg-white border rounded-lg w-full">
            <div className="flex flex-col lg:flex-row">
              <div
                className={`w-full ${isAdmin ? 'lg:w-2/3' : ''
                  } flex flex-col overflow-x-auto`}
              >
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b bg-gray-100">
                      <SortableHeader
                        label="Supplier"
                        field="supplierName"
                        sortBy={sortBy}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />

                      <th className="py-3 px-2 text-left">
                        Contact
                      </th>

                      <th className="py-3 px-2 text-left">
                        Phone
                      </th>

                      <SortableHeader
                        label="Purchases"
                        field="purchaseCount"
                        sortBy={sortBy}
                        sortDir={sortDir}
                        onSort={handleSort}
                        align="right"
                      />

                      <SortableHeader
                        label="Balance"
                        field="totalBalanceDue"
                        sortBy={sortBy}
                        sortDir={sortDir}
                        onSort={handleSort}
                        align="right"
                      />

                      <th className="py-3 px-2 text-left">
                        Actions
                      </th>
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
                    ) : suppliers.length === 0 ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="py-6 text-center text-gray-400"
                        >
                          No suppliers found
                        </td>
                      </tr>
                    ) : (
                      suppliers.map((s) => (
                        <Fragment key={s.supplierName}>
                          <tr
                            onClick={() =>
                              setExpandedName(
                                expandedName === s.supplierName
                                  ? null
                                  : s.supplierName
                              )
                            }
                            className={`border-b hover:bg-gray-50 cursor-pointer ${expandedName === s.supplierName
                              ? 'bg-blue-50'
                              : ''
                              }`}
                          >
                            <td className="py-2 px-3">
                              {s.supplierName}
                            </td>

                            <td className="py-2 px-3">
                              {s.contactPerson}
                            </td>

                            <td className="py-2 px-3">
                              {s.phone}
                            </td>

                            <td className="py-2 px-3 text-right">
                              {s.purchases.length}
                            </td>

                            <td className="py-2 px-3 text-right font-semibold">
                              {(() => {
                                const netBalance = roundMoney(
                                  (s.totalBalanceDue || 0) -
                                  (s.creditBalance || 0)
                                );

                                if (netBalance > 0) {
                                  return (
                                    <span className="text-red-700">
                                      -{formatMoney(netBalance)}
                                    </span>
                                  );
                                }

                                if (netBalance < 0) {
                                  return (
                                    <span className="text-green-700">
                                      +
                                      {formatMoney(
                                        -netBalance
                                      )}
                                    </span>
                                  );
                                }

                                return (
                                  <span className="text-gray-400 font-normal">
                                    {formatMoney(0)}
                                  </span>
                                );
                              })()}
                            </td>

                            <td className="py-2 px-3">
                              {isAdmin ? (
                                <div className="flex items-center gap-3">
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleStartEditSupplier(s);
                                    }}
                                    className="text-blue-600 hover:text-blue-800"
                                    title="Edit supplier"
                                  >
                                    ✏️
                                  </button>

                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteSupplier(s);
                                    }}
                                    className="text-red-600 hover:text-red-800"
                                    title="Delete"
                                  >
                                    🗑️
                                  </button>
                                </div>
                              ) : (
                                <span className="text-xs text-gray-400">
                                  —
                                </span>
                              )}
                            </td>
                          </tr>

                          {expandedName === s.supplierName && (
                            <tr className="bg-gray-50">
                              <td colSpan={6} className="p-4">
                                <h4 className="font-medium text-sm mb-2">
                                  Purchase history
                                </h4>

                                {s.purchases.length === 0 ? (
                                  <p className="text-xs text-gray-400">
                                    No purchases recorded yet.
                                  </p>
                                ) : (
                                  <table className="w-full min-w-[640px] text-xs bg-white border-collapse">
                                    <thead className="bg-gray-100">
                                      <tr>
                                        <th className="p-1 text-left border">
                                          Purchase ID
                                        </th>
                                       

                                        <th className="p-1 text-left border">
                                          Bill ID
                                        </th>
                                        <th className="p-1 text-left border">
                                          Date
                                        </th>

                                        <th className="p-1 text-left border">
                                          Items
                                        </th>

                                        <th className="p-1 text-right border">
                                          Total
                                        </th>

                                        <th className="p-1 text-right border">
                                          Paid
                                        </th>

                                        <th className="p-1 text-right border">
                                          Status
                                        </th>

                                       
                                      </tr>
                                    </thead>

                                    <tbody>
                                      {s.purchases.map((p) => {
                                        const stillOwes =
                                          p.balanceDue > 0;

                                        const madeCredit =
                                          !stillOwes &&
                                          p.creditGenerated > 0;

                                        return (
                                          <tr key={p.purchaseID}>
                                            <td className="p-1 border">
                                              {p.purchaseID}
                                            </td>
                                            <td className="p-1 border">
                                              {p.billID || '—'}
                                            </td>

                                            <td className="p-1 border">
                                              {new Date(
                                                p.date
                                              ).toLocaleDateString()}
                                            </td>

                                            <td className="p-1 border">
                                              {p.items
                                                .map(
                                                  (it) =>
                                                    `${it.productID} x${it.quantity}`
                                                )
                                                .join(', ')}
                                            </td>

                                            <td className="p-1 border text-right">
                                              {formatMoney(
                                                p.totalAmount
                                              )}
                                            </td>

                                            <td className="p-1 border text-right">
                                              {formatMoney(
                                                p.amountPaid
                                              )}
                                            </td>

                                            <td
                                              className={`p-1 border text-right ${stillOwes
                                                ? 'text-red-700 font-semibold'
                                                : madeCredit
                                                  ? 'text-green-700 font-semibold'
                                                  : 'text-gray-500'
                                                }`}
                                            >
                                              {stillOwes
                                                ? `Due ${formatMoney(
                                                  p.balanceDue
                                                )}`
                                                : madeCredit
                                                  ? `Credit +${formatMoney(
                                                    p.creditGenerated
                                                  )}`
                                                  : 'Settled'}
                                            </td>

                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
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

              {isAdmin && (
                <div className="w-full lg:w-1/3 p-4 sm:p-6 border-t-4 lg:border-t-0 lg:border-l-4 border-gray-300 lg:overflow-y-auto">
                  <h2 className="text-xl flex justify-center text-blue-600 font-bold mb-4">
                    {editingSupplierName
                      ? 'Edit Supplier'
                      : 'Add Supplier'}
                  </h2>

                  <form
                    onSubmit={handleAddSupplier}
                    className="space-y-3 text-sm"
                  >
                    <input
                      type="text"
                      value={supplierForm.supplierName}
                      onChange={(e) =>
                        setSupplierForm({
                          ...supplierForm,
                          supplierName: e.target.value,
                        })
                      }
                      placeholder="Supplier name"
                      className={`border rounded px-3 py-2 w-full ${editingSupplierName
                        ? 'bg-gray-100 cursor-not-allowed'
                        : ''
                        }`}
                      readOnly={Boolean(editingSupplierName)}
                    />

                    <input
                      type="text"
                      value={supplierForm.contactPerson}
                      onChange={(e) =>
                        setSupplierForm({
                          ...supplierForm,
                          contactPerson: e.target.value,
                        })
                      }
                      placeholder="Contact person"
                      className="border rounded px-3 py-2 w-full"
                    />

                    <input
                      type="tel"
                      value={supplierForm.phone}
                      onChange={(e) =>
                        setSupplierForm({
                          ...supplierForm,
                          phone: e.target.value,
                        })
                      }
                      placeholder="Phone"
                      className="border rounded px-3 py-2 w-full"
                    />

                    <input
                      type="email"
                      value={supplierForm.email}
                      onChange={(e) =>
                        setSupplierForm({
                          ...supplierForm,
                          email: e.target.value,
                        })
                      }
                      placeholder="Email"
                      className="border rounded px-3 py-2 w-full"
                    />

                    <input
                      type="text"
                      value={supplierForm.address}
                      onChange={(e) =>
                        setSupplierForm({
                          ...supplierForm,
                          address: e.target.value,
                        })
                      }
                      placeholder="Address"
                      className="border rounded px-3 py-2 w-full"
                    />

                    {editingSupplierName &&
                      canAdjustSupplierBalance && (
                        <div className="pt-2 border-t border-gray-200">
                          <label className="block font-medium mb-1">
                            Amount Paid / Balance Adjustment
                          </label>

                          <p className="text-xs text-gray-500 mb-2">
                            Applies the payment to this supplier's
                            existing outstanding purchases. It does not
                            create a new purchase or change supplier
                            credit.
                          </p>

                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={supplierForm.paymentAmount}
                            onChange={(e) =>
                              setSupplierForm({
                                ...supplierForm,
                                paymentAmount: e.target.value,
                              })
                            }
                            placeholder="0 = no adjustment"
                            className="border rounded px-3 py-2 w-full"
                          />
                        </div>
                      )}

                    <div className="flex gap-2">
                      <button
                        type="submit"
                        className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                      >
                        {editingSupplierName
                          ? 'Update Supplier'
                          : 'Save Supplier'}
                      </button>

                      {editingSupplierName && (
                        <button
                          type="button"
                          onClick={handleCancelEdit}
                          className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-100"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </form>
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border rounded-lg p-6">
            <h2 className="text-xl text-brand-green font-bold mb-4">
              Record a Purchase (restocks the product)
            </h2>

            <form
              onSubmit={handleRecordPurchase}
              className="grid grid-cols-1 md:grid-cols-7 gap-3 text-sm items-end"
            >
              <div>
                <label className="block mb-1 font-medium">
                  Supplier
                </label>

                <select
                  value={purchaseForm.supplierName}
                  onChange={(e) =>
                    setPurchaseForm({
                      ...purchaseForm,
                      supplierName: e.target.value,
                    })
                  }
                  className="border rounded px-3 py-2 w-full"
                >
                  <option value="">Select supplier</option>

                  {allSuppliers.map((s) => (
                    <option
                      key={s.supplierName}
                      value={s.supplierName}
                    >
                      {s.supplierName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">
                  Bill ID / Bill No. <span className="text-gray-500">(Optional)</span>
                </label>

                <input
                  type="text"
                  value={purchaseForm.billID}
                  onChange={(e) =>
                    setPurchaseForm((prev) => ({
                      ...prev,
                      billID: e.target.value,
                    }))
                  }
                  placeholder="Enter supplier bill / receipt number"
                  className="w-full rounded-md border px-3 py-2"
                />
              </div>
              <div>
                <label className="block mb-1 font-medium">
                  Product
                </label>

                <select
                  value={purchaseForm.productId}
                  onChange={(e) =>
                    setPurchaseForm({
                      ...purchaseForm,
                      productId: e.target.value,
                    })
                  }
                  className="border rounded px-3 py-2 w-full"
                >
                  <option value="">Select product</option>

                  {allProducts.map((p) => (
                    <option
                      key={p.productID}
                      value={p.productID}
                    >
                      {p.productID} — {p.productName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block mb-1 font-medium">
                  Quantity
                </label>

                <input
                  type="number"
                  min="1"
                  value={purchaseForm.quantity}
                  onChange={(e) =>
                    setPurchaseForm({
                      ...purchaseForm,
                      quantity: e.target.value,
                    })
                  }
                  className="border rounded px-3 py-2 w-full"
                />
              </div>

              <div>
                <label className="block mb-1 font-medium">
                  Cost / Buying Price
                </label>

                {isAdmin && purchaseForm.productId && (
                  <p className="text-xs text-gray-500 mb-1">
                    Previous cost:{' '}
                    <span className="font-medium text-gray-700">
                      {formatMoney(previousBuyingPrice ?? 0)}
                    </span>
                  </p>
                )}

                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={purchaseForm.unitCost}
                  onChange={(e) =>
                    setPurchaseForm({
                      ...purchaseForm,
                      unitCost: e.target.value,
                    })
                  }
                  className="border rounded px-3 py-2 w-full"
                />
              </div>

              <div>
                <label className="block mb-1 font-medium">
                  Retail (optional)
                </label>

                {isAdmin && purchaseForm.productId && (
                  <p className="text-xs text-gray-500 mb-1">
                    Previous retail:{' '}
                    <span className="font-medium text-gray-700">
                      {previousSellingPrice == null
                        ? 'Not set'
                        : formatMoney(previousSellingPrice)}
                    </span>
                  </p>
                )}

                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={purchaseForm.sellingPrice}
                  onChange={(e) =>
                    setPurchaseForm({
                      ...purchaseForm,
                      sellingPrice: e.target.value,
                    })
                  }
                  placeholder="Leave blank to keep unchanged"
                  className="border rounded px-3 py-2 w-full"
                />
              </div>

              <div>
                <label className="block mb-1 font-medium">
                  Amount Paid
                </label>

                <p className="text-xs text-gray-500 mb-1">
                  Auto-fills as quantity × cost — edit for a partial
                  payment or overpayment.
                  {selectedSupplierCredit > 0 &&
                    ` This supplier has ${formatMoney(
                      selectedSupplierCredit
                    )} credit — pay less if you want to use it.`}
                </p>

                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={purchaseForm.amountPaid}
                  onChange={(e) => {
                    amountPaidManualRef.current = true;
                    setPurchaseForm((prev) => ({
                      ...prev,
                      amountPaid: e.target.value,
                    }));
                  }}
                  placeholder="0 = nothing paid yet"
                  className="border rounded px-3 py-2 w-full"
                />
              </div>

              <div className="md:col-span-7">
                <button
                  type="submit"
                  className="px-4 py-2 bg-brand-green text-white rounded hover:bg-green-700"
                >
                  Record Purchase
                </button>

                <p className="text-xs text-gray-500 mt-1">
                  Optional
                </p>
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
