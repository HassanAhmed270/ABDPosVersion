const PDFDocument = require('pdfkit');

function columnWidths(columns, totalWidth) {
  const n = columns.length;
  const w = Math.floor(totalWidth / n);
  return columns.map(() => w);
}

function sendTablePDF(res, filenameBase, { title, subtitle, columns, rows }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
  doc.pipe(res);

  doc.fontSize(16).text(title, { align: 'left' });
  if (subtitle) doc.fontSize(10).fillColor('#555').text(subtitle);
  doc.moveDown(1);

  const tableLeft = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const widths = columnWidths(columns, tableWidth);
  const rowHeight = 20;

  function drawRow(values, y, isHeader) {
    let x = tableLeft;
    doc.fontSize(9).fillColor(isHeader ? '#ffffff' : '#000000');
    if (isHeader) {
      doc.rect(tableLeft, y, tableWidth, rowHeight).fill('#333333');
      doc.fillColor('#ffffff');
    }
    values.forEach((v, i) => {
      doc.text(v === null || v === undefined ? '' : String(v), x + 4, y + 5, {
        width: widths[i] - 8,
        ellipsis: true,
      });
      x += widths[i];
    });
  }

  let y = doc.y;
  drawRow(columns.map((c) => c.label), y, true);
  y += rowHeight;

  if (rows.length === 0) {
    doc.fontSize(10).fillColor('#555').text('No data for this range.', tableLeft, y + 5);
  } else {
    rows.forEach((row) => {
      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
        drawRow(columns.map((c) => c.label), y, true);
        y += rowHeight;
      }
      drawRow(columns.map((c) => row[c.key]), y, false);
      y += rowHeight;
    });
  }

  doc.end();
}

module.exports = { sendTablePDF };
