/* Ticker — live stock & ETF viewer.
 * Talks to /api/quote and /api/search (Vercel serverless proxies to Yahoo). */

"use strict";

const DEFAULT_WATCHLIST = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "TSLA", "META",
  "SPY", "QQQ", "VOO", "VTI",
];
const STORAGE_KEY = "ticker.watchlist.v1";
const REFRESH_MS = 60_000;

const $ = (id) => document.getElementById(id);

const state = {
  symbols: load(),
  quotes: new Map(),   // symbol -> quote object
  active: null,        // symbol shown in detail sheet
  refreshTimer: null,
};

/* ── persistence ─────────────────────────── */
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch (_) {}
  return [...DEFAULT_WATCHLIST];
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.symbols)); } catch (_) {}
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

/* ── data fetching ───────────────────────── */
async function fetchQuotes() {
  if (!state.symbols.length) { renderList(); return; }
  const url = `/api/quote?symbols=${encodeURIComponent(state.symbols.join(","))}&range=5d&interval=1d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`quote ${res.status}`);
  const data = await res.json();
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
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
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
    const res = await fetch(`/api/quote?symbol=${encodeURIComponent(sym)}&range=${range}&interval=${interval}`);
    const q = await res.json();
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
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("overlay").hidden) closeDetail(); });
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

  renderList();
  refresh(false);
  state.refreshTimer = setInterval(() => refresh(false), REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh(false);
  });
}

document.addEventListener("DOMContentLoaded", init);
