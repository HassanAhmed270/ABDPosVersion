export function printReceipt(html) {
  const printWindow = window.open('', '', 'width=420,height=700');

  if (!printWindow) {
    throw new Error(
      'Unable to open print window. Please allow pop-ups for this site.'
    );
  }

  printWindow.document.write(`
    <html>
      <head>
        <title>Print Receipt</title>
        <style>
          body {
            font-family: ui-monospace, monospace;
            padding: 16px;
            margin: 0;
          }

          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
          }

          th,
          td {
            border: 1px solid #ddd;
            padding: 4px 6px;
            text-align: left;
          }

          .totals {
            display: flex;
            justify-content: space-between;
            font-weight: bold;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid #ddd;
          }

          .edit-history {
            width: 100%;
            max-width: 300px;
            margin: 12px auto 0;
            padding-top: 6px;
            border-top: 1px dashed #999;
            box-sizing: border-box;
            overflow: hidden;
          }

          .edit-history h3 {
            margin: 0 0 4px;
            font-size: 9px;
            line-height: 1.2;
          }

          .edit-history table {
            width: 100%;
            max-width: 300px;
            table-layout: fixed;
            border-collapse: collapse;
            font-size: 7px;
            line-height: 1.2;
          }

          .edit-history th,
          .edit-history td {
            border: 1px solid #ccc;
            padding: 2px;
            text-align: center;
            vertical-align: middle;
            white-space: normal;
            overflow-wrap: anywhere;
            word-break: break-word;
          }

          .edit-history th {
            font-weight: bold;
          }

          .receipt {
            width: 100%;
            max-width: 300px;
            margin: 0 auto;
            font-size: 12px;
            line-height: 1.45;
          }

          .receipt .shop-name {
            text-align: center;
            font-weight: bold;
            font-size: 16px;
            letter-spacing: 0.5px;
          }

          .receipt .shop-line {
            text-align: center;
          }

          .receipt .sep {
            border: none;
            border-top: 1px dashed #000;
            margin: 6px 0;
          }

          .receipt .sep-solid {
            border: none;
            border-top: 2px solid #000;
            margin: 6px 0;
          }

          .receipt .meta-row {
            display: flex;
            justify-content: space-between;
            gap: 8px;
          }

          .receipt .offline-banner {
            text-align: center;
            font-weight: 700;
            color: #b45309;
            margin: 4px 0;
          }

          .receipt table.items {
            width: 100%;
            border-collapse: collapse;
            font-size: 9px;
            table-layout: fixed;
          }

          .receipt table.items .col-item {
            width: 40%;
          }

          .receipt table.items .col-retail {
            width: 17%;
          }

          .receipt table.items .col-rate {
            width: 17%;
          }

          .receipt table.items .col-qty {
            width: 9%;
          }

          .receipt table.items .col-total {
            width: 17%;
          }

          .receipt table.items th,
          .receipt table.items td {
            border: none;
            padding: 1px 2px;
            text-align: right;
            vertical-align: middle;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .receipt table.items th:first-child,
          .receipt table.items td:first-child {
            text-align: left;
          }

          .receipt table.items thead th {
            border-bottom: 1px dashed #000;
            padding-bottom: 3px;
            font-weight: bold;
          }

          .receipt table.items td.item-name {
            text-align: left;
            font-weight: 600;
            padding-top: 4px;
          }

          .receipt table.items tbody tr:first-child td {
            padding-top: 4px;
          }

          .receipt .totals-row {
            display: flex;
            justify-content: space-between;
            font-size: 10px;
            line-height: 1.4;
          }

          .receipt .totals-row.grand {
            font-weight: bold;
            font-size: 11px;
          }

          .receipt .footer {
            text-align: center;
            font-weight: bold;
            font-size: 11px;
            margin-top: 8px;
          }

          @media print {
            @page {
              margin: 6mm;
            }

            body {
              padding: 0;
            }

            .receipt {
              width: 100%;
              max-width: 300px;
            }

            .edit-history {
              max-width: 300px;
            }

            .edit-history table {
              max-width: 300px;
            }
          }
        </style>
      </head>
      <body>${html}</body>
    </html>
  `);

  printWindow.document.close();

  printWindow.onload = () => {
    printWindow.focus();
    printWindow.print();
    printWindow.onafterprint = () => printWindow.close();
  };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatReceiptMoney(value) {
  return String(value ?? 0);
}

export function formatReceiptDate(date) {
  return `${pad2(date.getDate())}-${pad2(date.getMonth() + 1)}-${date.getFullYear()}`;
}

export function formatReceiptTime(date) {
  let hours = date.getHours();
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  const ampm = hours >= 12 ? 'PM' : 'AM';

  hours = hours % 12 || 12;

  return `${pad2(hours)}:${minutes}:${seconds} ${ampm}`;
}

export function buildReceiptHtml({
  shopName,
  shopAddress,
  shopPhone,
  billId,
  offline,
  customerName,
  customerAddress,
  items,
  grandTotalLabel,
  paidLabel,
  settlementLabel,
  settlementAmountLabel
}) {
  const now = new Date();

  const itemRows = items
    .map(
      (item) => `
        <tr>
          <td class="item-name">${item.itemName}</td>
          <td>${formatReceiptMoney(item.retailLabel)}</td>
          <td>${formatReceiptMoney(item.rateLabel)}</td>
          <td>${item.qty}</td>
          <td>${formatReceiptMoney(item.totalLabel)}</td>
        </tr>
      `
    )
    .join('');

  return `
    <div class="receipt">
      <div class="shop-name">${shopName}</div>
      <div class="shop-line">${shopAddress}</div>
      <div class="shop-line">Phone: ${shopPhone}</div>

      <hr class="sep-solid" />

      <div class="meta-row">
        <span>Invoice: ${billId}</span>
        <span>${formatReceiptDate(now)}</span>
      </div>

      <div class="meta-row">
        <span>Time: ${formatReceiptTime(now)}</span>
      </div>

      <div>Customer Name: ${customerName}</div>

      ${
        customerAddress
          ? `<div>Address: ${customerAddress}</div>`
          : ''
      }

      ${
        offline
          ? '<div class="offline-banner">OFFLINE — PENDING SYNC (not yet confirmed)</div>'
          : ''
      }

      <hr class="sep" />

      <table class="items">
        <colgroup>
          <col class="col-item" />
          <col class="col-retail" />
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
        <span>${formatReceiptMoney(grandTotalLabel)}</span>
      </div>

      <div class="totals-row">
        <span>Paid</span>
        <span>${formatReceiptMoney(paidLabel)}</span>
      </div>

      <div class="totals-row">
        <span>${settlementLabel}</span>
        <span>${formatReceiptMoney(settlementAmountLabel)}</span>
      </div>

      <hr class="sep-solid" />

      <div class="footer">
        THANK YOU! VISIT AGAIN
      </div>
    </div>
  `;
}