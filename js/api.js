/* ============================================================
   CORS PROXIES  (Yahoo Finance blocks direct browser requests)
   Tried in order; first successful response is used.
   ============================================================ */
const CORS_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

async function fetchWithCorsProxy(url) {
  let lastErr;
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetch(proxy(url));
      if (res.ok) return res;
      lastErr = new Error(`Proxy returned HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("All CORS proxies failed");
}

/* ============================================================
   DATA AGGREGATION
   ============================================================ */
function aggregateData(rawPoints, groupMins) {
  if (groupMins <= 1) {
    return rawPoints.map(p => ({
      ts: p.ts, rate: p.price,
      open: p.open ?? p.price, high: p.high ?? p.price, low: p.low ?? p.price,
    }));
  }

  const groupMs = groupMins * 60_000;
  const buckets = new Map();

  rawPoints.forEach(p => {
    const bts = Math.floor(p.ts / groupMs) * groupMs;
    // Use actual OHLC fields when available (e.g. 5min source bars); fall
    // back to close price for sources that only carry a single price value
    // (e.g. Frankfurter daily data used for 1W candles).
    const hi = p.high ?? p.price;
    const lo = p.low  ?? p.price;
    if (!buckets.has(bts)) {
      buckets.set(bts, { ts: bts, open: p.open ?? p.price, high: hi, low: lo, close: p.price });
    } else {
      const b = buckets.get(bts);
      if (hi > b.high) b.high = hi;
      if (lo < b.low)  b.low  = lo;
      b.close = p.price;
    }
  });

  return Array.from(buckets.values())
    .sort((a, b) => a.ts - b.ts)
    .map(b => ({ ts: b.ts, rate: b.close, open: b.open, high: b.high, low: b.low }));
}

/* ============================================================
   CHART LABEL FORMATTER
   ============================================================ */
function fmtChartLabel(ts, interval) {
  const d = new Date(ts);
  if (['1m','5m','15m','30m'].includes(interval)) {
    return d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12: false });
  }
  if (['1h','2h','4h'].includes(interval)) {
    const date = d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12: false });
    return `${date} ${time}`;
  }
  if (interval === '1D') return d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
  // 1W
  return d.toLocaleDateString('en-US', { month:'short', year:'2-digit' });
}

/* ============================================================
   YAHOO FINANCE — INTRADAY CHART DATA  (1m – 4h)
   No API key required. Uses CORS proxies to bypass browser
   same-origin restrictions on query1.finance.yahoo.com.
   2h and 4h share the 1h fetch and aggregate client-side.
   ============================================================ */
async function fetchYahooFinanceChart(f, t, interval) {
  const cacheKey = `${f}/${t}/${interval}`;
  const cached   = S.chartCache[cacheKey];
  const ttl      = CACHE_TTL[interval] || 300_000;
  if (cached && Date.now() - cached.ts < ttl) return cached.data;

  const { yfInterval, yfRange, groupMins } = INTERVAL_CONFIG[interval];
  const yfGroupMins = { "1m":1, "5m":5, "15m":15, "30m":30, "1h":60 }[yfInterval] || 1;

  // 2h and 4h share the same 1h raw fetch
  const rawKey = `${f}/${t}/${yfInterval}`;
  const RAW_TTL = 5 * 60_000; // 5 min
  let rawPoints;

  if (S.yfRawCache[rawKey] && Date.now() - S.yfRawCache[rawKey].ts < RAW_TTL) {
    rawPoints = S.yfRawCache[rawKey].data;
  } else {
    const symbol = `${f}${t}=X`;
    const yfUrl  = `https://query1.finance.yahoo.com/v8/finance/chart/`
                 + `${encodeURIComponent(symbol)}`
                 + `?interval=${yfInterval}&range=${yfRange}`;

    const res = await fetchWithCorsProxy(yfUrl);
    if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);
    const j = await res.json();

    if (j.chart?.error) throw new Error(j.chart.error.description || "Yahoo Finance error");
    const result = j.chart?.result?.[0];
    if (!result) throw new Error("No data from Yahoo Finance");

    const timestamps = result.timestamp || [];
    const quote  = result.indicators?.quote?.[0] || {};
    const opens  = quote.open  || [];
    const highs  = quote.high  || [];
    const lows   = quote.low   || [];
    const closes = quote.close || [];

    rawPoints = timestamps
      .map((ts, i) => ({
        ts:    ts * 1000,   // YF timestamps are Unix seconds → ms
        price: closes[i],
        open:  opens[i],
        high:  highs[i],
        low:   lows[i],
      }))
      .filter(p => p.price != null && !isNaN(p.ts))
      .sort((a, b) => a.ts - b.ts);

    S.yfRawCache[rawKey] = { data: rawPoints, ts: Date.now() };
  }

  // Aggregate client-side when groupMins > native interval (e.g. 4h from 1h)
  let data;
  if (groupMins > yfGroupMins) {
    data = aggregateData(rawPoints, groupMins);
  } else {
    data = rawPoints.map(p => ({
      ts: p.ts, rate: p.price, open: p.open, high: p.high, low: p.low,
    }));
  }

  S.chartCache[cacheKey] = { data, ts: Date.now() };
  return data;
}

/* ============================================================
   FRANKFURTER — DAILY / WEEKLY CHART DATA  (1D and 1W)
   No rate limit — existing Frankfurter endpoint.
   Daily data is returned as-is; weekly data is aggregated.
   ============================================================ */
async function fetchFrankfurterChart(f, t, interval) {
  const cacheKey = `${f}/${t}/${interval}`;
  const cached   = S.chartCache[cacheKey];
  const ttl      = CACHE_TTL[interval] || 3_600_000;
  if (cached && Date.now() - cached.ts < ttl) return cached.data;

  const days  = interval === "1W" ? 365 * 5 : 366;
  const end   = isoDate(new Date());
  const start = isoDate(new Date(Date.now() - days * 86_400_000));
  const url   = `https://api.frankfurter.app/${start}..${end}?from=${f}&to=${t}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
  const j = await res.json();

  // rawPoints in { ts, price } form required by aggregateData
  const rawPoints = Object.entries(j.rates)
    .map(([date, r]) => ({
      ts:    new Date(date + 'T12:00:00Z').getTime(),
      price: r[t],
    }))
    .filter(p => p.price != null)
    .sort((a, b) => a.ts - b.ts);

  let data;
  if (interval === "1W") {
    // Aggregate daily points into weekly candles
    data = aggregateData(rawPoints, 10080);
  } else {
    // 1D — use each day's close directly
    data = rawPoints.map(p => ({
      ts: p.ts, rate: p.price, open: p.price, high: p.price, low: p.price,
    }));
  }

  S.chartCache[cacheKey] = { data, ts: Date.now() };
  return data;
}

/* ============================================================
   API LAYER — CURRENT RATES (open.er-api)
   ============================================================ */
async function fetchCurrentRates() {
  const res = await fetch("https://open.er-api.com/v6/latest/USD", { cache:"no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j.result !== "success") throw new Error("API returned non-success");
  return j.rates;
}

// Fetch previous-close rates from Frankfurter (for 1D % change on cards)
async function fetchPrevClose() {
  for (let d = 1; d <= 4; d++) {
    const date = isoDate(new Date(Date.now() - d * 86400000));
    try {
      const res = await fetch(`https://api.frankfurter.app/${date}?from=USD`);
      if (!res.ok) continue;
      const j = await res.json();
      if (j.rates) return { rates: j.rates, date };
    } catch { /* try next */ }
  }
  return null;
}

// Fetch 7-day historical series for sparklines (Frankfurter)
async function fetchHistorical(f, t, days) {
  const key = `${f}/${t}/${days}`;
  const cached = S.histCache[key];
  if (cached && Date.now() - cached.ts < 3_600_000) return cached.data;

  const end   = isoDate(new Date());
  const start = isoDate(new Date(Date.now() - (days + 5) * 86400000));
  const url   = `https://api.frankfurter.app/${start}..${end}?from=${f}&to=${t}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
  const j = await res.json();

  const data = Object.entries(j.rates)
    .map(([date, r]) => ({ date, rate: r[t] }))
    .filter(x => x.rate != null)
    .sort((a, b) => a.date < b.date ? -1 : 1);

  S.histCache[key] = { data, ts: Date.now() };
  return data;
}
