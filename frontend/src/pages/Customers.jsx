import { useEffect, useState } from 'react';

import { toast } from 'sonner';

import Sidebar from '../components/Sidebar';

import Topbar from '../components/Topbar';

import SortableHeader from '../components/SortableHeader';

import Pagination from '../components/Pagination';

import { api } from '../lib/api';

import { formatMoney, roundMoney } from '../lib/money';

import { useDebouncedValue } from '../lib/useDebouncedValue';

import { useConfirm } from '../components/ConfirmDialog';

const emptyForm = {
  customerName: '',
  mobileNo: '',
  emergencyMobile: '',
  email: '',
  address: '',
  paymentAmount: '',
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PAGE_SIZE = 10;

export default function Customers() {
  const confirm = useConfirm();

  const [customers, setCustomers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  const [sortBy, setSortBy] = useState('customerName');
  const [sortDir, setSortDir] = useState('asc');

  const [page, setPage] = useState(1);

  const [mode, setMode] = useState('add');
  const [selectedName, setSelectedName] = useState(null);

  const [form, setForm] = useState(emptyForm);

  const [undoStack, setUndoStack] = useState([]);
  const [showUndo, setShowUndo] = useState(false);

  const loadCustomers = async () => {
    setLoading(true);

    try {
      console.log('[CUSTOMERS] Loading customers...');

      const data = await api.getCustomers({
        search: debouncedSearch,
        sortBy,
        sortDir,
        page,
        limit: PAGE_SIZE,
      });

      console.log('[CUSTOMERS] API response:', data);

      const selectedCustomer = (data.customers || []).find(
        (c) => c.customerName === selectedName
      );

      console.log(
        '[CUSTOMERS] Selected customer returned balance:',
        selectedCustomer?.accountBalance
      );

      setCustomers(data.customers || []);
      setTotal(data.total || 0);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCustomers();

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

  const resetForm = () => {
    setForm(emptyForm);
    setMode('add');
    setSelectedName(null);
  };

  const handleSelectForUpdate = (c) => {
    setSelectedName(c.customerName);
    setMode('update');

    setForm({
      customerName: c.customerName,
      mobileNo: c.mobileNo || '',
      emergencyMobile: c.emergencyMobile || '',
      email: c.email || '',
      address: c.address || '',
      paymentAmount: '',
    });
  };

  const validate = () => {
    const {
      customerName,
      mobileNo,
      emergencyMobile,
      email,
      address,
      paymentAmount,
    } = form;

    if (
      !customerName &&
      !mobileNo &&
      !emergencyMobile &&
      !email &&
      !address
    ) {
      toast.error('Please fill the required fields.');
      return false;
    }

    if (email && !emailPattern.test(email)) {
      toast.error('Please enter a valid email address.');
      return false;
    }

    if (
      mode === 'update' &&
      paymentAmount !== '' &&
      (!Number.isFinite(Number(paymentAmount)) ||
        Number(paymentAmount) < 0)
    ) {
      toast.error('Payment amount must be a valid non-negative amount.');
      return false;
    }

    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!validate()) return;

    const payload = {
      customerName: form.customerName.trim().replace(/\s+/g, ' '),
      mobileNo: form.mobileNo,
      emergencyMobile: form.emergencyMobile,
      email: form.email,
      address: form.address,
    };

    if (mode === 'update') {
      payload.paymentAmount =
        form.paymentAmount === '' ? 0 : Number(form.paymentAmount);
    }

    console.log(
      '[CUSTOMER FRONTEND] Sending update payload:',
      payload
    );

    try {
      if (mode === 'add') {
        const data = await api.addCustomer(payload);

        if (!data.success) {
          throw new Error(
            data.message || 'Failed to add customer'
          );
        }

        toast.success('New customer added successfully!');
      } else {
        console.log(
          '[CUSTOMER FRONTEND] Payment amount being sent:',
          payload.paymentAmount
        );

        const data = await api.updateCustomer(payload);

        console.log(
          '[CUSTOMER FRONTEND] Update response:',
          data
        );

        console.log(
          '[CUSTOMER FRONTEND] Returned accountBalance:',
          data?.customer?.accountBalance
        );

        if (!data.success) {
          throw new Error(
            data.message || 'Failed to update customer'
          );
        }

        toast.success('Customer updated successfully!');
      }

      await loadCustomers();

      resetForm();
    } catch (err) {
      console.error('[CUSTOMER FRONTEND] Update failed:', err);
      toast.error(err.message);
    }
  };

  const handleDelete = async (c) => {
    if (!(await confirm(`Delete customer ${c.customerName}?`))) {
      return;
    }

    try {
      const data = await api.deleteCustomer(c.customerName);

      if (!data.success) {
        throw new Error(
          data.message || 'Failed to delete customer'
        );
      }

      setUndoStack((s) => [...s, { ...c }]);

      await loadCustomers();

      setShowUndo(true);

      setTimeout(() => setShowUndo(false), 5000);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleUndo = async () => {
    if (undoStack.length === 0) return;

    const last = undoStack[undoStack.length - 1];

    try {
      const data = await api.undoCustomer(last);

      if (!data.success) {
        throw new Error(
          data.message || 'Failed to restore customer'
        );
      }

      setUndoStack((s) => s.slice(0, -1));

      setShowUndo(false);

      await loadCustomers();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="flex h-screen">
      <Sidebar />

      <main className="w-full flex flex-col overflow-hidden">
        <Topbar title="Customer Management" />

        <div className="p-4 overflow-y-auto flex-1">
          <div className="bg-white rounded-lg shadow p-4 w-full">
            <div className="flex flex-wrap text-sm justify-between items-center mb-4 px-4 py-2 gap-2">
              <div className="flex gap-2">
                <button
                  onClick={() => setMode('add')}
                  className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
                >
                  New Customer
                </button>

                {showUndo && (
                  <button
                    onClick={handleUndo}
                    className="bg-blue-400 text-white px-4 py-2 rounded-md hover:bg-blue-500"
                  >
                    Undo
                  </button>
                )}
              </div>

              <input
                type="text"
                placeholder="Search customers..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="border rounded-md px-3 py-2 w-full @min-[640px]:w-64"
              />
            </div>

            {error && (
              <p className="text-red-600 text-sm px-4">
                {error}
              </p>
            )}

            <div className="bg-white border rounded-lg w-full p-2">
              <div className="flex flex-col @min-[1024px]:flex-row @min-[1024px]:h-[560px]">
                <div className="w-full @min-[1024px]:w-2/3 flex flex-col">
                  <div className="overflow-x-auto @min-[1024px]:overflow-y-auto px-4 flex-1">
                    <table className="w-full min-w-[850px] text-sm">
                      <thead>
                        <tr className="border-b bg-gray-100">
                          <SortableHeader
                            label="ID"
                            field="customerID"
                            sortBy={sortBy}
                            sortDir={sortDir}
                            onSort={handleSort}
                          />

                          <SortableHeader
                            label="Name"
                            field="customerName"
                            sortBy={sortBy}
                            sortDir={sortDir}
                            onSort={handleSort}
                          />

                          <th className="p-2 text-left">
                            Mobile
                          </th>

                          <th className="p-2 text-left">
                            Second No
                          </th>

                          <th className="p-2 text-left">
                            Email
                          </th>

                          <th className="p-2 text-left">
                            Address
                          </th>

                          <SortableHeader
                            label="Balance"
                            field="accountBalance"
                            sortBy={sortBy}
                            sortDir={sortDir}
                            onSort={handleSort}
                            align="right"
                          />

                          <th className="p-2 text-left">
                            Actions
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {loading ? (
                          <tr>
                            <td
                              colSpan={8}
                              className="py-6 text-center text-gray-400"
                            >
                              Loading…
                            </td>
                          </tr>
                        ) : customers.length === 0 ? (
                          <tr>
                            <td
                              colSpan={8}
                              className="py-6 text-center text-gray-400"
                            >
                              No customers found
                            </td>
                          </tr>
                        ) : (
                          customers.map((c) => (
                            <tr
                              key={c.customerID || c.customerName}
                              className={`border-b hover:bg-gray-50 ${
                                selectedName === c.customerName
                                  ? 'bg-blue-50'
                                  : ''
                              }`}
                            >
                              <td className="py-2 px-3 font-medium">
                                {c.customerID || '—'}
                              </td>

                              <td className="py-2 px-3">
                                {c.customerName}
                              </td>

                              <td className="py-2 px-3">
                                {c.mobileNo}
                              </td>

                              <td className="py-2 px-3">
                                {c.emergencyMobile}
                              </td>

                              <td className="py-2 px-3">
                                {c.email}
                              </td>

                              <td className="py-2 px-3">
                                {c.address}
                              </td>

                              <td className="py-2 px-3 text-right font-semibold">
                                {(() => {
                                  const netBalance = roundMoney(
                                    c.accountBalance || 0
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
                                        +{formatMoney(-netBalance)}
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

                              <td className="py-2 px-3 flex gap-2">
                                <button
                                  onClick={() =>
                                    handleSelectForUpdate(c)
                                  }
                                  className="text-blue-600 hover:text-blue-800"
                                  title="Edit"
                                >
                                  ✏️
                                </button>

                                <button
                                  onClick={() =>
                                    handleDelete(c)
                                  }
                                  className="text-red-600 hover:text-red-800"
                                  title="Delete"
                                >
                                  🗑️
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  <Pagination
                    page={page}
                    limit={PAGE_SIZE}
                    total={total}
                    onPageChange={setPage}
                  />
                </div>

                <div className="w-full @min-[1024px]:w-1/3 px-4 @min-[640px]:px-10 py-6 border-t-4 @min-[1024px]:border-t-0 @min-[1024px]:border-l-4 border-gray-300 @min-[1024px]:overflow-y-auto">
                  <h2
                    className={`text-2xl flex justify-center font-bold mb-2 ${
                      mode === 'add'
                        ? 'text-blue-600'
                        : 'text-yellow-600'
                    }`}
                  >
                    {mode === 'add'
                      ? 'Add New Customer'
                      : 'Update Customer'}
                  </h2>

                  <form
                    onSubmit={handleSubmit}
                    className="space-y-2 w-full text-sm"
                  >
                    <div>
                      <label className="block mb-1 font-medium">
                        Name
                      </label>

                      <input
                        type="text"
                        disabled={mode === 'update'}
                        value={form.customerName}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            customerName: e.target.value,
                          })
                        }
                        placeholder="Enter customer name"
                        className="border rounded px-3 py-1.5 bg-gray-100 w-full disabled:opacity-70"
                      />
                    </div>

                    <div>
                      <label className="block mb-1 font-medium">
                        Mobile
                      </label>

                      <input
                        type="text"
                        value={form.mobileNo}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            mobileNo: e.target.value,
                          })
                        }
                        placeholder="Enter mobile number"
                        className="border rounded px-3 py-1.5 w-full"
                      />
                    </div>

                    <div>
                      <label className="block mb-1 font-medium">
                        Second No
                      </label>

                      <input
                        type="text"
                        value={form.emergencyMobile}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            emergencyMobile: e.target.value,
                          })
                        }
                        placeholder="Enter second number"
                        className="border rounded px-3 py-1.5 w-full"
                      />
                    </div>

                    <div>
                      <label className="block mb-1 font-medium">
                        Email
                      </label>

                      <input
                        type="email"
                        value={form.email}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            email: e.target.value,
                          })
                        }
                        placeholder="Enter email"
                        className="border rounded px-3 py-1.5 w-full"
                      />
                    </div>

                    <div>
                      <label className="block mb-1 font-medium">
                        Address
                      </label>

                      <input
                        type="text"
                        value={form.address}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            address: e.target.value,
                          })
                        }
                        placeholder="Enter address"
                        className="border rounded px-3 py-1.5 w-full"
                      />
                    </div>

                    {mode === 'update' && (
                      <div>
                        <label className="block mb-1 font-medium">
                          Payment
                        </label>

                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={form.paymentAmount}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              paymentAmount: e.target.value,
                            })
                          }
                          placeholder="Enter payment amount"
                          className="border rounded px-3 py-1.5 w-full"
                        />
                      </div>
                    )}

                    <div className="flex gap-2 pt-2">
                      <button
                        type="submit"
                        className={`px-4 py-1.5 text-white rounded ${
                          mode === 'add'
                            ? 'bg-blue-600 hover:bg-blue-700'
                            : 'bg-yellow-600 hover:bg-yellow-700'
                        }`}
                      >
                        {mode === 'add'
                          ? 'Add Customer'
                          : 'Update'}
                      </button>

                      {mode === 'update' && (
                        <button
                          type="button"
                          onClick={resetForm}
                          className="px-4 py-1.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </form>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}