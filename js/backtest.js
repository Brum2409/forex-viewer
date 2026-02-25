/* ============================================================
   BACKTESTING ENGINE
   Walk-forward simulation on daily candles. No look-ahead:
   signals are generated only from data[0..i], trade entered
   at data[i+1].open with ATR-based SL and 2:1 R:R take-profit.
   ============================================================ */

const BT = {
  WARMUP:    200,  // bars for EMA200 + indicator warm-up
  ATR_SL:    1.5,  // stop-loss = ATR × this
  RR:        2.0,  // take-profit = SL distance × R:R
  MIN_SCORE: 25,   // minimum |confidence score| to open a trade
};

/* Neutral placeholders so calcConfidenceScore only scores the
   daily slot — prevents inflating the score with repeated data */
const _BT_NEUTRAL_BIAS = {
  bias: 'NEUTRAL', structure: 'MIXED', emaSignal: 'UNKNOWN',
  emaCross: 'NONE', ema50: null, ema200: null,
  rsi: null, rsiState: 'UNKNOWN', macdState: 'NEUTRAL',
  swingHighs: [], swingLows: [],
};
const _BT_EMPTY_ZONES = { supply: [], demand: [] };
const _BT_NO_HS       = { found: false, type: null, neckline: null, headPrice: null, confidence: null };

/* ── Signal from a fixed candle slice (no API calls) ─────── */
function _btSignal(candles, pipSize) {
  const ind = computeIndicators(candles, pipSize);
  if (!ind || !ind.atr) return null;

  const bias  = detectBias(candles, pipSize);
  const zones = detectZones(candles, pipSize);
  const hs    = detectHeadAndShoulders(candles);
  const cp    = detectCandlestickPatterns(candles);

  const currentPrice = candles[candles.length - 1].rate;

  const conf = calcConfidenceScore(
    { weekly: _BT_NEUTRAL_BIAS, daily: bias,  h4: _BT_NEUTRAL_BIAS },
    { weekly: _BT_EMPTY_ZONES,  daily: zones, h4: _BT_EMPTY_ZONES  },
    { weekly: _BT_NO_HS,        daily: hs,    h4: _BT_NO_HS        },
    { daily:  cp, h4: [] },
    { daily:  ind, h4: null },
    currentPrice, pipSize
  );

  return { ...conf, atr: ind.atr };
}

/* ── Walk-forward simulation ─────────────────────────────── */
function _walkForward(candles, pipSize) {
  const trades   = [];
  let   position = null;

  for (let i = BT.WARMUP; i < candles.length - 1; i++) {
    const next = candles[i + 1];

    /* ── Manage open position ───────────────────────── */
    if (position) {
      const hi = next.high ?? next.rate;
      const lo = next.low  ?? next.rate;
      let exitPrice = null, exitType = null;

      if (position.direction === 'LONG') {
        if (lo  <= position.sl)  { exitPrice = position.sl;  exitType = 'SL'; }
        else if (hi >= position.tp) { exitPrice = position.tp; exitType = 'TP'; }
      } else {
        if (hi >= position.sl)   { exitPrice = position.sl;  exitType = 'SL'; }
        else if (lo <= position.tp) { exitPrice = position.tp; exitType = 'TP'; }
      }

      if (exitPrice !== null) {
        const pips = position.direction === 'LONG'
          ? (exitPrice - position.entry) / pipSize
          : (position.entry - exitPrice) / pipSize;
        trades.push({ ...position, exit: exitPrice, exitType, pips, exitBar: i + 1 });
        position = null;
      } else {
        continue; // still in trade — skip signal check
      }
    }

    /* ── Generate signal ────────────────────────────── */
    const sig = _btSignal(candles.slice(0, i + 1), pipSize);
    if (!sig || Math.abs(sig.score) < BT.MIN_SCORE) continue;

    const direction = sig.recommendation.includes('BUY')  ? 'LONG'
                    : sig.recommendation.includes('SELL') ? 'SHORT'
                    : null;
    if (!direction) continue;

    const entry  = next.open ?? next.rate;
    const slDist = sig.atr * BT.ATR_SL;
    if (!slDist) continue; // skip if ATR unavailable

    const sl = direction === 'LONG' ? entry - slDist : entry + slDist;
    const tp = direction === 'LONG' ? entry + slDist * BT.RR : entry - slDist * BT.RR;

    position = { direction, entry, sl, tp, entryBar: i + 1,
                 score: sig.score, recommendation: sig.recommendation, ts: next.ts };
  }

  /* Force-close open position at last price */
  if (position) {
    const last = candles[candles.length - 1];
    const pips = position.direction === 'LONG'
      ? (last.rate - position.entry) / pipSize
      : (position.entry - last.rate) / pipSize;
    trades.push({ ...position, exit: last.rate, exitType: 'OPEN', pips, exitBar: candles.length - 1 });
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

  /* Composite score 0–100
     win-rate  40% (60% wr → full marks)
     PF        30% (PF ≥ 2 → full marks)
     total pip 30% (≥ 200 pips → full marks) */
  const wrPts  = Math.min(winRate / 0.60, 1) * 100 * 0.40;
  const pfPts  = Math.min(profitFactor / 2, 1) * 100 * 0.30;
  const pipPts = totalPips > 0 ? Math.min(totalPips / 200, 1) * 100 * 0.30 : 0;
  const profitabilityScore = Math.max(0, Math.round(wrPts + pfPts + pipPts));

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate:         (winRate * 100).toFixed(1),
    totalPips:       totalPips.toFixed(1),
    grossWin:        grossWin.toFixed(1),
    grossLoss:       grossLoss.toFixed(1),
    profitFactor:    isFinite(profitFactor) ? profitFactor.toFixed(2) : '∞',
    maxDrawdownPips: maxDD.toFixed(1),
    avgWin:          avgWin.toFixed(1),
    avgLoss:         avgLoss.toFixed(1),
    profitabilityScore,
    equityCurve,
    trades,
  };
}

/* ── Public: single-pair backtest ─────────────────────────── */
async function runBacktest(f, t) {
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
  const pairs   = CFG.PAIRS.slice(0, 12); // cap to avoid rate limits
  const results = [];

  for (let i = 0; i < pairs.length; i++) {
    const { f, t } = pairs[i];
    if (progressCb) progressCb(i, pairs.length, `${f}/${t}`);
    try {
      const res = await runBacktest(f, t);
      if (!res.error) results.push(res);
    } catch (_) { /* skip failed pairs */ }
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
  const mn  = Math.min(0, ...curve);
  const mx  = Math.max(0, ...curve);
  const rng = mx - mn || 1;

  const toX = i => PAD + (i / (curve.length - 1)) * (W - 2 * PAD);
  const toY = v => PAD + (1 - (v - mn) / rng) * (H - 2 * PAD);

  const pts     = curve.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
  const lastEq  = curve[curve.length - 1];
  const col     = lastEq >= 0 ? '#3FB950' : '#F85149';
  const zY      = toY(0).toFixed(1);
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
          profitabilityScore, equityCurve, bars } = result;

  const scoreCls   = profitabilityScore >= 70 ? 'bt-score-great'
                   : profitabilityScore >= 50 ? 'bt-score-ok'
                   :                            'bt-score-poor';
  const pipsNum    = parseFloat(totalPips);
  const pipsCls    = pipsNum >= 0 ? 'bt-pip-pos' : 'bt-pip-neg';
  const pipsSign   = pipsNum >= 0 ? '+' : '';
  const scoreLabel = _btScoreLabel(profitabilityScore);

  const curveSvg = _drawEquityCurve(equityCurve);

  /* Recent trades list (last 8) */
  const recentTrades = (result.trades || []).slice(-8).reverse().map(tr => {
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

  return `
    <div class="bt-score-wrap">
      <div class="bt-score-num ${scoreCls}">${profitabilityScore}</div>
      <div class="bt-score-meta">
        <div class="bt-score-label ${scoreCls}">${scoreLabel}</div>
        <div class="bt-score-sub">${bars} bars tested · daily signals</div>
      </div>
      <div class="bt-score-bar-track">
        <div class="bt-score-bar-fill ${scoreCls}" style="width:${profitabilityScore}%"></div>
      </div>
    </div>

    <div class="bt-metrics">
      <div class="bt-metric">
        <span class="bt-m-lbl">Trades</span>
        <span class="bt-m-val">${totalTrades}</span>
        <span class="bt-m-sub">${wins}W / ${losses}L</span>
      </div>
      <div class="bt-metric">
        <span class="bt-m-lbl">Win Rate</span>
        <span class="bt-m-val">${winRate}%</span>
        <span class="bt-m-sub">of ${totalTrades} trades</span>
      </div>
      <div class="bt-metric">
        <span class="bt-m-lbl">Profit Factor</span>
        <span class="bt-m-val">${profitFactor}</span>
        <span class="bt-m-sub">gross W/L ratio</span>
      </div>
      <div class="bt-metric">
        <span class="bt-m-lbl">Total Pips</span>
        <span class="bt-m-val ${pipsCls}">${pipsSign}${totalPips}</span>
        <span class="bt-m-sub">net result</span>
      </div>
      <div class="bt-metric">
        <span class="bt-m-lbl">Max Drawdown</span>
        <span class="bt-m-val">${maxDrawdownPips}p</span>
        <span class="bt-m-sub">peak to trough</span>
      </div>
      <div class="bt-metric">
        <span class="bt-m-lbl">Avg Win / Loss</span>
        <span class="bt-m-val">${avgWin} / ${avgLoss}</span>
        <span class="bt-m-sub">pips per trade</span>
      </div>
    </div>

    ${curveSvg ? `<div class="bt-curve-wrap">
      <div class="bt-curve-label">Equity Curve (pips)</div>
      ${curveSvg}
    </div>` : ''}

    ${recentTrades ? `<div class="bt-trades-wrap">
      <div class="bt-curve-label">Recent Trades</div>
      <div class="bt-trades">${recentTrades}</div>
    </div>` : ''}

    <button class="bt-auto-btn" onclick="_launchAutoBacktest()">
      Test All Pairs
    </button>
    <div id="bt-auto-result"></div>`;
}

function _buildAutoBacktestResult(result) {
  if (result.error) return `<div class="analysis-error">${result.error}</div>`;

  const { pairs, avgScore, totalPips, avgWinRate } = result;
  const scoreCls = avgScore >= 70 ? 'bt-score-great'
                 : avgScore >= 50 ? 'bt-score-ok'
                 :                  'bt-score-poor';

  const rows = pairs.map(p => {
    const pipNum  = parseFloat(p.totalPips);
    const pipSign = pipNum >= 0 ? '+' : '';
    const pipCls  = pipNum >= 0 ? 'bt-pip-pos' : 'bt-pip-neg';
    const sCls    = p.profitabilityScore >= 70 ? 'bt-score-great'
                  : p.profitabilityScore >= 50 ? 'bt-score-ok'
                  :                              'bt-score-poor';
    return `<div class="bt-auto-row">
      <span class="bt-auto-pair">${p.pair}</span>
      <span class="bt-auto-score ${sCls}">${p.profitabilityScore}</span>
      <span class="bt-auto-wr">${p.winRate}%</span>
      <span class="bt-auto-pips ${pipCls}">${pipSign}${p.totalPips}p</span>
    </div>`;
  }).join('');

  const totalSign = parseFloat(totalPips) >= 0 ? '+' : '';

  return `<div class="bt-auto-wrap">
    <div class="bt-auto-header">
      <div class="bt-auto-hcell">Pair</div>
      <div class="bt-auto-hcell">Score</div>
      <div class="bt-auto-hcell">Win%</div>
      <div class="bt-auto-hcell">Pips</div>
    </div>
    ${rows}
    <div class="bt-auto-summary">
      <span>Avg Score: <strong class="${scoreCls}">${avgScore}</strong></span>
      <span>Avg Win Rate: <strong>${avgWinRate}%</strong></span>
      <span>All Pairs: <strong class="${parseFloat(totalPips) >= 0 ? 'bt-pip-pos' : 'bt-pip-neg'}">${totalSign}${totalPips}p</strong></span>
    </div>
  </div>`;
}

/* ── DOM interaction ─────────────────────────────────────── */
async function _launchBacktest(f, t) {
  const container = document.getElementById('bt-result');
  if (!container) return;
  container.innerHTML = `<div class="analysis-loading">
    <div class="loader"></div>
    <span>Running walk-forward simulation…</span>
  </div>`;
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
  container.innerHTML = `<div class="analysis-loading">
    <div class="loader"></div>
    <span id="bt-auto-progress">Fetching pair 1…</span>
  </div>`;

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
  const section = document.createElement('div');
  section.className = 'analysis-section';
  section.innerHTML = `
    <div class="analysis-section-title">Strategy Backtest</div>
    <div class="bt-intro">
      Walk-forward simulation on ~1 yr of daily candles.
      ATR stop (${BT.ATR_SL}×) · ${BT.RR}:1 R:R · min score ${BT.MIN_SCORE}.
    </div>
    <button class="bt-run-btn" onclick="_launchBacktest('${f}','${t}')">
      Run Backtest
    </button>
    <div id="bt-result"></div>`;
  panel.appendChild(section);
}

window.runBacktest        = runBacktest;
window.runAutoBacktest    = runAutoBacktest;
window._launchBacktest    = _launchBacktest;
window._launchAutoBacktest = _launchAutoBacktest;
window.appendBacktestSection = appendBacktestSection;
