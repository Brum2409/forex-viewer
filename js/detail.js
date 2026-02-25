/* ============================================================
   DETAIL PANEL
   ============================================================ */
let _chartType = 'line';           // 'line' | 'candle'
let _chartResizeObserver = null;
let _activeSeries = null;          // holds current chart series for price-line overlays

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
  _triggerAnalysis(f, t);
}

function closeDetail() {
  document.getElementById("detail").classList.remove("open");
  document.body.style.overflow = "";
  _destroyChart();
  document.getElementById("statsRow").innerHTML    = "";
  document.getElementById("multiTf").innerHTML     = "";
  document.getElementById("analysis-panel").innerHTML = "";
  window._lastAnalysis = null;
}

function _destroyChart() {
  if (_chartResizeObserver) { _chartResizeObserver.disconnect(); _chartResizeObserver = null; }
  if (S.chart) { S.chart.remove(); S.chart = null; }
  _activeSeries = null;
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
    _activeSeries = S.chart.addCandlestickSeries({
      upColor:        '#3FB950',
      downColor:      '#F85149',
      borderUpColor:  '#3FB950',
      borderDownColor:'#F85149',
      wickUpColor:    '#3FB950',
      wickDownColor:  '#F85149',
      priceFormat,
    });
    _activeSeries.setData(chartData.map(d => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close })));
  } else {
    _activeSeries = S.chart.addAreaSeries({
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
    _activeSeries.setData(chartData.map(d => ({ time: d.time, value: d.value })));
  }

  S.chart.timeScale().fitContent();
  _drawZoneOverlays(f, t);

  // Handle container resize
  _chartResizeObserver = new ResizeObserver(() => {
    if (S.chart && container.clientWidth > 0) {
      S.chart.resize(container.clientWidth, container.clientHeight);
    }
  });
  _chartResizeObserver.observe(container);
}

/* ============================================================
   ZONE OVERLAYS — draw supply/demand price lines on chart
   ============================================================ */
function _drawZoneOverlays(f, t) {
  if (!_activeSeries || !window._lastAnalysis) return;
  const { zones } = window._lastAnalysis;
  if (!zones) return;

  const allSupply = [
    ...(zones.h4     && zones.h4.supply     || []),
    ...(zones.daily  && zones.daily.supply  || []),
    ...(zones.weekly && zones.weekly.supply || []),
  ];
  const allDemand = [
    ...(zones.h4     && zones.h4.demand     || []),
    ...(zones.daily  && zones.daily.demand  || []),
    ...(zones.weekly && zones.weekly.demand || []),
  ];

  for (const z of allSupply) {
    _activeSeries.createPriceLine({
      price: z.top,
      color: 'rgba(248,81,73,0.6)',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: false,
      title: '',
    });
    _activeSeries.createPriceLine({
      price: z.bottom,
      color: 'rgba(248,81,73,0.3)',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `Supply (${z.strength})`,
    });
  }

  for (const z of allDemand) {
    _activeSeries.createPriceLine({
      price: z.top,
      color: 'rgba(63,185,80,0.3)',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `Demand (${z.strength})`,
    });
    _activeSeries.createPriceLine({
      price: z.bottom,
      color: 'rgba(63,185,80,0.6)',
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: false,
      title: '',
    });
  }
}

/* ============================================================
   ANALYSIS TRIGGER — kick off analysis after chart loads
   ============================================================ */
function _triggerAnalysis(f, t) {
  const panel = document.getElementById('analysis-panel');
  if (!panel) return;

  panel.innerHTML = `
    <div class="analysis-loading">
      <div class="loader"></div>
      <span>Running technical analysis…</span>
    </div>`;

  runFullAnalysis(f, t)
    .then(result => {
      window._lastAnalysis = result;
      _renderAnalysisPanel(panel, result, f, t);
      _drawZoneOverlays(f, t);
    })
    .catch(err => {
      console.warn('Analysis failed:', err);
      panel.innerHTML = `<div class="analysis-error">Analysis unavailable</div>`;
    });
}

/* ============================================================
   ANALYSIS PANEL RENDERING
   ============================================================ */
function _renderAnalysisPanel(panel, result, f, t) {
  const { biases, zones, hsPatterns, candlePatterns, indicators, confidence } = result;
  panel._btPair = { f, t }; // stash for backtest section

  const rec    = confidence && confidence.recommendation ? confidence.recommendation : 'NEUTRAL';
  const score  = confidence && confidence.score != null  ? confidence.score : 0;
  const recCls = rec.includes('BUY') ? 'rec-buy' : rec.includes('SELL') ? 'rec-sell' : 'rec-neutral';
  const scoreBar = _buildScoreBar(score);

  const biasRows = ['weekly', 'daily', 'h4'].map(tf => {
    const b = biases[tf];
    if (!b) return '';
    const cls  = b.bias === 'BULLISH' ? 'bias-bull' : b.bias === 'BEARISH' ? 'bias-bear' : 'bias-neut';
    const icon = b.bias === 'BULLISH' ? '▲' : b.bias === 'BEARISH' ? '▼' : '–';
    const crossBadge = b.emaCross === 'GOLDEN' ? '<span class="cross-badge cross-golden">GX</span>'
                     : b.emaCross === 'DEATH'  ? '<span class="cross-badge cross-death">DX</span>'
                     : '';
    return `
      <div class="bias-row">
        <span class="bias-tf">${tf.toUpperCase()}</span>
        <span class="bias-structure">${b.structure || '—'}</span>
        <span class="bias-ema">EMA ${b.emaSignal || '—'}</span>
        ${crossBadge}
        <span class="bias-badge ${cls}">${icon} ${b.bias}</span>
      </div>`;
  }).join('');

  const indSection  = _buildIndicatorSection(indicators, result.pipSize);
  const zonePills   = _buildZonePills(zones, result.currentPrice, result.pipSize, f, t);
  const patternList = _buildPatternList(hsPatterns, candlePatterns);

  const factorRows = ((confidence && confidence.factors) || []).map(fac => {
    const pts = fac.points > 0 ? `+${fac.points}` : `${fac.points}`;
    const cls = fac.points > 0 ? 'factor-pos' : fac.points < 0 ? 'factor-neg' : 'factor-neu';
    return `<div class="factor-row">
      <span class="factor-label">${fac.label}</span>
      <span class="factor-value">${fac.value || ''}</span>
      <span class="factor-pts ${cls}">${pts}</span>
    </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="analysis-wrap">

      <div class="section-label" style="margin-top:12px">Technical Analysis</div>

      <div class="rec-banner ${recCls}">
        <div class="rec-label">${rec}</div>
        <div class="rec-score-wrap">
          ${scoreBar}
          <span class="rec-score-num">${score > 0 ? '+' : ''}${score}</span>
        </div>
      </div>

      <div class="analysis-section">
        <div class="analysis-section-title">Market Bias</div>
        <div class="bias-table">${biasRows}</div>
      </div>

      ${indSection}

      <div class="analysis-section">
        <div class="analysis-section-title">Supply &amp; Demand Zones</div>
        ${zonePills}
      </div>

      <div class="analysis-section">
        <div class="analysis-section-title">Patterns Detected</div>
        ${patternList}
      </div>

      <div class="analysis-section">
        <div class="analysis-section-title">Score Breakdown</div>
        <div class="factor-table">${factorRows || '<div class="analysis-empty">No data</div>'}</div>
      </div>

    </div>`;

  appendBacktestSection(panel, f, t);
}

function _buildIndicatorSection(indicators, pipSize) {
  const ind = indicators && indicators.daily;
  if (!ind) return '';

  function indCls(state, bullStates, bearStates) {
    if (bullStates.includes(state)) return 'ind-bull';
    if (bearStates.includes(state)) return 'ind-bear';
    return 'ind-neut';
  }

  // RSI cell
  const rsiVal = ind.rsi != null ? ind.rsi.toFixed(1) : '—';
  const rsiCls = indCls(ind.rsiState, ['OVERSOLD', 'LOW'], ['OVERBOUGHT', 'HIGH']);
  const rsiLbl = ind.rsiState === 'OVERBOUGHT' ? 'OVERBOUGHT'
               : ind.rsiState === 'OVERSOLD'   ? 'OVERSOLD'
               : ind.rsiState === 'HIGH'        ? 'HIGH ZONE'
               : ind.rsiState === 'LOW'         ? 'LOW ZONE'
               : ind.rsiState === 'UNKNOWN'     ? '—'
               : 'NEUTRAL';
  const rsiDivBadge = ind.rsiDivergence !== 'NONE'
    ? `<span class="div-badge ${ind.rsiDivergence === 'BULLISH' ? 'div-bull' : 'div-bear'}">${ind.rsiDivergence} DIV</span>`
    : '';

  // MACD cell
  const macdSign = ind.macd != null ? (ind.macd >= 0 ? '+' : '') : '';
  const macdDisp = ind.macd != null ? macdSign + ind.macd.toExponential(2) : '—';
  const macdCls  = indCls(ind.macdState,
    ['BULLISH CROSS', 'BULLISH'], ['BEARISH CROSS', 'BEARISH']);
  const macdLbl  = ind.macdState === 'BULLISH CROSS' ? 'BULL CROSS'
                 : ind.macdState === 'BEARISH CROSS' ? 'BEAR CROSS'
                 : ind.macdState === 'BULLISH'        ? 'BULLISH'
                 : ind.macdState === 'BEARISH'        ? 'BEARISH'
                 : 'NEUTRAL';

  // ATR cell
  const atrDisp = ind.atrPips != null ? `${ind.atrPips} pips` : '—';
  const atrLbl  = ind.atrPips == null  ? '—'
                : ind.atrPips > 80    ? 'HIGH VOL'
                : ind.atrPips > 40    ? 'MODERATE'
                : 'LOW VOL';

  // EMA cross cell
  const crossVal = ind.ema50 != null && ind.ema200 != null
    ? `50 ${ind.ema50 > ind.ema200 ? '>' : '<'} 200`
    : '—';
  const crossCls = ind.emaCross === 'GOLDEN' ? 'ind-bull'
                 : ind.emaCross === 'DEATH'  ? 'ind-bear'
                 : 'ind-neut';
  const crossLbl = ind.emaCross === 'GOLDEN' ? 'GOLDEN X'
                 : ind.emaCross === 'DEATH'  ? 'DEATH X'
                 : '—';

  // Fibonacci cell
  let fibVal = '—', fibCls = 'ind-neut', fibLbl = '—';
  if (ind.fib) {
    const nl = ind.fib.nearestLevel;
    fibVal = nl ? `${nl.label}%` : '—';
    if (ind.fib.signal) {
      fibCls = ind.fib.signal.direction === 'BULLISH' ? 'ind-bull' : 'ind-bear';
      fibLbl = `${ind.fib.signal.level}% ${ind.fib.signal.type}`;
    } else {
      fibLbl = ind.fib.trend === 'UP' ? 'UPTREND' : 'DOWNTREND';
    }
  }

  return `
    <div class="analysis-section">
      <div class="analysis-section-title">Oscillators &amp; Momentum (Daily)</div>
      <div class="ind-grid">
        <div class="ind-cell">
          <span class="ind-name">RSI (14)</span>
          <span class="ind-val ${rsiCls}">${rsiVal}</span>
          <span class="ind-lbl ${rsiCls}">${rsiLbl}</span>
          ${rsiDivBadge}
        </div>
        <div class="ind-cell">
          <span class="ind-name">MACD (12/26/9)</span>
          <span class="ind-val ${macdCls}">${macdDisp}</span>
          <span class="ind-lbl ${macdCls}">${macdLbl}</span>
        </div>
        <div class="ind-cell">
          <span class="ind-name">EMA Cross</span>
          <span class="ind-val ${crossCls}">${crossVal}</span>
          <span class="ind-lbl ${crossCls}">${crossLbl}</span>
        </div>
        <div class="ind-cell">
          <span class="ind-name">ATR (14)</span>
          <span class="ind-val ind-neut">${atrDisp}</span>
          <span class="ind-lbl ind-neut">${atrLbl}</span>
        </div>
        <div class="ind-cell ind-cell-wide">
          <span class="ind-name">Fibonacci</span>
          <span class="ind-val ${fibCls}">${fibVal}</span>
          <span class="ind-lbl ${fibCls}">${fibLbl}</span>
        </div>
      </div>
    </div>`;
}

function _buildScoreBar(score) {
  const pct   = Math.abs(score);
  const side  = score >= 0 ? 'right' : 'left';
  const color = score > 0 ? 'var(--green)' : score < 0 ? 'var(--red)' : 'var(--txt3)';
  return `<div class="score-bar-wrap">
    <div class="score-bar-track">
      <div class="score-bar-fill" style="width:${pct / 2}%;background:${color};float:${side}"></div>
    </div>
  </div>`;
}

function _buildZonePills(zones, currentPrice, pipSize, f, t) {
  const rows = [];
  for (const tf of ['weekly', 'daily', 'h4']) {
    const z = zones[tf];
    if (!z) continue;
    if (!z.supply.length && !z.demand.length) continue;
    const label = tf.toUpperCase();
    for (const s of z.supply.slice(0, 2)) {
      const near = (pipSize && (s.bottom - currentPrice) < 20 * pipSize) ? ' zone-near' : '';
      rows.push(`<div class="zone-pill zone-supply${near}">
        <span class="zone-tf">${label}</span>
        <span class="zone-type">Supply</span>
        <span class="zone-range">${fmt(s.bottom, f, t)} – ${fmt(s.top, f, t)}</span>
        <span class="zone-strength">${s.strength}✦</span>
      </div>`);
    }
    for (const d of z.demand.slice(0, 2)) {
      const near = (pipSize && (currentPrice - d.top) < 20 * pipSize) ? ' zone-near' : '';
      rows.push(`<div class="zone-pill zone-demand${near}">
        <span class="zone-tf">${label}</span>
        <span class="zone-type">Demand</span>
        <span class="zone-range">${fmt(d.top, f, t)} – ${fmt(d.bottom, f, t)}</span>
        <span class="zone-strength">${d.strength}✦</span>
      </div>`);
    }
  }
  return rows.length ? rows.join('') : '<div class="analysis-empty">No zones detected</div>';
}

function _buildPatternList(hsPatterns, candlePatterns) {
  const items = [];
  for (const [tf, hs] of Object.entries(hsPatterns || {})) {
    if (!hs || !hs.found) continue;
    const cls = hs.type === 'HS' ? 'pat-bear' : 'pat-bull';
    items.push(`<div class="pattern-item ${cls}">
      <span class="pat-tf">${tf.toUpperCase()}</span>
      <span class="pat-name">${hs.type === 'HS' ? 'Head &amp; Shoulders' : 'Inv. Head &amp; Shoulders'}</span>
      <span class="pat-conf">${hs.confidence}</span>
    </div>`);
  }
  for (const [tf, pats] of Object.entries(candlePatterns || {})) {
    if (!pats) continue;
    for (const p of pats) {
      const cls = p.type === 'BULLISH' ? 'pat-bull' : p.type === 'BEARISH' ? 'pat-bear' : 'pat-neut';
      items.push(`<div class="pattern-item ${cls}">
        <span class="pat-tf">${tf.toUpperCase()}</span>
        <span class="pat-name">${p.name}</span>
        <span class="pat-conf">${p.type}</span>
      </div>`);
    }
  }
  return items.length ? items.join('') : '<div class="analysis-empty">No patterns detected</div>';
}
