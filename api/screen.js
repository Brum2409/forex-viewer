// Vercel serverless function — stock/ETF screener (discovery).
//
//   POST /api/screen   body: friendly filter spec (see buildQuery below)
//
// Proxies Yahoo Finance's screener API, which searches the whole universe of
// listed stocks and ETFs by region, sector, market cap, price, performance,
// and volume. Yahoo's screener requires a "crumb" + cookie pair, so we perform
// that handshake server-side and cache it across warm invocations.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/123.0 Safari/537.36";

const SCREENER_HOSTS = [
  "https://query2.finance.yahoo.com",
  "https://query1.finance.yahoo.com",
];

// Regions OR-ed together when the caller asks for "any" major market.
const MAJOR_REGIONS = [
  "us", "gb", "de", "fr", "ca", "jp", "cn", "hk", "in",
  "au", "nl", "ch", "br", "kr", "es", "it", "se",
];

// Market-cap field differs between equities and ETFs.
const CAP_FIELD = { EQUITY: "intradaymarketcap", ETF: "fundnetassets" };

const SORTS = {
  marketcap:  ["intradaymarketcap", "DESC"],
  gainers:    ["percentchange", "DESC"],
  losers:     ["percentchange", "ASC"],
  volume:     ["dayvolume", "DESC"],
  price:      ["intradayprice", "DESC"],
  yeargainers:["fiftytwowkpercentchange", "DESC"],
  yearlosers: ["fiftytwowkpercentchange", "ASC"],
};

/* ── Yahoo auth (crumb + cookie), cached while the function stays warm ── */
let auth = { crumb: null, cookie: null, ts: 0 };
const AUTH_TTL = 30 * 60 * 1000;

function collectCookies(res) {
  let list = [];
  try {
    if (typeof res.headers.getSetCookie === "function") list = res.headers.getSetCookie();
  } catch { /* ignore */ }
  if (!list.length) {
    const single = res.headers.get("set-cookie");
    if (single) list = [single];
  }
  return list.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

async function getAuth(force) {
  if (!force && auth.crumb && Date.now() - auth.ts < AUTH_TTL) return auth;

  let cookie = "";
  for (const url of ["https://fc.yahoo.com/", "https://finance.yahoo.com/"]) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
      cookie = collectCookies(r);
      if (cookie) break;
    } catch { /* try next */ }
  }

  let crumb = "";
  for (const host of SCREENER_HOSTS) {
    try {
      const r = await fetch(`${host}/v1/test/getcrumb`, {
        headers: { "User-Agent": UA, Accept: "text/plain", Cookie: cookie },
      });
      const text = (await r.text()).trim();
      if (r.ok && text && !text.includes("<") && text.length < 40) {
        crumb = text;
        break;
      }
    } catch { /* try next */ }
  }
  if (!crumb) throw new Error("yahoo_auth_failed");

  auth = { crumb, cookie, ts: Date.now() };
  return auth;
}

/* ── request building / parsing ── */
function clampNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Turn the friendly filter spec from the browser into a Yahoo screener payload.
function buildPayload(spec) {
  const quoteType = spec.type === "etfs" ? "ETF" : "EQUITY";
  const capField = CAP_FIELD[quoteType];
  const operands = [];

  // Region (required so the query is never empty).
  let region = spec.region;
  if (region === "any" || (Array.isArray(region) && region.includes("any"))) {
    operands.push({
      operator: "or",
      operands: MAJOR_REGIONS.map((r) => ({ operator: "eq", operands: ["region", r] })),
    });
  } else {
    const list = (Array.isArray(region) ? region : [region])
      .map((r) => String(r || "").toLowerCase())
      .filter((r) => /^[a-z]{2}$/.test(r));
    const regions = list.length ? list : ["us"];
    if (regions.length === 1) {
      operands.push({ operator: "eq", operands: ["region", regions[0]] });
    } else {
      operands.push({
        operator: "or",
        operands: regions.map((r) => ({ operator: "eq", operands: ["region", r] })),
      });
    }
  }

  if (quoteType === "EQUITY" && spec.sector) {
    operands.push({ operator: "eq", operands: ["sector", String(spec.sector)] });
  }

  const ranges = [
    [capField, spec.marketCapMin, spec.marketCapMax],
    ["intradayprice", spec.priceMin, spec.priceMax],
    ["percentchange", spec.dayChangeMin, spec.dayChangeMax],
    ["fiftytwowkpercentchange", spec.yearChangeMin, spec.yearChangeMax],
  ];
  for (const [field, min, max] of ranges) {
    const lo = clampNum(min), hi = clampNum(max);
    if (lo != null && hi != null) operands.push({ operator: "btwn", operands: [field, lo, hi] });
    else if (lo != null) operands.push({ operator: "gt", operands: [field, lo] });
    else if (hi != null) operands.push({ operator: "lt", operands: [field, hi] });
  }

  const vol = clampNum(spec.volumeMin);
  if (vol != null) operands.push({ operator: "gt", operands: ["dayvolume", vol] });

  let [sortField, sortType] = SORTS[spec.sort] || SORTS.marketcap;
  if (sortField === "intradaymarketcap") sortField = capField; // ETFs use fundnetassets
  const size = Math.min(Math.max(clampNum(spec.size) || 50, 1), 100);
  const offset = Math.max(clampNum(spec.offset) || 0, 0);

  return {
    size,
    offset,
    sortField,
    sortType,
    quoteType,
    query: { operator: "and", operands },
    userId: "",
    userIdType: "guid",
  };
}

const num = (v) => (v && typeof v === "object" && "raw" in v ? v.raw : v);

function normalizeQuote(q) {
  const price = num(q.regularMarketPrice);
  return {
    symbol: q.symbol,
    name: q.longName || q.shortName || q.displayName || q.symbol,
    price: price ?? null,
    change: num(q.regularMarketChange) ?? null,
    changePct: num(q.regularMarketChangePercent) ?? null,
    yearChangePct: num(q.fiftyTwoWeekChangePercent) ?? null,
    marketCap: num(q.marketCap) ?? num(q.netAssets) ?? null,
    volume: num(q.regularMarketVolume) ?? null,
    currency: q.currency || "USD",
    exchange: q.fullExchangeName || q.exchange || "",
    sector: q.sector || "",
    type: q.quoteType || "",
  };
}

async function runScreener(payload) {
  let a = await getAuth(false);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const host of SCREENER_HOSTS) {
      try {
        const url =
          `${host}/v1/finance/screener?crumb=${encodeURIComponent(a.crumb)}` +
          `&lang=en-US&region=US&formatted=false`;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "User-Agent": UA,
            "Content-Type": "application/json",
            Accept: "application/json",
            Cookie: a.cookie || "",
            Origin: "https://finance.yahoo.com",
            Referer: "https://finance.yahoo.com/screener/",
          },
          body: JSON.stringify(payload),
        });
        if (r.status === 401 || r.status === 403 || r.status === 422) {
          throw Object.assign(new Error(`auth ${r.status}`), { auth: true });
        }
        if (!r.ok) throw new Error(`screener ${r.status}`);
        return await r.json();
      } catch (e) {
        lastErr = e;
        if (e.auth) break; // refresh crumb and retry the whole thing
      }
    }
    a = await getAuth(true); // crumb likely stale — refresh and retry once
  }
  throw lastErr || new Error("screener_failed");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  try {
    const spec = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const payload = buildPayload(spec);
    const json = await runScreener(payload);

    const result = json?.finance?.result?.[0];
    if (!result) {
      const msg = json?.finance?.error?.description || "no_results";
      throw new Error(msg);
    }

    const quotes = (result.quotes || [])
      .filter((q) => q && q.symbol)
      .map(normalizeQuote);

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json({
      quotes,
      total: result.total ?? quotes.length,
      offset: payload.offset,
      size: payload.size,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || "screener_error" });
  }
}
