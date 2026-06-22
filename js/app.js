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

  // reset range tabs to 1M
  const tabs = $("rangeTabs").querySelectorAll("button");
  tabs.forEach((b, i) => b.classList.toggle("active", i === 1));
  loadChart("1mo", "1d");
}

function closeDetail() {
  $("overlay").hidden = true;
  document.body.style.overflow = "";
  state.active = null;
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
    // refresh header price with the freshest quote
    state.quotes.set(sym, { ...state.quotes.get(sym), ...q });
    $("dPrice").textContent = fmtPrice(q.price, q.currency);
    const ch = fmtChange(q.change, q.changePct);
    const el = $("dChange"); el.textContent = ch.text; el.className = "big-change " + ch.cls;
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
    if (state.active && confirm(`Remove ${state.active} from your list?`)) {
      removeSymbol(state.active);
      closeDetail();
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
