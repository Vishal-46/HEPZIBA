// Decimal-safe money parser: "19.99" -> 1999 cents. Returns NaN on invalid.
// Shared by billing so invoice totals are computed identically everywhere.
function moneyToCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [rs, ps = ''] = s.split('.');
  return Number(rs) * 100 + Number((ps + '00').slice(0, 2));
}

module.exports = { moneyToCents };
