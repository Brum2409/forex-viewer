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
    items: [],
    total: 0,
    size: 50,
    loading: false,
    loaded: false,
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

function currentType() {
  return $("segType").querySelector(".active")?.dataset.type || "stocks";
}

function numOrNull(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function buildSpec(offset) {
  const type = currentType();
  const cap = CAP_PRESETS[$("fCap").value];
  return {
    type,
    region: $("fRegion").value,
    sector: type === "stocks" ? ($("fSector").value || null) : null,
    marketCapMin: cap ? cap[0] : null,
    marketCapMax: cap ? cap[1] : null,
    priceMin: numOrNull($("fPriceMin").value),
    priceMax: numOrNull($("fPriceMax").value),
    dayChangeMin: numOrNull($("fDayMin").value),
    dayChangeMax: numOrNull($("fDayMax").value),
    yearChangeMin: numOrNull($("fYearMin").value),
    yearChangeMax: numOrNull($("fYearMax").value),
    volumeMin: VOL_PRESETS[$("fVol").value] ?? null,
    sort: $("fSort").value,
    size: state.discover.size,
    offset: offset || 0,
  };
}

function setType(type) {
  $("segType").querySelectorAll("button").forEach((b) =>
    b.classList.toggle("active", b.dataset.type === type));
  // Sector only applies to individual stocks.
  $("sectorRow").style.display = type === "stocks" ? "" : "none";
}

function resetFilters() {
  setType("stocks");
  $("fRegion").value = "us";
  $("fSector").value = "";
  $("fCap").value = "";
  ["fPriceMin","fPriceMax","fDayMin","fDayMax","fYearMin","fYearMax"].forEach((id) => ($(id).value = ""));
  $("fVol").value = "";
  $("fSort").value = "marketcap";
  $("presetRow").querySelectorAll(".preset").forEach((p) => p.classList.remove("active"));
}

// One-tap shortcuts that configure the filter form, then run.
function applyPreset(preset) {
  resetFilters();
  const cfg = {
    gainers:  { fSort: "gainers",     fDayMin: "2" },
    losers:   { fSort: "losers",      fDayMax: "-2" },
    active:   { fSort: "volume" },
    large:    { fSort: "marketcap",   fCap: "large" },
    yearup:   { fSort: "yeargainers", fYearMin: "20" },
    yeardown: { fSort: "yearlosers",  fYearMax: "-20" },
  }[preset];
  if (!cfg) return;
  for (const [id, val] of Object.entries(cfg)) $(id).value = val;
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
  d.loading = true;
  d.loaded = true;

  if (reset) {
    d.items = [];
    d.total = 0;
    $("loadMore").hidden = true;
    renderDiscover();
    setDiscoverStatus("Searching the market…");
  } else {
    setDiscoverStatus("Loading more…");
  }

  try {
    const data = await apiScreen(buildSpec(reset ? 0 : d.items.length));
    const incoming = data.quotes || [];
    d.total = data.total || d.items.length + incoming.length;
    d.items = reset ? incoming : d.items.concat(incoming);
    renderDiscover();
    if (!d.items.length) {
      setDiscoverStatus("No matches — try widening your filters.");
    } else {
      setDiscoverStatus(`Showing ${d.items.length} of ${d.total.toLocaleString()} matches`);
    }
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

function renderDiscover() {
  const root = $("discoverResults");
  root.innerHTML = "";
  for (const q of state.discover.items) root.appendChild(discoverCard(q));
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
    $("presetRow").querySelectorAll(".preset").forEach((p) => p.classList.remove("active"));
    runScreen(true);
  });
  $("resetFilters").addEventListener("click", () => { resetFilters(); runScreen(true); });
  $("loadMore").addEventListener("click", () => runScreen(false));

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
