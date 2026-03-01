/* ============================================================
   BACKTESTING ENGINE
   Walk-forward simulation on daily candles. No look-ahead:
   signals are generated only from data[0..i], trade entered
   at data[i+1].open with ATR-based SL and 2:1 R:R take-profit.
   ============================================================ */

const BT_DEFAULTS = {
  WARMUP:               200,   // bars for EMA200 + indicator warm-up
  ATR_SL:               2.0,   // stop-loss = ATR × this
  RR:                   2.0,   // take-profit = SL distance × R:R
  MIN_SCORE:            50,    // minimum |confidence score| to open a trade
  USE_TREND_FILTER:     true,  // apply EMA200 + monthly/weekly trend filter
  USE_TRAILING_STOP:    false, // use a trailing stop-loss
  TSL_FACTOR:           1.5,   // trailing stop ATR factor
  TSL_TRIGGER_RR:       1.0,   // R:R multiple to activate trailing stop
  // ── Entry quality filters ────────────────────────────────
  REQUIRE_WEEKLY_ALIGN:  false,   // require weekly bias to match direction (no NEUTRAL)
  REQUIRE_STRONG_SIGNAL: false,   // require |score| >= 60 (STRONG BUY/SELL only)
  RSI_FILTER:           'NORMAL', // 'OFF' | 'NORMAL' (68/32) | 'STRICT' (60/40)
  MACD_CONFIRM:          false,   // daily MACD histogram must align with trade direction
  // ── Window & hold constraints ────────────────────────────
  BT_WINDOW_DAYS:       365,   // backtest last N trading bars (~1 year default)
  MAX_HOLD_DAYS:         60,   // soft safety cap — bot exits via signals/trail/breakeven first
  // ── Intelligent exit controls ────────────────────────────
  BREAKEVEN_TRIGGER_RR:  1.0,  // move SL to entry once profit ≥ this × initial risk
  REVERSAL_EXIT_SCORE:   45,   // exit immediately if opposite-direction score reaches this
  // ── Short-term performance filters ──────────────────────
  SCORE_CONSISTENCY:     0,    // require last N bars to signal same direction (0 = off, 2-3 practical)
  USE_VOLATILITY_FILTER: false,// skip entries when current bar's range < 75% of 20-bar avg (avoids ranging)
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

/* ── Monthly bias approximation from daily candles ───────── */
// Groups every 20 daily bars into pseudo-monthly candles to give
// the scorer long-term macro context without look-ahead bias.
function _computeMonthlyFromDaily(dailyCandles, pipSize) {
  if (!dailyCandles || dailyCandles.length < 40) return _BT_NEUTRAL_BIAS;
  const monthly = [];
  for (let i = 0; i < dailyCandles.length; i += 20) {
    const g = dailyCandles.slice(i, i + 20);
    if (g.length < 10) continue;
    monthly.push({
      ts:   g[g.length - 1].ts,
      open: g[0].open  || g[0].rate,
      high: Math.max(...g.map(c => c.high || c.rate)),
      low:  Math.min(...g.map(c => c.low  || c.rate)),
      rate: g[g.length - 1].rate,
    });
  }
  return monthly.length >= 3 ? detectBias(monthly, pipSize) : _BT_NEUTRAL_BIAS;
}

/* ── Signal from a fixed candle slice (no API calls) ─────── */
// True 5-level multi-timeframe hierarchy built entirely from daily candles:
//   'weekly'  slot ← monthly macro context   (group 20 bars → monthly candles)
//   'daily'   slot ← weekly trend context    (group 5 bars  → weekly candles)
//   'h4'      slot ← medium-term momentum   (last 60 daily bars)
//   'h2'      slot ← short-term momentum    (last 20 daily bars)
//   'h1'      slot ← recent entry timing    (last 10 daily bars)
// This lets the scoring engine apply its full confluence logic:
// higher TFs set trend direction, lower TFs time the entry.
function _btSignal(candles, pipSize) {
  // Full-history indicators — accurate EMA200/ATR anchored to all available history
  const ind = computeIndicators(candles, pipSize);
  if (!ind || !ind.atr) return null;

  // 1. Monthly macro context
  const monthlyBias = _computeMonthlyFromDaily(candles, pipSize);

  // 2. Weekly trend
  const weeklyBias  = _computeWeeklyFromDaily(candles, pipSize);

  // 3. Medium-term momentum — last 60 bars (~3 months of daily data)
  const medSlice  = candles.length > 60 ? candles.slice(-60) : candles;
  const medBias   = detectBias(medSlice, pipSize);
  const medInd    = computeIndicators(medSlice, pipSize);

  // 4. Short-term momentum — last 20 bars (~1 month of daily data)
  const shortSlice = candles.length > 20 ? candles.slice(-20) : candles;
  const shortBias  = detectBias(shortSlice, pipSize);
  const shortInd   = computeIndicators(shortSlice, pipSize);

  // 5. Recent entry timing — last 10 bars (~2 weeks of daily data)
  const recentSlice = candles.length > 10 ? candles.slice(-10) : candles;
  const recentBias  = detectBias(recentSlice, pipSize);

  const currentPrice = candles[candles.length - 1].rate;

  // Supply/demand zones at macro, medium, and short horizons
  const longZones  = detectZones(candles, pipSize);
  const medZones   = detectZones(medSlice, pipSize);
  const shortZones = detectZones(shortSlice, pipSize);

  // Head & Shoulders across timeframes
  const hs      = detectHeadAndShoulders(candles);
  const shortHs = detectHeadAndShoulders(shortSlice);

  // Candlestick patterns
  const cp      = detectCandlestickPatterns(candles);
  const shortCp = detectCandlestickPatterns(shortSlice);

  const conf = calcConfidenceScore(
    // Proper multi-TF hierarchy: monthly → weekly → medium → short → recent
    { weekly: monthlyBias, daily: weeklyBias, h4: medBias, h2: shortBias, h1: recentBias, m30: _BT_NEUTRAL_BIAS },
    { weekly: longZones,   daily: medZones,   h4: shortZones },
    { weekly: _BT_NO_HS,   daily: hs,         h4: shortHs },
    { daily: cp,           h4: shortCp,       h2: [] },
    { daily: medInd || ind, h4: shortInd,     h2: null, h1: null, m30: null },
    currentPrice, pipSize
  );

  return {
    ...conf,
    atr:            ind.atr,
    ema200:         ind.ema200,
    monthlyBias:    monthlyBias.bias,
    weeklyBias:     weeklyBias.bias,
    medBias:        medBias.bias,
    shortBias:      shortBias.bias,
    recentBias:     recentBias.bias,
    dailyRsi:       medInd ? medInd.rsi       : ind.rsi,
    dailyMacdHist:  medInd ? medInd.histogram : ind.histogram,
  };
}

/* ── Walk-forward simulation ─────────────────────────────── */
// The bot evaluates a full 5-level multi-timeframe signal every bar and
// makes all decisions autonomously:
//   Entry: when multi-TF confluence score passes MIN_SCORE, all filters pass
//          and monthly macro trend does not oppose direction.
//   Exit:  in priority order —
//     1. Breakeven management  — move SL to entry once BREAKEVEN_TRIGGER_RR
//        profit reached; protects capital on winning trades.
//     2. Trailing stop         — optional, activates after TSL_TRIGGER_RR profit.
//     3. Signal reversal       — immediately exit when opposite-direction score
//        reaches REVERSAL_EXIT_SCORE; bot pivots on new evidence.
//     4. Soft time cap         — MAX_HOLD_DAYS safety fallback (generous, 60 days).
//     5. SL / TP hits.
// No hard hold limit: the bot decides when a trade is done.
function _walkForward(candles, pipSize) {
  const trades      = [];
  let   position    = null;
  const recentScores = []; // rolling buffer for score-consistency check (last 5 signals)

  // Only enter new trades inside the backtest window; signal computation
  // still uses the full candle history for accurate EMA200/ATR.
  const btWindowStart = Math.max(BT.WARMUP, candles.length - BT.BT_WINDOW_DAYS);

  for (let i = btWindowStart; i < candles.length - 1; i++) {
    const next = candles[i + 1];
    const sig  = _btSignal(candles.slice(0, i + 1), pipSize);

    // Track signal history for consistency filter
    if (sig) {
      recentScores.push(sig.score);
      if (recentScores.length > 5) recentScores.shift();
    }

    /* ── Manage open position ───────────────────────── */
    if (position) {
      const hi       = next.high ?? next.rate;
      const lo       = next.low  ?? next.rate;
      const slDist   = Math.abs(position.entry - position.sl);
      const barsHeld = (i + 1) - position.entryBar;
      let exitPrice  = null, exitType = null;

      // 1. Breakeven management: once profit ≥ BREAKEVEN_TRIGGER_RR × initial risk,
      //    move SL to entry so this trade can no longer be a net loser.
      if (!position.breakevenMoved && slDist > 0) {
        const beTarget = BT.BREAKEVEN_TRIGGER_RR * slDist;
        const inProfit = position.direction === 'LONG'
          ? hi >= position.entry + beTarget
          : lo <= position.entry - beTarget;
        if (inProfit) {
          position.sl = position.entry;
          position.breakevenMoved = true;
        }
      }

      // 2. Trailing stop (optional): ratchets SL behind price once activated
      if (!exitPrice && BT.USE_TRAILING_STOP && sig && sig.atr) {
        if (position.direction === 'LONG') {
          const triggerPrice = position.entry + slDist * BT.TSL_TRIGGER_RR;
          if (hi > triggerPrice) {
            position.sl = Math.max(position.sl, hi - sig.atr * BT.TSL_FACTOR);
          }
        } else {
          const triggerPrice = position.entry - slDist * BT.TSL_TRIGGER_RR;
          if (lo < triggerPrice) {
            position.sl = Math.min(position.sl, lo + sig.atr * BT.TSL_FACTOR);
          }
        }
      }

      // 3. Signal reversal exit: the full multi-TF analysis now strongly favours
      //    the opposite direction — bot acknowledges new evidence and closes.
      if (!exitPrice && sig && Math.abs(sig.score) >= BT.REVERSAL_EXIT_SCORE) {
        const reversal =
          (position.direction === 'LONG'  && sig.recommendation.includes('SELL')) ||
          (position.direction === 'SHORT' && sig.recommendation.includes('BUY'));
        if (reversal) {
          exitPrice = next.open ?? next.rate;
          exitType  = 'REVERSAL';
        }
      }

      // 4. Soft safety cap: close if held too long regardless of signals
      if (!exitPrice && barsHeld >= BT.MAX_HOLD_DAYS) {
        exitPrice = next.open ?? next.rate;
        exitType  = 'TIME';
      }

      // 5. SL / TP check
      if (!exitPrice) {
        if (position.direction === 'LONG') {
          if (lo  <= position.sl)     { exitPrice = position.sl; exitType = 'SL'; }
          else if (hi >= position.tp) { exitPrice = position.tp; exitType = 'TP'; }
        } else {
          if (hi >= position.sl)      { exitPrice = position.sl; exitType = 'SL'; }
          else if (lo <= position.tp) { exitPrice = position.tp; exitType = 'TP'; }
        }
      }

      if (exitPrice !== null) {
        const pips = position.direction === 'LONG'
          ? (exitPrice - position.entry) / pipSize
          : (position.entry - exitPrice) / pipSize;
        trades.push({ ...position, exit: exitPrice, exitType, pips,
                      exitBar: i + 1, exitTs: next.ts });
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

        if (slDist) {
          // EMA200 trend filter
          const emaOK = !BT.USE_TREND_FILTER || !sig.ema200 ||
            (direction === 'LONG'  && entry >= sig.ema200) ||
            (direction === 'SHORT' && entry <= sig.ema200);

          // Monthly macro filter: never trade counter to the monthly trend
          const monthlyOK = !BT.USE_TREND_FILTER || !sig.monthlyBias ||
            sig.monthlyBias === 'NEUTRAL' ||
            (direction === 'LONG'  && sig.monthlyBias === 'BULLISH') ||
            (direction === 'SHORT' && sig.monthlyBias === 'BEARISH');

          // Weekly alignment
          const weeklyOK = !BT.USE_TREND_FILTER || !sig.weeklyBias ||
            (!BT.REQUIRE_WEEKLY_ALIGN && sig.weeklyBias === 'NEUTRAL') ||
            (direction === 'LONG'  && sig.weeklyBias === 'BULLISH') ||
            (direction === 'SHORT' && sig.weeklyBias === 'BEARISH');

          // RSI gate
          const rsiLim = BT.RSI_FILTER === 'STRICT' ? { ob: 60, os: 40 }
                       : BT.RSI_FILTER === 'OFF'    ? { ob: 100, os: 0  }
                       :                              { ob: 68,  os: 32  };
          const rsiOK = sig.dailyRsi == null ||
            (direction === 'LONG'  && sig.dailyRsi < rsiLim.ob) ||
            (direction === 'SHORT' && sig.dailyRsi > rsiLim.os);

          // Strong signal gate
          const strongOK = !BT.REQUIRE_STRONG_SIGNAL || Math.abs(sig.score) >= 60;

          // MACD confirmation
          const macdOK = !BT.MACD_CONFIRM || sig.dailyMacdHist == null ||
            (direction === 'LONG'  && sig.dailyMacdHist > 0) ||
            (direction === 'SHORT' && sig.dailyMacdHist < 0);

          // Score consistency: require last N signals in the same direction
          const consistN = Math.floor(BT.SCORE_CONSISTENCY) || 0;
          const consistencyOK = consistN <= 0 || recentScores.length < consistN ||
            recentScores.slice(-consistN).every(s => direction === 'LONG' ? s > 0 : s < 0);

          // Volatility expansion: skip if today's candle range < 75% of 20-bar avg
          // (market compressing / ranging → poor trend-follow environment)
          let volatilityOK = true;
          if (BT.USE_VOLATILITY_FILTER) {
            const v0 = Math.max(0, i - 19);
            let rSum = 0, rCnt = 0;
            for (let k = v0; k < i; k++) {
              rSum += (candles[k].high ?? candles[k].rate) - (candles[k].low ?? candles[k].rate);
              rCnt++;
            }
            if (rCnt >= 5) {
              const avgR = rSum / rCnt;
              const curR = (candles[i].high ?? candles[i].rate) - (candles[i].low ?? candles[i].rate);
              volatilityOK = avgR === 0 || curR >= avgR * 0.75;
            }
          }

          if (emaOK && monthlyOK && weeklyOK && rsiOK && strongOK && macdOK && consistencyOK && volatilityOK) {
            const sl = direction === 'LONG' ? entry - slDist : entry + slDist;
            const tp = direction === 'LONG' ? entry + slDist * BT.RR : entry - slDist * BT.RR;
            position = {
              direction, entry, sl, tp, entryBar: i + 1,
              score: sig.score, recommendation: sig.recommendation, ts: next.ts,
              breakevenMoved: false,
              // Full entry-signal context captured for export/analysis
              entryFactors:  sig.factors      || [],
              monthlyBias:   sig.monthlyBias,
              weeklyBias:    sig.weeklyBias,
              medBias:       sig.medBias,
              shortBias:     sig.shortBias,
              recentBias:    sig.recentBias,
              atrAtEntry:    sig.atr,
              rsiAtEntry:    sig.dailyRsi,
              ema200AtEntry: sig.ema200,
            };
          }
        }
      }
    }
  }

  /* Force-close open position at end of backtest window */
  if (position) {
    const last = candles[candles.length - 1];
    const pips = position.direction === 'LONG'
      ? (last.rate - position.entry) / pipSize
      : (position.entry - last.rate) / pipSize;
    trades.push({ ...position, exit: last.rate, exitType: 'OPEN', pips,
                  exitBar: candles.length - 1, exitTs: last.ts });
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
  // Scale pip target with backtest window: ~1.5 pips/day is a solid target
  const pipTarget = Math.max(200, Math.round(BT.BT_WINDOW_DAYS * 1.5));
  const wrPts  = Math.min(winRate / 0.60, 1) * 100 * 0.40;
  const pfPts  = Math.min(profitFactor / 2, 1) * 100 * 0.30;
  const pipPts = totalPips > 0 ? Math.min(totalPips / pipTarget, 1) * 100 * 0.30 : 0;
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
  // Fetch up to 2 years so EMA200 (200-bar warmup) is properly initialised,
  // but trades are only taken in the last BT.BT_WINDOW_DAYS bars.
  const candles = await fetchYahooFinanceChart(f, t, '1D');

  if (!candles || candles.length < BT.WARMUP + 10) {
    return { error: `Need ≥ ${BT.WARMUP + 10} daily bars; got ${candles ? candles.length : 0}` };
  }

  const btWindowStart = Math.max(BT.WARMUP, candles.length - BT.BT_WINDOW_DAYS);
  const trades  = _walkForward(candles, pipSize);
  const stats   = _btStats(trades) || { totalTrades: 0, profitabilityScore: 0 };

  // Return window candles so the trade chart can plot them
  const windowCandles = candles.slice(btWindowStart);
  return { ...stats, pair: `${f}/${t}`, bars: windowCandles.length, windowCandles };
}

/* ── Public: auto-test all configured pairs ──────────────── */
async function runAutoBacktest(progressCb) {
  _updateBTState(); // Sync global BT object with UI settings
  const excluded = _getExcludedPairs();
  const pairs    = CFG.PAIRS.slice(0, 12).filter(p => !excluded.includes(`${p.f}/${p.t}`));
  const results  = [];

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

  const windowLabel = BT.BT_WINDOW_DAYS >= 480 ? '~2yr'
                    : BT.BT_WINDOW_DAYS >= 240 ? '~1yr'
                    : BT.BT_WINDOW_DAYS >= 120 ? '~6mo'
                    : '~3mo';
  const settingsDesc = `min score ${BT.MIN_SCORE} · ${windowLabel} window` +
    (BT.USE_TREND_FILTER      ? ' · trend filter'     : '') +
    (BT.REQUIRE_WEEKLY_ALIGN  ? ' · weekly req.'      : '') +
    (BT.REQUIRE_STRONG_SIGNAL ? ' · strong only'      : '') +
    (BT.RSI_FILTER !== 'NORMAL' ? ` · RSI ${BT.RSI_FILTER.toLowerCase()}` : '') +
    (BT.MACD_CONFIRM          ? ' · MACD confirm'     : '') +
    (BT.USE_TRAILING_STOP     ? ` · TSL (${BT.TSL_TRIGGER_RR}R, ${BT.TSL_FACTOR}×ATR)` : '') +
    ` · BE@${BT.BREAKEVEN_TRIGGER_RR}R · rev≥${BT.REVERSAL_EXIT_SCORE}`;

  const recentTrades = (trades || []).slice(-8).reverse().map(tr => {
    const cls  = tr.pips > 0 ? 'bt-tr-win' : tr.pips <= 0 ? 'bt-tr-loss' : '';
    const icon = tr.direction === 'LONG' ? '▲' : '▼';
    const sign = tr.pips >= 0 ? '+' : '';
    const exit = tr.exitType === 'SL'       ? 'SL'
               : tr.exitType === 'TP'       ? 'TP'
               : tr.exitType === 'TIME'     ? 'TIME'
               : tr.exitType === 'REVERSAL' ? 'REV' : '—';
    return `<div class="bt-trade-row ${cls}">
      <span class="bt-tr-dir">${icon}</span>
      <span class="bt-tr-exit">${exit}</span>
      <span class="bt-tr-pips">${sign}${tr.pips.toFixed(1)}p</span>
    </div>`;
  }).join('');

  const pipDigits = (result.pair || '').includes('JPY') ? 3 : 5;
  // tr.ts and tr.exitTs are Unix milliseconds (stored by api.js as sec×1000)
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
            <span>${new Date(tr.ts).toLocaleDateString()}</span>
            <span>${tr.exitTs ? new Date(tr.exitTs).toLocaleDateString() : '-'}</span>
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
        <div class="bt-score-sub">${bars} bars tested · ${settingsDesc}</div>
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
    <div class="bt-trade-chart-wrap">
      <div class="bt-curve-label">Trade Chart — daily candles with entries &amp; exits</div>
      <div class="bt-chart-legend">
        <span class="bt-leg bt-leg-entry-long">▲ Long entry</span>
        <span class="bt-leg bt-leg-entry-short">▼ Short entry</span>
        <span class="bt-leg bt-leg-sl">● SL exit</span>
        <span class="bt-leg bt-leg-tp">● TP exit</span>
        <span class="bt-leg bt-leg-time">● Time exit</span>
        <span class="bt-leg bt-leg-reversal">● Reversal exit</span>
        <span class="bt-leg bt-leg-sl-line">— SL level</span>
        <span class="bt-leg bt-leg-tp-line">— TP level</span>
      </div>
      <div id="bt-trade-chart" class="bt-trade-chart"></div>
    </div>
    ${curveSvg ? `<div class="bt-curve-wrap"><div class="bt-curve-label">Equity Curve (pips)</div>${curveSvg}</div>` : ''}
    ${recentTrades ? `<div class="bt-trades-wrap"><div class="bt-curve-label">Recent Trades</div><div class="bt-trades">${recentTrades}</div></div>` : ''}
    ${allTradesTable}
    <div class="bt-copy-row">
      <button id="bt-copy-btn" class="bt-copy-btn" onclick="_copyBacktestExport()">
        Copy Full Analysis Export
      </button>
      <span class="bt-copy-hint">
        Copies all settings, statistics, per-trade signal context (5-TF biases, score breakdown,
        RSI/ATR/EMA200 at entry) and surrounding OHLCV candles — paste into Claude for a
        detailed strategy assessment.
      </span>
    </div>
    <button class="bt-auto-btn" onclick="_launchAutoBacktest()">Test All Pairs</button>
    <div id="bt-auto-result"></div>`;
}

function _buildAutoBacktestResult(result) {
  if (result.error) return `<div class="analysis-error">${result.error}</div>`;

  const { pairs, avgScore, totalPips, avgWinRate } = result;
  const scoreCls  = avgScore >= 70 ? 'bt-score-great' : avgScore >= 50 ? 'bt-score-ok' : 'bt-score-poor';
  const excluded  = _getExcludedPairs();

  const rows = pairs.map(p => {
    const pipNum   = parseFloat(p.totalPips);
    const pipSign  = pipNum >= 0 ? '+' : '';
    const pipCls   = pipNum >= 0 ? 'bt-pip-pos' : 'bt-pip-neg';
    const sCls     = p.profitabilityScore >= 70 ? 'bt-score-great' : p.profitabilityScore >= 50 ? 'bt-score-ok' : 'bt-score-poor';
    const isExcl   = excluded.includes(p.pair);
    const btnLabel = isExcl ? '+ Include' : '✕ Exclude';
    const btnCls   = isExcl ? 'bt-incl-btn' : 'bt-excl-btn';
    return `<div class="bt-auto-row${isExcl ? ' bt-auto-row--excluded' : ''}">
      <span class="bt-auto-pair">
        ${p.pair}
        <button class="${btnCls}" onclick="_toggleExcludedPair('${p.pair}')">${btnLabel}</button>
      </span>
      <span class="bt-auto-score ${sCls}">${p.profitabilityScore}</span>
      <span class="bt-auto-wr">${p.winRate}%</span>
      <span class="bt-auto-pips ${pipCls}">${pipSign}${p.totalPips}p</span>
    </div>`;
  }).join('');

  const totalSign = parseFloat(totalPips) >= 0 ? '+' : '';

  // Excluded pairs footer
  const exclSection = excluded.length > 0 ? `
    <div class="bt-excl-section">
      <span class="bt-excl-label">Excluded from test (${excluded.length}): ${excluded.join(', ')}</span>
      <button class="bt-excl-clear" onclick="_clearExcludedPairs()">Clear all exclusions</button>
    </div>` : '';

  return `<div class="bt-auto-wrap">
    <div class="bt-auto-header">
      <div class="bt-auto-hcell">Pair</div>
      <div class="bt-auto-hcell">Score</div>
      <div class="bt-auto-hcell">Win%</div>
      <div class="bt-auto-hcell">Pips</div>
    </div>
    ${rows}
    <div class="bt-auto-summary">
      <span>Avg Score: <strong class="bt-score-label ${scoreCls}">${avgScore}</strong></span>
      <span>Avg Win Rate: <strong>${avgWinRate}%</strong></span>
      <span>All Pairs: <strong class="${parseFloat(totalPips) >= 0 ? 'bt-pip-pos' : 'bt-pip-neg'}">${totalSign}${totalPips}p</strong></span>
    </div>
    ${exclSection}
  </div>
  <div class="bt-copy-row bt-auto-copy-row">
    <button id="bt-auto-copy-btn" class="bt-copy-btn" onclick="_copyAutoBacktestExport()">
      Copy All Pairs Report
    </button>
    <span class="bt-copy-hint">
      Copies all pair scores, win rates, pips, and settings — paste into Claude
      for a full strategy assessment and improvement suggestions.
    </span>
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
    BT.MIN_SCORE              = _getBTSavedSetting('min_score',              BT_DEFAULTS.MIN_SCORE);
    BT.ATR_SL                 = _getBTSavedSetting('atr_sl',                 BT_DEFAULTS.ATR_SL);
    BT.RR                     = _getBTSavedSetting('rr',                     BT_DEFAULTS.RR);
    BT.USE_TREND_FILTER       = _getBTSavedSetting('use_trend_filter',        BT_DEFAULTS.USE_TREND_FILTER);
    BT.USE_TRAILING_STOP      = _getBTSavedSetting('use_trailing_stop',       BT_DEFAULTS.USE_TRAILING_STOP);
    BT.TSL_FACTOR             = _getBTSavedSetting('tsl_factor',              BT_DEFAULTS.TSL_FACTOR);
    BT.TSL_TRIGGER_RR         = _getBTSavedSetting('tsl_trigger_rr',          BT_DEFAULTS.TSL_TRIGGER_RR);
    BT.REQUIRE_WEEKLY_ALIGN   = _getBTSavedSetting('require_weekly_align',    BT_DEFAULTS.REQUIRE_WEEKLY_ALIGN);
    BT.REQUIRE_STRONG_SIGNAL  = _getBTSavedSetting('require_strong_signal',   BT_DEFAULTS.REQUIRE_STRONG_SIGNAL);
    BT.RSI_FILTER             = _getBTSavedSetting('rsi_filter',              BT_DEFAULTS.RSI_FILTER);
    BT.MACD_CONFIRM           = _getBTSavedSetting('macd_confirm',            BT_DEFAULTS.MACD_CONFIRM);
    BT.BT_WINDOW_DAYS         = _getBTSavedSetting('window_days',             BT_DEFAULTS.BT_WINDOW_DAYS);
    BT.MAX_HOLD_DAYS          = _getBTSavedSetting('max_hold_days',           BT_DEFAULTS.MAX_HOLD_DAYS);
    BT.BREAKEVEN_TRIGGER_RR   = _getBTSavedSetting('breakeven_trigger_rr',    BT_DEFAULTS.BREAKEVEN_TRIGGER_RR);
    BT.REVERSAL_EXIT_SCORE    = _getBTSavedSetting('reversal_exit_score',     BT_DEFAULTS.REVERSAL_EXIT_SCORE);
    BT.SCORE_CONSISTENCY      = _getBTSavedSetting('score_consistency',       BT_DEFAULTS.SCORE_CONSISTENCY);
    BT.USE_VOLATILITY_FILTER  = _getBTSavedSetting('use_volatility_filter',   BT_DEFAULTS.USE_VOLATILITY_FILTER);
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
    window._lastBtResult = result;  // stored for copy-export
    container.innerHTML = _buildBacktestResult(result, f, t);
    _renderBtTradeChart(result);  // render after HTML is in the DOM
  } catch (err) {
    container.innerHTML = `<div class="analysis-error">Backtest failed: ${err.message}</div>
      <button class="bt-run-btn" onclick="_launchBacktest('${f}','${t}')">Retry</button>`;
  }
}

/* ── Pair exclusion helpers ─────────────────────────────── */
function _getExcludedPairs() {
  try { return JSON.parse(localStorage.getItem('bt_excluded_pairs') || '[]'); }
  catch (_) { return []; }
}

function _toggleExcludedPair(pairKey) {
  const excl = _getExcludedPairs();
  const idx  = excl.indexOf(pairKey);
  if (idx >= 0) excl.splice(idx, 1); else excl.push(pairKey);
  localStorage.setItem('bt_excluded_pairs', JSON.stringify(excl));
  // Re-render live if results are visible
  if (window._lastAutoResult) {
    const c = document.getElementById('bt-auto-result');
    if (c) c.innerHTML = _buildAutoBacktestResult(window._lastAutoResult);
  }
}

function _clearExcludedPairs() {
  localStorage.removeItem('bt_excluded_pairs');
  if (window._lastAutoResult) {
    const c = document.getElementById('bt-auto-result');
    if (c) c.innerHTML = _buildAutoBacktestResult(window._lastAutoResult);
  }
}

/* ── Copy all-pairs export to clipboard ─────────────────── */
async function _copyAutoBacktestExport() {
  const result = window._lastAutoResult;
  if (!result) return;

  const windowLabel = BT.BT_WINDOW_DAYS >= 480 ? '~2yr'
                    : BT.BT_WINDOW_DAYS >= 240 ? '~1yr'
                    : BT.BT_WINDOW_DAYS >= 120 ? '~6mo'
                    : BT.BT_WINDOW_DAYS >= 55  ? '~3mo'
                    :                            '~1mo';

  const data = {
    _note: 'All-pairs backtest export — paste into Claude to get strategy analysis, improvement suggestions, and per-pair breakdown.',
    exportTimestamp: new Date().toISOString(),
    settings: {
      backtestWindow:        windowLabel + ' (' + BT.BT_WINDOW_DAYS + ' trading days)',
      minConfidenceScore:    BT.MIN_SCORE,
      atrStopLossMultiplier: BT.ATR_SL,
      riskRewardRatio:       BT.RR,
      ema200TrendFilter:     BT.USE_TREND_FILTER,
      requireWeeklyAlign:    BT.REQUIRE_WEEKLY_ALIGN,
      requireStrongSignal:   BT.REQUIRE_STRONG_SIGNAL,
      rsiFilter:             BT.RSI_FILTER,
      macdConfirmation:      BT.MACD_CONFIRM,
      trailingStop:          BT.USE_TRAILING_STOP
                               ? { factor: BT.TSL_FACTOR, triggerRR: BT.TSL_TRIGGER_RR }
                               : false,
      breakevenTriggerRR:    BT.BREAKEVEN_TRIGGER_RR,
      reversalExitScore:     BT.REVERSAL_EXIT_SCORE,
      safetyCapDays:         BT.MAX_HOLD_DAYS,
      scoreConsistencyBars:  BT.SCORE_CONSISTENCY,
      volatilityFilter:      BT.USE_VOLATILITY_FILTER,
    },
    summary: {
      pairsTested:   result.pairs.length,
      excludedPairs: _getExcludedPairs(),
      avgScore:      result.avgScore,
      avgWinRate:    result.avgWinRate + '%',
      totalPips:     +parseFloat(result.totalPips).toFixed(1),
    },
    pairs: result.pairs.map(p => ({
      pair:               p.pair,
      profitabilityScore: p.profitabilityScore,
      totalTrades:        p.totalTrades,
      wins:               p.wins,
      losses:             p.losses,
      winRate:            p.winRate + '%',
      totalPips:          +parseFloat(p.totalPips).toFixed(1),
      profitFactor:       p.profitFactor,
      maxDrawdownPips:    +parseFloat(p.maxDrawdownPips).toFixed(1),
      avgWinPips:         +parseFloat(p.avgWin).toFixed(1),
      avgLossPips:        +parseFloat(p.avgLoss).toFixed(1),
    })),
  };

  const text = JSON.stringify(data, null, 2);
  const btn  = document.getElementById('bt-auto-copy-btn');
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied to clipboard!';
      btn.classList.add('bt-copy-btn--done');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('bt-copy-btn--done'); }, 2800);
    }
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    if (btn) {
      btn.textContent = '✓ Copied (fallback)';
      setTimeout(() => { btn.textContent = 'Copy All Results'; }, 2500);
    }
  }
}

async function _launchAutoBacktest() {
  const container = document.getElementById('bt-auto-result');
  if (!container) return;
  _updateBTState();
  const excluded = _getExcludedPairs();
  const totalPairs = CFG.PAIRS.slice(0, 12).length;
  const testingCount = totalPairs - excluded.length;
  container.innerHTML = `<div class="analysis-loading"><div class="loader"></div><span id="bt-auto-progress">Fetching pair 1 of ${testingCount}…</span></div>`;
  const onProgress = (i, total, pair) => {
    const el = document.getElementById('bt-auto-progress');
    if (el) el.textContent = `Testing ${pair} (${i + 1}/${total})…`;
  };
  try {
    const result = await runAutoBacktest(onProgress);
    window._lastAutoResult = result;
    container.innerHTML = _buildAutoBacktestResult(result);
  } catch (err) {
    container.innerHTML = `<div class="analysis-error">Auto-test failed: ${err.message}</div>`;
  }
}

/* ── Settings Optimizer ────────────────────────────────────
   Pre-computes signals once per pair, then sweeps a parameter
   grid in memory (no extra API calls) to find the settings
   that best match the user's target (high win rate, low DD).
   ────────────────────────────────────────────────────────── */

// Precompute one signal per bar so the optimizer doesn't rerun
// expensive indicator calculations for every parameter combo.
function _precomputeBtSignals(candles, pipSize) {
  const sigs = [];
  for (let i = BT.WARMUP; i < candles.length - 1; i++) {
    sigs.push(_btSignal(candles.slice(0, i + 1), pipSize));
  }
  return sigs; // sigs[j] → signal at bar (WARMUP + j)
}

// Walk-forward using precomputed signals + a custom settings object.
// Includes breakeven management and signal-reversal exits; omits trailing stop
// for optimizer sweep speed (parameter not varied by the optimizer).
function _walkForwardFast(candles, sigs, pipSize, cfg) {
  const { MIN_SCORE, ATR_SL, RR, USE_TREND_FILTER,
          REQUIRE_WEEKLY_ALIGN, REQUIRE_STRONG_SIGNAL, RSI_FILTER, MACD_CONFIRM } = cfg;
  const rsiLim = RSI_FILTER === 'STRICT' ? { ob: 60, os: 40 }
               : RSI_FILTER === 'OFF'    ? { ob: 100, os: 0  }
               :                          { ob: 68,  os: 32  };
  const trades = [];
  let pos = null;

  for (let i = BT.WARMUP; i < candles.length - 1; i++) {
    const sig  = sigs[i - BT.WARMUP];
    const next = candles[i + 1];
    const hi   = next.high ?? next.rate;
    const lo   = next.low  ?? next.rate;

    if (pos) {
      let exitPrice = null, exitType = null;
      const slDist = Math.abs(pos.entry - pos.sl);

      // Breakeven management
      if (!pos.breakevenMoved && slDist > 0) {
        const beTarget = BT.BREAKEVEN_TRIGGER_RR * slDist;
        const inProfit = pos.dir === 'LONG'
          ? hi >= pos.entry + beTarget
          : lo <= pos.entry - beTarget;
        if (inProfit) { pos.sl = pos.entry; pos.breakevenMoved = true; }
      }

      // Signal reversal exit
      if (!exitPrice && sig && Math.abs(sig.score) >= BT.REVERSAL_EXIT_SCORE) {
        const reversal =
          (pos.dir === 'LONG'  && sig.recommendation.includes('SELL')) ||
          (pos.dir === 'SHORT' && sig.recommendation.includes('BUY'));
        if (reversal) { exitPrice = next.open ?? next.rate; exitType = 'REVERSAL'; }
      }

      // SL / TP
      if (!exitPrice) {
        if (pos.dir === 'LONG') {
          if (lo  <= pos.sl)     { exitPrice = pos.sl; exitType = 'SL'; }
          else if (hi >= pos.tp) { exitPrice = pos.tp; exitType = 'TP'; }
        } else {
          if (hi >= pos.sl)      { exitPrice = pos.sl; exitType = 'SL'; }
          else if (lo <= pos.tp) { exitPrice = pos.tp; exitType = 'TP'; }
        }
      }
      if (exitPrice !== null) {
        const pips = pos.dir === 'LONG'
          ? (exitPrice - pos.entry) / pipSize
          : (pos.entry - exitPrice) / pipSize;
        trades.push({ pips, exitType });
        pos = null;
      }
    }

    if (!pos && sig && Math.abs(sig.score) >= MIN_SCORE) {
      const dir = sig.recommendation.includes('BUY')  ? 'LONG'
                : sig.recommendation.includes('SELL') ? 'SHORT' : null;
      if (dir) {
        const entry  = next.open ?? next.rate;
        const slDist = sig.atr * ATR_SL;
        if (slDist) {
          const emaOK     = !USE_TREND_FILTER || !sig.ema200 ||
            (dir === 'LONG'  && entry >= sig.ema200) ||
            (dir === 'SHORT' && entry <= sig.ema200);
          const monthlyOK = !USE_TREND_FILTER || !sig.monthlyBias ||
            sig.monthlyBias === 'NEUTRAL' ||
            (dir === 'LONG'  && sig.monthlyBias === 'BULLISH') ||
            (dir === 'SHORT' && sig.monthlyBias === 'BEARISH');
          const weeklyOK  = !USE_TREND_FILTER || !sig.weeklyBias ||
            (!REQUIRE_WEEKLY_ALIGN && sig.weeklyBias === 'NEUTRAL') ||
            (dir === 'LONG'  && sig.weeklyBias === 'BULLISH') ||
            (dir === 'SHORT' && sig.weeklyBias === 'BEARISH');
          const rsiOK     = sig.dailyRsi == null ||
            (dir === 'LONG'  && sig.dailyRsi < rsiLim.ob) ||
            (dir === 'SHORT' && sig.dailyRsi > rsiLim.os);
          const strongOK  = !REQUIRE_STRONG_SIGNAL || Math.abs(sig.score) >= 60;
          const macdOK    = !MACD_CONFIRM || sig.dailyMacdHist == null ||
            (dir === 'LONG'  && sig.dailyMacdHist > 0) ||
            (dir === 'SHORT' && sig.dailyMacdHist < 0);
          if (emaOK && monthlyOK && weeklyOK && rsiOK && strongOK && macdOK) {
            const sl = dir === 'LONG' ? entry - slDist : entry + slDist;
            const tp = dir === 'LONG' ? entry + slDist * RR : entry - slDist * RR;
            pos = { dir, entry, sl, tp, breakevenMoved: false };
          }
        }
      }
    }
  }

  if (pos) {
    const last = candles[candles.length - 1];
    const pips = pos.dir === 'LONG'
      ? (last.rate - pos.entry) / pipSize
      : (pos.entry - last.rate) / pipSize;
    trades.push({ pips, exitType: 'OPEN' });
  }
  return trades;
}

async function runOptimizer(progressCb) {
  _updateBTState();

  // ── Fetch & precompute signals for first 6 pairs ────────
  const pairs    = CFG.PAIRS.slice(0, 6);
  const pairData = [];
  for (let pi = 0; pi < pairs.length; pi++) {
    const { f, t } = pairs[pi];
    if (progressCb) progressCb('fetch', pi, pairs.length, `${f}/${t}`);
    try {
      const pipSize = (f === 'JPY' || t === 'JPY') ? 0.01 : 0.0001;
      const candles = await fetchYahooFinanceChart(f, t, '1D');
      if (candles && candles.length >= BT.WARMUP + 20) {
        const sigs = _precomputeBtSignals(candles, pipSize);
        pairData.push({ candles, sigs, pipSize });
      }
    } catch (_) {}
    if (pi < pairs.length - 1) await new Promise(r => setTimeout(r, 200));
  }
  if (!pairData.length) return { error: 'No pair data available' };

  // ── Build parameter grid (6×4×4×2×2×2 = 768 combos) ────
  const combos = [];
  for (const MIN_SCORE of [25, 35, 45, 55, 65, 75]) {
    for (const ATR_SL of [1.5, 2.0, 2.5, 3.0]) {
      for (const RR of [1.5, 2.0, 2.5, 3.0]) {
        for (const REQUIRE_WEEKLY_ALIGN of [false, true]) {
          for (const MACD_CONFIRM of [false, true]) {
            for (const RSI_FILTER of ['NORMAL', 'STRICT']) {
              combos.push({ MIN_SCORE, ATR_SL, RR, USE_TREND_FILTER: true,
                            REQUIRE_WEEKLY_ALIGN, REQUIRE_STRONG_SIGNAL: false,
                            RSI_FILTER, MACD_CONFIRM });
            }
          }
        }
      }
    }
  }

  // ── Sweep all combinations ───────────────────────────────
  const results = [];
  for (let ci = 0; ci < combos.length; ci++) {
    if (ci % 100 === 0) {
      if (progressCb) progressCb('test', ci, combos.length, '');
      await new Promise(r => setTimeout(r, 0)); // yield to UI
    }
    const cfg = combos[ci];
    let totalTrades = 0, totalWins = 0, totalPips = 0, maxDD = 0, validPairs = 0;

    for (const { candles, sigs, pipSize } of pairData) {
      const trades = _walkForwardFast(candles, sigs, pipSize, cfg);
      if (trades.length < 3) continue;
      validPairs++;
      totalTrades += trades.length;
      totalWins   += trades.filter(t => t.pips > 0).length;
      totalPips   += trades.reduce((s, t) => s + t.pips, 0);
      let eq = 0, peak = 0;
      for (const tr of trades) {
        eq += tr.pips; peak = Math.max(peak, eq);
        maxDD = Math.max(maxDD, peak - eq);
      }
    }

    if (totalTrades >= 8 && validPairs >= 2) {
      results.push({ cfg,
        trades:  totalTrades,
        winRate: Math.round(totalWins / totalTrades * 1000) / 10,
        pips:    Math.round(totalPips),
        maxDD:   Math.round(maxDD),
      });
    }
  }

  results.sort((a, b) => b.winRate - a.winRate || b.pips - a.pips);
  return { results: results.slice(0, 30), totalTested: combos.length, pairsTested: pairData.length };
}

function _buildOptimizerResult(data, sortKey = 'winRate') {
  if (data.error) return `<div class="analysis-error">${data.error}</div>`;
  const { results, totalTested, pairsTested } = data;
  if (!results || !results.length)
    return `<div class="analysis-error">No valid combinations found (all filtered out — try reducing filter strictness)</div>`;

  // sort a copy so we can re-sort without re-running
  const sorted = [...results].sort((a, b) =>
    sortKey === 'pips'   ? b.pips - a.pips || b.winRate - a.winRate :
    sortKey === 'maxDD'  ? a.maxDD - b.maxDD || b.winRate - a.winRate :
                           b.winRate - a.winRate || b.pips - a.pips);

  const rsiLabel = r => r === 'STRICT' ? 'Strict' : r === 'OFF' ? 'Off' : 'Normal';
  const tf  = b => b ? '✓' : '—';
  const sortBtn = (key, label) =>
    `<button class="bt-opt-sort ${sortKey === key ? 'active' : ''}" onclick="_reRenderOptimizer('${key}')">${label}</button>`;

  const rows = sorted.map((r, i) => {
    const wrCls  = r.winRate >= 60 ? 'bt-score-great' : r.winRate >= 50 ? 'bt-score-ok' : 'bt-score-poor';
    const pipCls = r.pips >= 0 ? 'bt-pip-pos' : 'bt-pip-neg';
    const cfgJson = JSON.stringify(r.cfg).replace(/"/g, '&quot;');
    return `<div class="bt-opt-row">
      <span class="bt-opt-rank">${i + 1}</span>
      <span class="${wrCls} bt-opt-wr">${r.winRate}%</span>
      <span class="${pipCls} bt-opt-pips">${r.pips >= 0 ? '+' : ''}${r.pips}p</span>
      <span class="bt-opt-dd">-${r.maxDD}p</span>
      <span class="bt-opt-n">${r.trades}</span>
      <span class="bt-opt-cfg">${r.cfg.MIN_SCORE}</span>
      <span class="bt-opt-cfg">${r.cfg.ATR_SL}×</span>
      <span class="bt-opt-cfg">${r.cfg.RR}:1</span>
      <span class="bt-opt-flag">${tf(r.cfg.REQUIRE_WEEKLY_ALIGN)}</span>
      <span class="bt-opt-flag">${tf(r.cfg.MACD_CONFIRM)}</span>
      <span class="bt-opt-cfg">${rsiLabel(r.cfg.RSI_FILTER)}</span>
      <button class="bt-apply-btn" onclick="_applyOptimizerSettings(${cfgJson})">Apply</button>
    </div>`;
  }).join('');

  return `<div class="bt-opt-wrap">
    <div class="bt-opt-meta">Tested ${totalTested} combinations · ${pairsTested} pairs · top ${sorted.length} shown</div>
    <div class="bt-opt-sortbar">Sort by: ${sortBtn('winRate','Win Rate')} ${sortBtn('pips','Pips')} ${sortBtn('maxDD','Min DrawDown')}</div>
    <div class="bt-opt-head">
      <span>#</span><span>Win%</span><span>Pips</span><span>MaxDD</span><span>Trades</span>
      <span>Score</span><span>SL</span><span>RR</span>
      <span>Wkly</span><span>MACD</span><span>RSI</span><span></span>
    </div>
    ${rows}
  </div>`;
}

// Cached optimizer data for re-sorting without re-running
let _lastOptimizerData = null;
function _reRenderOptimizer(sortKey) {
  const container = document.getElementById('bt-optimizer-result');
  if (container && _lastOptimizerData) {
    container.innerHTML = _buildOptimizerResult(_lastOptimizerData, sortKey);
  }
}

function _applyOptimizerSettings(cfg) {
  localStorage.setItem('bt_min_score',             cfg.MIN_SCORE);
  localStorage.setItem('bt_atr_sl',                cfg.ATR_SL);
  localStorage.setItem('bt_rr',                    cfg.RR);
  localStorage.setItem('bt_require_weekly_align',  cfg.REQUIRE_WEEKLY_ALIGN);
  localStorage.setItem('bt_require_strong_signal', cfg.REQUIRE_STRONG_SIGNAL);
  localStorage.setItem('bt_rsi_filter',            cfg.RSI_FILTER);
  localStorage.setItem('bt_macd_confirm',          cfg.MACD_CONFIRM);
  _updateBTState();

  // Sync all UI controls
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  const setCb  = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
  set('bt-min-score', cfg.MIN_SCORE);       setTxt('bt-min-score-val', cfg.MIN_SCORE);
  set('bt-atr-sl',    cfg.ATR_SL);          setTxt('bt-atr-sl-val',    cfg.ATR_SL);
  set('bt-rr',        cfg.RR);              setTxt('bt-rr-val',        cfg.RR);
  setCb('bt-require-weekly-align',  cfg.REQUIRE_WEEKLY_ALIGN);
  setCb('bt-require-strong-signal', cfg.REQUIRE_STRONG_SIGNAL);
  set('bt-rsi-filter', cfg.RSI_FILTER);
  setCb('bt-macd-confirm', cfg.MACD_CONFIRM);

  const container = document.getElementById('bt-optimizer-result');
  if (container) {
    const note = document.createElement('div');
    note.className = 'bt-opt-applied';
    note.textContent = '✓ Settings applied — run Backtest to verify';
    container.prepend(note);
    setTimeout(() => note.remove(), 3000);
  }
}

async function _launchOptimizer() {
  const container = document.getElementById('bt-optimizer-result');
  if (!container) return;
  _updateBTState();
  _lastOptimizerData = null;
  container.innerHTML = `<div class="analysis-loading"><div class="loader"></div><span id="bt-opt-progress">Preparing…</span></div>`;

  const onProgress = (phase, done, total, pair) => {
    const el = document.getElementById('bt-opt-progress');
    if (!el) return;
    if (phase === 'fetch') el.textContent = `Fetching ${pair} (${done + 1}/${total})…`;
    if (phase === 'test')  el.textContent = `Testing combinations ${done}/${total}…`;
  };

  try {
    const result = await runOptimizer(onProgress);
    _lastOptimizerData = result;
    container.innerHTML = _buildOptimizerResult(result);
  } catch (err) {
    container.innerHTML = `<div class="analysis-error">Optimizer failed: ${err.message}</div>`;
  }
}

/* ── Trade chart: candlestick + entry/exit markers + SL/TP lines ─── */
// Renders a TradingView Lightweight Charts candlestick chart inside
// the #bt-trade-chart container created by _buildBacktestResult.
// Shows window-period candles with overlaid trade annotations.
function _renderBtTradeChart(result) {
  const container = document.getElementById('bt-trade-chart');
  if (!container || !window.LightweightCharts) return;

  // Tear down any previous bt chart instance
  if (window._btChartInst) {
    try { window._btChartInst.remove(); } catch (_) {}
    window._btChartInst = null;
  }
  if (window._btChartResizeObs) {
    window._btChartResizeObs.disconnect();
    window._btChartResizeObs = null;
  }

  const candles = result.windowCandles;
  const trades  = result.trades || [];
  if (!candles || !candles.length) {
    container.textContent = 'No candle data for chart.';
    return;
  }

  const pairStr   = result.pair || '';
  const isJPY     = pairStr.includes('JPY');
  const precision = isJPY ? 3 : 5;
  const minMove   = Math.pow(10, -precision);
  const priceFormat = { type: 'price', precision, minMove };

  const chart = LightweightCharts.createChart(container, {
    width:  container.clientWidth  || 360,
    height: 240,
    layout: {
      background:  { type: 'solid', color: 'transparent' },
      textColor:   '#6E7681',
      fontFamily:  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize:    10,
    },
    grid: {
      vertLines: { color: '#1E2530' },
      horzLines: { color: '#1E2530' },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: {
      borderColor:  '#30363D',
      scaleMargins: { top: 0.15, bottom: 0.15 },
    },
    timeScale: {
      borderColor:    '#30363D',
      timeVisible:    false,
      fixLeftEdge:    true,
      fixRightEdge:   true,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale:  { mouseWheel: true, pinch: true },
  });
  window._btChartInst = chart;

  // ── Candlestick series ──────────────────────────────────
  const candleSeries = chart.addCandlestickSeries({
    upColor:         '#3FB950',
    downColor:       '#F85149',
    borderUpColor:   '#3FB950',
    borderDownColor: '#F85149',
    wickUpColor:     '#3FB950',
    wickDownColor:   '#F85149',
    priceFormat,
  });

  const seenTimes = new Set();
  const chartData = candles
    .map(d => ({
      time:  Math.floor(d.ts / 1000),       // ms → unix seconds for LWC
      open:  d.open  ?? d.rate,
      high:  d.high  ?? d.rate,
      low:   d.low   ?? d.rate,
      close: d.rate,
    }))
    .filter(d => {
      if (seenTimes.has(d.time)) return false;
      seenTimes.add(d.time); return true;
    })
    .sort((a, b) => a.time - b.time);

  candleSeries.setData(chartData);
  const chartTimeSet = new Set(chartData.map(d => d.time));
  const chartTimes   = chartData.map(d => d.time);

  // ── Markers (entry arrows + exit circles) ───────────────
  const markers = [];
  for (const tr of trades) {
    const entryTime = Math.floor(tr.ts / 1000);
    const exitTime  = tr.exitTs ? Math.floor(tr.exitTs / 1000) : null;

    // Entry arrow — yellow, above/below bar depending on direction
    if (chartTimeSet.has(entryTime)) {
      markers.push({
        time:     entryTime,
        position: tr.direction === 'LONG' ? 'belowBar' : 'aboveBar',
        color:    '#F0B72F',
        shape:    tr.direction === 'LONG' ? 'arrowUp' : 'arrowDown',
        text:     'E',
        size:     1,
      });
    }

    // Exit circle — red=SL, green=TP, purple=TIME, orange=REVERSAL, grey=force close
    if (exitTime && chartTimeSet.has(exitTime)) {
      const exitColor = tr.exitType === 'SL'       ? '#F85149'
                      : tr.exitType === 'TP'       ? '#3FB950'
                      : tr.exitType === 'TIME'     ? '#A371F7'
                      : tr.exitType === 'REVERSAL' ? '#F0B72F'
                      :                              '#8B949E';
      const exitText  = tr.exitType === 'SL'       ? 'SL'
                      : tr.exitType === 'TP'       ? 'TP'
                      : tr.exitType === 'TIME'     ? 'T'
                      : tr.exitType === 'REVERSAL' ? 'R'
                      :                              'X';
      markers.push({
        time:     exitTime,
        position: tr.direction === 'LONG' ? 'aboveBar' : 'belowBar',
        color:    exitColor,
        shape:    'circle',
        text:     exitText,
        size:     1,
      });
    }
  }
  if (markers.length) {
    markers.sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(markers);
  }

  // ── SL / TP / Entry-price line series ───────────────────
  // Only supply data for bars during an active trade; LWC leaves gaps
  // at times where no data is provided, so each trade shows its own
  // isolated SL and TP lines without connecting between trades.
  const slMap     = new Map();
  const tpMap     = new Map();
  const entryMap  = new Map();

  for (const tr of trades) {
    const tEntry = Math.floor(tr.ts / 1000);
    const tExit  = tr.exitTs ? Math.floor(tr.exitTs / 1000)
                             : chartTimes[chartTimes.length - 1];
    for (const t of chartTimes) {
      if (t >= tEntry && t <= tExit) {
        slMap.set(t, tr.sl);
        tpMap.set(t, tr.tp);
        entryMap.set(t, tr.entry);
      }
    }
  }

  const toSeries = (map, color, lineStyle) => {
    const data = Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time, value }));
    if (!data.length) return;
    const s = chart.addLineSeries({
      color,
      lineWidth:              1,
      lineStyle,              // 0=solid, 2=dashed
      crosshairMarkerVisible: false,
      lastValueVisible:       false,
      priceLineVisible:       false,
      priceFormat,
    });
    s.setData(data);
  };

  toSeries(slMap,    'rgba(248,81,73,0.85)',  2); // red dashed  — stop-loss
  toSeries(tpMap,    'rgba(63,185,80,0.85)',  2); // green dashed — take-profit
  toSeries(entryMap, 'rgba(240,183,47,0.5)',  0); // gold solid  — entry price

  chart.timeScale().fitContent();

  // Keep chart responsive to panel width changes
  window._btChartResizeObs = new ResizeObserver(() => {
    if (chart && container.clientWidth > 0) {
      chart.resize(container.clientWidth, container.clientHeight);
    }
  });
  window._btChartResizeObs.observe(container);
}

/* ── Full export builder ─────────────────────────────────── */
// Assembles every piece of information needed for a thorough external
// assessment: settings, statistics, per-trade signal context (all 5 TF
// biases, score breakdown, RSI/ATR/EMA200 at entry) and the raw OHLCV
// candles surrounding each trade so price action can be reviewed.
function _buildExportData(result) {
  const pipDigits    = (result.pair || '').includes('JPY') ? 3 : 5;
  const windowCandles = result.windowCandles || [];

  const tradesExport = (result.trades || []).map(tr => {
    // Locate trade within window candles and grab ±10 / +5 bars of context
    const entryIdx = windowCandles.findIndex(c => c.ts >= tr.ts);
    const rawExit  = tr.exitTs || (windowCandles.length ? windowCandles[windowCandles.length - 1].ts : 0);
    const exitIdx  = windowCandles.findIndex(c => c.ts >= rawExit);
    const ctxStart = Math.max(0, (entryIdx >= 0 ? entryIdx : 0) - 10);
    const ctxEnd   = Math.min(windowCandles.length - 1,
                              (exitIdx   >= 0 ? exitIdx  : windowCandles.length - 1) + 5);

    const priceContext = windowCandles.slice(ctxStart, ctxEnd + 1).map(c => ({
      date:  new Date(c.ts).toISOString().split('T')[0],
      open:  +(c.open ?? c.rate).toFixed(pipDigits),
      high:  +(c.high ?? c.rate).toFixed(pipDigits),
      low:   +(c.low  ?? c.rate).toFixed(pipDigits),
      close: +(c.rate).toFixed(pipDigits),
      // mark entry/exit bars for clarity
      _mark: c.ts === tr.ts        ? 'ENTRY'
           : c.ts === tr.exitTs    ? 'EXIT'
           : undefined,
    }));

    const fmt = v => v != null ? +v.toFixed(pipDigits) : null;

    return {
      entryDate:     new Date(tr.ts).toISOString().split('T')[0],
      exitDate:      tr.exitTs ? new Date(tr.exitTs).toISOString().split('T')[0] : null,
      direction:     tr.direction,
      barsHeld:      tr.exitBar != null ? tr.exitBar - tr.entryBar : null,
      outcome:       tr.pips > 0 ? 'WIN' : 'LOSS',
      pips:          +tr.pips.toFixed(2),
      exitReason:    tr.exitType,
      breakevenUsed: tr.breakevenMoved || false,
      prices: {
        entry:       fmt(tr.entry),
        stopLoss:    fmt(tr.sl),
        takeProfit:  fmt(tr.tp),
        exit:        fmt(tr.exit),
      },
      signalAtEntry: {
        confidenceScore:    tr.score,
        recommendation:     tr.recommendation,
        // 5-level TF hierarchy at moment of entry
        monthlyMacroTrend:  tr.monthlyBias  || 'UNKNOWN',
        weeklyTrend:        tr.weeklyBias   || 'UNKNOWN',
        mediumTerm_60d:     tr.medBias      || 'UNKNOWN',
        shortTerm_20d:      tr.shortBias    || 'UNKNOWN',
        recentMomentum_10d: tr.recentBias   || 'UNKNOWN',
        rsi:                tr.rsiAtEntry    != null ? +tr.rsiAtEntry.toFixed(1)    : null,
        atr:                tr.atrAtEntry    != null ? +tr.atrAtEntry.toFixed(pipDigits) : null,
        ema200:             tr.ema200AtEntry != null ? +tr.ema200AtEntry.toFixed(pipDigits) : null,
        // Full score breakdown — every factor that pushed the bot to trade
        scoreBreakdown: (tr.entryFactors || []).map(f => ({
          factor: f.label,
          detail: String(f.value),
          points: f.points,
        })),
      },
      // Raw OHLCV bars 10 before entry → 5 after exit (entry/exit bars marked)
      priceContext,
    };
  });

  return {
    _note: 'Paste this JSON into Claude to get a full strategy assessment, ' +
           'improvement suggestions, and trade-by-trade analysis.',
    exportTimestamp: new Date().toISOString(),
    pair:            result.pair,
    settings: {
      backtestWindow:       BT.BT_WINDOW_DAYS + ' trading days',
      minConfidenceScore:   BT.MIN_SCORE,
      atrStopLossMultiplier: BT.ATR_SL,
      riskRewardRatio:      BT.RR,
      ema200TrendFilter:    BT.USE_TREND_FILTER,
      requireWeeklyAlign:   BT.REQUIRE_WEEKLY_ALIGN,
      requireStrongSignal:  BT.REQUIRE_STRONG_SIGNAL,
      rsiFilter:            BT.RSI_FILTER,
      macdConfirmation:     BT.MACD_CONFIRM,
      trailingStop:         BT.USE_TRAILING_STOP
                              ? { factor: BT.TSL_FACTOR, triggerRR: BT.TSL_TRIGGER_RR }
                              : false,
      breakevenTriggerRR:   BT.BREAKEVEN_TRIGGER_RR,
      reversalExitScore:    BT.REVERSAL_EXIT_SCORE,
      safetyCapDays:        BT.MAX_HOLD_DAYS,
    },
    statistics: {
      totalTrades:        result.totalTrades,
      wins:               result.wins,
      losses:             result.losses,
      winRate:            result.winRate + '%',
      totalPips:          +parseFloat(result.totalPips).toFixed(1),
      grossWinPips:       +parseFloat(result.grossWin).toFixed(1),
      grossLossPips:      +parseFloat(result.grossLoss).toFixed(1),
      profitFactor:       result.profitFactor,
      maxDrawdownPips:    +parseFloat(result.maxDrawdownPips).toFixed(1),
      avgWinPips:         +parseFloat(result.avgWin).toFixed(1),
      avgLossPips:        +parseFloat(result.avgLoss).toFixed(1),
      profitabilityScore: result.profitabilityScore,
      equityCurveByTrade: result.equityCurve || [],
    },
    trades: tradesExport,
  };
}

/* ── Copy export to clipboard ────────────────────────────── */
async function _copyBacktestExport() {
  const result = window._lastBtResult;
  if (!result) return;
  const data = _buildExportData(result);
  const text = JSON.stringify(data, null, 2);
  const btn  = document.getElementById('bt-copy-btn');

  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Copied to clipboard!';
      btn.classList.add('bt-copy-btn--done');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('bt-copy-btn--done'); }, 2800);
    }
  } catch (_) {
    // Fallback for browsers without clipboard API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    if (btn) { btn.textContent = '✓ Copied (fallback)'; setTimeout(() => { btn.textContent = 'Copy Full Analysis'; }, 2500); }
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

      <div class="bt-setting-divider">Backtest Window &amp; Intelligent Exit Controls</div>

      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-window-days">Backtest Period
          <span class="bt-setting-hint">How many recent trading days to simulate (uses up to 5yr of history)</span>
        </label>
        <div class="bt-setting-ctrl">
          <select id="bt-window-days" class="bt-select" onchange="_onBTSettingChange('window_days', this.value)">
            <option value="30"  ${BT.BT_WINDOW_DAYS === 30  ? 'selected' : ''}>1 month (~30 days)</option>
            <option value="66"  ${BT.BT_WINDOW_DAYS === 66  ? 'selected' : ''}>3 months (~66 days)</option>
            <option value="130" ${BT.BT_WINDOW_DAYS === 130 ? 'selected' : ''}>6 months (~130 days)</option>
            <option value="365" ${BT.BT_WINDOW_DAYS === 365 ? 'selected' : ''}>1 year (~365 days)</option>
            <option value="500" ${BT.BT_WINDOW_DAYS === 500 ? 'selected' : ''}>2 years (~500 days)</option>
          </select>
        </div>
      </div>
      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-breakeven-trigger-rr">Breakeven Trigger (×R)
          <span class="bt-setting-hint">Move SL to entry once profit reaches this multiple of initial risk</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="range" id="bt-breakeven-trigger-rr" min="0.5" max="2.0" value="${BT.BREAKEVEN_TRIGGER_RR}" step="0.1" oninput="_onBTSettingChange('breakeven_trigger_rr', this.value)">
          <span id="bt-breakeven-trigger-rr-val" class="bt-range-val">${BT.BREAKEVEN_TRIGGER_RR}</span>
        </div>
      </div>
      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-reversal-exit-score">Reversal Exit Threshold
          <span class="bt-setting-hint">Close position immediately when opposite-direction score reaches this (bot pivots on new evidence)</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="range" id="bt-reversal-exit-score" min="25" max="75" value="${BT.REVERSAL_EXIT_SCORE}" step="5" oninput="_onBTSettingChange('reversal_exit_score', this.value)">
          <span id="bt-reversal-exit-score-val" class="bt-range-val">${BT.REVERSAL_EXIT_SCORE}</span>
        </div>
      </div>
      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-max-hold-days">Safety Cap (days)
          <span class="bt-setting-hint">Last-resort close if the bot hasn't exited by signal, SL, TP, or breakeven after this many bars</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="range" id="bt-max-hold-days" min="7" max="120" value="${BT.MAX_HOLD_DAYS}" step="7" oninput="_onBTSettingChange('max_hold_days', this.value)">
          <span id="bt-max-hold-days-val" class="bt-range-val">${BT.MAX_HOLD_DAYS}</span>
        </div>
      </div>

      <div class="bt-setting-divider">Advanced Entry Filters</div>

      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-require-weekly-align">Require Weekly Alignment
          <span class="bt-setting-hint">Block trades when weekly trend is unclear (NEUTRAL)</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="checkbox" id="bt-require-weekly-align" ${BT.REQUIRE_WEEKLY_ALIGN ? 'checked' : ''} onchange="_onBTSettingChange('require_weekly_align', this.checked)">
        </div>
      </div>
      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-require-strong-signal">Only Strong Signals (≥60)
          <span class="bt-setting-hint">Requires STRONG BUY/SELL — fewer but higher-confidence entries</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="checkbox" id="bt-require-strong-signal" ${BT.REQUIRE_STRONG_SIGNAL ? 'checked' : ''} onchange="_onBTSettingChange('require_strong_signal', this.checked)">
        </div>
      </div>
      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-rsi-filter">RSI Quality Gate
          <span class="bt-setting-hint">Filter overbought longs / oversold shorts at entry</span>
        </label>
        <div class="bt-setting-ctrl">
          <select id="bt-rsi-filter" class="bt-select" onchange="_onBTSettingChange('rsi_filter', this.value)">
            <option value="OFF"    ${BT.RSI_FILTER === 'OFF'    ? 'selected' : ''}>Off</option>
            <option value="NORMAL" ${BT.RSI_FILTER === 'NORMAL' ? 'selected' : ''}>Normal (RSI &lt;68 / &gt;32)</option>
            <option value="STRICT" ${BT.RSI_FILTER === 'STRICT' ? 'selected' : ''}>Strict (RSI &lt;60 / &gt;40)</option>
          </select>
        </div>
      </div>
      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-macd-confirm">MACD Confirmation
          <span class="bt-setting-hint">MACD histogram must align with trade direction at entry</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="checkbox" id="bt-macd-confirm" ${BT.MACD_CONFIRM ? 'checked' : ''} onchange="_onBTSettingChange('macd_confirm', this.checked)">
        </div>
      </div>

      <div class="bt-setting-divider">Short-Term Performance Filters</div>

      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-score-consistency">Signal Consistency (bars)
          <span class="bt-setting-hint">Require last N bars to signal the same direction before entry — cuts whipsaw entries in choppy markets. 0 = off, 2–3 recommended for short windows.</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="range" id="bt-score-consistency" min="0" max="4" value="${BT.SCORE_CONSISTENCY}" step="1" oninput="_onBTSettingChange('score_consistency', this.value)">
          <span id="bt-score-consistency-val" class="bt-range-val">${BT.SCORE_CONSISTENCY}</span>
        </div>
      </div>
      <div class="bt-setting-row">
        <label class="bt-setting-label" for="bt-use-volatility-filter">Volatility Expansion Filter
          <span class="bt-setting-hint">Skip entries when today's candle range is below 75% of the 20-bar average — avoids ranging/compressing markets that punish trend-following.</span>
        </label>
        <div class="bt-setting-ctrl">
          <input type="checkbox" id="bt-use-volatility-filter" ${BT.USE_VOLATILITY_FILTER ? 'checked' : ''} onchange="_onBTSettingChange('use_volatility_filter', this.checked)">
        </div>
      </div>
    </div>
    <div class="bt-intro">
      Fully automated walk-forward simulation on up to 5 years of real daily candles.
      The bot evaluates a true 5-level multi-timeframe hierarchy every bar — monthly macro
      trend, weekly context, 60-day momentum, 20-day short-term, and 10-day entry timing —
      then combines all signals with full confluence scoring to make entry decisions.
      Exits are driven by intelligence: breakeven management locks in safety once profit
      moves in your favour, signal reversals close trades when the multi-TF picture flips,
      and an optional trailing stop locks in profits. No arbitrary time cap.
    </div>
    <button class="bt-run-btn" onclick="_launchBacktest('${f}','${t}')">Run Backtest</button>
    <div id="bt-result"></div>
    <div class="bt-opt-section">
      <button class="bt-opt-launch-btn" onclick="_launchOptimizer()">Optimize Settings</button>
      <span class="bt-opt-hint">Sweeps 768 setting combinations across 6 major pairs to find your best win rate &amp; drawdown profile</span>
    </div>
    <div id="bt-optimizer-result"></div>`;
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

window.runBacktest             = runBacktest;
window.runAutoBacktest         = runAutoBacktest;
window.runOptimizer            = runOptimizer;
window._launchBacktest         = _launchBacktest;
window._launchAutoBacktest     = _launchAutoBacktest;
window._launchOptimizer        = _launchOptimizer;
window._applyOptimizerSettings = _applyOptimizerSettings;
window._reRenderOptimizer      = _reRenderOptimizer;
window.appendBacktestSection   = appendBacktestSection;
window._onBTSettingChange      = _onBTSettingChange;
window._renderBtTradeChart     = _renderBtTradeChart;
window._copyBacktestExport     = _copyBacktestExport;
window._copyAutoBacktestExport = _copyAutoBacktestExport;
window._buildExportData        = _buildExportData;
window._getExcludedPairs       = _getExcludedPairs;
window._toggleExcludedPair     = _toggleExcludedPair;
window._clearExcludedPairs     = _clearExcludedPairs;
