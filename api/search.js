// Vercel serverless function — proxies Yahoo Finance symbol search.
//   /api/search?q=apple  -> list of matching stocks / ETFs

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/123.0 Safari/537.36";

const YF_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com",
];
const SEARCH_PATH = "/v1/finance/search";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Provide ?q=" });

  const path =
    SEARCH_PATH +
    `?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0`;

  try {
    let json;
    let lastErr;
    for (const host of YF_HOSTS) {
      try {
        const r = await fetch(host + path, {
          headers: { "User-Agent": UA, Accept: "application/json" },
        });
        if (!r.ok) throw new Error(`Yahoo responded ${r.status}`);
        json = await r.json();
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;

    const allowed = new Set(["EQUITY", "ETF", "INDEX", "MUTUALFUND", "CURRENCY"]);
    const results = (json.quotes || [])
      .filter((x) => x.symbol && allowed.has(x.quoteType))
      .map((x) => ({
        symbol: x.symbol,
        name: x.longname || x.shortname || x.symbol,
        type: x.quoteType,
        exchange: x.exchDisp || x.exchange || "",
      }));

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({ results });
  } catch (err) {
    return res.status(502).json({ error: err.message || "Upstream error" });
  }
}
