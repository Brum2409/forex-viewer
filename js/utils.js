/* ============================================================
   UTILITIES
   ============================================================ */

// Given USD-base rates: A/B = rates[B] / rates[A]
function calcRate(r, f, t) {
  const rf = f === "USD" ? 1 : r[f];
  const rt = t === "USD" ? 1 : r[t];
  if (!rf || !rt) return null;
  return rt / rf;
}

// Format a rate value with appropriate decimal places
function fmt(rate, f, t) {
  if (rate == null) return "—";
  const isJPY = f === "JPY" || t === "JPY";
  const isINR = f === "INR" || t === "INR";
  const isLarge = rate >= 100;
  if (isJPY || (isLarge && isINR)) return rate.toFixed(3);
  if (isLarge) return rate.toFixed(4);
  return rate.toFixed(5);
}

function isoDate(d) { return d.toISOString().slice(0,10); }
