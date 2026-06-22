/* Ticker — live stock & ETF viewer.
 * Talks to /api/quote and /api/search (Vercel serverless proxies to Yahoo). */

"use strict";

const DEFAULT_WATCHLIST = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "TSLA", "META",
  "SPY", "QQQ", "VOO", "VTI",
];
const USER_KEY = "ticker.user";
const LEGACY_WATCHLIST_KEY = "ticker.watchlist.v1";
const REFRESH_MS = 60_000;

const $ = (id) => document.getElementById(id);

const state = {
  user: null,          // logged-in username, or null
  cloud: false,        // true once a save has synced to the server
  symbols: [],         // current watchlist
  quotes: new Map(),   // symbol -> quote object
  active: null,        // symbol shown in detail sheet
  refreshTimer: null,
  saveTimer: null,
  view: "watchlist",   // "watchlist" | "discover"
  discover: {          // screener (Discover tab) state
    spec: null,        // active filter spec (source of truth)
    items: [],
    total: 0,
    size: 50,
    loading: false,
    loaded: false,
    curation: null,    // AI-selected ordered symbols, or null = show all
  },
  ai: {                // AI search helper
    key: "",
    model: "",
    models: [],
    history: [],       // [{ role:"user"|"model", text }]
    busy: false,
  },
};

/* ── username helpers ────────────────────── */
function normalizeUser(raw) {
  const name = String(raw || "").trim().toLowerCase();
  return /^[a-z0-9_.-]{2,24}$/.test(name) ? name : null;
}
const watchlistKey = (user) => `ticker.watchlist.${user}`;

/* ── local persistence (offline + fallback) ─ */
function loadLocal(user) {
  try {
    const raw = localStorage.getItem(watchlistKey(user));
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
    // Migrate a pre-accounts watchlist into the first account that logs in.
    const legacy = localStorage.getItem(LEGACY_WATCHLIST_KEY);
    if (legacy) {
      const arr = JSON.parse(legacy);
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch (_) {}
  return null;
}
function saveLocal() {
  if (!state.user) return;
  try {
    localStorage.setItem(watchlistKey(state.user), JSON.stringify(state.symbols));
  } catch (_) {}
}

/* Persist the watchlist locally now and to the cloud (debounced). */
function save() {
  saveLocal();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveCloud, 600);
}

async function saveCloud() {
  if (!state.user) return;
  try {
    const res = await fetch("/api/account", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: state.user, watchlist: state.symbols }),
    });
    if (res.ok) {
      state.cloud = true;
    } else if (res.status === 503) {
      state.cloud = false; // cloud sync not configured — local only
    }
  } catch (_) {
    /* offline — local copy is already saved */
  }
}

/* ── auth / session ──────────────────────── */
// Pull the watchlist for a user from the cloud, falling back to the local copy
// (or the defaults) when cloud sync is unavailable.
async function fetchWatchlist(user) {
  try {
    const res = await fetch(`/api/account?user=${encodeURIComponent(user)}`);
    if (res.ok) {
      const data = await res.json();
      state.cloud = true;
      return Array.isArray(data.watchlist) ? data.watchlist : [];
    }
    // 503 => storage not configured; anything else => fall through to local.
  } catch (_) {
    /* offline */
  }
  state.cloud = false;
  return loadLocal(user) || [...DEFAULT_WATCHLIST];
}

async function login(rawName) {
  const user = normalizeUser(rawName);
  if (!user) {
    setLoginHint("Use 2–24 letters, numbers, . _ or -.", true);
    return;
  }
  const btn = $("loginBtn");
  btn.disabled = true;
  btn.textContent = "Loading…";
  setLoginHint("");

  state.user = user;
  try { localStorage.setItem(USER_KEY, user); } catch (_) {}

  state.symbols = await fetchWatchlist(user);
  saveLocal(); // keep a local mirror

  btn.disabled = false;
  btn.textContent = "Continue";
  enterApp();
}

function logout() {
  clearTimeout(state.saveTimer);
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  try { localStorage.removeItem(USER_KEY); } catch (_) {}
  state.user = null;
  state.cloud = false;
  state.symbols = [];
  state.quotes.clear();
  closeDetail();
  $("accountOverlay").hidden = true;
  $("app").hidden = true;
  $("userChip").hidden = true;
  $("login").hidden = false;
  $("loginInput").value = "";
  setLoginHint("No password — just a name to save your list under.");
  $("loginInput").focus();
}

function setLoginHint(msg, isErr) {
  const el = $("loginHint");
  el.textContent = msg;
  el.classList.toggle("err", Boolean(isErr));
}

// Reveal the main app for the logged-in user and kick off data loading.
function enterApp() {
  $("login").hidden = true;
  $("app").hidden = false;
  renderUser();
  renderList();
  refresh(false);
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => refresh(false), REFRESH_MS);
}

function renderUser() {
  if (!state.user) return;
  const initial = state.user[0].toUpperCase();
  $("userAvatar").textContent = initial;
  $("userName").textContent = state.user;
  $("userChip").hidden = false;
  $("accountAvatar").textContent = initial;
  $("accountUser").textContent = state.user;
  $("accountSync").textContent = state.cloud
    ? "✓ Synced to the cloud"
    : "Saved on this device";
}

/* ── formatting ──────────────────────────── */
const CCY = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CAD: "C$", AUD: "A$", CHF: "CHF " };
function fmtPrice(v, ccy = "USD") {
  if (v == null || isNaN(v)) return "—";
  const sym = CCY[ccy] ?? "";
  const digits = Math.abs(v) >= 1000 ? 2 : Math.abs(v) >= 1 ? 2 : 4;
  return sym + v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtChange(chg, pct) {
  if (chg == null || pct == null) return { text: "—", cls: "flat" };
  const sign = chg > 0 ? "+" : "";
  const cls = chg > 0 ? "up" : chg < 0 ? "down" : "flat";
  return { text: `${sign}${chg.toFixed(2)} (${sign}${pct.toFixed(2)}%)`, cls };
}
function fmtBig(n) {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return String(n);
}

/* ── data source ─────────────────────────────
 * On Vercel the /api/* serverless proxies are available. On GitHub Pages
 * (and other static hosting) there is no backend, so we talk to Yahoo
 * Finance directly from the browser through a public CORS proxy. */
const HAS_BACKEND = !(
  /(\.github\.io|\.githubusercontent\.com)$/i.test(location.hostname) ||
  location.protocol === "file:"
);

const YF_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const YF_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

// Tried in order; first one that succeeds wins.
const CORS_PROXIES = [
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
];

async function proxyFetchJson(targetUrl) {
  let lastErr;
  for (const wrap of CORS_PROXIES) {
    try {
      const res = await fetch(wrap(targetUrl), { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`proxy ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("all CORS proxies failed");
}

// Mirrors the normalization done server-side in api/quote.js.
function normalizeChart(json, symbol) {
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || `${symbol}: no data`);
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
    changePct: price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
    marketState: meta.marketState || "",
    time: meta.regularMarketTime || null,
    candles,
  };
}

async function directChart(symbol, range, interval) {
  const url =
    `${YF_CHART_BASE}${encodeURIComponent(symbol)}` +
    `?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}` +
    `&includePrePost=false`;
  return normalizeChart(await proxyFetchJson(url), symbol);
}

/* Unified data API used by the rest of the app — branches on HAS_BACKEND. */
async function apiQuoteSingle(symbol, range, interval) {
  if (HAS_BACKEND) {
    const res = await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`);
    if (!res.ok) throw new Error(`quote ${res.status}`);
    return res.json();
  }
  return directChart(symbol, range, interval);
}

async function apiQuoteBatch(symbols, range, interval) {
  if (HAS_BACKEND) {
    const url = `/api/quote?symbols=${encodeURIComponent(symbols.join(","))}&range=${range}&interval=${interval}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`quote ${res.status}`);
    return res.json();
  }
  const settled = await Promise.allSettled(symbols.map((s) => directChart(s, range, interval)));
  const quotes = [], errors = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") quotes.push(r.value);
    else errors.push({ symbol: symbols[i], error: r.reason?.message || "failed" });
  });
  if (!quotes.length && errors.length) throw new Error("all quotes failed");
  return { quotes, errors };
}

async function apiSearch(q) {
  if (HAS_BACKEND) {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    return res.json();
  }
  const url = `${YF_SEARCH_URL}?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0`;
  const json = await proxyFetchJson(url);
  const allowed = new Set(["EQUITY", "ETF", "INDEX", "MUTUALFUND", "CURRENCY"]);
  const results = (json.quotes || [])
    .filter((x) => x.symbol && allowed.has(x.quoteType))
    .map((x) => ({
      symbol: x.symbol,
      name: x.longname || x.shortname || x.symbol,
      type: x.quoteType,
      exchange: x.exchDisp || x.exchange || "",
    }));
  return { results };
}

async function apiScreen(spec) {
  const res = await fetch("/api/screen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(spec),
  });
  if (!res.ok) {
    let msg = `screen ${res.status}`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

/* ── data fetching ───────────────────────── */
async function fetchQuotes() {
  if (!state.symbols.length) { renderList(); return; }
  const data = await apiQuoteBatch(state.symbols, "5d", "1d");
  (data.quotes || []).forEach((q) => state.quotes.set(q.symbol.toUpperCase(), q));
  renderList();
  setStatus(true);
}

/* ── list rendering ──────────────────────── */
function renderList() {
  const root = $("watchlist");
  if (!state.symbols.length) {
    root.innerHTML = `<div class="center-msg">Your list is empty.<br>Search above to add a stock or ETF.</div>`;
    return;
  }
  root.innerHTML = "";
  for (const sym of state.symbols) {
    const q = state.quotes.get(sym.toUpperCase());
    if (!q) {
      const skel = document.createElement("div");
      skel.className = "card-skel";
      root.appendChild(skel);
      continue;
    }
    root.appendChild(card(q));
  }
}

function card(q) {
  const el = document.createElement("div");
  el.className = "card";
  el.onclick = () => openDetail(q.symbol);

  const ch = fmtChange(q.change, q.changePct);

  const left = document.createElement("div");
  left.className = "card-left";
  left.innerHTML = `<div class="card-sym">${q.symbol}</div><div class="card-name">${escapeHtml(q.name)}</div>`;

  const spark = document.createElement("canvas");
  spark.className = "spark";
  spark.width = 192; spark.height = 76;

  const right = document.createElement("div");
  right.className = "card-right";
  right.innerHTML =
    `<div class="card-price">${fmtPrice(q.price, q.currency)}</div>` +
    `<div class="card-chg ${ch.cls}">${ch.text}</div>`;

  el.append(left, spark, right);
  drawSpark(spark, q.candles, ch.cls);
  return el;
}

function drawSpark(canvas, candles, cls) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height, pad = 4;
  const data = (candles || []).map((c) => c.c).filter((v) => v != null);
  if (data.length < 2) return;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const x = (i) => pad + (i / (data.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / range) * (h - pad * 2);
  const color = cls === "down" ? "#ea3943" : cls === "up" ? "#16c784" : "#8a93a6";

  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + "33");
  grad.addColorStop(1, color + "00");
  ctx.lineTo(x(data.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
}

/* ── search ──────────────────────────────── */
let searchTimer = null;
function onSearchInput(value) {
  const v = value.trim();
  clearTimeout(searchTimer);
  if (!v) { hideSearch(); return; }
  searchTimer = setTimeout(() => runSearch(v), 280);
}

async function runSearch(q) {
  const box = $("searchResults");
  box.hidden = false;
  box.innerHTML = `<div class="sr-msg">Searching…</div>`;
  try {
    const data = await apiSearch(q);
    const items = data.results || [];
    if (!items.length) { box.innerHTML = `<div class="sr-msg">No matches.</div>`; return; }
    box.innerHTML = "";
    for (const it of items) {
      const added = state.symbols.includes(it.symbol.toUpperCase());
      const row = document.createElement("div");
      row.className = "sr-item";
      row.innerHTML =
        `<div class="sr-left">
           <div class="sr-sym">${it.symbol}</div>
           <div class="sr-name">${escapeHtml(it.name)}</div>
         </div>
         <span class="sr-badge">${added ? "✓ added" : it.type}</span>`;
      row.onclick = () => addSymbol(it.symbol);
      box.appendChild(row);
    }
  } catch (_) {
    box.innerHTML = `<div class="sr-msg">Search failed. Try again.</div>`;
  }
}

function hideSearch() {
  const box = $("searchResults");
  box.hidden = true; box.innerHTML = "";
}

async function addSymbol(symbol) {
  const sym = symbol.toUpperCase();
  if (!state.symbols.includes(sym)) {
    state.symbols.push(sym);
    save();
    renderList();
  }
  $("searchInput").value = "";
  hideSearch();
  try { await fetchQuotes(); } catch (_) {}
}

function removeSymbol(symbol) {
  const sym = symbol.toUpperCase();
  state.symbols = state.symbols.filter((s) => s !== sym);
  state.quotes.delete(sym);
  save();
  renderList();
}

/* ── Discover (screener) ─────────────────── */
const CAP_PRESETS = {
  mega:  [200e9, null],
  large: [10e9, 200e9],
  mid:   [2e9, 10e9],
  small: [300e6, 2e9],
  micro: [null, 300e6],
};
const VOL_PRESETS = { "100k": 1e5, "1m": 1e6, "10m": 1e7 };

function switchView(view) {
  state.view = view;
  $("view-watchlist").hidden = view !== "watchlist";
  $("view-discover").hidden = view !== "discover";
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view));
  if (view === "discover" && !state.discover.loaded) runScreen(true);
}

const SORT_VALUES = ["marketcap","gainers","losers","volume","price","yeargainers","yearlosers"];
const SECTOR_VALUES = [
  "Technology","Healthcare","Financial Services","Consumer Cyclical","Consumer Defensive",
  "Communication Services","Industrials","Energy","Basic Materials","Real Estate","Utilities",
];
const REGION_VALUES = ["us","any","gb","de","fr","ca","jp","cn","hk","in","au","nl","ch","br","kr","es","it","se"];

const DEFAULT_SPEC = {
  type: "stocks", region: "us", sector: null,
  marketCapMin: null, marketCapMax: null,
  priceMin: null, priceMax: null,
  dayChangeMin: null, dayChangeMax: null,
  yearChangeMin: null, yearChangeMax: null,
  volumeMin: null, sort: "marketcap",
};

function numOrNull(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmtCap(n) {
  if (n == null) return "";
  const a = Math.abs(n);
  if (a >= 1e12) return "$" + (n / 1e12).toFixed(1).replace(/\.0$/, "") + "T";
  if (a >= 1e9)  return "$" + (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (a >= 1e6)  return "$" + (n / 1e6).toFixed(0) + "M";
  return "$" + n;
}
function capLabel(min, max) {
  if (min != null && max != null) return `${fmtCap(min)}–${fmtCap(max)}`;
  if (min != null) return `over ${fmtCap(min)}`;
  if (max != null) return `under ${fmtCap(max)}`;
  return "Custom";
}

/* The form is just an editor for state.discover.spec; the AI edits the same
 * spec. readForm/writeForm keep the two in sync (both directions). */
function readForm() {
  const type = $("segType").querySelector(".active")?.dataset.type || "stocks";
  let capMin = null, capMax = null;
  const capVal = $("fCap").value;
  if (capVal === "custom") {
    const o = $("fCap").querySelector('option[value="custom"]');
    capMin = o?.dataset.min ? Number(o.dataset.min) : null;
    capMax = o?.dataset.max ? Number(o.dataset.max) : null;
  } else if (CAP_PRESETS[capVal]) {
    [capMin, capMax] = CAP_PRESETS[capVal];
  }
  return {
    type,
    region: $("fRegion").value,
    sector: type === "stocks" ? ($("fSector").value || null) : null,
    marketCapMin: capMin,
    marketCapMax: capMax,
    priceMin: numOrNull($("fPriceMin").value),
    priceMax: numOrNull($("fPriceMax").value),
    dayChangeMin: numOrNull($("fDayMin").value),
    dayChangeMax: numOrNull($("fDayMax").value),
    yearChangeMin: numOrNull($("fYearMin").value),
    yearChangeMax: numOrNull($("fYearMax").value),
    volumeMin: numOrNull($("fVol").value === "" ? null : (VOL_PRESETS[$("fVol").value] ?? null)),
    sort: $("fSort").value,
  };
}

function setCapControl(min, max) {
  const sel = $("fCap");
  const existing = sel.querySelector('option[value="custom"]');
  let match = "";
  for (const [k, [lo, hi]] of Object.entries(CAP_PRESETS)) {
    if ((lo ?? null) === (min ?? null) && (hi ?? null) === (max ?? null)) { match = k; break; }
  }
  if (match || (min == null && max == null)) {
    if (existing) existing.remove();
    sel.value = match;
  } else {
    const label = capLabel(min, max);
    const opt = existing || document.createElement("option");
    opt.value = "custom";
    opt.textContent = `Custom (${label})`;
    opt.dataset.min = min ?? "";
    opt.dataset.max = max ?? "";
    if (!existing) sel.appendChild(opt);
    sel.value = "custom";
  }
}

function setVolControl(min) {
  const map = { 100000: "100k", 1000000: "1m", 10000000: "10m" };
  $("fVol").value = min != null && map[min] ? map[min] : "";
}

function writeForm(spec) {
  setType(spec.type || "stocks");
  $("fRegion").value = REGION_VALUES.includes(spec.region) ? spec.region : "us";
  $("fSector").value = spec.sector && SECTOR_VALUES.includes(spec.sector) ? spec.sector : "";
  setCapControl(spec.marketCapMin ?? null, spec.marketCapMax ?? null);
  $("fPriceMin").value = spec.priceMin ?? "";
  $("fPriceMax").value = spec.priceMax ?? "";
  $("fDayMin").value = spec.dayChangeMin ?? "";
  $("fDayMax").value = spec.dayChangeMax ?? "";
  $("fYearMin").value = spec.yearChangeMin ?? "";
  $("fYearMax").value = spec.yearChangeMax ?? "";
  setVolControl(spec.volumeMin ?? null);
  $("fSort").value = SORT_VALUES.includes(spec.sort) ? spec.sort : "marketcap";
}

function setType(type) {
  $("segType").querySelectorAll("button").forEach((b) =>
    b.classList.toggle("active", b.dataset.type === type));
  // Sector only applies to individual stocks.
  $("sectorRow").style.display = type === "stocks" ? "" : "none";
}

function clearPresetHighlight() {
  $("presetRow").querySelectorAll(".preset").forEach((p) => p.classList.remove("active"));
}

function resetFilters() {
  state.discover.spec = { ...DEFAULT_SPEC };
  writeForm(state.discover.spec);
  clearPresetHighlight();
}

const PRESET_SPECS = {
  gainers:  { ...DEFAULT_SPEC, sort: "gainers",     dayChangeMin: 2 },
  losers:   { ...DEFAULT_SPEC, sort: "losers",      dayChangeMax: -2 },
  active:   { ...DEFAULT_SPEC, sort: "volume" },
  large:    { ...DEFAULT_SPEC, sort: "marketcap",   marketCapMin: 10e9, marketCapMax: 200e9 },
  yearup:   { ...DEFAULT_SPEC, sort: "yeargainers", yearChangeMin: 20 },
  yeardown: { ...DEFAULT_SPEC, sort: "yearlosers",  yearChangeMax: -20 },
};

// One-tap shortcuts that set the spec, sync the form, then run.
function applyPreset(preset) {
  const spec = PRESET_SPECS[preset];
  if (!spec) return;
  state.discover.spec = { ...spec };
  writeForm(state.discover.spec);
  $("presetRow").querySelectorAll(".preset").forEach((p) =>
    p.classList.toggle("active", p.dataset.preset === preset));
  runScreen(true);
}

function setDiscoverStatus(msg) {
  $("discoverStatus").textContent = msg;
}

async function runScreen(reset) {
  const d = state.discover;
  if (d.loading) return;
  if (!d.spec) d.spec = readForm();
  d.loading = true;
  d.loaded = true;

  if (reset) {
    d.items = [];
    d.total = 0;
    d.curation = null; // a fresh search clears any AI hand-selection
    $("loadMore").hidden = true;
    renderDiscover();
    setDiscoverStatus("Searching the market…");
  } else {
    setDiscoverStatus("Loading more…");
  }

  try {
    const spec = { ...d.spec, size: d.size, offset: reset ? 0 : d.items.length };
    const data = await apiScreen(spec);
    const incoming = data.quotes || [];
    d.total = data.total || d.items.length + incoming.length;
    d.items = reset ? incoming : d.items.concat(incoming);
    d.loading = false;
    renderDiscover();
    $("loadMore").hidden = !incoming.length || d.items.length >= d.total;
  } catch (e) {
    if (!HAS_BACKEND) {
      setDiscoverStatus("Discover needs the live backend — open the app on Vercel.");
    } else {
      setDiscoverStatus("Couldn't load results. Please try again.");
    }
    $("loadMore").hidden = true;
  } finally {
    d.loading = false;
  }
}

// Items currently visible, honoring an AI hand-selection (curation) if active.
function visibleItems() {
  const d = state.discover;
  if (!d.curation) return d.items;
  const bySym = new Map(d.items.map((q) => [q.symbol.toUpperCase(), q]));
  return d.curation.map((s) => bySym.get(String(s).toUpperCase())).filter(Boolean);
}

function renderDiscover() {
  const root = $("discoverResults");
  const items = visibleItems();
  root.innerHTML = "";
  for (const q of items) root.appendChild(discoverCard(q));

  const d = state.discover;
  if (d.curation) {
    $("curationBar").hidden = false;
    $("curationText").textContent = `✨ AI is showing ${items.length} hand-picked of ${d.items.length} loaded`;
  } else {
    $("curationBar").hidden = true;
  }

  if (!d.items.length) {
    setDiscoverStatus(d.loading ? "Searching the market…" : "No matches — try widening your filters.");
  } else if (d.curation) {
    setDiscoverStatus("");
  } else {
    setDiscoverStatus(`Showing ${d.items.length} of ${d.total.toLocaleString()} matches`);
  }
}

function clearCuration() {
  state.discover.curation = null;
  renderDiscover();
}

function syncDiscoverAddButtons() {
  $("discoverResults").querySelectorAll(".discover-card").forEach((el) => {
    const btn = el.querySelector(".add-btn");
    if (!btn) return;
    const added = state.symbols.includes((el.dataset.sym || "").toUpperCase());
    btn.classList.toggle("added", added);
    btn.textContent = added ? "✓ Added" : "+ Add";
  });
}

function discoverCard(q) {
  const el = document.createElement("div");
  el.className = "card discover-card";
  el.dataset.sym = q.symbol;
  const ch = fmtChange(q.change, q.changePct);
  const added = state.symbols.includes(q.symbol.toUpperCase());

  const tags = [];
  if (q.marketCap) tags.push(`<span class="tag">${fmtBig(q.marketCap)}</span>`);
  if (q.sector) tags.push(`<span class="tag">${escapeHtml(q.sector)}</span>`);
  if (q.yearChangePct != null) {
    const cls = q.yearChangePct >= 0 ? "up" : "down";
    const sign = q.yearChangePct >= 0 ? "+" : "";
    tags.push(`<span class="tag ${cls}">1Y ${sign}${q.yearChangePct.toFixed(1)}%</span>`);
  }

  el.innerHTML =
    `<div class="card-left">
       <div class="card-sym">${q.symbol}</div>
       <div class="card-name">${escapeHtml(q.name)}</div>
       <div class="card-tags">${tags.join("")}</div>
     </div>
     <div class="card-right">
       <div class="card-price">${fmtPrice(q.price, q.currency)}</div>
       <div class="card-chg ${ch.cls}">${ch.text}</div>
       <button class="add-btn ${added ? "added" : ""}" type="button">${added ? "✓ Added" : "+ Add"}</button>
     </div>`;

  el.onclick = (e) => {
    if (e.target.closest(".add-btn")) return;
    const key = q.symbol.toUpperCase();
    state.quotes.set(key, { ...state.quotes.get(key), ...q });
    openDetail(q.symbol);
  };
  el.querySelector(".add-btn").onclick = (e) => {
    e.stopPropagation();
    addSymbol(q.symbol);
    syncDiscoverAddButtons();
  };
  return el;
}

/* ── AI search helper (Google Gemini) ────── */
const AI_KEY_LS = "ticker.ai.key";
const AI_MODEL_LS = "ticker.ai.model";
const DEFAULT_MODEL = "gemini-2.5-flash";

function loadAISettings() {
  try {
    state.ai.key = localStorage.getItem(AI_KEY_LS) || "";
    state.ai.model = localStorage.getItem(AI_MODEL_LS) || "";
  } catch (_) {}
}

async function apiAI(body) {
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, apiKey: state.ai.key || undefined }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `ai ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function aiFetchModels() {
  const data = await apiAI({ action: "models" });
  state.ai.models = data.models || [];
  const known = state.ai.models.some((m) => m.id === state.ai.model);
  if ((!state.ai.model || !known) && state.ai.models.length) {
    const preferred =
      state.ai.models.find((m) => m.id === DEFAULT_MODEL) ||
      state.ai.models.find((m) => /2\.5-flash$/.test(m.id)) ||
      state.ai.models.find((m) => /flash/.test(m.id)) ||
      state.ai.models[0];
    state.ai.model = preferred.id;
    try { localStorage.setItem(AI_MODEL_LS, state.ai.model); } catch (_) {}
  }
  return state.ai.models;
}

// Compact snapshot of the currently visible stocks for the model to reason over.
function aiResultsContext() {
  const round = (v, d = 2) => (v == null ? null : Number(v.toFixed(d)));
  return visibleItems().slice(0, 60).map((q) => ({
    symbol: q.symbol,
    name: q.name,
    price: round(q.price),
    todayPct: round(q.changePct),
    yearPct: round(q.yearChangePct, 1),
    marketCap: q.marketCap ?? null,
    pe: round(q.peRatio, 1),
    divYield: q.dividendYield != null ? round(q.dividendYield * 100, 2) : null,
    volume: q.volume ?? null,
    sector: q.sector || null,
    exchange: q.exchange || null,
    region: q.region || null,
    type: q.type || null,
  }));
}

function buildSystemPrompt() {
  const spec = state.discover.spec || DEFAULT_SPEC;
  return `You are the AI search assistant inside "Ticker", an app for discovering stocks and ETFs.
You help the user find and narrow investments by either (A) editing the market screener filters, or (B) hand-picking from the stocks currently on screen. Always reply briefly and helpfully.

You must respond with JSON matching the provided schema. Choose exactly one "action":

- "filter": Re-run the screener across the WHOLE market with a new filter set. Put the COMPLETE desired filter state in "filters" (omit a field to mean "no filter on it"). Use this for broad requests like "cheap US tech stocks up a lot this year" or "large European dividend ETFs".
- "curate": Hand-pick a subset of the stocks ALREADY listed below (by symbol) and put them, in your preferred order, in "visibleSymbols". Use this for follow-ups that refine what's already shown, e.g. "only the ones under $100", "hide the Chinese companies", "rank these by best value", "just the profitable-looking ones". Only use symbols that appear in the current results.
- "none": Just answer or ask a clarifying question; change nothing.

FILTER FIELDS (all optional unless noted):
- type: "stocks" or "etfs" (required in filters).
- region: one of us, any, gb, de, fr, ca, jp, cn, hk, in, au, nl, ch, br, kr, es, it, se. "any" = any major market. (required in filters; default us)
- sector (stocks only): exactly one of: Technology, Healthcare, Financial Services, Consumer Cyclical, Consumer Defensive, Communication Services, Industrials, Energy, Basic Materials, Real Estate, Utilities.
- marketCapMin / marketCapMax: market cap in USD (e.g. 10000000000 = $10B). For ETFs this means fund net assets.
- priceMin / priceMax: share price in USD.
- dayChangeMin / dayChangeMax: percent change TODAY (e.g. 5 = up 5%, -3 = down 3%).
- yearChangeMin / yearChangeMax: percent change over the past 1 YEAR (52 weeks).
- volumeMin: minimum shares traded today.
- sort: one of marketcap, gainers (today up), losers (today down), volume, price, yeargainers (1y up), yearlosers (1y down).

IMPORTANT: The screener can only filter on the fields above. The only performance time windows it supports are TODAY and 1 YEAR. If the user asks for a window it can't do (e.g. "up this week"/"last month"), pick the closest available window, say so in your reply, and/or use "curate" on the loaded results.

CURRENT FILTERS:
${JSON.stringify(spec)}

CURRENT RESULTS ON SCREEN (${visibleItems().length} shown; reason over these for "curate"; divYield is a %, marketCap/volume are absolute):
${JSON.stringify(aiResultsContext())}`;
}

function aiResponseSchema() {
  const NUM = { type: "NUMBER" };
  return {
    type: "OBJECT",
    properties: {
      reply: { type: "STRING" },
      action: { type: "STRING", enum: ["filter", "curate", "none"] },
      filters: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["stocks", "etfs"] },
          region: { type: "STRING" },
          sector: { type: "STRING" },
          marketCapMin: NUM, marketCapMax: NUM,
          priceMin: NUM, priceMax: NUM,
          dayChangeMin: NUM, dayChangeMax: NUM,
          yearChangeMin: NUM, yearChangeMax: NUM,
          volumeMin: NUM,
          sort: { type: "STRING", enum: SORT_VALUES },
        },
      },
      visibleSymbols: { type: "ARRAY", items: { type: "STRING" } },
    },
    required: ["reply", "action"],
  };
}

function sanitizeSpec(filters) {
  const f = filters || {};
  const spec = { ...DEFAULT_SPEC };
  spec.type = f.type === "etfs" ? "etfs" : "stocks";
  spec.region = REGION_VALUES.includes(f.region) ? f.region : "us";
  spec.sector = spec.type === "stocks" && SECTOR_VALUES.includes(f.sector) ? f.sector : null;
  for (const k of ["marketCapMin","marketCapMax","priceMin","priceMax","dayChangeMin","dayChangeMax","yearChangeMin","yearChangeMax","volumeMin"]) {
    const n = Number(f[k]);
    spec[k] = Number.isFinite(n) ? n : null;
  }
  spec.sort = SORT_VALUES.includes(f.sort) ? f.sort : "marketcap";
  return spec;
}

function applyAIFilters(filters) {
  state.discover.spec = sanitizeSpec(filters);
  writeForm(state.discover.spec);
  clearPresetHighlight();
  runScreen(true);
}

function applyAICuration(symbols) {
  const have = new Set(state.discover.items.map((q) => q.symbol.toUpperCase()));
  const picked = (symbols || [])
    .map((s) => String(s).toUpperCase())
    .filter((s) => have.has(s));
  state.discover.curation = picked.length ? picked : null;
  renderDiscover();
  syncDiscoverAddButtons();
}

function renderAILog() {
  const log = $("aiLog");
  log.innerHTML = "";
  for (const m of state.ai.history) {
    const row = document.createElement("div");
    row.className = "ai-msg ai-" + m.role;
    row.textContent = m.text;
    log.appendChild(row);
  }
  if (state.ai.busy) {
    const row = document.createElement("div");
    row.className = "ai-msg ai-model ai-typing";
    row.textContent = "Thinking…";
    log.appendChild(row);
  }
  log.scrollTop = log.scrollHeight;
}

function setAIHint(msg, isErr) {
  const el = $("aiHint");
  el.textContent = msg || "";
  el.classList.toggle("err", Boolean(isErr));
}

async function aiSend(text) {
  const msg = text.trim();
  if (!msg || state.ai.busy) return;

  // Make sure we have a model (also detects a server-side key).
  if (!state.ai.model) {
    try { await aiFetchModels(); } catch (e) {
      if (e.status === 503) { setAIHint("Add your Gemini API key in AI settings (⚙︎) — it's free.", true); openAISettings(); }
      else setAIHint(aiErrorText(e), true);
      return;
    }
  }

  state.ai.history.push({ role: "user", text: msg });
  state.ai.busy = true;
  setAIHint("");
  renderAILog();

  const contents = state.ai.history.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.text }],
  }));

  try {
    const data = await apiAI({
      action: "generate",
      model: state.ai.model || DEFAULT_MODEL,
      systemInstruction: buildSystemPrompt(),
      contents,
      responseSchema: aiResponseSchema(),
      temperature: 0.2,
    });

    let parsed;
    try { parsed = JSON.parse(data.text); } catch (_) { parsed = { reply: data.text, action: "none" }; }

    state.ai.history.push({ role: "model", text: parsed.reply || "Done." });
    state.ai.busy = false;
    renderAILog();

    if (parsed.action === "filter" && parsed.filters) {
      applyAIFilters(parsed.filters);
    } else if (parsed.action === "curate" && Array.isArray(parsed.visibleSymbols)) {
      applyAICuration(parsed.visibleSymbols);
    }
  } catch (e) {
    state.ai.busy = false;
    // Drop the optimistic user turn so a retry isn't doubled up.
    if (state.ai.history.at(-1)?.role === "user") state.ai.history.pop();
    renderAILog();
    if (e.status === 503) { setAIHint("Add your Gemini API key in AI settings (⚙︎) — it's free.", true); openAISettings(); }
    else if (e.status === 401) { setAIHint("That API key was rejected. Check it in AI settings (⚙︎).", true); }
    else setAIHint(aiErrorText(e), true);
  }
}

function aiErrorText(e) {
  if (!HAS_BACKEND) return "AI search needs the live backend — open the app on Vercel.";
  return "AI request failed. Please try again.";
}

/* AI settings (key + model) */
function openAISettings() {
  $("aiKeyInput").value = state.ai.key || "";
  populateModelSelect();
  $("aiSettingsStatus").textContent = state.ai.models.length
    ? ""
    : (state.ai.key ? "Tap “Save & load models”." : "Paste a key, then “Save & load models”.");
  $("aiSettings").hidden = false;
}

function populateModelSelect() {
  const sel = $("aiModelSelect");
  sel.innerHTML = "";
  if (!state.ai.models.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "— no models loaded —";
    sel.appendChild(o);
    return;
  }
  for (const m of state.ai.models) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.displayName && m.displayName !== m.id ? `${m.displayName} (${m.id})` : m.id;
    sel.appendChild(o);
  }
  sel.value = state.ai.model || state.ai.models[0]?.id || "";
}

async function saveAISettings() {
  state.ai.key = $("aiKeyInput").value.trim();
  try { localStorage.setItem(AI_KEY_LS, state.ai.key); } catch (_) {}

  const status = $("aiSettingsStatus");
  status.classList.remove("err");
  status.textContent = "Loading models…";
  try {
    await aiFetchModels();
    populateModelSelect();
    status.textContent = `Loaded ${state.ai.models.length} models. ✓`;
    setAIHint("");
  } catch (e) {
    status.classList.add("err");
    status.textContent = e.status === 401
      ? "Key rejected — double-check it."
      : (e.status === 503 ? "No key set and no server key configured." : "Couldn't load models.");
  }
}

function commitModelChoice() {
  state.ai.model = $("aiModelSelect").value || "";
  try { localStorage.setItem(AI_MODEL_LS, state.ai.model); } catch (_) {}
}

/* ── detail sheet + chart ────────────────── */
let chart = null, series = null;

function openDetail(symbol) {
  state.active = symbol.toUpperCase();
  const q = state.quotes.get(state.active);
  $("overlay").hidden = false;
  document.body.style.overflow = "hidden";

  $("dSymbol").textContent = q?.symbol || symbol;
  $("dName").textContent = q?.name || "";
  if (q) {
    $("dPrice").textContent = fmtPrice(q.price, q.currency);
    const ch = fmtChange(q.change, q.changePct);
    const el = $("dChange");
    el.textContent = ch.text; el.className = "big-change " + ch.cls;
  }
  renderStats(q);
  updateSheetActionBtn();

  // reset range tabs to 1M
  const tabs = $("rangeTabs").querySelectorAll("button");
  tabs.forEach((b, i) => b.classList.toggle("active", i === 1));
  loadChart("1mo", "1d");
}

// The header action toggles between adding and removing, based on membership.
function updateSheetActionBtn() {
  const btn = $("removeBtn");
  const inList = state.active && state.symbols.includes(state.active);
  btn.textContent = inList ? "🗑" : "＋";
  btn.title = inList ? "Remove from list" : "Add to watchlist";
}

function closeDetail() {
  $("overlay").hidden = true;
  document.body.style.overflow = "";
  state.active = null;
  syncDiscoverAddButtons(); // reflect any add/remove done from the sheet
}

function renderStats(q) {
  const grid = $("statsGrid");
  if (!q) { grid.innerHTML = ""; return; }
  const closes = (q.candles || []).map((c) => c.c);
  const dayHi = q.candles?.length ? Math.max(...q.candles.map((c) => c.h)) : null;
  const dayLo = q.candles?.length ? Math.min(...q.candles.map((c) => c.l)) : null;
  const stats = [
    ["Previous close", fmtPrice(q.prevClose, q.currency)],
    ["Recent high", fmtPrice(dayHi, q.currency)],
    ["Recent low", fmtPrice(dayLo, q.currency)],
    ["Currency", q.currency || "—"],
    ["Exchange", q.exchange || "—"],
    ["Type", q.instrumentType || "—"],
  ];
  grid.innerHTML = stats
    .map(([l, v]) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${escapeHtml(String(v))}</div></div>`)
    .join("");
}

async function loadChart(range, interval) {
  const sym = state.active;
  if (!sym) return;
  $("chartLoader").hidden = false;
  ensureChart();
  try {
    const q = await apiQuoteSingle(sym, range, interval);
    if (state.active !== sym) return; // user navigated away
    const points = (q.candles || [])
      .map((c) => ({ time: c.t, value: c.c }))
      .filter((p) => p.value != null);
    const up = (q.change ?? 0) >= 0;
    series.applyOptions({
      lineColor: up ? "#16c784" : "#ea3943",
      topColor: up ? "rgba(22,199,132,.28)" : "rgba(234,57,67,.28)",
      bottomColor: "rgba(0,0,0,0)",
    });
    series.setData(points);
    chart.timeScale().fitContent();
    // refresh header price + stats with the freshest quote
    const merged = { ...state.quotes.get(sym), ...q };
    state.quotes.set(sym, merged);
    $("dPrice").textContent = fmtPrice(q.price, q.currency);
    const ch = fmtChange(q.change, q.changePct);
    const el = $("dChange"); el.textContent = ch.text; el.className = "big-change " + ch.cls;
    renderStats(merged);
  } catch (_) {
    /* keep previous chart on error */
  } finally {
    $("chartLoader").hidden = true;
  }
}

function ensureChart() {
  if (chart) return;
  const el = $("chart");
  chart = LightweightCharts.createChart(el, {
    width: el.clientWidth,
    height: 300,
    layout: { background: { color: "transparent" }, textColor: "#8a93a6", fontSize: 11 },
    grid: { vertLines: { color: "#1c2333" }, horzLines: { color: "#1c2333" } },
    rightPriceScale: { borderColor: "#232a3b" },
    timeScale: { borderColor: "#232a3b", timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 },
    handleScroll: true, handleScale: true,
  });
  series = chart.addAreaSeries({ lineWidth: 2, priceLineVisible: false });
  window.addEventListener("resize", () => {
    if (chart) chart.applyOptions({ width: el.clientWidth });
  });
}

/* ── status + refresh ────────────────────── */
function setStatus(ok) {
  const dot = $("liveDot"), txt = $("statusTxt");
  if (ok) {
    dot.className = "dot live";
    txt.textContent = "Live · " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } else {
    dot.className = "dot err";
    txt.textContent = "Offline — retrying";
  }
}

async function refresh(manual) {
  const btn = $("refreshBtn");
  if (manual) btn.classList.add("refreshing");
  try {
    await fetchQuotes();
    if (state.active) renderStats(state.quotes.get(state.active));
  } catch (_) {
    setStatus(false);
  } finally {
    if (manual) setTimeout(() => btn.classList.remove("refreshing"), 600);
  }
}

/* ── helpers ─────────────────────────────── */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ── wire up ─────────────────────────────── */
function init() {
  // Auth UI.
  $("loginForm").addEventListener("submit", (e) => {
    e.preventDefault();
    login($("loginInput").value);
  });
  $("userChip").addEventListener("click", () => {
    renderUser();
    $("accountOverlay").hidden = false;
  });
  $("accountOverlay").addEventListener("click", (e) => {
    if (e.target.id === "accountOverlay") $("accountOverlay").hidden = true;
  });
  $("logoutBtn").addEventListener("click", logout);

  // App UI.
  $("searchInput").addEventListener("input", (e) => onSearchInput(e.target.value));
  $("refreshBtn").addEventListener("click", () => refresh(true));
  $("backBtn").addEventListener("click", closeDetail);
  $("removeBtn").addEventListener("click", () => {
    if (!state.active) return;
    if (state.symbols.includes(state.active)) {
      if (confirm(`Remove ${state.active} from your list?`)) {
        removeSymbol(state.active);
        closeDetail();
      }
    } else {
      addSymbol(state.active);
      updateSheetActionBtn();
    }
  });
  $("overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeDetail(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("overlay").hidden) closeDetail();
    else if (!$("aiSettings").hidden) $("aiSettings").hidden = true;
    else if (!$("accountOverlay").hidden) $("accountOverlay").hidden = true;
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) hideSearch();
  });
  $("rangeTabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    $("rangeTabs").querySelectorAll("button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    loadChart(btn.dataset.range, btn.dataset.interval);
  });

  // Discover UI.
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchView(t.dataset.view)));
  $("presetRow").addEventListener("click", (e) => {
    const btn = e.target.closest(".preset");
    if (btn) applyPreset(btn.dataset.preset);
  });
  $("segType").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn) setType(btn.dataset.type);
  });
  $("applyFilters").addEventListener("click", () => {
    state.discover.spec = readForm();
    clearPresetHighlight();
    runScreen(true);
  });
  $("resetFilters").addEventListener("click", () => { resetFilters(); runScreen(true); });
  $("loadMore").addEventListener("click", () => runScreen(false));
  $("clearCuration").addEventListener("click", clearCuration);

  // AI search UI.
  $("aiForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("aiInput").value;
    $("aiInput").value = "";
    aiSend(v);
  });
  $("aiSettingsBtn").addEventListener("click", openAISettings);
  $("aiCloseSettings").addEventListener("click", () => { $("aiSettings").hidden = true; });
  $("aiSaveSettings").addEventListener("click", saveAISettings);
  $("aiModelSelect").addEventListener("change", commitModelChoice);
  $("aiSettings").addEventListener("click", (e) => {
    if (e.target.id === "aiSettings") $("aiSettings").hidden = true;
  });
  loadAISettings();

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.user) refresh(false);
  });

  // Resume a saved session, otherwise show the login gate.
  let saved = null;
  try { saved = normalizeUser(localStorage.getItem(USER_KEY)); } catch (_) {}
  if (saved) {
    login(saved);
  } else {
    $("login").hidden = false;
    $("loginInput").focus();
  }
}

document.addEventListener("DOMContentLoaded", init);
