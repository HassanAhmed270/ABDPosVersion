// Single place currency math happens. Always parseFloat (never parseInt —
// that silently truncates $19.99 to $19) and always round to 2dp before
// anything is displayed or written to the DB, so a value can't drift
// through a chain of additions/percentage calcs and land on a fraction
// of a cent.
function roundMoney(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = { roundMoney };