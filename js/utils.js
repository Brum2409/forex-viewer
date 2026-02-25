/* ============================================================
   UTILITIES
   ============================================================ */

// Rates are stored as direct pair rates: { "EUR/USD": 1.0856, ... }
function calcRate(r, f, t) {
  return r[`${f}/${t}`] ?? null;
}

// Format a rate value with appropriate decimal places
function fmt(rate, f, t) {
  if (rate == null) return "—";
  const isJPY   = f === "JPY" || t === "JPY";
  const isINR   = f === "INR" || t === "INR";
  const isLarge = rate >= 100;
  if (isJPY || (isLarge && isINR)) return rate.toFixed(3);
  if (isLarge) return rate.toFixed(4);
  return rate.toFixed(5);
}

function isoDate(d) { return d.toISOString().slice(0, 10); }
