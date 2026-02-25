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
   DATA AGGREGATION — combine raw bars into larger candles
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
    const hi  = p.high ?? p.price;
    const lo  = p.low  ?? p.price;
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
   YAHOO FINANCE — BATCH QUOTE (current rates + prev close)
   Fetches all 28 pairs in one request. Returns direct pair
   rates: { "EUR/USD": 1.0856, ... } for both current and prev.
   ============================================================ */
async function fetchYahooQuotes() {
  const symbols = CFG.PAIRS.map(p => `${p.f}${p.t}=X`).join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}&fields=regularMarketPrice,regularMarketPreviousClose`;

  const res = await fetchWithCorsProxy(url);
  if (!res.ok) throw new Error(`Yahoo Finance quotes HTTP ${res.status}`);
  const j = await res.json();

  const results = j.quoteResponse?.result || [];
  if (!results.length) throw new Error("Yahoo Finance returned no quote data");

  const rates     = {};
  const prevRates = {};

  for (const q of results) {
    // Symbol like "EURUSD=X" → f="EUR", t="USD"
    const sym = q.symbol.replace('=X', '');
    const f   = sym.slice(0, 3);
    const t   = sym.slice(3);
    const key = `${f}/${t}`;
    if (q.regularMarketPrice      != null) rates[key]     = q.regularMarketPrice;
    if (q.regularMarketPreviousClose != null) prevRates[key] = q.regularMarketPreviousClose;
  }

  return { rates, prevRates };
}

/* ============================================================
   YAHOO FINANCE — CHART DATA (all intervals, all pairs)
   Handles 1m → 1wk via a single code path.
   2h and 4h share the 1h raw fetch and aggregate client-side.
   ============================================================ */
async function fetchYahooFinanceChart(f, t, interval) {
  const cacheKey = `${f}/${t}/${interval}`;
  const cached   = S.chartCache[cacheKey];
  const ttl      = CACHE_TTL[interval] || 300_000;
  if (cached && Date.now() - cached.ts < ttl) return cached.data;

  const { yfInterval, yfRange, groupMins } = INTERVAL_CONFIG[interval];

  // Native minutes per bar for the YF fetch interval
  const nativeMin = { "1m":1, "5m":5, "15m":15, "30m":30, "1h":60, "1d":1440, "1wk":10080 }[yfInterval] || 1;

  // 2h and 4h reuse 1h raw data; daily/weekly share their own raw cache
  const rawKey = `${f}/${t}/${yfInterval}`;
  const RAW_TTL = 5 * 60_000;
  let rawPoints;

  if (S.yfRawCache[rawKey] && Date.now() - S.yfRawCache[rawKey].ts < RAW_TTL) {
    rawPoints = S.yfRawCache[rawKey].data;
  } else {
    const symbol = `${f}${t}=X`;
    const yfUrl  = `https://query1.finance.yahoo.com/v8/finance/chart/`
                 + `${encodeURIComponent(symbol)}`
                 + `?interval=${yfInterval}&range=${yfRange}`;

    const res = await fetchWithCorsProxy(yfUrl);
    if (!res.ok) throw new Error(`Yahoo Finance chart HTTP ${res.status}`);
    const j = await res.json();

    if (j.chart?.error) throw new Error(j.chart.error.description || "Yahoo Finance error");
    const result = j.chart?.result?.[0];
    if (!result) throw new Error("No chart data from Yahoo Finance");

    const timestamps = result.timestamp || [];
    const quote      = result.indicators?.quote?.[0] || {};
    const opens      = quote.open  || [];
    const highs      = quote.high  || [];
    const lows       = quote.low   || [];
    const closes     = quote.close || [];

    // Deduplicate timestamps (keep last occurrence per second)
    const seen = new Map();
    timestamps.forEach((ts, i) => {
      const sec = Math.floor(ts); // YF timestamps are already seconds
      if (closes[i] != null) seen.set(sec, i);
    });

    rawPoints = Array.from(seen.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([sec, i]) => ({
        ts:    sec * 1000,     // store as ms internally
        price: closes[i],
        open:  opens[i],
        high:  highs[i],
        low:   lows[i],
      }))
      .filter(p => p.price != null && !isNaN(p.ts));

    S.yfRawCache[rawKey] = { data: rawPoints, ts: Date.now() };
  }

  // Aggregate into wider candles if needed (e.g., 1h → 2h or 4h)
  let data;
  if (groupMins > nativeMin) {
    data = aggregateData(rawPoints, groupMins);
  } else {
    data = rawPoints.map(p => ({
      ts: p.ts, rate: p.price,
      open: p.open ?? p.price, high: p.high ?? p.price, low: p.low ?? p.price,
    }));
  }

  S.chartCache[cacheKey] = { data, ts: Date.now() };
  return data;
}

/* ============================================================
   YAHOO FINANCE — 7-DAY SPARKLINE  (daily bars, all pairs)
   ============================================================ */
async function fetchSparkline(f, t) {
  const key    = `${f}/${t}/7`;
  const cached = S.histCache[key];
  if (cached && Date.now() - cached.ts < 3_600_000) return cached.data;

  const symbol = `${f}${t}=X`;
  const url    = `https://query1.finance.yahoo.com/v8/finance/chart/`
               + `${encodeURIComponent(symbol)}?interval=1d&range=7d`;

  const res = await fetchWithCorsProxy(url);
  if (!res.ok) throw new Error(`Yahoo Finance sparkline HTTP ${res.status}`);
  const j = await res.json();

  const result = j.chart?.result?.[0];
  if (!result) return [];

  const timestamps = result.timestamp || [];
  const closes     = result.indicators?.quote?.[0]?.close || [];

  const data = timestamps
    .map((ts, i) => ({ date: isoDate(new Date(ts * 1000)), rate: closes[i] }))
    .filter(x => x.rate != null);

  S.histCache[key] = { data, ts: Date.now() };
  return data;
}

/* ============================================================
   ANALYSIS ACCESS
   Expose cached data globally for external analysis scripts.
   Usage:
     forex.getData('EUR/USD', '1h')  → OHLCV array or null
     forex.getRate('EUR/USD')        → current rate or null
     forex.getPrevClose('EUR/USD')   → previous close or null
     forex.pairs()                   → ['EUR/USD', ...]
     forex.cache()                   → full chart cache object
   ============================================================ */
window.forex = {
  getData:      (pair, iv) => { const [f,t] = pair.split('/'); return S.chartCache[`${f}/${t}/${iv}`]?.data ?? null; },
  getRate:      (pair)     => S.rates[pair]     ?? null,
  getPrevClose: (pair)     => S.prevRates[pair] ?? null,
  pairs:        ()         => CFG.PAIRS.map(p => `${p.f}/${p.t}`),
  cache:        ()         => S.chartCache,
};
