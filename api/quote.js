// Vercel serverless function — proxies Yahoo Finance chart data.
// No API key required. Handles CORS and normalizes the response so the
// browser gets a small, predictable payload.
//
//   /api/quote?symbols=AAPL,MSFT         -> compact summaries + sparkline
//   /api/quote?symbol=AAPL&range=1y&interval=1d  -> full OHLC series

const YF_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/123.0 Safari/537.36";

async function fetchChart(symbol, range, interval) {
  const url =
    `${YF_BASE}${encodeURIComponent(symbol)}` +
    `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}` +
    `&includePrePost=false`;

  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Yahoo responded ${r.status} for ${symbol}`);
  const json = await r.json();

  const result = json?.chart?.result?.[0];
  if (!result) {
    const msg = json?.chart?.error?.description || "no data";
    throw new Error(`${symbol}: ${msg}`);
  }

  const meta = result.meta || {};
  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = q.close?.[i];
    if (close == null) continue;
    candles.push({
      t: timestamps[i],
      o: q.open?.[i] ?? close,
      h: q.high?.[i] ?? close,
      l: q.low?.[i] ?? close,
      c: close,
    });
  }

  const price = meta.regularMarketPrice ?? candles.at(-1)?.c ?? null;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;

  return {
    symbol: meta.symbol || symbol,
    name: meta.longName || meta.shortName || meta.symbol || symbol,
    currency: meta.currency || "USD",
    exchange: meta.fullExchangeName || meta.exchangeName || "",
    instrumentType: meta.instrumentType || "",
    price,
    prevClose,
    change: price != null && prevClose != null ? price - prevClose : null,
    changePct:
      price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    marketState: meta.marketState || "",
    time: meta.regularMarketTime || null,
    candles,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  const { symbol, symbols, range = "1mo", interval = "1d" } = req.query;

  try {
    // Single full-series request (used by the detail chart).
    if (symbol) {
      const data = await fetchChart(symbol, range, interval);
      res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
      return res.status(200).json(data);
    }

    // Batch request for the list view.
    if (symbols) {
      const list = symbols
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
        .slice(0, 50);

      const settled = await Promise.allSettled(
        list.map((s) => fetchChart(s, range, interval))
      );

      const quotes = [];
      const errors = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") quotes.push(r.value);
        else errors.push({ symbol: list[i], error: r.reason?.message || "failed" });
      });

      res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
      return res.status(200).json({ quotes, errors });
    }

    return res.status(400).json({ error: "Provide ?symbol= or ?symbols=" });
  } catch (err) {
    return res.status(502).json({ error: err.message || "Upstream error" });
  }
}
