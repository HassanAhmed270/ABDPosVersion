import { useEffect, useState } from 'react';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import { useAuth } from '../lib/AuthContext';
import { api } from '../lib/api';
import { formatMoney } from '../lib/money';

const StatCard = ({ label, value, accent, hint }) => (
  <div className={`p-4 bg-white rounded-lg shadow border-t-4 ${accent}`}>
    <p className="text-sm text-gray-500">{label}</p>
    <p className="text-xl font-bold">{value}</p>
    {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
  </div>
);

const RANGE_LABEL = { week: 'this week', month: 'this month', year: 'this year' };

export default function Dashboard() {
  const { username } = useAuth();
  const [range, setRange] = useState('month');
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getDashboard(range)
      .then((data) => {
        if (!data.success) throw new Error('Dashboard API failed');
        setDashboard(data.dashboard);
      })
      .catch((err) => setError(err.message || 'Failed to load dashboard'));
  }, [range]);

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <Topbar title="Dashboard" />
        <main className="p-4 @min-[768px]:p-6 space-y-6 overflow-y-auto">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-2xl @min-[640px]:text-3xl font-semibold text-brand">Welcome back, {username}!</h2>
              <p className="text-gray-600">Here's a quick overview of your business {RANGE_LABEL[range]}.</p>
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

          <div className="grid grid-cols-1 @min-[640px]:grid-cols-2 @min-[768px]:grid-cols-5 gap-4 @min-[640px]:gap-6">
            <StatCard
              label="Total Sales"
              value={dashboard ? formatMoney(dashboard.overallSales) : '--'}
              accent="border-brand"
              hint="Net of exchanges & refunds"
            />
            <StatCard
              label="Total Profit"
              value={dashboard ? formatMoney(dashboard.totalProfit) : '--'}
              accent="border-brand-green"
              hint={
                dashboard?.unknownCostUnits > 0
                  ? `${dashboard.unknownCostUnits} unit(s) sold have no recorded cost, excluded`
                  : 'From batch/FIFO cost records'
              }
            />
            <StatCard
              label="Total Orders"
              value={dashboard ? dashboard.totalOrders : '--'}
              accent="border-brand-green"
            />
            <StatCard
              label="Total Customers"
              value={dashboard ? dashboard.totalCustomers : '--'}
              accent="border-brand-green"
            />
            <StatCard
              label="Products Sold"
              value={dashboard ? dashboard.totalProducts : '--'}
              accent="border-brand"
            />
          </div>

          <div className="grid grid-cols-1 @min-[640px]:grid-cols-2 @min-[768px]:grid-cols-5 gap-4 @min-[640px]:gap-6">
            <StatCard
              label="Refunded Orders"
              value={dashboard ? dashboard.refundedOrders : '--'}
              accent="border-red-400"
              hint={dashboard ? `${formatMoney(dashboard.refundedAmount)} refunded` : undefined}
            />
            <StatCard
              label="Exchanged Orders"
              value={dashboard ? dashboard.exchangedOrders : '--'}
              accent="border-yellow-400"
              hint="Line-item edits, not refunds"
            />
            <StatCard
              label="Customer Credit Outstanding"
              value={dashboard ? formatMoney(dashboard.totalCustomerCreditOutstanding) : '--'}
              accent="border-orange-400"
              hint="As of now, all customers"
            />
            <StatCard
              label="Supplier Payable"
              value={dashboard ? formatMoney(dashboard.totalSupplierPayable) : '--'}
              accent="border-purple-400"
              hint="As of now, all suppliers"
            />
            <StatCard
              label="Losses"
              value={dashboard ? dashboard.totalLosses : '--'}
              accent="border-red-400"
              hint={dashboard ? `${formatMoney(dashboard.totalLossValue)} written off` : 'Expired/Damaged/Discontinued'}
            />
            <StatCard
              label="Offline Sales"
              value={dashboard ? dashboard.offlineOrders : '--'}
              accent="border-yellow-400"
              hint="Made offline, synced since"
            />
          </div>

          <div className="p-4 @min-[640px]:p-6 bg-white rounded-lg shadow overflow-x-auto">
            <h3 className="font-medium text-lg mb-4 text-brand">Customer Sales ({RANGE_LABEL[range]})</h3>
            <table className="w-full text-sm border border-gray-200 rounded overflow-hidden">
              <thead className="bg-brand text-white">
                <tr>
                  <th className="px-4 py-2 border border-gray-200">Customer</th>
                  <th className="px-4 py-2 border border-gray-200">Total Sales</th>
                </tr>
              </thead>
              <tbody>
                {dashboard?.customerSales?.length ? (
                  dashboard.customerSales.map((c) => (
                    <tr key={c._id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 border border-gray-200">{c._id}</td>
                      <td className="px-4 py-2 border border-gray-200">{formatMoney(c.total)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={2} className="px-4 py-3 text-center text-gray-400">
                      No sales yet {RANGE_LABEL[range]}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="p-4 @min-[640px]:p-6 bg-white rounded-lg shadow overflow-x-auto">
            <h3 className="font-medium text-lg mb-4 text-brand-green">Product Sales ({RANGE_LABEL[range]})</h3>
            <table className="w-full text-sm border border-gray-200 rounded overflow-hidden">
              <thead className="bg-brand-green text-white">
                <tr>
                  <th className="px-4 py-2 border border-gray-200">Product Code</th>
                  <th className="px-4 py-2 border border-gray-200">Product Name</th>
                  <th className="px-4 py-2 border border-gray-200">Quantity Sold</th>
                  <th className="px-4 py-2 border border-gray-200">Revenue</th>
                </tr>
              </thead>
              <tbody>
                
                
                {dashboard?.productSales?.length ? (
                  dashboard.productSales.map((p) => (
                    <tr key={p._id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 border border-gray-200">{p._id}</td>
                      <td className="px-4 py-2 border border-gray-200">{p.productName}</td>
                      <td className="px-4 py-2 border border-gray-200">{p.totalQuantity}</td>
                      <td className="px-4 py-2 border border-gray-200">{formatMoney(p.totalRevenue)}</td>
                    </tr>
                    
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="px-4 py-3 text-center text-gray-400">
                      No product sales yet {RANGE_LABEL[range]}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </main>
      </div>
    </div>
  );
}