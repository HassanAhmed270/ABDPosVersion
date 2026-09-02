// Minimal CSV writer — deliberately dependency-free. Stage 10's exit
// criteria is "removable without touching core code"; not pulling in an
// npm package for this means the export module is just files that can be
// deleted, with nothing added to package.json for the rest of the app to
// carry around.
//
// Output is standard RFC 4180 CSV (comma-separated, CRLF line endings,
// double-quote escaping) — opens cleanly in Excel, Google Sheets, and
// Numbers, which is what "CSV/Excel export" means in practice without a
// binary .xlsx writer.

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// rows: array of plain objects. columns: [{ key, label }] — controls both
// column order and the header row text, independent of key names.
function toCSV(rows, columns) {
  const header = columns.map((c) => escapeCell(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => escapeCell(row[c.key])).join(','));
  return [header, ...body].join('\r\n') + '\r\n';
}

module.exports = { toCSV };
