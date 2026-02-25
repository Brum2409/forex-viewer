/* ============================================================
   TECHNICAL ANALYSIS ENGINE
   Indicators: EMA, RSI (Wilder), MACD, ATR, Fibonacci
   Patterns: Swing points, Supply/Demand zones, Head & Shoulders,
             Candlestick patterns (9 types)
   Bias: Multi-timeframe structure + EMA cross + RSI + MACD
   Score: Weighted confluence score (-100 to +100)
   ============================================================ */

/* ── EMA (Exponential Moving Average) ────────────────────── */
// Uses SMA seed for the first `period` bars, then standard EMA.
// Returns an array of same length as data; indices 0..period-2 are null.
function calcEMA(data, period) {
  const result = new Array(data.length).fill(null);
  if (data.length < period) return result;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i].rate;
  result[period - 1] = sum / period;

  const mult = 2 / (period + 1);
  for (let i = period; i < data.length; i++) {
    result[i] = (data[i].rate - result[i - 1]) * mult + result[i - 1];
  }
  return result;
}

/* ── RSI (Relative Strength Index, Wilder's smoothing) ───── */
// Standard 14-period RSI. First value at index `period` (SMA seed),
// subsequent values use Wilder's exponential smoothing (α = 1/period).
// Returns 0–100; null for indices without enough history.
function calcRSI(data, period) {
  period = period || 14;
  const result = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = data[i].rate - data[i - 1].rate;
    if (delta > 0) avgGain += delta;
    else           avgLoss += Math.abs(delta);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) result[period] = 100;
  else result[period] = 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < data.length; i++) {
    const delta = data[i].rate - data[i - 1].rate;
    const gain  = delta > 0 ? delta : 0;
    const loss  = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    if (avgLoss === 0) result[i] = 100;
    else result[i] = 100 - (100 / (1 + avgGain / avgLoss));
  }
  return result;
}

/* ── MACD (12, 26, 9) ─────────────────────────────────────── */
// MACD line = EMA(fast) - EMA(slow).
// Signal line = EMA(signalPeriod) of the MACD line — seeded with
// the SMA of the first `signalPeriod` MACD values.
// Histogram = MACD - Signal.
function calcMACD(data, fast, slow, signalPeriod) {
  fast         = fast         || 12;
  slow         = slow         || 26;
  signalPeriod = signalPeriod || 9;

  const fastEMA = calcEMA(data, fast);
  const slowEMA = calcEMA(data, slow);

  const macdLine  = new Array(data.length).fill(null);
  const sigLine   = new Array(data.length).fill(null);
  const histogram = new Array(data.length).fill(null);

  for (let i = 0; i < data.length; i++) {
    if (fastEMA[i] !== null && slowEMA[i] !== null) {
      macdLine[i] = fastEMA[i] - slowEMA[i];
    }
  }

  // First MACD value is at index slow-1; signal seeds at slow-1+signalPeriod-1
  const firstMacd  = slow - 1;
  const signalSeed = firstMacd + signalPeriod - 1;
  if (signalSeed >= data.length) return { macd: macdLine, signal: sigLine, histogram };

  let seedSum = 0;
  for (let i = firstMacd; i < firstMacd + signalPeriod; i++) {
    if (macdLine[i] !== null) seedSum += macdLine[i];
  }
  sigLine[signalSeed] = seedSum / signalPeriod;
  histogram[signalSeed] = macdLine[signalSeed] - sigLine[signalSeed];

  const mult = 2 / (signalPeriod + 1);
  for (let i = signalSeed + 1; i < data.length; i++) {
    if (macdLine[i] !== null) {
      sigLine[i]   = (macdLine[i] - sigLine[i - 1]) * mult + sigLine[i - 1];
      histogram[i] = macdLine[i] - sigLine[i];
    }
  }
  return { macd: macdLine, signal: sigLine, histogram };
}

/* ── ATR (Average True Range, Wilder's smoothing) ────────── */
// True Range = max(H-L, |H-prevC|, |L-prevC|).
// Seeded with the SMA of the first `period` TRs, then Wilder's
// exponential smoothing (α = 1/period, same as RSI).
function calcATR(data, period) {
  period = period || 14;
  const result = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;

  const tr = new Array(data.length);
  tr[0] = data[0].high - data[0].low;
  for (let i = 1; i < data.length; i++) {
    const prevClose = data[i - 1].rate;
    tr[i] = Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - prevClose),
      Math.abs(data[i].low  - prevClose)
    );
  }

  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr /= period;
  result[period - 1] = atr;

  for (let i = period; i < data.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    result[i] = atr;
  }
  return result;
}

/* ── Fibonacci Retracement Levels ────────────────────────── */
// Identifies the most recent significant swing (high→low or low→high)
// using confirmed swing points, then projects the 23.6/38.2/50/61.8/78.6%
// retracement levels. Returns a signal if price is within 10 pips of
// a key level (38.2%, 50%, 61.8%).
function calcFibLevels(candles, pipSize) {
  if (!candles || candles.length < 20) return null;

  const swings = findSwingPoints(candles, 5);
  if (swings.highs.length < 1 || swings.lows.length < 1) return null;

  const lastHigh = swings.highs[swings.highs.length - 1];
  const lastLow  = swings.lows[swings.lows.length - 1];

  let swingHigh, swingLow, trend;
  if (lastHigh.index > lastLow.index) {
    // Most recent confirmed point was a high → pull-back to retracement
    const prevLows = swings.lows.filter(l => l.index < lastHigh.index);
    swingLow  = prevLows.length ? prevLows[prevLows.length - 1] : lastLow;
    swingHigh = lastHigh;
    trend = 'UP';
  } else {
    // Most recent confirmed point was a low → bounce retracement
    const prevHighs = swings.highs.filter(h => h.index < lastLow.index);
    swingHigh = prevHighs.length ? prevHighs[prevHighs.length - 1] : lastHigh;
    swingLow  = lastLow;
    trend = 'DOWN';
  }

  const range = swingHigh.price - swingLow.price;
  if (range < 20 * pipSize) return null; // Too small a swing to be meaningful

  const currentPrice = candles[candles.length - 1].rate;

  // Retracement levels counted from the end of the move (where price is pulling back)
  const base   = trend === 'UP' ? swingHigh.price : swingLow.price;
  const dir    = trend === 'UP' ? -1 : 1; // UP: price retraced down; DOWN: price bounced up
  const levels = {
    '0':    trend === 'UP' ? swingHigh.price : swingLow.price,
    '23.6': base + dir * 0.236 * range,
    '38.2': base + dir * 0.382 * range,
    '50.0': base + dir * 0.500 * range,
    '61.8': base + dir * 0.618 * range,
    '78.6': base + dir * 0.786 * range,
    '100':  trend === 'UP' ? swingLow.price  : swingHigh.price,
  };

  // Find the nearest level to current price
  let nearestLevel = null;
  let minDist = Infinity;
  for (const [label, price] of Object.entries(levels)) {
    const dist = Math.abs(currentPrice - price);
    if (dist < minDist) { minDist = dist; nearestLevel = { label, price }; }
  }

  // Signal only at the three key levels (38.2%, 50%, 61.8%)
  const threshold = 10 * pipSize;
  let signal = null;
  for (const label of ['38.2', '50.0', '61.8']) {
    if (Math.abs(currentPrice - levels[label]) <= threshold) {
      signal = {
        level:     label,
        price:     levels[label],
        type:      trend === 'UP' ? 'SUPPORT' : 'RESISTANCE',
        direction: trend === 'UP' ? 'BULLISH' : 'BEARISH',
      };
      break;
    }
  }

  return { levels, trend, swingHigh: swingHigh.price, swingLow: swingLow.price, range, nearestLevel, signal };
}

/* ── Swing Points ─────────────────────────────────────────── */
// A swing high at index i requires candles[i].high to be strictly
// greater than all highs in [i-lookback .. i-1] ∪ [i+1 .. i+lookback].
// Same logic (inverted) for swing lows.
function findSwingPoints(candles, lookback) {
  lookback = lookback || 3;
  const highs = [];
  const lows  = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high, ts: candles[i].ts });
    if (isLow)  lows.push( { index: i, price: candles[i].low,  ts: candles[i].ts });
  }
  return { highs, lows };
}

/* ── Supply / Demand Zones ────────────────────────────────── */
// Clusters swing highs within 60 pips of each other into supply zones,
// and swing lows into demand zones. A cluster of ≥2 becomes a zone.
// Zones containing the current price or on the wrong side are filtered out.
// Returns up to 5 of each, sorted by proximity to current price.
function detectZones(candles, pipSize) {
  if (!candles || candles.length < 20) return { supply: [], demand: [] };

  const tolerance    = 60 * pipSize;
  const swings       = findSwingPoints(candles, 5);
  const currentPrice = candles[candles.length - 1].rate;

  function cluster(points, descending) {
    const sorted  = points.slice().sort((a, b) => descending ? b.price - a.price : a.price - b.price);
    const visited = new Array(sorted.length).fill(false);
    const zones   = [];

    for (let i = 0; i < sorted.length; i++) {
      if (visited[i]) continue;
      const grp = [sorted[i]];
      for (let j = i + 1; j < sorted.length; j++) {
        if (visited[j]) continue;
        if (Math.abs(sorted[i].price - sorted[j].price) <= tolerance) {
          grp.push(sorted[j]);
          visited[j] = true;
        }
      }
      if (grp.length >= 2) {
        const prices = grp.map(c => c.price);
        const top    = Math.max(...prices);
        const bottom = Math.min(...prices);
        // Discard zones wider than 60 pips (cluster drift)
        if ((top - bottom) <= tolerance) {
          zones.push({ top, bottom, strength: grp.length, ts: Math.max(...grp.map(c => c.ts)) });
        }
      }
    }
    return zones;
  }

  let supply = cluster(swings.highs, true).filter(z => z.bottom > currentPrice);
  let demand = cluster(swings.lows, false).filter(z => z.top    < currentPrice);

  supply.sort((a, b) => a.bottom - b.bottom); // nearest supply first
  demand.sort((a, b) => b.top    - a.top);    // nearest demand first

  return { supply: supply.slice(0, 5), demand: demand.slice(0, 5) };
}

/* ── Per-Timeframe Indicator Bundle ──────────────────────── */
// Computes RSI, MACD, ATR, EMA50/200 cross, Fibonacci, and RSI
// divergence for a single candles array. Returns a plain object
// safe to store in the analysis result and render directly.
function computeIndicators(candles, pipSize) {
  if (!candles || candles.length < 30) return null;

  const last = candles.length - 1;

  const rsiArr  = calcRSI(candles, 14);
  const macdRes = calcMACD(candles, 12, 26, 9);
  const atrArr  = calcATR(candles, 14);
  const ema50Arr  = calcEMA(candles, 50);
  const ema200Arr = calcEMA(candles, 200);

  const rsi      = rsiArr[last];
  const macdVal  = macdRes.macd[last];
  const sigVal   = macdRes.signal[last];
  const hist     = macdRes.histogram[last];
  const prevHist = last > 0 ? macdRes.histogram[last - 1] : null;
  const atr      = atrArr[last];
  const ema50    = ema50Arr[last];
  const ema200   = ema200Arr[last];

  // RSI state
  const rsiState = rsi === null   ? 'UNKNOWN'
                 : rsi >= 70      ? 'OVERBOUGHT'
                 : rsi <= 30      ? 'OVERSOLD'
                 : rsi >= 60      ? 'HIGH'
                 : rsi <= 40      ? 'LOW'
                 : 'NEUTRAL';

  // MACD state — distinguish fresh crossover from sustained momentum
  let macdState = 'NEUTRAL';
  if (hist !== null && prevHist !== null) {
    if      (hist > 0 && prevHist <= 0)  macdState = 'BULLISH CROSS';
    else if (hist < 0 && prevHist >= 0)  macdState = 'BEARISH CROSS';
    else if (hist > 0)                   macdState = 'BULLISH';
    else if (hist < 0)                   macdState = 'BEARISH';
  }

  // EMA 50/200 cross
  let emaCross = 'NONE';
  if (ema50 !== null && ema200 !== null) {
    emaCross = ema50 > ema200 ? 'GOLDEN' : 'DEATH';
  }

  // RSI divergence: compare RSI at last two swing extremes
  const swings = findSwingPoints(candles, 5);
  let rsiDivergence = 'NONE';

  if (rsi !== null && swings.lows.length >= 2) {
    const [l0, l1] = swings.lows.slice(-2);
    const r0 = rsiArr[l0.index], r1 = rsiArr[l1.index];
    // Bullish: price lower low but RSI higher low (hidden strength)
    if (r0 !== null && r1 !== null && l1.price < l0.price && r1 > r0) {
      rsiDivergence = 'BULLISH';
    }
  }
  if (rsiDivergence === 'NONE' && rsi !== null && swings.highs.length >= 2) {
    const [h0, h1] = swings.highs.slice(-2);
    const r0 = rsiArr[h0.index], r1 = rsiArr[h1.index];
    // Bearish: price higher high but RSI lower high (hidden weakness)
    if (r0 !== null && r1 !== null && h1.price > h0.price && r1 < r0) {
      rsiDivergence = 'BEARISH';
    }
  }

  const fib      = calcFibLevels(candles, pipSize);
  const atrPips  = atr !== null ? Math.round(atr / pipSize) : null;

  return {
    rsi, rsiState, rsiDivergence,
    macd: macdVal, signal: sigVal, histogram: hist, macdState,
    macdAboveZero: macdVal !== null ? macdVal > 0 : null,
    emaCross, ema50, ema200,
    atr, atrPips,
    fib,
  };
}

/* ── Market Bias ──────────────────────────────────────────── */
// Combines two independent signals:
//  1. Price structure: counts HH/HL vs LH/LL among the last 3 swing points.
//  2. EMA200: price position relative to the 200-period EMA.
//     Proximity threshold is 0.1% of current price (not a fixed pip count)
//     so it scales correctly across JPY pairs, gold, etc.
// Result also exposes RSI, MACD, and EMA50/200 cross for use by the scorer.
function detectBias(candles, pipSize) {
  const empty = { bias: 'NEUTRAL', structure: 'MIXED', emaSignal: 'UNKNOWN',
                  emaCross: 'NONE', ema50: null, ema200: null,
                  rsi: null, rsiState: 'UNKNOWN', macdState: 'NEUTRAL',
                  swingHighs: [], swingLows: [] };
  if (!candles || candles.length < 10) return empty;

  const swings    = findSwingPoints(candles, 5);
  const ema200Arr = calcEMA(candles, 200);
  const ema200    = ema200Arr[ema200Arr.length - 1];
  const ema50Arr  = calcEMA(candles, 50);
  const ema50     = ema50Arr[ema50Arr.length - 1];

  const lastHighs = swings.highs.slice(-3);
  const lastLows  = swings.lows.slice(-3);

  let hhCount = 0, lhCount = 0, hlCount = 0, llCount = 0;
  for (let i = 1; i < lastHighs.length; i++) {
    if (lastHighs[i].price > lastHighs[i - 1].price) hhCount++;
    else lhCount++;
  }
  for (let i = 1; i < lastLows.length; i++) {
    if (lastLows[i].price > lastLows[i - 1].price) hlCount++;
    else llCount++;
  }

  const structure = (hhCount > lhCount && hlCount > llCount) ? 'HH/HL'
                  : (lhCount > hhCount && llCount > hlCount) ? 'LH/LL'
                  : 'MIXED';

  const currentClose  = candles[candles.length - 1].rate;
  // Use 0.1% of current price as the "near EMA" threshold — scales across all pairs
  const nearThreshold = currentClose * 0.001;
  const emaSignal = ema200 == null
    ? 'UNKNOWN'
    : Math.abs(currentClose - ema200) < nearThreshold ? 'NEAR'
    : currentClose > ema200 ? 'ABOVE'
    : 'BELOW';

  const emaCross = (ema50 !== null && ema200 !== null)
    ? (ema50 > ema200 ? 'GOLDEN' : 'DEATH')
    : 'NONE';

  // RSI + MACD for exposure in the return object (not used for the bias decision itself)
  const rsiArr  = calcRSI(candles, 14);
  const rsi     = rsiArr[rsiArr.length - 1];
  const rsiState = rsi === null ? 'UNKNOWN'
                 : rsi >= 70   ? 'OVERBOUGHT'
                 : rsi <= 30   ? 'OVERSOLD'
                 : rsi >= 60   ? 'HIGH'
                 : rsi <= 40   ? 'LOW'
                 : 'NEUTRAL';

  const macdRes  = calcMACD(candles, 12, 26, 9);
  const last     = candles.length - 1;
  const hist     = macdRes.histogram[last];
  const prevHist = last > 0 ? macdRes.histogram[last - 1] : null;
  let macdState  = 'NEUTRAL';
  if (hist !== null && prevHist !== null) {
    if      (hist > 0 && prevHist <= 0) macdState = 'BULLISH CROSS';
    else if (hist < 0 && prevHist >= 0) macdState = 'BEARISH CROSS';
    else if (hist > 0) macdState = 'BULLISH';
    else if (hist < 0) macdState = 'BEARISH';
  }

  // Bias decision: structure + EMA200 are the primary signals
  let bias;
  if      (structure === 'HH/HL' && emaSignal === 'ABOVE') bias = 'BULLISH';
  else if (structure === 'LH/LL' && emaSignal === 'BELOW') bias = 'BEARISH';
  else if (structure === 'HH/HL' || emaSignal === 'ABOVE') bias = 'BULLISH';
  else if (structure === 'LH/LL' || emaSignal === 'BELOW') bias = 'BEARISH';
  else bias = 'NEUTRAL';

  return { bias, structure, emaSignal, emaCross, ema50, ema200,
           rsi, rsiState, macdState, swingHighs: lastHighs, swingLows: lastLows };
}

/* ── Head & Shoulders ─────────────────────────────────────── */
// Scans the most recent 100 candles for a classic H&S (bearish) or
// inverse H&S (bullish) using confirmed swing points (lookback=3).
// Symmetry check: shoulder price difference ≤ 30% of head height.
// Neckline: average of the two troughs (or peaks) between the shoulders.
// Confidence: HIGH when the right shoulder decays further than the left.
function detectHeadAndShoulders(candles) {
  const none = { found: false, type: null, neckline: null, headPrice: null, confidence: null };
  if (!candles || candles.length < 20) return none;

  const window100 = candles.slice(-100); // wider window for reliability
  const swings    = findSwingPoints(window100, 3);

  // Regular H&S (bearish reversal)
  const highs = swings.highs;
  for (let i = 2; i < highs.length; i++) {
    const ls = highs[i - 2], head = highs[i - 1], rs = highs[i];

    if (head.price <= ls.price || head.price <= rs.price) continue;

    const shoulderDiff = Math.abs(ls.price - rs.price);
    const headHeight   = head.price - Math.min(ls.price, rs.price);
    if (headHeight === 0 || shoulderDiff > headHeight * 0.3) continue;

    const lowsBetween = swings.lows.filter(l => l.index > ls.index && l.index < rs.index);
    if (lowsBetween.length < 2) continue;

    const neckline = lowsBetween.reduce((s, l) => s + l.price, 0) / lowsBetween.length;
    // Right shoulder must still be above the neckline (pattern not yet broken)
    if (rs.price < neckline) continue;

    const confidence = rs.price < ls.price ? 'HIGH' : 'MEDIUM';
    return { found: true, type: 'HS', neckline, headPrice: head.price, confidence };
  }

  // Inverse H&S (bullish reversal)
  const lows = swings.lows;
  for (let i = 2; i < lows.length; i++) {
    const ls = lows[i - 2], head = lows[i - 1], rs = lows[i];

    if (head.price >= ls.price || head.price >= rs.price) continue;

    const shoulderDiff = Math.abs(ls.price - rs.price);
    const headHeight   = Math.max(ls.price, rs.price) - head.price;
    if (headHeight === 0 || shoulderDiff > headHeight * 0.3) continue;

    const highsBetween = swings.highs.filter(h => h.index > ls.index && h.index < rs.index);
    if (highsBetween.length < 2) continue;

    const neckline = highsBetween.reduce((s, h) => s + h.price, 0) / highsBetween.length;
    // Right shoulder must still be below the neckline (pattern not yet broken out)
    if (rs.price > neckline) continue;

    const confidence = rs.price > ls.price ? 'HIGH' : 'MEDIUM';
    return { found: true, type: 'IHS', neckline, headPrice: head.price, confidence };
  }

  return none;
}

/* ── Candlestick Patterns ─────────────────────────────────── */
// Checks the last 1–3 candles for 9 standard patterns.
// Helpers:
//   bodySize  = |close - open|
//   upperWick = high - max(close, open)
//   lowerWick = min(close, open) - low
//   isBullish = close >= open
// Context checks (Hammer, Shooting Star) use the last 10 candles
// to confirm the candle appears at a local extreme.
function detectCandlestickPatterns(candles) {
  if (!candles || candles.length < 3) return [];

  const patterns = [];

  const bodySize  = c => Math.abs(c.rate - c.open);
  const upperWick = c => c.high - Math.max(c.rate, c.open);
  const lowerWick = c => Math.min(c.rate, c.open) - c.low;
  const totalRange= c => c.high - c.low;
  const isBullish = c => c.rate >= c.open;
  const isBearish = c => c.rate < c.open;
  const midpoint  = c => (c.open + c.rate) / 2;

  const last3 = candles.slice(-3);
  const last2 = candles.slice(-2);
  const c     = candles[candles.length - 1];

  // ── 3-candle ─────────────────────────────────────────────
  {
    const [c0, c1, c2] = last3;
    // Morning Star: bearish → small body → bullish closing above c0 midpoint
    if (isBearish(c0) && bodySize(c0) > 0 &&
        bodySize(c1) < 0.3 * bodySize(c0) &&
        isBullish(c2) && c2.rate > midpoint(c0)) {
      patterns.push({ name: 'Morning Star', type: 'BULLISH', candles: 3 });
    }
    // Evening Star: bullish → small body → bearish closing below c0 midpoint
    if (isBullish(c0) && bodySize(c0) > 0 &&
        bodySize(c1) < 0.3 * bodySize(c0) &&
        isBearish(c2) && c2.rate < midpoint(c0)) {
      patterns.push({ name: 'Evening Star', type: 'BEARISH', candles: 3 });
    }
    // Three White Soldiers: three consecutive bullish candles, each closing higher
    if (isBullish(c0) && isBullish(c1) && isBullish(c2) &&
        c1.rate > c0.rate && c2.rate > c1.rate &&
        c1.open > c0.open && c2.open > c1.open &&
        bodySize(c0) > 0 && bodySize(c1) > 0 && bodySize(c2) > 0) {
      patterns.push({ name: 'Three White Soldiers', type: 'BULLISH', candles: 3 });
    }
    // Three Black Crows: three consecutive bearish candles, each closing lower
    if (isBearish(c0) && isBearish(c1) && isBearish(c2) &&
        c1.rate < c0.rate && c2.rate < c1.rate &&
        c1.open < c0.open && c2.open < c1.open &&
        bodySize(c0) > 0 && bodySize(c1) > 0 && bodySize(c2) > 0) {
      patterns.push({ name: 'Three Black Crows', type: 'BEARISH', candles: 3 });
    }
  }

  // ── 2-candle ─────────────────────────────────────────────
  {
    const [c0, c1] = last2;
    // Bullish Engulfing: bearish c0 fully engulfed by bullish c1
    if (isBearish(c0) && isBullish(c1) &&
        c1.open <= c0.rate && c1.rate >= c0.open) {
      patterns.push({ name: 'Bullish Engulfing', type: 'BULLISH', candles: 2 });
    }
    // Bearish Engulfing: bullish c0 fully engulfed by bearish c1
    if (isBullish(c0) && isBearish(c1) &&
        c1.open >= c0.rate && c1.rate <= c0.open) {
      patterns.push({ name: 'Bearish Engulfing', type: 'BEARISH', candles: 2 });
    }
    // Bullish Harami: small bullish c1 body contained within large bearish c0 body
    if (isBearish(c0) && bodySize(c0) > 0 && isBullish(c1) &&
        c1.open > c0.rate && c1.rate < c0.open) {
      patterns.push({ name: 'Bullish Harami', type: 'BULLISH', candles: 2 });
    }
    // Bearish Harami: small bearish c1 body contained within large bullish c0 body
    if (isBullish(c0) && bodySize(c0) > 0 && isBearish(c1) &&
        c1.open < c0.rate && c1.rate > c0.open) {
      patterns.push({ name: 'Bearish Harami', type: 'BEARISH', candles: 2 });
    }
    // Tweezer Bottom: two candles at same low with opposite direction
    if (Math.abs(c0.low - c1.low) < Math.abs(c0.open - c0.rate) * 0.1 &&
        isBearish(c0) && isBullish(c1) && bodySize(c0) > 0 && bodySize(c1) > 0) {
      patterns.push({ name: 'Tweezer Bottom', type: 'BULLISH', candles: 2 });
    }
    // Tweezer Top: two candles at same high with opposite direction
    if (Math.abs(c0.high - c1.high) < Math.abs(c0.open - c0.rate) * 0.1 &&
        isBullish(c0) && isBearish(c1) && bodySize(c0) > 0 && bodySize(c1) > 0) {
      patterns.push({ name: 'Tweezer Top', type: 'BEARISH', candles: 2 });
    }
  }

  // ── 1-candle ─────────────────────────────────────────────
  const body  = bodySize(c);
  const range = totalRange(c);
  const upper = upperWick(c);
  const lower = lowerWick(c);

  // Doji: body < 5% of range (indecision)
  if (range > 0 && body / range < 0.05) {
    patterns.push({ name: 'Doji', type: 'NEUTRAL', candles: 1 });
  }

  // Hammer: lower wick ≥ 2× body, upper wick ≤ 0.5× body, at local low
  if (body > 0 && lower >= 2 * body && upper <= 0.5 * body) {
    const recentLow = Math.min(...candles.slice(-10).map(x => x.low));
    if (c.low <= recentLow * 1.0015) {
      patterns.push({ name: 'Hammer', type: 'BULLISH', candles: 1 });
    }
  }

  // Shooting Star: upper wick ≥ 2× body, lower wick ≤ 0.5× body, at local high
  if (body > 0 && upper >= 2 * body && lower <= 0.5 * body) {
    const recentHigh = Math.max(...candles.slice(-10).map(x => x.high));
    if (c.high >= recentHigh * 0.9985) {
      patterns.push({ name: 'Shooting Star', type: 'BEARISH', candles: 1 });
    }
  }

  // Marubozu: near-zero wicks (≤ 5% of body), strong directional candle
  if (body > 0 && upper <= 0.05 * body && lower <= 0.05 * body) {
    patterns.push({ name: isBullish(c) ? 'Bullish Marubozu' : 'Bearish Marubozu',
                    type: isBullish(c) ? 'BULLISH' : 'BEARISH', candles: 1 });
  }

  return patterns;
}

/* ── Confidence Score ─────────────────────────────────────── */
// Weighted multi-factor score from -100 (strong bear) to +100 (strong bull).
// Factors and weights:
//   Bias (weekly/daily/4H): ±25/20/15
//   Triple TF confluence bonus: ±10
//   EMA 50/200 cross (daily): ±8
//   RSI overbought/oversold (daily): ±10 with trend (±5 countertrend), mid-zone: ±4
//   RSI divergence (daily): ±8
//   MACD crossover (daily): ±8  sustained momentum: ±4
//   MACD above/below zero (daily): ±3
//   Fibonacci key level (daily): ±6 (61.8% → ±8)
//   4H RSI extreme: ±5
//   4H MACD crossover: ±5
//   Zone proximity (per TF, trend-aware): near ±10/±5 (trend-aligned/counter)
//   H&S patterns: ±10
//   Candlestick patterns 4H: ±5 each, max ±10
//   Candlestick patterns Daily: ±4 each, max ±8
function calcConfidenceScore(biases, zones, hsPatterns, candlePatterns, indicators, currentPrice, pipSize) {
  let score = 0;
  const factors = [];

  function add(pts, label, value) {
    if (pts === 0) return;
    score += pts;
    factors.push({ label, value, points: pts });
  }

  // ── Bias scoring ────────────────────────────────────────
  const biasDir = { BULLISH: 1, BEARISH: -1, NEUTRAL: 0 };
  add(biasDir[biases.weekly && biases.weekly.bias] * 25, 'WEEKLY Bias', biases.weekly && biases.weekly.bias);
  add(biasDir[biases.daily  && biases.daily.bias]  * 20, 'DAILY Bias',  biases.daily  && biases.daily.bias);
  add(biasDir[biases.h4     && biases.h4.bias]     * 15, '4H Bias',     biases.h4     && biases.h4.bias);

  // Triple confluence bonus
  const allBiases = [biases.weekly && biases.weekly.bias, biases.daily && biases.daily.bias, biases.h4 && biases.h4.bias];
  if (allBiases.every(b => b === 'BULLISH')) add(10,  'Triple Bullish Confluence', 'All TFs Aligned');
  if (allBiases.every(b => b === 'BEARISH')) add(-10, 'Triple Bearish Confluence', 'All TFs Aligned');

  // Daily bias used for trend-aware sub-scoring below
  const dailyBias     = biases.daily && biases.daily.bias;    // 'BULLISH'|'BEARISH'|'NEUTRAL'
  const dailyEmaSignal = biases.daily && biases.daily.emaSignal; // 'ABOVE'|'BELOW'|'NEAR'|'UNKNOWN'

  // ── Daily indicators ────────────────────────────────────
  const dInd = indicators && indicators.daily;
  if (dInd) {
    // EMA 50/200 cross
    if (dInd.emaCross === 'GOLDEN') add(8,  'Daily EMA Cross', 'Golden (50 > 200)');
    if (dInd.emaCross === 'DEATH')  add(-8, 'Daily EMA Cross', 'Death (50 < 200)');

    // RSI — trend-aware: extreme readings aligned with trend score higher;
    // countertrend extremes score half (they indicate potential reversal only,
    // not continuation, and carry higher risk of being faded further).
    const rsiDisp = dInd.rsi != null ? dInd.rsi.toFixed(1) : '—';
    if (dInd.rsiState === 'OVERSOLD') {
      const trendAligned = dailyBias === 'BULLISH' || dailyEmaSignal === 'ABOVE';
      add(trendAligned ? 10 : 5, 'Daily RSI', `${rsiDisp} — Oversold`);
    } else if (dInd.rsiState === 'OVERBOUGHT') {
      const trendAligned = dailyBias === 'BEARISH' || dailyEmaSignal === 'BELOW';
      add(trendAligned ? -10 : -5, 'Daily RSI', `${rsiDisp} — Overbought`);
    } else if (dInd.rsiState === 'LOW') {
      add(4, 'Daily RSI', `${rsiDisp} — Low Zone`);
    } else if (dInd.rsiState === 'HIGH') {
      add(-4, 'Daily RSI', `${rsiDisp} — High Zone`);
    }

    // RSI divergence
    if (dInd.rsiDivergence === 'BULLISH') add(8,  'RSI Divergence', 'Bullish Divergence');
    if (dInd.rsiDivergence === 'BEARISH') add(-8, 'RSI Divergence', 'Bearish Divergence');

    // MACD
    if      (dInd.macdState === 'BULLISH CROSS') add(8,  'Daily MACD', 'Bullish Crossover');
    else if (dInd.macdState === 'BEARISH CROSS') add(-8, 'Daily MACD', 'Bearish Crossover');
    else if (dInd.macdState === 'BULLISH')        add(4,  'Daily MACD', 'Bullish Momentum');
    else if (dInd.macdState === 'BEARISH')        add(-4, 'Daily MACD', 'Bearish Momentum');

    // MACD above/below zero line
    if (dInd.macdAboveZero === true)  add(3,  'Daily MACD Zone', 'Above Zero');
    if (dInd.macdAboveZero === false) add(-3, 'Daily MACD Zone', 'Below Zero');

    // Fibonacci
    if (dInd.fib && dInd.fib.signal) {
      const fibPts = dInd.fib.signal.level === '61.8' ? 8 : 6;
      if (dInd.fib.signal.direction === 'BULLISH') add(fibPts,  'Fibonacci', `${dInd.fib.signal.level}% Support`);
      if (dInd.fib.signal.direction === 'BEARISH') add(-fibPts, 'Fibonacci', `${dInd.fib.signal.level}% Resistance`);
    }
  }

  // ── 4H indicators (lighter weight) ──────────────────────
  const h4Ind = indicators && indicators.h4;
  if (h4Ind) {
    if (h4Ind.rsiState === 'OVERSOLD')   add(5,  '4H RSI', `${h4Ind.rsi != null ? h4Ind.rsi.toFixed(1) : '—'} — Oversold`);
    if (h4Ind.rsiState === 'OVERBOUGHT') add(-5, '4H RSI', `${h4Ind.rsi != null ? h4Ind.rsi.toFixed(1) : '—'} — Overbought`);
    if (h4Ind.macdState === 'BULLISH CROSS') add(5,  '4H MACD', 'Bullish Crossover');
    if (h4Ind.macdState === 'BEARISH CROSS') add(-5, '4H MACD', 'Bearish Crossover');
  }

  // ── Zone proximity (trend-aware) ─────────────────────────
  // detectZones guarantees supply zones have bottom > currentPrice and
  // demand zones have top < currentPrice, so only proximity checks apply.
  // Zones aligned with the daily trend score higher than countertrend zones.
  const nearPips = 10;
  for (const tf of ['weekly', 'daily', 'h4']) {
    const z = zones[tf];
    if (!z) continue;
    for (const zone of z.supply) {
      if (zone.bottom - currentPrice <= nearPips * pipSize) {
        // Supply resistance: strongest when trend is already bearish
        const pts = dailyBias === 'BEARISH' ? -10
                  : dailyBias === 'BULLISH' ? -5
                  : -8;
        add(pts, `${tf.toUpperCase()} Near Supply`, `${zone.strength} touches`); break;
      }
    }
    for (const zone of z.demand) {
      if (currentPrice - zone.top <= nearPips * pipSize) {
        // Demand support: strongest when trend is already bullish
        const pts = dailyBias === 'BULLISH' ? 10
                  : dailyBias === 'BEARISH' ? 5
                  : 8;
        add(pts,  `${tf.toUpperCase()} Near Demand`, `${zone.strength} touches`); break;
      }
    }
  }

  // ── H&S patterns ────────────────────────────────────────
  for (const [tf, hs] of Object.entries(hsPatterns)) {
    if (!hs || !hs.found) continue;
    if (hs.type === 'HS')  add(-10, `${tf.toUpperCase()} Head & Shoulders`, hs.confidence);
    if (hs.type === 'IHS') add(10,  `${tf.toUpperCase()} Inv. H&S`,         hs.confidence);
  }

  // ── Candlestick patterns ─────────────────────────────────
  for (const [tf, pats] of Object.entries(candlePatterns)) {
    if (!pats) continue;
    const perPat = tf === 'h4' ? 5 : 4;
    const cap    = tf === 'h4' ? 10 : 8;
    let bullAcc = 0, bearAcc = 0;
    for (const p of pats) {
      if (p.type === 'BULLISH' && bullAcc < cap)  bullAcc += perPat;
      if (p.type === 'BEARISH' && bearAcc > -cap) bearAcc -= perPat;
    }
    if (bullAcc) add(bullAcc, `${tf.toUpperCase()} Bullish Pattern`, pats.filter(p => p.type === 'BULLISH').map(p => p.name).join(', '));
    if (bearAcc) add(bearAcc, `${tf.toUpperCase()} Bearish Pattern`, pats.filter(p => p.type === 'BEARISH').map(p => p.name).join(', '));
  }

  score = Math.max(-100, Math.min(100, score));

  const recommendation = score >= 60  ? 'STRONG BUY'
                       : score >= 25  ? 'BUY'
                       : score > -25  ? 'NEUTRAL'
                       : score > -60  ? 'SELL'
                       :                'STRONG SELL';

  return { score, recommendation, factors };
}

/* ── Main Entry Point ─────────────────────────────────────── */
async function runFullAnalysis(f, t) {
  const pipSize = (f === 'JPY' || t === 'JPY') ? 0.01 : 0.0001;

  const [h4Data, dailyData, weeklyData] = await Promise.all([
    fetchYahooFinanceChart(f, t, '4h'),
    fetchYahooFinanceChart(f, t, '1D'),
    fetchYahooFinanceChart(f, t, '1W'),
  ]);

  const biases = {
    h4:     detectBias(h4Data,     pipSize),
    daily:  detectBias(dailyData,  pipSize),
    weekly: detectBias(weeklyData, pipSize),
  };

  const zones = {
    h4:     detectZones(h4Data,     pipSize),
    daily:  detectZones(dailyData,  pipSize),
    weekly: detectZones(weeklyData, pipSize),
  };

  const hsPatterns = {
    h4:     detectHeadAndShoulders(h4Data),
    daily:  detectHeadAndShoulders(dailyData),
    weekly: detectHeadAndShoulders(weeklyData),
  };

  const candlePatterns = {
    h4:    detectCandlestickPatterns(h4Data),
    daily: detectCandlestickPatterns(dailyData),
  };

  const indicators = {
    daily: computeIndicators(dailyData,  pipSize),
    h4:    computeIndicators(h4Data,     pipSize),
  };

  const currentPrice = (h4Data && h4Data.length) ? h4Data[h4Data.length - 1].rate : null;

  const confidence = currentPrice != null
    ? calcConfidenceScore(biases, zones, hsPatterns, candlePatterns, indicators, currentPrice, pipSize)
    : null;

  return { biases, zones, hsPatterns, candlePatterns, indicators, confidence, pipSize, currentPrice };
}

window.runFullAnalysis = runFullAnalysis;
