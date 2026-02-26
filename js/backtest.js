/* ============================================================
   BACKTESTING ENGINE
   Walk-forward simulation on daily candles. No look-ahead:
   signals are generated only from data[0..i], trade entered
   at data[i+1].open with ATR-based SL and 2:1 R:R take-profit.
   ============================================================ */

const BT_DEFAULTS = {
  WARMUP:         200,   // bars for EMA200 + indicator warm-up
  ATR_SL:         2.0,   // stop-loss = ATR × this
  RR:             2.0,   // take-profit = SL distance × R:R
  MIN_SCORE:      55,    // minimum |confidence score| to open a trade (raised for quality)
  USE_TREND_FILTER: true, // apply EMA200 + weekly trend filter
  USE_TRAILING_STOP: false, // use a trailing stop-loss
  TSL_FACTOR:       1.5,   // trailing stop ATR factor
  TSL_TRIGGER_RR:   1.0,   // R:R multiple to activate trailing stop
};

// Global BT object to hold current settings
const BT = { ...BT_DEFAULTS };

/* Neutral placeholders for timeframes not used in backtest signal */
const _BT_NEUTRAL_BIAS = {
  bias: 'NEUTRAL', structure: 'MIXED', emaSignal: 'UNKNOWN',
  emaCross: 'NONE', ema50: null, ema200: null,
  rsi: null, rsiState: 'UNKNOWN', macdState: 'NEUTRAL',
  swingHighs: [], swingLows: [],
};
const _BT_EMPTY_ZONES = { supply: [], demand: [] };
const _BT_NO_HS       = { found: false, type: null, neckline: null, headPrice: null, confidence: null };

/* ── Weekly bias approximation from daily candles ────────── */
// Groups every 5 daily bars into pseudo-weekly candles to give
// the scorer a weekly-trend perspective without look-ahead bias.
function _computeWeeklyFromDaily(dailyCandles, pipSize) {
  if (!dailyCandles || dailyCandles.length < 10) return _BT_NEUTRAL_BIAS;
  const weekly = [];
  for (let i = 0; i < dailyCandles.length; i += 5) {
    const g = dailyCandles.slice(i, i + 5);
    if (g.length < 3) continue;
    weekly.push({
      ts:   g[g.length - 1].ts,
      open: g[0].open  || g[0].rate,
      high: Math.max(...g.map(c => c.high || c.rate)),
      low:  Math.min(...g.map(c => c.low  || c.rate)),
      rate: g[g.length - 1].rate,
    });
  }
  return weekly.length >= 5 ? detectBias(weekly, pipSize) : _BT_NEUTRAL_BIAS;
}

/* ── Signal from a fixed candle slice (no API calls) ─────── */
// Now includes weekly-trend approximation for proper multi-TF scoring.
// Also exposes weeklyBias and dailyRsi for the walk-forward filters.
function _btSignal(candles, pipSize) {
  const ind = computeIndicators(candles, pipSize);
  if (!ind || !ind.atr) return null;

  const bias    = detectBias(candles, pipSize);
  const wBias   = _computeWeeklyFromDaily(candles, pipSize);
  const zones   = detectZones(candles, pipSize);
  const hs      = detectHeadAndShoulders(candles);
  const cp      = detectCandlestickPatterns(candles);

  const currentPrice = candles[candles.length - 1].rate;

  const conf = calcConfidenceScore(
    { weekly: wBias, daily: bias, h4: _BT_NEUTRAL_BIAS, h2: _BT_NEUTRAL_BIAS, h1: _BT_NEUTRAL_BIAS, m30: _BT_NEUTRAL_BIAS },
    { weekly: _BT_EMPTY_ZONES, daily: zones, h4: _BT_EMPTY_ZONES },
    { weekly: _BT_NO_HS, daily: hs, h4: _BT_NO_HS },
    { daily: cp, h4: [], h2: [] },
    { daily: ind, h4: null, h2: null, h1: null, m30: null },
    currentPrice, pipSize
  );

  return { ...conf, atr: ind.atr, ema200: ind.ema200, weeklyBias: wBias.bias, dailyRsi: ind.rsi };
}

/* ── Walk-forward simulation ─────────────────────────────── */
function _walkForward(candles, pipSize) {
  const trades   = [];
  let   position = null;

  for (let i = BT.WARMUP; i < candles.length - 1; i++) {
    const next = candles[i + 1];
    const candleSlice = candles.slice(0, i + 1);
    const sig = _btSignal(candleSlice, pipSize);

    /* ── Manage open position ───────────────────────── */
    if (position) {
      const hi = next.high ?? next.rate;
      const lo = next.low  ?? next.rate;
      let exitPrice = null, exitType = null;

      // Trailing stop update
      if (BT.USE_TRAILING_STOP && sig && sig.atr) {
        if (position.direction === 'LONG') {
          const triggerPrice = position.entry + (position.tp - position.entry) / BT.RR * BT.TSL_TRIGGER_RR;
          if (hi > triggerPrice) {
            position.sl = Math.max(position.sl, hi - (sig.atr * BT.TSL_FACTOR));
          }
        } else { // SHORT
          const triggerPrice = position.entry - (position.entry - position.tp) / BT.RR * BT.TSL_TRIGGER_RR;
          if (lo < triggerPrice) {
            position.sl = Math.min(position.sl, lo + (sig.atr * BT.TSL_FACTOR));
          }
        }
      }

      if (position.direction === 'LONG') {
        if (lo  <= position.sl)  { exitPrice = position.sl; exitType = 'SL'; }
        else if (hi >= position.tp) { exitPrice = position.tp; exitType = 'TP'; }
      } else { // SHORT
        if (hi >= position.sl)   { exitPrice = position.sl; exitType = 'SL'; }
        else if (lo <= position.tp) { exitPrice = position.tp; exitType = 'TP'; }
      }

      if (exitPrice !== null) {
        const pips = position.direction === 'LONG'
          ? (exitPrice - position.entry) / pipSize
          : (position.entry - exitPrice) / pipSize;
        trades.push({ ...position, exit: exitPrice, exitType, pips, exitBar: i + 1, exitTs: next.ts });
        position = null;
      }
    }

    /* ── Generate signal & open position ──────────────── */
    if (!position && sig && Math.abs(sig.score) >= BT.MIN_SCORE) {
      const direction = sig.recommendation.includes('BUY')  ? 'LONG'
                      : sig.recommendation.includes('SELL') ? 'SHORT'
                      : null;

      if (direction) {
        const entry  = next.open ?? next.rate;
        const slDist = sig.atr * BT.ATR_SL;

        if (slDist) { // Skip if ATR is zero
          // EMA200 trend filter (daily EMA200 on primary timeframe)
          const emaOK = !BT.USE_TREND_FILTER || !sig.ema200 ||
            (direction === 'LONG'  && entry >= sig.ema200) ||
            (direction === 'SHORT' && entry <= sig.ema200);

          // Weekly trend alignment filter — avoids counter-trend trades
          // NEUTRAL weekly allows both directions; opposing weekly blocks trade
          const weeklyOK = !BT.USE_TREND_FILTER || !sig.weeklyBias ||
            sig.weeklyBias === 'NEUTRAL' ||
            (direction === 'LONG'  && sig.weeklyBias === 'BULLISH') ||
            (direction === 'SHORT' && sig.weeklyBias === 'BEARISH');

          // RSI quality filter — avoid entering when daily RSI is extended
          // against the trade direction (overbought on longs, oversold on shorts)
          const rsiOK = sig.dailyRsi == null ||
            (direction === 'LONG'  && sig.dailyRsi < 68) ||
            (direction === 'SHORT' && sig.dailyRsi > 32);

          if (emaOK && weeklyOK && rsiOK) {
            const sl = direction === 'LONG' ? entry - slDist : entry + slDist;
            const tp = direction === 'LONG' ? entry + slDist * BT.RR : entry - slDist * BT.RR;
            position = { direction, entry, sl, tp, entryBar: i + 1,
                         score: sig.score, recommendation: sig.recommendation, ts: next.ts };
          }
        }
      }
    }
  }

  /* Force-close open position at last price */
  if (position) {
    const last = candles[candles.length - 1];
    const pips = position.direction === 'LONG'
      ? (last.rate - position.entry) / pipSize
      : (position.entry - last.rate) / pipSize;
    trades.push({ ...position, exit: last.rate, exitType: 'OPEN', pips, exitBar: candles.length - 1, exitTs: last.ts });
  }

  return trades;
}


/* ── Compute stats from trade list ───────────────────────── */
function _btStats(trades) {
  if (!trades.length) return null;

  const wins      = trades.filter(t => t.pips > 0);
  const losses    = trades.filter(t => t.pips <= 0);
  const totalPips = trades.reduce((s, t) => s + t.pips, 0);
  const grossWin  = wins.reduce((s, t) => s + t.pips, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pips, 0));

  /* Equity curve + max drawdown */
  let eq = 0, peak = 0, maxDD = 0;
  const equityCurve = trades.map(t => {
    eq   += t.pips;
    peak  = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
    return eq;
  });

  const winRate      = wins.length / trades.length;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0);
  const avgWin       = wins.length   ? grossWin  / wins.length   : 0;
  const avgLoss      = losses.length ? grossLoss / losses.length : 0;

  /* Composite score 0–100 */
  const wrPts  = Math.min(winRate / 0.60, 1) * 100 * 0.40;
  const pfPts  = Math.min(profitFactor / 2, 1) * 100 * 0.30;
  const pipPts = totalPips > 0 ? Math.min(totalPips / 200, 1) * 100 * 0.30 : 0;
  const profitabilityScore = Math.max(0, Math.round(wrPts + pfPts + pipPts));

  return {
    totalTrades: trades.length,
    wins: wins.length, losses: losses.length,
    winRate: (winRate * 100).toFixed(1),
    totalPips: totalPips.toFixed(1),
    grossWin: grossWin.toFixed(1),
    grossLoss: grossLoss.toFixed(1),
    profitFactor: isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞',
    maxDrawdownPips: maxDD.toFixed(1),
    avgWin: avgWin.toFixed(1),
    avgLoss: avgLoss.toFixed(1),
    profitabilityScore,
    equityCurve,
    trades,
  };
}

/* ── Public: single-pair backtest ─────────────────────────── */
async function runBacktest(f, t) {
  _updateBTState(); // Sync global BT object with UI settings
  const pipSize = (f === 'JPY' || t === 'JPY') ? 0.01 : 0.0001;
  const candles = await fetchYahooFinanceChart(f, t, '1D');

  if (!candles || candles.length < BT.WARMUP + 20) {
    return { error: `Need ≥ ${BT.WARMUP + 20} daily bars; got ${candles ? candles.length : 0}` };
  }

  const trades = _walkForward(candles, pipSize);
  const stats  = _btStats(trades) || { totalTrades: 0, profitabilityScore: 0 };
  return { ...stats, pair: `${f}/${t}`, bars: candles.length - BT.WARMUP };
}

/* ── Public: auto-test all configured pairs ──────────────── */
async function runAutoBacktest(progressCb) {
  _updateBTState(); // Sync global BT object with UI settings
  const pairs   = CFG.PAIRS.slice(0, 12);
  const results = [];

  for (let i = 0; i < pairs.length; i++) {
    const { f, t } = pairs[i];
    if (progressCb) progressCb(i, pairs.length, `${f}/${t}`);
    try {
      const res = await runBacktest(f, t);
      if (!res.error) results.push(res);
    } catch (_) { /* skip */ }
    if (i < pairs.length - 1) await new Promise(r => setTimeout(r, 400));
  }

  if (!results.length) return { error: 'No results', pairs: [] };

  const avgScore   = Math.round(results.reduce((s, r) => s + r.profitabilityScore, 0) / results.length);
  const totalPips  = results.reduce((s, r) => s + parseFloat(r.totalPips  || 0), 0).toFixed(1);
  const avgWinRate = (results.reduce((s, r) => s + parseFloat(r.winRate || 0), 0) / results.length).toFixed(1);

  return { pairs: results, avgScore, totalPips, avgWinRate };
}


/* ============================================================
   UI HELPERS
   ============================================================ */

function _drawEquityCurve(curve) {
  if (!curve || curve.length < 2) return '';
  const W = 300, H = 56, PAD = 3;
  const mn = Math.min(0, ...curve), mx = Math.max(0, ...curve);
  const rng = mx - mn || 1;
  const toX = i => PAD + (i / (curve.length - 1)) * (W - 2 * PAD);
  const toY = v => PAD + (1 - (v - mn) / rng) * (H - 2 * PAD);
  const pts = curve.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const lastEq = curve[curve.length - 1];
  const col = lastEq >= 0 ? '#3FB950' : '#F85149';
  const zY = toY(0).toFixed(1);
  const fillPts = `${PAD},${zY} ${pts} ${toX(curve.length - 1).toFixed(1)},${zY}`;

  return `<svg viewBox="0 0 ${W} ${H}" class="bt-equity-svg" preserveAspectRatio="none">
    <polygon points="${fillPts}" fill="${col}" opacity="0.12"/>
    <line x1="${PAD}" y1="${zY}" x2="${W - PAD}" y2="${zY}"
          stroke="#30363D" stroke-width="1" stroke-dasharray="3,2"/>
    <polyline points="${pts}" fill="none" stroke="${col}"
              stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function _btScoreLabel(score) {
  return score >= 70 ? 'STRONG'
       : score >= 50 ? 'MODERATE'
       : score >= 30 ? 'WEAK'
       :               'POOR';
}

function _buildBacktestResult(result, f, t) {
  if (result.error) {
    return `<div class="analysis-error">${result.error}</div>
      <button class="bt-run-btn" onclick="_launchBacktest('${f}','${t}')">Retry</button>`;
  }

  const { totalTrades, wins, losses, winRate, totalPips,
          profitFactor, maxDrawdownPips, avgWin, avgLoss,
          profitabilityScore, equityCurve, bars, trades } = result;

  const scoreCls   = profitabilityScore >= 70 ? 'bt-score-great'
                   : profitabilityScore >= 50 ? 'bt-score-ok'
                   :                            'bt-score-poor';
  const pipsNum    = parseFloat(totalPips);
  const pipsCls    = pipsNum >= 0 ? 'bt-pip-pos' : 'bt-pip-neg';
  const pipsSign   = pipsNum >= 0 ? '+' : '';
  const scoreLabel = _btScoreLabel(profitabilityScore);
  const curveSvg = _drawEquityCurve(equityCurve);

  const settingsDesc = `min score ${BT.MIN_SCORE}` +
    (BT.USE_TREND_FILTER ? ' · EMA200 filter' : '') +
    (BT.USE_TRAILING_STOP ? ` · TSL (${BT.TSL_TRIGGER_RR}R, ${BT.TSL_FACTOR}×ATR)` : '');

  const recentTrades = (trades || []).slice(-8).reverse().map(tr => {
    const cls  = tr.pips > 0 ? 'bt-tr-win' : tr.pips <= 0 ? 'bt-tr-loss' : '';
    const icon = tr.direction === 'LONG' ? '▲' : '▼';
    const sign = tr.pips >= 0 ? '+' : '';
    const exit = tr.exitType === 'SL' ? 'SL' : tr.exitType === 'TP' ? 'TP' : '—';
    return `<div class="bt-trade-row ${cls}">
      <span class="bt-tr-dir">${icon}</span>
      <span class="bt-tr-exit">${exit}</span>
      <span class="bt-tr-pips">${sign}${tr.pips.toFixed(1)}p</span>
    </div>`;
  }).join('');

  const pipDigits = (result.pair || '').includes('JPY') ? 3 : 5;
  const allTradesTable = (trades && trades.length > 0) ? `
    <div class="bt-trades-wrap" style="margin-top: 24px;">
      <div class="bt-curve-label">Full Trade Log</div>
      <div class="bt-trade-log-container">
        <div class="bt-log-header">
          <span>Entry Date</span>
          <span>Exit Date</span>
          <span>Type</span>
          <span>Entry</span>
          <span>SL</span>
          <span>TP</span>
          <span>Exit</span>
          <span>Pips</span>
          <span>Reason</span>
        </div>
        ${trades.map(tr => `
          <div class="bt-log-row ${tr.pips > 0 ? 'bt-tr-win' : 'bt-tr-loss'}">
            <span>${new Date(tr.ts * 1000).toLocaleDateString()}</span>
            <span>${tr.exitTs ? new Date(tr.exitTs * 1000).toLocaleDateString() : '-'}</span>
            <span title="${tr.direction}">${tr.direction === 'LONG' ? '▲' : '▼'} ${tr.direction}</span>
            <span>${tr.entry.toFixed(pipDigits)}</span>
            <span>${tr.sl.toFixed(pipDigits)}</span>
            <span>${tr.tp.toFixed(pipDigits)}</span>
            <span>${tr.exit.toFixed(pipDigits)}</span>
            <span>${tr.pips.toFixed(1)}</span>
            <span>${tr.exitType}</span>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  return `
    <div class="bt-score-wrap">
      <div class="bt-score-num ${scoreCls}">${profitabilityScore}</div>
      <div class="bt-score-meta">
        <div class="bt-score-label ${scoreCls}">${scoreLabel}</div>
        <div class="bt-score-sub">${bars} bars · ${settingsDesc}</div>
      </div>
      <div class="bt-score-bar-track">
        <div class="bt-score-bar-fill ${scoreCls}" style="width:${profitabilityScore}%"></div>
      </div>
    </div>
    <div class="bt-metrics">
      <div class="bt-metric"><span class="bt-m-lbl">Trades</span><span class="bt-m-val">${totalTrades}</span><span class="bt-m-sub">${wins}W / ${losses}L</span></div>
      <div class="bt-metric"><span class="bt-m-lbl">Win Rate</span><span class="bt-m-val">${winRate}%</span><span class="bt-m-sub">of ${totalTrades} trades</span></div>
      <div class="bt-metric"><span class="bt-m-lbl">Profit Factor</span><span class="bt-m-val">${profitFactor}</span><span class="bt-m-sub">gross W/L ratio</span></div>
      <div class="bt-metric"><span class="bt-m-lbl">Total Pips</span><span class="bt-m-val ${pipsCls}">${pipsSign}${totalPips}</span><span class="bt-m-sub">net result</span></div>
      <div class="bt-metric"><span class="bt-m-lbl">Max Drawdown</span><span class="bt-m-val">${maxDrawdownPips}p</span><span class="bt-m-sub">peak to trough</span></div>
      <div class="bt-metric"><span class="bt-m-lbl">Avg Win / Loss</span><span class="bt-m-val">${avgWin} / ${avgLoss}</span><span class="bt-m-sub">pips per trade</span></div>
    </div>
    ${curveSvg ? `<div class="bt-curve-wrap"><div class="bt-curve-label">Equity Curve (pips)</div>${curveSvg}</div>` : ''}
    ${recentTrades ? `<div class="bt-trades-wrap"><div class="bt-curve-label">Recent Trades</div><div class="bt-trades">${recentTrades}</div></div>` : ''}
    ${allTradesTable}
    <button class="bt-auto-btn" onclick="_launchAutoBacktest()">Test All Pairs</button>
    <div id="bt-auto-result"></div>`;
}

function _buildAutoBacktestResult(result) {
    if (result.error) return `<div class="analysis-error">${result.error}</div>`;

  const { pairs, avgScore, totalPips, avgWinRate } = result;
  const scoreCls = avgScore >= 70 ? 'bt-score-great' : avgScore >= 50 ? 'bt-score-ok' : 'bt-score-poor';

  const rows = pairs.map(p => {
    const pipNum  = parseFloat(p.totalPips);
    const pipSign = pipNum >= 0 ? '+' : '';
    const pipCls  = pipNum >= 0 ? 'bt-pip-pos' : 'bt-pip-neg';
    const sCls    = p.profitabilityScore >= 70 ? 'bt-score-great' : p.profitabilityScore >= 50 ? 'bt-score-ok' : 'bt-score-poor';
    return `<div class="bt-auto-row">
      <span class="bt-auto-pair">${p.pair}</span>
      <span class="bt-auto-score ${sCls}">${p.profitabilityScore}</span>
      <span class="bt-auto-wr">${p.winRate}%</span>
      <span class="bt-auto-pips ${pipCls}">${pipSign}${p.totalPips}p</span>
    </div>`;
  }).join('');

  const totalSign = parseFloat(totalPips) >= 0 ? '+' : '';

  return `<div class="bt-auto-wrap">
    <div class="bt-auto-header"><div class="bt-auto-hcell">Pair</div><div class="bt-auto-hcell">Score</div><div class="bt-auto-hcell">Win%</div><div class="bt-auto-hcell">Pips</div></div>
    ${rows}
    <div class="bt-auto-summary">
      <span>Avg Score: <strong class="bt-score-label ${scoreCls}">${avgScore}</strong></span>
      <span>Avg Win Rate: <strong>${avgWinRate}%</strong></span>
      <span>All Pairs: <strong class="${parseFloat(totalPips) >= 0 ? 'bt-pip-pos' : 'bt-pip-neg'}">${totalSign}${totalPips}p</strong></span>
    </div>
  </div>`;
}

/* ── DOM interaction ─────────────────────────────────────── */

function _getBTSavedSetting(key, defaultValue) {
    const saved = localStorage.getItem(`bt_${key}`);
    if (saved === null) return defaultValue;
    if (typeof defaultValue === 'boolean') return saved === 'true';
    if (typeof defaultValue === 'number') return parseFloat(saved);
    return saved;
}

function _updateBTState() {
    BT.MIN_SCORE = _getBTSavedSetting('min_score', BT_DEFAULTS.MIN_SCORE);
    BT.ATR_SL = _getBTSavedSetting('atr_sl', BT_DEFAULTS.ATR_SL);
    BT.RR = _getBTSavedSetting('rr', BT_DEFAULTS.RR);
    BT.USE_TREND_FILTER = _getBTSavedSetting('use_trend_filter', BT_DEFAULTS.USE_TREND_FILTER);
    BT.USE_TRAILING_STOP = _getBTSavedSetting('use_trailing_stop', BT_DEFAULTS.USE_TRAILING_STOP);
    BT.TSL_FACTOR = _getBTSavedSetting('tsl_factor', BT_DEFAULTS.TSL_FACTOR);
    BT.TSL_TRIGGER_RR = _getBTSavedSetting('tsl_trigger_rr', BT_DEFAULTS.TSL_TRIGGER_RR);
}

function _onBTSettingChange(key, val) {
    const el = document.getElementById(`bt-${key.replace(/_/g, '-')}-val`);
    if (el) el.textContent = val;
    localStorage.setItem(`bt_${key}`, val);
    _updateBTState();
}

async function _launchBacktest(f, t) {
  const container = document.getElementById('bt-result');
  if (!container) return;
  _updateBTState();
  container.innerHTML = `<div class="analysis-loading"><div class="loader"></div><span>Running walk-forward simulation...</span></div>`;
  try {
    const result = await runBacktest(f, t);
    container.innerHTML = _buildBacktestResult(result, f, t);
  } catch (err) {
    container.innerHTML = `<div class="analysis-error">Backtest failed: ${err.message}</div>
      <button class="bt-run-btn" onclick="_launchBacktest('${f}','${t}')">Retry</button>`;
  }
}

async function _launchAutoBacktest() {
  const container = document.getElementById('bt-auto-result');
  if (!container) return;
  _updateBTState();
  container.innerHTML = `<div class="analysis-loading"><div class="loader"></div><span id="bt-auto-progress">Fetching pair 1…</span></div>`;
  const onProgress = (i, total, pair) => {
    const el = document.getElementById('bt-auto-progress');
    if (el) el.textContent = `Testing ${pair} (${i + 1}/${total})…`;
  };
  try {
    const result = await runAutoBacktest(onProgress);
    container.innerHTML = _buildAutoBacktestResult(result);
  } catch (err) {
    container.innerHTML = `<div class="analysis-error">Auto-test failed: ${err.message}</div>`;
  }
}

/* ── Entry point called from detail.js ───────────────────── */
function appendBacktestSection(panel, f, t) {
  _updateBTState(); // Load saved settings on init
  const section = document.createElement('div');
  section.className = 'analysis-section';
  section.innerHTML = `
    <div class="analysis-section-title">Strategy Backtest</div>
    <div class="bt-settings">
      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-min-score">Min. Confidence Score
          <span class="bt-setting-hint">Higher = fewer but stronger signals</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="range" id="bt-min-score" min="25" max="80" value="${BT.MIN_SCORE}" step="5" oninput="_onBTSettingChange('min_score', this.value)">
          <span id="bt-min-score-val" class="bt-range-val">${BT.MIN_SCORE}</span>
        </div>
      </div>
      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-atr-sl">ATR Stop-Loss Multiplier
          <span class="bt-setting-hint">Wider stop to survive daily volatility</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="range" id="bt-atr-sl" min="1.0" max="5.0" value="${BT.ATR_SL}" step="0.5" oninput="_onBTSettingChange('atr_sl', this.value)">
          <span id="bt-atr-sl-val" class="bt-range-val">${BT.ATR_SL}</span>
        </div>
      </div>
      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-rr">Risk:Reward Ratio
          <span class="bt-setting-hint">Target profit relative to stop-loss</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="range" id="bt-rr" min="1.0" max="5.0" value="${BT.RR}" step="0.5" oninput="_onBTSettingChange('rr', this.value)">
          <span id="bt-rr-val" class="bt-range-val">${BT.RR}</span>
        </div>
      </div>
      <div class="bt-setting-row">
          <label class="bt-setting-label" for="bt-use-trend-filter">EMA200 Trend Filter
            <span class="bt-setting-hint">Only trade in direction of major trend</span>
          </label>
          <div class="bt-setting-ctrl">
              <input type="checkbox" id="bt-use-trend-filter" ${BT.USE_TREND_FILTER ? 'checked' : ''} onchange="_onBTSettingChange('use_trend_filter', this.checked)">
          </div>
      </div>
      <div class="bt-setting-row">
          <label class="bt-setting-label" for="bt-use-trailing-stop">Use Trailing Stop-Loss
            <span class="bt-setting-hint">Lock in profits as price moves favorably</span>
          </label>
          <div class="bt-setting-ctrl">
              <input type="checkbox" id="bt-use-trailing-stop" ${BT.USE_TRAILING_STOP ? 'checked' : ''} onchange="_onBTSettingChange('use_trailing_stop', this.checked)">
          </div>
      </div>
       <div class="bt-setting-row" ${!BT.USE_TRAILING_STOP ? 'style="display: none;"' : ''}>
        <label class="bt-setting-label" for="bt-tsl-trigger-rr">TSL Trigger R:R
          <span class="bt-setting-hint">R:R multiple to activate trailing stop</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="range" id="bt-tsl-trigger-rr" min="0.5" max="2.0" value="${BT.TSL_TRIGGER_RR}" step="0.1" oninput="_onBTSettingChange('tsl_trigger_rr', this.value)">
          <span id="bt-tsl-trigger-rr-val" class="bt-range-val">${BT.TSL_TRIGGER_RR}</span>
        </div>
      </div>
       <div class="bt-setting-row" ${!BT.USE_TRAILING_STOP ? 'style="display: none;"' : ''}>
        <label class="bt-setting-label" for="bt-tsl-factor">TSL ATR Factor
          <span class="bt-setting-hint">How far trailing stop follows price</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="range" id="bt-tsl-factor" min="1.0" max="4.0" value="${BT.TSL_FACTOR}" step="0.5" oninput="_onBTSettingChange('tsl_factor', this.value)">
          <span id="bt-tsl-factor-val" class="bt-range-val">${BT.TSL_FACTOR}</span>
        </div>
      </div>
    </div>
    <div class="bt-intro">
      Day-trader walk-forward on ~2 yrs of daily candles. Uses 4H/2H as primary signal timeframes with 1D/1W trend filters and RSI quality gates.
    </div>
    <button class="bt-run-btn" onclick="_launchBacktest('${f}','${t}')">Run Backtest</button>
    <div id="bt-result"></div>`;
  panel.appendChild(section);

  // Show/hide TSL settings based on checkbox
  const tslCheckbox = section.querySelector('#bt-use-trailing-stop');
  const tslRows = section.querySelectorAll('.bt-setting-row[style*="display"]');
  tslCheckbox.addEventListener('change', (e) => {
    tslRows.forEach(row => {
        row.style.display = e.target.checked ? '' : 'none';
    });
  });
}

window.runBacktest           = runBacktest;
window.runAutoBacktest       = runAutoBacktest;
window._launchBacktest       = _launchBacktest;
window._launchAutoBacktest   = _launchAutoBacktest;
window.appendBacktestSection = appendBacktestSection;
window._onBTSettingChange    = _onBTSettingChange;
