/* ============================================================
   TECHNICAL ANALYSIS ENGINE
   Provides: EMA, swing points, supply/demand zones, bias
   detection, Head & Shoulders, candlestick patterns, and a
   confidence score used by the detail panel.
   ============================================================ */

/* ── EMA ──────────────────────────────────────────────────── */
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

/* ── Swing Points ─────────────────────────────────────────── */
function findSwingPoints(candles, lookback) {
  lookback = lookback || 3;
  const highs = [];
  const lows  = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow  = true;
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
function detectZones(candles, pipSize) {
  if (!candles || candles.length < 20) return { supply: [], demand: [] };

  const tolerance = 60 * pipSize;
  const swings    = findSwingPoints(candles, 5);
  const currentPrice = candles[candles.length - 1].rate;

  function clusterPoints(points, descending) {
    const sorted  = points.slice().sort((a, b) => descending ? b.price - a.price : a.price - b.price);
    const visited = new Array(sorted.length).fill(false);
    const zones   = [];

    for (let i = 0; i < sorted.length; i++) {
      if (visited[i]) continue;
      const cluster = [sorted[i]];
      for (let j = i + 1; j < sorted.length; j++) {
        if (visited[j]) continue;
        if (Math.abs(sorted[i].price - sorted[j].price) <= tolerance) {
          cluster.push(sorted[j]);
          visited[j] = true;
        }
      }
      if (cluster.length >= 2) {
        const prices = cluster.map(c => c.price);
        const top    = Math.max(...prices);
        const bottom = Math.min(...prices);
        if ((top - bottom) / pipSize <= 60) {
          zones.push({
            top,
            bottom,
            strength: cluster.length,
            ts: Math.max(...cluster.map(c => c.ts)),
          });
        }
      }
    }
    return zones;
  }

  let supply = clusterPoints(swings.highs, true).filter(z => z.bottom > currentPrice);
  let demand = clusterPoints(swings.lows,  false).filter(z => z.top < currentPrice);

  supply.sort((a, b) => a.bottom - b.bottom);
  demand.sort((a, b) => b.top - a.top);

  return { supply: supply.slice(0, 5), demand: demand.slice(0, 5) };
}

/* ── Market Bias ──────────────────────────────────────────── */
function detectBias(candles, pipSize) {
  if (!candles || candles.length < 10) {
    return { bias: 'NEUTRAL', structure: 'MIXED', emaSignal: 'UNKNOWN', ema200: null, swingHighs: [], swingLows: [] };
  }

  const swings    = findSwingPoints(candles, 5);
  const emaValues = calcEMA(candles, 200);
  const ema200    = emaValues[emaValues.length - 1];

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
  const nearThreshold = 5 * pipSize;
  const emaSignal = ema200 == null
    ? 'UNKNOWN'
    : Math.abs(currentClose - ema200) < nearThreshold ? 'NEAR'
    : currentClose > ema200 ? 'ABOVE'
    : 'BELOW';

  let bias;
  if      (structure === 'HH/HL' && emaSignal === 'ABOVE') bias = 'BULLISH';
  else if (structure === 'LH/LL' && emaSignal === 'BELOW') bias = 'BEARISH';
  else if (structure === 'HH/HL' || emaSignal === 'ABOVE') bias = 'BULLISH';
  else if (structure === 'LH/LL' || emaSignal === 'BELOW') bias = 'BEARISH';
  else bias = 'NEUTRAL';

  return { bias, structure, emaSignal, ema200, swingHighs: lastHighs, swingLows: lastLows };
}

/* ── Head & Shoulders ─────────────────────────────────────── */
function detectHeadAndShoulders(candles) {
  const none = { found: false, type: null, neckline: null, headPrice: null, confidence: null };
  if (!candles || candles.length < 20) return none;

  const window60 = candles.slice(-60);
  const swings   = findSwingPoints(window60, 3);

  // Regular H&S (bearish)
  const highs = swings.highs;
  for (let i = 2; i < highs.length; i++) {
    const ls   = highs[i - 2];
    const head = highs[i - 1];
    const rs   = highs[i];

    if (head.price <= ls.price || head.price <= rs.price) continue;

    const shoulderDiff = Math.abs(ls.price - rs.price);
    const headHeight   = head.price - Math.min(ls.price, rs.price);
    if (shoulderDiff > headHeight * 0.3) continue;

    const lowsBetween = swings.lows.filter(l => l.index > ls.index && l.index < rs.index);
    if (lowsBetween.length < 2) continue;

    const neckline = lowsBetween.reduce((s, l) => s + l.price, 0) / lowsBetween.length;
    if (rs.price < neckline) continue;

    const confidence = rs.price < ls.price ? 'HIGH' : 'MEDIUM';
    return { found: true, type: 'HS', neckline, headPrice: head.price, confidence };
  }

  // Inverse H&S (bullish)
  const lows = swings.lows;
  for (let i = 2; i < lows.length; i++) {
    const ls   = lows[i - 2];
    const head = lows[i - 1];
    const rs   = lows[i];

    if (head.price >= ls.price || head.price >= rs.price) continue;

    const shoulderDiff = Math.abs(ls.price - rs.price);
    const headHeight   = Math.max(ls.price, rs.price) - head.price;
    if (shoulderDiff > headHeight * 0.3) continue;

    const highsBetween = swings.highs.filter(h => h.index > ls.index && h.index < rs.index);
    if (highsBetween.length < 2) continue;

    const neckline = highsBetween.reduce((s, h) => s + h.price, 0) / highsBetween.length;
    if (rs.price > neckline) continue;

    const confidence = rs.price > ls.price ? 'HIGH' : 'MEDIUM';
    return { found: true, type: 'IHS', neckline, headPrice: head.price, confidence };
  }

  return none;
}

/* ── Candlestick Patterns ─────────────────────────────────── */
function detectCandlestickPatterns(candles) {
  if (!candles || candles.length < 3) return [];

  const patterns = [];

  function bodySize(c)  { return Math.abs(c.rate - c.open); }
  function upperWick(c) { return c.high - Math.max(c.rate, c.open); }
  function lowerWick(c) { return Math.min(c.rate, c.open) - c.low; }
  function totalRange(c){ return c.high - c.low; }
  function isBullish(c) { return c.rate >= c.open; }
  function isBearish(c) { return c.rate < c.open; }
  function midpoint(c)  { return (c.open + c.rate) / 2; }

  const last3 = candles.slice(-3);
  const last2 = candles.slice(-2);
  const last1 = candles[candles.length - 1];

  // Morning Star (3-candle bullish)
  if (last3.length === 3) {
    const [c0, c1, c2] = last3;
    if (isBearish(c0) && bodySize(c0) > 0 &&
        bodySize(c1) < 0.3 * bodySize(c0) &&
        isBullish(c2) && c2.rate > midpoint(c0)) {
      patterns.push({ name: 'Morning Star', type: 'BULLISH', candles: 3, description: '3-candle bullish reversal' });
    }
  }

  // Evening Star (3-candle bearish)
  if (last3.length === 3) {
    const [c0, c1, c2] = last3;
    if (isBullish(c0) && bodySize(c0) > 0 &&
        bodySize(c1) < 0.3 * bodySize(c0) &&
        isBearish(c2) && c2.rate < midpoint(c0)) {
      patterns.push({ name: 'Evening Star', type: 'BEARISH', candles: 3, description: '3-candle bearish reversal' });
    }
  }

  // Bullish Engulfing (2-candle)
  if (last2.length === 2) {
    const [c0, c1] = last2;
    if (isBearish(c0) && isBullish(c1) &&
        c1.open <= c0.rate && c1.rate >= c0.open) {
      patterns.push({ name: 'Bullish Engulfing', type: 'BULLISH', candles: 2, description: '2-candle bullish reversal' });
    }
  }

  // Bearish Engulfing (2-candle)
  if (last2.length === 2) {
    const [c0, c1] = last2;
    if (isBullish(c0) && isBearish(c1) &&
        c1.open >= c0.rate && c1.rate <= c0.open) {
      patterns.push({ name: 'Bearish Engulfing', type: 'BEARISH', candles: 2, description: '2-candle bearish reversal' });
    }
  }

  // Bullish Harami (2-candle)
  if (last2.length === 2) {
    const [c0, c1] = last2;
    if (isBearish(c0) && bodySize(c0) > 0 && isBullish(c1) &&
        c1.open > c0.rate && c1.rate < c0.open) {
      patterns.push({ name: 'Bullish Harami', type: 'BULLISH', candles: 2, description: '2-candle inside-bar bullish' });
    }
  }

  // Bearish Harami (2-candle)
  if (last2.length === 2) {
    const [c0, c1] = last2;
    if (isBullish(c0) && bodySize(c0) > 0 && isBearish(c1) &&
        c1.open < c0.rate && c1.rate > c0.open) {
      patterns.push({ name: 'Bearish Harami', type: 'BEARISH', candles: 2, description: '2-candle inside-bar bearish' });
    }
  }

  // Single candle patterns
  const c = last1;
  const body   = bodySize(c);
  const range  = totalRange(c);
  const upper  = upperWick(c);
  const lower  = lowerWick(c);

  // Doji
  if (range > 0 && body / range < 0.05) {
    patterns.push({ name: 'Doji', type: 'NEUTRAL', candles: 1, description: 'Indecision candle' });
  }

  // Hammer
  if (body > 0 && lower >= 2 * body && upper <= 0.5 * body) {
    const recentLow = Math.min(...candles.slice(-10).map(x => x.low));
    if (c.low <= recentLow * 1.001) {
      patterns.push({ name: 'Hammer', type: 'BULLISH', candles: 1, description: 'Potential bullish reversal' });
    }
  }

  // Shooting Star
  if (body > 0 && upper >= 2 * body && lower <= 0.5 * body) {
    const recentHigh = Math.max(...candles.slice(-10).map(x => x.high));
    if (c.high >= recentHigh * 0.999) {
      patterns.push({ name: 'Shooting Star', type: 'BEARISH', candles: 1, description: 'Potential bearish reversal' });
    }
  }

  return patterns;
}

/* ── Confidence Score ─────────────────────────────────────── */
function calcConfidenceScore(biases, zones, hsPatterns, candlePatterns, currentPrice, pipSize) {
  let score = 0;
  const factors = [];

  // Bias scoring
  const biasPoints  = { BULLISH: 1, BEARISH: -1, NEUTRAL: 0 };
  const biasWeights = { weekly: 25, daily: 20, h4: 15 };

  for (const [tf, weight] of Object.entries(biasWeights)) {
    const b = biases[tf];
    if (!b) continue;
    const pts = biasPoints[b.bias] * weight;
    if (pts !== 0) {
      score += pts;
      factors.push({ label: `${tf.toUpperCase()} Bias`, value: b.bias, points: pts });
    }
  }

  // Triple confluence bonus
  const allBiases = [biases.weekly && biases.weekly.bias, biases.daily && biases.daily.bias, biases.h4 && biases.h4.bias];
  if (allBiases.every(b => b === 'BULLISH')) {
    score += 10;
    factors.push({ label: 'Triple Bullish Confluence', value: 'All TFs Aligned', points: 10 });
  } else if (allBiases.every(b => b === 'BEARISH')) {
    score -= 10;
    factors.push({ label: 'Triple Bearish Confluence', value: 'All TFs Aligned', points: -10 });
  }

  // Zone proximity scoring
  const nearPips = 10;
  for (const tf of ['weekly', 'daily', 'h4']) {
    const z = zones[tf];
    if (!z) continue;
    for (const zone of z.supply) {
      if (currentPrice >= zone.bottom && currentPrice <= zone.top) {
        score -= 8;
        factors.push({ label: `${tf.toUpperCase()} Inside Supply`, value: `${zone.bottom.toFixed(5)}–${zone.top.toFixed(5)}`, points: -8 });
        break;
      }
      if (zone.bottom - currentPrice <= nearPips * pipSize) {
        score -= 12;
        factors.push({ label: `${tf.toUpperCase()} Near Supply`, value: `${zone.strength} touches`, points: -12 });
        break;
      }
    }
    for (const zone of z.demand) {
      if (currentPrice >= zone.bottom && currentPrice <= zone.top) {
        score += 8;
        factors.push({ label: `${tf.toUpperCase()} Inside Demand`, value: `${zone.bottom.toFixed(5)}–${zone.top.toFixed(5)}`, points: 8 });
        break;
      }
      if (currentPrice - zone.top <= nearPips * pipSize) {
        score += 12;
        factors.push({ label: `${tf.toUpperCase()} Near Demand`, value: `${zone.strength} touches`, points: 12 });
        break;
      }
    }
  }

  // H&S patterns
  for (const [tf, hs] of Object.entries(hsPatterns)) {
    if (!hs || !hs.found) continue;
    if (hs.type === 'HS') {
      score -= 10;
      factors.push({ label: `${tf.toUpperCase()} Head & Shoulders`, value: hs.confidence, points: -10 });
    } else if (hs.type === 'IHS') {
      score += 10;
      factors.push({ label: `${tf.toUpperCase()} Inv. H&S`, value: hs.confidence, points: 10 });
    }
  }

  // Candlestick patterns — 4H
  if (candlePatterns.h4 && candlePatterns.h4.length) {
    let bullPts = 0, bearPts = 0;
    for (const p of candlePatterns.h4) {
      if (p.type === 'BULLISH' && bullPts < 10) { bullPts += 5; }
      if (p.type === 'BEARISH' && bearPts > -10) { bearPts -= 5; }
    }
    if (bullPts > 0) { score += bullPts; factors.push({ label: '4H Bullish Candle Pattern', value: candlePatterns.h4.filter(p => p.type === 'BULLISH').map(p => p.name).join(', '), points: bullPts }); }
    if (bearPts < 0) { score += bearPts; factors.push({ label: '4H Bearish Candle Pattern', value: candlePatterns.h4.filter(p => p.type === 'BEARISH').map(p => p.name).join(', '), points: bearPts }); }
  }

  // Candlestick patterns — Daily
  if (candlePatterns.daily && candlePatterns.daily.length) {
    let bullPts = 0, bearPts = 0;
    for (const p of candlePatterns.daily) {
      if (p.type === 'BULLISH' && bullPts < 8)  { bullPts += 4; }
      if (p.type === 'BEARISH' && bearPts > -8)  { bearPts -= 4; }
    }
    if (bullPts > 0) { score += bullPts; factors.push({ label: 'Daily Bullish Candle Pattern', value: candlePatterns.daily.filter(p => p.type === 'BULLISH').map(p => p.name).join(', '), points: bullPts }); }
    if (bearPts < 0) { score += bearPts; factors.push({ label: 'Daily Bearish Candle Pattern', value: candlePatterns.daily.filter(p => p.type === 'BEARISH').map(p => p.name).join(', '), points: bearPts }); }
  }

  score = Math.max(-100, Math.min(100, score));

  const recommendation = score >= 60  ? 'STRONG BUY'
                       : score >= 25  ? 'BUY'
                       : score > -25  ? 'NEUTRAL'
                       : score > -60  ? 'SELL'
                       : 'STRONG SELL';

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

  const currentPrice = (h4Data && h4Data.length) ? h4Data[h4Data.length - 1].rate : null;

  const confidence = currentPrice != null
    ? calcConfidenceScore(biases, zones, hsPatterns, candlePatterns, currentPrice, pipSize)
    : null;

  return { biases, zones, hsPatterns, candlePatterns, confidence, pipSize, currentPrice };
}

window.runFullAnalysis = runFullAnalysis;
