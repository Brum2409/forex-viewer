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
  lowpe:      ["peratio.lasttwelvemonths", "ASC"],
  dividend:   ["forward_dividend_yield", "DESC"],
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

// A single min/max range as a Yahoo operand, or null if both bounds are empty.
function rangeOperand(field, min, max) {
  const lo = clampNum(min), hi = clampNum(max);
  if (lo != null && hi != null) return { operator: "btwn", operands: [field, lo, hi] };
  if (lo != null) return { operator: "gt", operands: [field, lo] };
  if (hi != null) return { operator: "lt", operands: [field, hi] };
  return null;
}

// Multiple equality choices for one field, OR-ed together so filters within a
// category (e.g. several sectors, several regions) combine instead of being
// mutually exclusive.
function orEq(field, values) {
  const list = (Array.isArray(values) ? values : values ? [values] : [])
    .map((v) => String(v || "")).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return { operator: "eq", operands: [field, list[0]] };
  return { operator: "or", operands: list.map((v) => ({ operator: "eq", operands: [field, v] })) };
}

// Turn the friendly filter spec from the browser into a Yahoo screener payload.
function buildPayload(spec) {
  const quoteType = spec.type === "etfs" ? "ETF" : "EQUITY";
  const capField = CAP_FIELD[quoteType];
  const operands = [];

  // Region (required so the query is never empty). Pick any number of
  // markets — they combine with OR.
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
    operands.push(orEq("region", regions));
  }

  // Sector — any number selected, OR-ed together (stocks only).
  if (quoteType === "EQUITY") {
    const sectorOp = orEq("sector", spec.sector);
    if (sectorOp) operands.push(sectorOp);
  }

  // Market cap — any number of size tiers (or a custom range), OR-ed together.
  const capRanges = Array.isArray(spec.marketCapRanges) ? spec.marketCapRanges : [];
  const capClauses = capRanges
    .map(([lo, hi]) => rangeOperand(capField, lo, hi))
    .filter(Boolean);
  if (capClauses.length === 1) operands.push(capClauses[0]);
  else if (capClauses.length > 1) operands.push({ operator: "or", operands: capClauses });

  const ranges = [
    ["intradayprice", spec.priceMin, spec.priceMax],
    ["percentchange", spec.dayChangeMin, spec.dayChangeMax],
    ["fiftytwowkpercentchange", spec.yearChangeMin, spec.yearChangeMax],
    ["avgdailyvol3m", spec.avgVolumeMin, null],
  ];
  for (const [field, min, max] of ranges) {
    const op = rangeOperand(field, min, max);
    if (op) operands.push(op);
  }

  const vol = clampNum(spec.volumeMin);
  if (vol != null) operands.push({ operator: "gt", operands: ["dayvolume", vol] });

  // Valuation / fundamentals filters. These are equity metrics, ignored by
  // Yahoo's ETF screener.
  if (quoteType === "EQUITY") {
    const pe = clampNum(spec.peMax);
    if (pe != null) operands.push({ operator: "lt", operands: ["peratio.lasttwelvemonths", pe] });
    const pb = clampNum(spec.pbMax);
    if (pb != null) operands.push({ operator: "lt", operands: ["pricebookratio.quarterly", pb] });
    const roe = clampNum(spec.roeMin);
    if (roe != null) operands.push({ operator: "gt", operands: ["returnonequity.lasttwelvemonths", roe] });
    const epsg = clampNum(spec.epsGrowthMin);
    if (epsg != null) operands.push({ operator: "gt", operands: ["epsgrowth.lasttwelvemonths", epsg] });
    const de = clampNum(spec.debtEquityMax);
    if (de != null) operands.push({ operator: "lt", operands: ["totaldebtequity.lasttwelvemonths", de] });
    const betaOp = rangeOperand("beta", spec.betaMin, spec.betaMax);
    if (betaOp) operands.push(betaOp);
  }
  const dy = clampNum(spec.dividendMin);
  if (dy != null) operands.push({ operator: "gt", operands: ["forward_dividend_yield", dy] });

  // When ranking by lowest P/E, exclude loss-making / undefined P/E names.
  if (spec.sort === "lowpe" && quoteType === "EQUITY") {
    operands.push({ operator: "gt", operands: ["peratio.lasttwelvemonths", 0] });
  }

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
    avgVolume: num(q.averageDailyVolume3Month) ?? null,
    peRatio: num(q.trailingPE) ?? null,
    dividendYield: num(q.trailingAnnualDividendYield) ?? null,
    fiftyTwoWeekHigh: num(q.fiftyTwoWeekHigh) ?? null,
    fiftyTwoWeekLow: num(q.fiftyTwoWeekLow) ?? null,
    currency: q.currency || "USD",
    exchange: q.fullExchangeName || q.exchange || "",
    region: q.region || "",
    sector: q.sector || "",
    industry: q.industry || "",
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
