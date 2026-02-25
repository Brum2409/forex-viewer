/* ============================================================
   STATE
   ============================================================ */
const S = {
  rates:      {},   // USD-base rates from open.er-api
  prevRates:  {},   // Previous-close rates from Frankfurter
  histCache:  {},   // Frankfurter sparkline cache
  chartCache: {},   // Processed chart data cache (per interval)
  yfRawCache: {},   // Raw Yahoo Finance OHLCV cache (per yfInterval)
  selected:   null, // currently open pair config object
  interval:   "1m", // current chart interval
  chart:      null,
  query:      "",
  countdown:  0,
  busy:       false,
  lastTs:     null,
};
