/* ============================================================
   STATE
   ============================================================ */
const S = {
  rates:      {},   // Direct pair rates from Yahoo Finance: { "EUR/USD": 1.0856, ... }
  prevRates:  {},   // Previous-close pair rates from Yahoo Finance: { "EUR/USD": 1.0823, ... }
  histCache:  {},   // Sparkline data cache (7-day daily bars via YF)
  chartCache: {},   // Processed chart data cache (per pair/interval)
  yfRawCache: {},   // Raw Yahoo Finance OHLCV cache (per yfInterval)
  selected:   null, // Currently open pair config object
  interval:   "1m", // Current chart interval
  chart:      null, // Active LightweightCharts chart instance
  query:      "",
  countdown:  0,
  busy:       false,
  lastTs:     null,
};
