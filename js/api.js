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
   FRANKFURTER API — BATCH QUOTE (current rates + prev close + sparklines)
   Groups pairs by base currency; one request per base fetches a
   2-week date range so we get current rate, previous close, and
   7-day sparkline data all in a single round of parallel calls.
   No API key, no rate limits, CORS-friendly.
   ============================================================ */
async function fetchFrankfurterQuotes() {
  // Group target currencies by their base currency
  const groups = {};
  for (const p of CFG.PAIRS) {
    if (!groups[p.f]) groups[p.f] = [];
    groups[p.f].push(p.t);
  }

  const rates     = {};
  const prevRates = {};

  // Fetch ~14 days so weekends don't leave us without 2 data points
  const start = new Date();
  start.setDate(start.getDate() - 14);
  const startStr = start.toISOString().slice(0, 10);

  const results = await Promise.allSettled(
    Object.entries(groups).map(async ([base, targets]) => {
      const to  = targets.join(',');
      const url = `https://api.frankfurter.app/${startStr}..?from=${base}&to=${to}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Frankfurter ${base} HTTP ${res.status}`);
      return { base, targets, data: await res.json() };
    })
  );

  for (const r of results) {
    if (r.status !== 'fulfilled') { console.warn("Frankfurter group failed:", r.reason); continue; }
    const { base, targets, data } = r.value;

    // data.rates: { "2024-01-15": { "USD": 1.08, ... }, ... }
    const dates = Object.keys(data.rates).sort();
    if (!dates.length) continue;

    const latestRates = data.rates[dates[dates.length - 1]];
    for (const [target, rate] of Object.entries(latestRates)) {
      rates[`${base}/${target}`] = rate;
    }

    if (dates.length >= 2) {
      const prevDayRates = data.rates[dates[dates.length - 2]];
      for (const [target, rate] of Object.entries(prevDayRates)) {
        prevRates[`${base}/${target}`] = rate;
      }
    }

    // Populate sparkline cache from the same date-range response
    for (const target of targets) {
      const key       = `${base}/${target}/7`;
      const sparkData = dates
        .map(date => ({ date, rate: data.rates[date]?.[target] }))
        .filter(x => x.rate != null)
        .slice(-7);
      if (sparkData.length) S.histCache[key] = { data: sparkData, ts: Date.now() };
    }
  }

  if (!Object.keys(rates).length) throw new Error("Frankfurter returned no rate data");
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
