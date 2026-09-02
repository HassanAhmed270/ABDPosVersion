// Stage 10 — CSV/Excel export, built as a standalone, toggleable module.
//
// Nothing outside this file (and its one mount line + require in main.js)
// knows this exists. It reads through lib/reports.js — the same
// aggregation queries Stage 9's dashboard uses — so a number in an
// exported CSV always matches what the dashboard showed for the same
// range. This file adds zero new npm dependencies (see lib/csv.js).
//
// To remove the whole module: delete this file, delete lib/csv.js,
// delete the `app.use('/api/export', ...)` line (and its require) in
// main.js. lib/reports.js stays — /dashboard/load depends on it too.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { toCSV } = require('../lib/csv');
const { sendTablePDF } = require('../lib/pdf');
const {
  getDashboardSummary,
  getSalesRows,
  getRefundRows,
  getLossRows,
  getCustomerCreditRows,
  getSupplierPayableRows,
} = require('../lib/reports');

const router = express.Router();

const VALID_RANGES = ['week', 'month', 'year'];
function parseRange(query) {
  return VALID_RANGES.includes(query.range) ? query.range : 'month';
}

function sendCSV(res, filenameBase, rows, columns) {
  const csv = toCSV(rows, columns);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
  res.send(csv);
}

function isPDF(query) {
  return query.format === 'pdf';
}

// Shared by every export route below: picks CSV or PDF off ?format=pdf
// (default CSV, unchanged from before this stage) so routes/export.js
// keeps one send call per route instead of branching inline everywhere.
function sendReport(req, res, filenameBase, rows, columns, title, subtitle) {
  if (isPDF(req.query)) {
    sendTablePDF(res, filenameBase, { title, subtitle, columns, rows });
  } else {
    sendCSV(res, filenameBase, rows, columns);
  }
}

// Exports read the same money/customer/supplier data the dashboard and
// orders/suppliers screens already expose to any authenticated user, just
// reshaped for download — requireAuth (not requireAdmin) matches that
// existing access level rather than introducing a stricter one.

// GET /api/export/sales?range=week|month|year — one row per order.
router.get(
  '/sales',
  requireAuth,
  asyncHandler(async (req, res) => {
    const range = parseRange(req.query);
    const rows = await getSalesRows(range);
    sendReport(req, res, `sales-${range}`, rows, [
      { key: 'orderID', label: 'Order ID' },
      { key: 'orderDate', label: 'Order Date' },
      { key: 'customerName', label: 'Customer' },
      { key: 'cashier', label: 'Cashier' },
      { key: 'totalAmount', label: 'Total Amount' },
      { key: 'amountPaid', label: 'Amount Paid' },
      { key: 'balanceDue', label: 'Balance Due' },
      { key: 'paymentStatus', label: 'Payment Status' },
      { key: 'status', label: 'Order Status' },
    ], 'Sales Report', `Range: ${range}`);
  })
);

// GET /api/export/refunds?range=week|month|year — one row per refund action.
router.get(
  '/refunds',
  requireAuth,
  asyncHandler(async (req, res) => {
    const range = parseRange(req.query);
    const rows = await getRefundRows(range);
    sendReport(req, res, `refunds-${range}`, rows, [
      { key: 'orderID', label: 'Order ID' },
      { key: 'refundDate', label: 'Refund Date' },
      { key: 'customerName', label: 'Customer' },
      { key: 'refundAmount', label: 'Refund Amount' },
      { key: 'itemCount', label: 'Items Refunded' },
      { key: 'reason', label: 'Reason' },
      { key: 'processedBy', label: 'Processed By' },
    ], 'Refunds Report', `Range: ${range}`);
  })
);

// GET /api/export/losses?range=week|month|year — one row per Deduct
// Stock write-off (Stage 9b). "Returned to Supplier" deductions never
// appear here — see models/Loss.js.
router.get(
  '/losses',
  requireAuth,
  asyncHandler(async (req, res) => {
    const range = parseRange(req.query);
    const rows = await getLossRows(range);
    sendReport(req, res, `losses-${range}`, rows, [
      { key: 'productID', label: 'Product ID' },
      { key: 'productName', label: 'Product' },
      { key: 'quantity', label: 'Quantity' },
      { key: 'costValue', label: 'Cost Value' },
      { key: 'reason', label: 'Reason' },
      { key: 'note', label: 'Note' },
      { key: 'actor', label: 'Recorded By' },
      { key: 'date', label: 'Date' },
    ], 'Losses Report', `Range: ${range}`);
  })
);

// GET /api/export/credit — snapshot, not date-scoped (matches the
// dashboard's "as of now" convention for outstanding balances).
router.get(
  '/credit',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await getCustomerCreditRows();
    sendReport(req, res, 'customer-credit', rows, [
      { key: 'customerName', label: 'Customer' },
      { key: 'mobileNo', label: 'Mobile No' },
      { key: 'orderNo', label: 'Order No' },
      { key: 'orderDate', label: 'Order Date' },
      { key: 'totalAmount', label: 'Total Amount' },
      { key: 'amountPaid', label: 'Amount Paid' },
      { key: 'balanceDue', label: 'Balance Due' },
    ], 'Customer Credit Report', 'Snapshot, as of now');
  })
);

// GET /api/export/payables — snapshot mirror of /credit for suppliers.
router.get(
  '/payables',
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await getSupplierPayableRows();
    sendReport(req, res, 'supplier-payables', rows, [
      { key: 'supplierName', label: 'Supplier' },
      { key: 'phone', label: 'Phone' },
      { key: 'purchaseID', label: 'Purchase ID' },
      { key: 'date', label: 'Purchase Date' },
      { key: 'totalAmount', label: 'Total Amount' },
      { key: 'amountPaid', label: 'Amount Paid' },
      { key: 'balanceDue', label: 'Balance Due' },
    ], 'Supplier Payables Report', 'Snapshot, as of now');
  })
);

// GET /api/export/summary?range=week|month|year — single-row snapshot of
// the same headline numbers the dashboard shows, for a quick management
// export without the line-item detail of /sales.
router.get(
  '/summary',
  requireAuth,
  asyncHandler(async (req, res) => {
    const range = parseRange(req.query);
    const summary = await getDashboardSummary(range);
    sendReport(req, res, `summary-${range}`, [summary], [
      { key: 'range', label: 'Range' },
      { key: 'overallSales', label: 'Total Sales' },
      { key: 'totalProfit', label: 'Total Profit' },
      { key: 'totalCostOfGoodsSold', label: 'Total Cost of Goods Sold' },
      { key: 'unknownCostUnits', label: 'Units Sold With Unknown Cost' },
      { key: 'totalOrders', label: 'Total Orders' },
      { key: 'refundedOrders', label: 'Refunded Orders' },
      { key: 'refundedAmount', label: 'Refunded Amount' },
      { key: 'exchangedOrders', label: 'Exchanged Orders' },
      { key: 'totalCustomerCreditOutstanding', label: 'Customer Credit Outstanding' },
      { key: 'totalSupplierPayable', label: 'Supplier Payable' },
      { key: 'totalLosses', label: 'Loss Entries' },
      { key: 'totalLossValue', label: 'Loss Value' },
    ], 'Summary Report', `Range: ${range}`);
  })
);

module.exports = router;
