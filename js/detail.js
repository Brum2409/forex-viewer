/* ============================================================
   DETAIL PANEL
   ============================================================ */
let _chartType = 'line';           // 'line' | 'candle'
let _chartResizeObserver = null;

async function openDetail(f, t) {
  const p = CFG.PAIRS.find(x => x.f === f && x.t === t);
  if (!p) return;
  S.selected = p;
  S.interval  = "1m";
  _chartType  = 'line';

  // Populate header from cached rates
  const rate    = calcRate(S.rates, f, t);
  const prev    = S.prevRates[`${f}/${t}`];
  const chgAbs  = (rate != null && prev != null) ? rate - prev : null;
  const chgPct  = chgAbs != null ? (chgAbs / prev) * 100 : null;
  const up      = chgPct != null ? chgPct >= 0 : null;

  document.getElementById("dPair").textContent = `${f}/${t}`;
  document.getElementById("dFull").textContent = `${p.fn} / ${p.tn}`;
  document.getElementById("dRate").textContent = rate != null ? fmt(rate, f, t) : "—";

  const dChg = document.getElementById("dChg");
  if (chgPct != null) {
    dChg.textContent = `${up ? "▲" : "▼"} ${Math.abs(chgPct).toFixed(2)}%`;
    dChg.className   = `d-chg ${up ? "up" : "down"}`;
  } else {
    dChg.textContent = "—";
    dChg.className   = "d-chg";
  }

  // Reset interval buttons
  document.querySelectorAll(".period-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.iv === "1m"));

  // Reset chart type buttons
  document.querySelectorAll(".type-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.type === "line"));

  document.getElementById("detail").classList.add("open");
  document.body.style.overflow = "hidden";

  renderMultiTimeframe(f, t);
  await loadChart(f, t, "1m");
}

function closeDetail() {
  document.getElementById("detail").classList.remove("open");
  document.body.style.overflow = "";
  _destroyChart();
  document.getElementById("statsRow").innerHTML  = "";
  document.getElementById("multiTf").innerHTML   = "";
}

function _destroyChart() {
  if (_chartResizeObserver) { _chartResizeObserver.disconnect(); _chartResizeObserver = null; }
  if (S.chart) { S.chart.remove(); S.chart = null; }
}

async function setChartInterval(btn, interval) {
  document.querySelectorAll(".period-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  S.interval = interval;
  if (S.selected) await loadChart(S.selected.f, S.selected.t, interval);
}

function setChartType(type) {
  _chartType = type;
  document.querySelectorAll(".type-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.type === type));
  if (S.selected) loadChart(S.selected.f, S.selected.t, S.interval);
}

/* ============================================================
   CHART LOADING — uses LightweightCharts (TradingView)
   Supports line (area) and candlestick modes.
   ============================================================ */
async function loadChart(f, t, interval) {
  const container = document.getElementById("chartContainer");
  const loader    = document.getElementById("chartLoader");
  loader.style.display   = "flex";
  container.style.opacity = "0";

  _destroyChart();

  let data;
  try {
    data = await fetchYahooFinanceChart(f, t, interval);
  } catch (err) {
    loader.style.display    = "none";
    container.style.opacity = "1";
    document.getElementById("statsRow").innerHTML =
      `<div class="chart-err">Chart unavailable — check connection</div>`;
    return;
  }

  loader.style.display    = "none";
  container.style.opacity = "1";

  if (!data || !data.length) {
    document.getElementById("statsRow").innerHTML =
      `<div class="chart-err">No data available for this interval</div>`;
    return;
  }

  const open  = data[0].open  ?? data[0].rate;
  const close = data[data.length - 1].rate;
  const mn    = Math.min(...data.map(d => d.low  ?? d.rate));
  const mx    = Math.max(...data.map(d => d.high ?? d.rate));
  const up    = close >= open;
  const color = up ? "#3FB950" : "#F85149";

  // Update multi-timeframe now that cache is populated
  renderMultiTimeframe(f, t);

  // Stats pills (O/H/L/C)
  document.getElementById("statsRow").innerHTML = `
    <div class="stat-pill">
      <span class="stat-l">O</span>
      <span class="stat-v">${fmt(open, f, t)}</span>
    </div>
    <div class="stat-pill stat-high">
      <span class="stat-l">H</span>
      <span class="stat-v">${fmt(mx, f, t)}</span>
    </div>
    <div class="stat-pill stat-low">
      <span class="stat-l">L</span>
      <span class="stat-v">${fmt(mn, f, t)}</span>
    </div>
    <div class="stat-pill">
      <span class="stat-l">C</span>
      <span class="stat-v" style="color:var(--${up?"green":"red"})">${fmt(close, f, t)}</span>
    </div>
  `;

  // Determine price format
  const isJPY   = f === "JPY" || t === "JPY";
  const isLarge = close >= 100;
  const precision = (isJPY || isLarge) ? 3 : 5;
  const minMove   = Math.pow(10, -precision);
  const showTime  = ['1m','5m','15m','30m','1h','2h','4h'].includes(interval);

  // Create LightweightCharts instance
  S.chart = LightweightCharts.createChart(container, {
    width:  container.clientWidth  || 380,
    height: container.clientHeight || 280,
    layout: {
      background: { type: 'solid', color: 'transparent' },
      textColor: '#6E7681',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: '#1E2530' },
      horzLines: { color: '#1E2530' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: '#484E58', labelBackgroundColor: '#21262D' },
      horzLine: { color: '#484E58', labelBackgroundColor: '#21262D' },
    },
    rightPriceScale: {
      borderColor: '#30363D',
      scaleMargins: { top: 0.08, bottom: 0.08 },
    },
    timeScale: {
      borderColor: '#30363D',
      timeVisible: showTime,
      secondsVisible: false,
      fixLeftEdge: true,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale:  { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
  });

  // Prepare series data (sorted, deduplicated by time)
  const seenTimes = new Set();
  const chartData = data
    .map(d => ({
      time:  Math.floor(d.ts / 1000),
      open:  d.open  ?? d.rate,
      high:  d.high  ?? d.rate,
      low:   d.low   ?? d.rate,
      close: d.rate,
      value: d.rate,
    }))
    .filter(d => { if (seenTimes.has(d.time)) return false; seenTimes.add(d.time); return true; })
    .sort((a, b) => a.time - b.time);

  const priceFormat = { type: 'price', precision, minMove };

  if (_chartType === 'candle') {
    const series = S.chart.addCandlestickSeries({
      upColor:        '#3FB950',
      downColor:      '#F85149',
      borderUpColor:  '#3FB950',
      borderDownColor:'#F85149',
      wickUpColor:    '#3FB950',
      wickDownColor:  '#F85149',
      priceFormat,
    });
    series.setData(chartData.map(d => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close })));
  } else {
    const series = S.chart.addAreaSeries({
      topColor:         color + '28',
      bottomColor:      color + '00',
      lineColor:        color,
      lineWidth:        2,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius:  4,
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat,
    });
    series.setData(chartData.map(d => ({ time: d.time, value: d.value })));
  }

  S.chart.timeScale().fitContent();

  // Handle container resize
  _chartResizeObserver = new ResizeObserver(() => {
    if (S.chart && container.clientWidth > 0) {
      S.chart.resize(container.clientWidth, container.clientHeight);
    }
  });
  _chartResizeObserver.observe(container);
}
