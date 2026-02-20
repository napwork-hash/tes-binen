const SYMBOLS = ["XAU", "BTC", "ETH", "PEPE"];
const INTERVAL_MS = Number(process.env.FETCH_INTERVAL_MS || 1000);
const REQUEST_TIMEOUT_MS = 8000;
const API_BASE_URL = "https://fapi.coinglass.com/api/coin/v2/info?symbol=";
const PING_URL = "https://fapi.coinglass.com";
const MAX_TICKS = 1000;
const SIGNAL_AGG_SECONDS = Math.max(1, Number(process.env.SIGNAL_AGG_SECONDS || 5));
const SIM_MARGIN_USD = Number(process.env.SIM_MARGIN_USD || 10);
const SIM_LEVERAGE = Number(process.env.SIM_LEVERAGE || 40);

// Pre-computed constants for EMA calculation
const EMA20_ALPHA = 2 / 21;
const EMA100_ALPHA = 2 / 101;
const VOL_LOOKBACK = 120;

const SYMBOL_PROFILE = {
  XAU: {
    entryScore: 2.4,
    strongScore: 2.9,
    sidewaysBand: 0.6,
    costPctRoundTrip: 0.03,
    minMoveCostMultiple: 3.5,
    longHorizonScore: 1.0,
    volMin: 0.00002,
    volMax: 0.0008,
    cooldownTicks: 120,
  },
  BTC: {
    entryScore: 1.35,
    strongScore: 2.6,
    sidewaysBand: 0.45,
    costPctRoundTrip: 0.06,
    minMoveCostMultiple: 3.2,
    longHorizonScore: 1.5,
    volMin: 0.00003,
    volMax: 0.0018,
    cooldownTicks: 90,
  },
  ETH: {
    entryScore: 1.45,
    strongScore: 2.7,
    sidewaysBand: 0.45,
    costPctRoundTrip: 0.08,
    minMoveCostMultiple: 3.4,
    longHorizonScore: 1.5,
    volMin: 0.00004,
    volMax: 0.0024,
    cooldownTicks: 90,
  },
  PEPE: {
    entryScore: 1.7,
    strongScore: 2.9,
    sidewaysBand: 0.5,
    costPctRoundTrip: 0.14,
    minMoveCostMultiple: 4.0,
    longHorizonScore: 1.7,
    volMin: 0.00008,
    volMax: 0.0055,
    cooldownTicks: 110,
  },
};

const previousPrices = new Map();
// Circular buffer implementation for O(1) tick insertion
const tickCache = new Map();
const circularBufferIndices = new Map();
const symbolTickCounter = new Map();
// Incremental EMA tracking for performance
const emaCache = new Map();
const volCache = new Map();
const recommendationState = new Map();
const lastRecommendationOutcome = new Map();
const recommendationStats = new Map();
const cooldownUntilTick = new Map();
const simulationStats = new Map();
let simulationTotalPnlUsd = 0;
let isRunning = false;

function formatNumber(value, digits = 2) {
  if (typeof value !== "number" || Number.isNaN(value)) return "N/A";
  return value.toFixed(digits);
}

function priceDigitsFor(symbol) {
  if (symbol === "PEPE") return 10;
  return 2;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pctReturn(fromPrice, toPrice) {
  if (
    typeof fromPrice !== "number" ||
    typeof toPrice !== "number" ||
    Number.isNaN(fromPrice) ||
    Number.isNaN(toPrice) ||
    fromPrice === 0
  ) {
    return 0;
  }
  return (toPrice - fromPrice) / fromPrice;
}

function stdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function updateTickCache(symbol, price) {
  if (typeof price !== "number" || Number.isNaN(price)) return null;

  let buffer = tickCache.get(symbol);
  let writeIdx = circularBufferIndices.get(symbol) ?? 0;

  if (!buffer) {
    // Initialize circular buffer with MAX_TICKS capacity
    buffer = new Array(MAX_TICKS).fill(null);
    tickCache.set(symbol, buffer);
    writeIdx = 0;
    circularBufferIndices.set(symbol, writeIdx);
  }

  // O(1) insertion using circular buffer
  buffer[writeIdx] = { ts: Date.now(), price };
  writeIdx = (writeIdx + 1) % MAX_TICKS;
  circularBufferIndices.set(symbol, writeIdx);

  const currentTick = (symbolTickCounter.get(symbol) ?? 0) + 1;
  symbolTickCounter.set(symbol, currentTick);
  return { buffer, currentTick };
}

function getSignalSeries(rawSeries, writeIdx) {
  // Convert circular buffer to linear array for processing
  const len = rawSeries.length;
  const linearSeries = [];
  for (let i = 0; i < len; i++) {
    const idx = (writeIdx + i) % len;
    const point = rawSeries[idx];
    if (point) linearSeries.push(point);
  }

  if (SIGNAL_AGG_SECONDS <= 1 || linearSeries.length <= 2) return linearSeries;

  const bucketMs = SIGNAL_AGG_SECONDS * 1000;
  const out = [];
  let currentBucket = -1;
  let lastPoint = null;

  for (const p of linearSeries) {
    const bucket = Math.floor(p.ts / bucketMs);
    if (bucket !== currentBucket) {
      if (lastPoint) out.push(lastPoint);
      currentBucket = bucket;
    }
    lastPoint = p;
  }
  if (lastPoint) out.push(lastPoint);
  return out;
}

function normalizedMove(series, lookback, vol, currentPrice) {
  const idx = series.length - 1 - lookback;
  if (idx < 0) return 0;
  const raw = pctReturn(series[idx].price, currentPrice);
  const denom = Math.max(vol * Math.sqrt(lookback), 1e-6);
  return raw / denom;
}

function analyzeMarket(symbol, series, currentPrice, change24h) {
  const profile = SYMBOL_PROFILE[symbol] ?? SYMBOL_PROFILE.BTC;
  if (series.length < 30 || typeof currentPrice !== "number") {
    const fallbackCategory = typeof change24h === "number" && change24h >= 0 ? "bull" : "bear";
    return { category: fallbackCategory, score: 0, vol: 0, absScore: 0 };
  }

  const returnWindow = Math.min(VOL_LOOKBACK, series.length - 1);
  const returns = [];
  for (let i = series.length - returnWindow; i < series.length; i += 1) {
    const prev = series[i - 1]?.price;
    const cur = series[i]?.price;
    returns.push(pctReturn(prev, cur));
  }

  // Cache volatility for reuse across symbols
  let vol = volCache.get(symbol);
  if (!vol || returns.length < 30) {
    vol = stdDev(returns);
    if (returns.length >= 30) volCache.set(symbol, vol);
  }

  const z10 = normalizedMove(series, 10, vol, currentPrice);
  const z60 = normalizedMove(series, 60, vol, currentPrice);
  const z300 = normalizedMove(series, 300, vol, currentPrice);

  // Incremental EMA calculation for performance
  let emaState = emaCache.get(symbol);
  if (!emaState || series.length < 100) {
    // Fallback to simple average for insufficient data
    const ema20 = series.slice(-20).reduce((a, b) => a + b.price, 0) / Math.min(20, series.length);
    const ema100 = series.slice(-100).reduce((a, b) => a + b.price, 0) / Math.min(100, series.length);
    if (series.length >= 100) {
      emaCache.set(symbol, { ema20, ema100, lastPrice: currentPrice });
    }
  } else {
    // Incremental EMA update: EMA_new = EMA_old + alpha * (price - EMA_old)
    const alpha20 = EMA20_ALPHA;
    const alpha100 = EMA100_ALPHA;
    emaState.ema20 += alpha20 * (currentPrice - emaState.ema20);
    emaState.ema100 += alpha100 * (currentPrice - emaState.ema100);
    emaState.lastPrice = currentPrice;
  }

  const ema20 = emaState?.ema20 ?? series.slice(-20).reduce((a, b) => a + b.price, 0) / Math.min(20, series.length);
  const ema100 = emaState?.ema100 ?? series.slice(-100).reduce((a, b) => a + b.price, 0) / Math.min(100, series.length);
  const trend = pctReturn(ema100, ema20);
  const trendZ = trend / Math.max(vol * Math.sqrt(40), 1e-6);
  const dailyBias = typeof change24h === "number" ? change24h / 100 : 0;

  const score = z10 * 0.35 + z60 * 0.3 + z300 * 0.2 + trendZ * 0.25 + dailyBias * 0.1;
  const absScore = Math.abs(score);

  let category = "bear";
  if (score >= profile.strongScore) category = "strong bull";
  else if (score <= -profile.strongScore) category = "strong bear";
  else if (absScore < profile.sidewaysBand) category = "sideways";
  else if (score > 0) category = "bull";

  const trendDirection = ema20 > ema100 ? "up" : "down";
  return { category, score, vol, absScore, trendDirection, z10, z60, z300, dailyBias };
}

function buildRecommendation(symbol, currentPrice, rawSeriesLength, analysis) {
  const profile = SYMBOL_PROFILE[symbol] ?? SYMBOL_PROFILE.BTC;
  if (rawSeriesLength < 100) {
    return {
      action: "no entry",
      horizon: 100,
      expectedMovePct: 0,
      targetPrice: currentPrice,
    };
  }

  const useLongHorizon = rawSeriesLength >= 300 && analysis.absScore >= profile.longHorizonScore;
  const horizon = useLongHorizon || analysis.vol < profile.volMin * 1.25 ? 300 : 100;

  let action = "hold";
  const momentumUp = analysis.z10 > 0 && analysis.z60 > 0 && analysis.z300 > 0;
  const momentumDown = analysis.z10 < 0 && analysis.z60 < 0 && analysis.z300 < 0;
  const biasUp = analysis.dailyBias >= 0.0015;
  const biasDown = analysis.dailyBias <= -0.0015;
  const fullyWarmed = rawSeriesLength >= 300;

  if (analysis.category === "strong bull" && momentumUp && biasUp && fullyWarmed) action = "long";
  else if (
    analysis.category === "bull" &&
    analysis.absScore >= profile.entryScore &&
    momentumUp &&
    biasUp &&
    fullyWarmed
  ) action = "long";
  else if (analysis.category === "strong bear" && momentumDown && biasDown && fullyWarmed) action = "short";
  else if (
    analysis.category === "bear" &&
    analysis.absScore >= profile.entryScore &&
    momentumDown &&
    biasDown &&
    fullyWarmed
  ) action = "short";
  else if (analysis.category === "sideways") action = analysis.absScore < profile.sidewaysBand * 0.55 ? "no entry" : "hold";

  const volPct = analysis.vol * 100;
  let expectedMovePct = clamp(volPct * Math.sqrt(horizon) * 1.1 + analysis.absScore * 0.12, 0.08, 8);

  if ((action === "long" || action === "short") && analysis.absScore < profile.entryScore) {
    action = "hold";
  }

  const minRequiredMovePct = profile.costPctRoundTrip * profile.minMoveCostMultiple;
  if ((action === "long" || action === "short") && expectedMovePct < minRequiredMovePct) {
    action = "no entry";
  }

  // Dynamic volatility band adjustment - more lenient in trending markets
  const dynamicVolMin = profile.volMin * (1 - Math.max(0, Math.min(0.2, (analysis.absScore - profile.entryScore) / 3)));
  const dynamicVolMax = profile.volMax * (1 + Math.max(0, Math.min(0.3, (analysis.absScore - profile.strongScore) / 2)));
  const outOfVolBand = analysis.vol < dynamicVolMin || analysis.vol > dynamicVolMax;
  if ((action === "long" || action === "short") && outOfVolBand) {
    action = "no entry";
  }

  if (action === "long" && analysis.trendDirection !== "up") action = "hold";
  if (action === "short" && analysis.trendDirection !== "down") action = "hold";

  if (action === "hold" || action === "no entry") {
    expectedMovePct = clamp(expectedMovePct, 0.05, 0.35);
  }

  const riskMovePct = clamp(expectedMovePct * 0.8, 0.05, 6);
  const rewardMovePct = clamp(expectedMovePct * 1.2, 0.08, 10);

  let targetPrice = currentPrice;
  let stopPrice = currentPrice;
  if (action === "long") {
    targetPrice = currentPrice * (1 + rewardMovePct / 100);
    stopPrice = currentPrice * (1 - riskMovePct / 100);
  }
  if (action === "short") {
    targetPrice = currentPrice * (1 - rewardMovePct / 100);
    stopPrice = currentPrice * (1 + riskMovePct / 100);
  }

  return { action, horizon, expectedMovePct, targetPrice, stopPrice, riskMovePct, rewardMovePct };
}

function evaluateRecommendation(rec, currentPrice) {
  if (rec.finalizedOutcome) return rec.finalizedOutcome;

  const realizedPct = pctReturn(rec.entryPrice, currentPrice) * 100;
  const profile = SYMBOL_PROFILE[rec.symbol] ?? SYMBOL_PROFILE.BTC;
  const netCost = profile.costPctRoundTrip;
  let valid = false;

  if (rec.action === "long") {
    const directional = realizedPct > 0;
    const targetHit = currentPrice >= rec.targetPrice;
    const stopHit = currentPrice <= rec.stopPrice;
    const netRealized = realizedPct - netCost;
    valid =
      (!stopHit &&
        (targetHit ||
      (directional &&
        netRealized >= Math.max(rec.expectedMovePct * 0.45, netCost * 1.1))));
  } else if (rec.action === "short") {
    const directional = realizedPct < 0;
    const targetHit = currentPrice <= rec.targetPrice;
    const stopHit = currentPrice >= rec.stopPrice;
    const netRealized = -realizedPct - netCost;
    valid =
      (!stopHit &&
        (targetHit ||
      (directional &&
        netRealized >= Math.max(rec.expectedMovePct * 0.45, netCost * 1.1))));
  } else if (rec.action === "hold") {
    valid = Math.abs(realizedPct) <= Math.max(0.25, rec.expectedMovePct * 1.2);
  } else {
    valid = Math.abs(realizedPct) <= 0.35;
  }

  const tag = valid ? "valid" : "invalid";
  const sign = realizedPct > 0 ? "+" : "";
  return { valid, realizedPct, text: `${tag} (${sign}${realizedPct.toFixed(3)}%)`, exit: "expiry" };
}

function updateSimulation(symbol, rec, realizedPct) {
  if (rec.action !== "long" && rec.action !== "short") return;
  const profile = SYMBOL_PROFILE[symbol] ?? SYMBOL_PROFILE.BTC;
  const signedReturnPct = rec.action === "long" ? realizedPct : -realizedPct;
  const netReturnPct = signedReturnPct - profile.costPctRoundTrip;
  const pnlUsd = SIM_MARGIN_USD * (SIM_LEVERAGE * netReturnPct) / 100;

  const stats = simulationStats.get(symbol) ?? { trades: 0, pnlUsd: 0 };
  stats.trades += 1;
  stats.pnlUsd += pnlUsd;
  simulationStats.set(symbol, stats);
  simulationTotalPnlUsd += pnlUsd;
}

function maybeFinalizeTradePath(rec, currentPrice) {
  if (!rec || rec.finalizedOutcome) return;
  if (rec.action !== "long" && rec.action !== "short") return;

  if (rec.action === "long") {
    if (currentPrice >= rec.targetPrice) {
      const realizedPct = pctReturn(rec.entryPrice, rec.targetPrice) * 100;
      rec.finalizedOutcome = {
        valid: true,
        realizedPct,
        text: `valid (+${realizedPct.toFixed(3)}%)`,
        exit: "tp",
      };
      return;
    }
    if (currentPrice <= rec.stopPrice) {
      const realizedPct = pctReturn(rec.entryPrice, rec.stopPrice) * 100;
      rec.finalizedOutcome = {
        valid: false,
        realizedPct,
        text: `invalid (${realizedPct.toFixed(3)}%)`,
        exit: "sl",
      };
    }
    return;
  }

  if (currentPrice <= rec.targetPrice) {
    const realizedPct = pctReturn(rec.entryPrice, rec.targetPrice) * 100;
    rec.finalizedOutcome = {
      valid: true,
      realizedPct,
      text: `valid (${realizedPct.toFixed(3)}%)`,
      exit: "tp",
    };
    return;
  }
  if (currentPrice >= rec.stopPrice) {
    const realizedPct = pctReturn(rec.entryPrice, rec.stopPrice) * 100;
    rec.finalizedOutcome = {
      valid: false,
      realizedPct,
      text: `invalid (+${realizedPct.toFixed(3)}%)`,
      exit: "sl",
    };
  }
}

function updateRecommendation(symbol, currentPrice, seriesLength, analysis, currentTick) {
  const state = recommendationState.get(symbol);
  const profile = SYMBOL_PROFILE[symbol] ?? SYMBOL_PROFILE.BTC;
  const cooldownTick = cooldownUntilTick.get(symbol) ?? 0;

  if (state) {
    maybeFinalizeTradePath(state, currentPrice);
  }

  if (state && currentTick <= state.expiresTick) {
    return {
      action: state.action,
      targetPrice: state.targetPrice,
      horizon: state.horizon,
      lockRemaining: state.expiresTick - currentTick + 1,
      validity: `pending | ${lastRecommendationOutcome.get(symbol) ?? "n/a"}`,
    };
  }

  if (state && currentTick > state.expiresTick) {
    const outcome = evaluateRecommendation(state, currentPrice);
    updateSimulation(symbol, state, outcome.realizedPct);
    lastRecommendationOutcome.set(symbol, outcome.text);
    const stats = recommendationStats.get(symbol) ?? {
      valid: 0,
      total: 0,
      directionalValid: 0,
      directionalTotal: 0,
      gainCount: 0,
      gainSumPct: 0,
      lossCount: 0,
      lossSumPct: 0,
    };
    stats.total += 1;
    if (outcome.valid) stats.valid += 1;
    if (state.action === "long" || state.action === "short") {
      stats.directionalTotal += 1;
      if (outcome.valid) stats.directionalValid += 1;
    }
    if (outcome.realizedPct > 0) {
      stats.gainCount += 1;
      stats.gainSumPct += outcome.realizedPct;
    } else if (outcome.realizedPct < 0) {
      stats.lossCount += 1;
      stats.lossSumPct += outcome.realizedPct;
    }
    recommendationStats.set(symbol, stats);

    if (!outcome.valid && (state.action === "long" || state.action === "short")) {
      cooldownUntilTick.set(symbol, currentTick + profile.cooldownTicks);
    }
  }

  const next = buildRecommendation(symbol, currentPrice, seriesLength, analysis);
  if (
    currentTick <= cooldownTick &&
    (next.action === "long" || next.action === "short")
  ) {
    next.action = "no entry";
  }

  const newState = {
    symbol,
    action: next.action,
    horizon: next.horizon,
    entryPrice: currentPrice,
    targetPrice: next.targetPrice,
    stopPrice: next.stopPrice,
    expectedMovePct: next.expectedMovePct,
    createdTick: currentTick,
    expiresTick: currentTick + next.horizon,
    finalizedOutcome: null,
  };
  recommendationState.set(symbol, newState);

  return {
    action: newState.action,
    targetPrice: newState.targetPrice,
    horizon: newState.horizon,
    lockRemaining: newState.expiresTick - currentTick + 1,
    validity: `pending | ${lastRecommendationOutcome.get(symbol) ?? "n/a"}`,
  };
}

async function fetchSymbol(symbol) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${API_BASE_URL}${encodeURIComponent(symbol)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    const data = json?.data ?? {};
    const currentPrice = typeof data.price === "number" ? data.price : null;
    const previousPrice = previousPrices.get(symbol) ?? null;
    const change24h =
      typeof data.priceChangePercent24h === "number" ? data.priceChangePercent24h : null;

    let tickChangeText = "N/A";
    if (currentPrice !== null && previousPrice !== null && previousPrice !== 0) {
      const tickPercent = ((currentPrice - previousPrice) / previousPrice) * 100;
      const sign = tickPercent > 0 ? "+" : "";
      tickChangeText = `${sign}${formatNumber(tickPercent, 4)}%`;
    }

    const cacheInfo = updateTickCache(symbol, currentPrice);
    const buffer = cacheInfo?.buffer ?? (tickCache.get(symbol) ?? []);
    const writeIdx = circularBufferIndices.get(symbol) ?? 0;
    const currentTick = cacheInfo?.currentTick ?? (symbolTickCounter.get(symbol) ?? 0);

    // Count non-null elements in circular buffer for cache size
    const cacheSize = buffer.filter(p => p !== null).length;
    const signalSeries = getSignalSeries(buffer, writeIdx);

    previousPrices.set(symbol, currentPrice);

    const analysis = analyzeMarket(symbol, signalSeries, currentPrice, change24h);
    const reco = updateRecommendation(symbol, currentPrice, cacheSize, analysis, currentTick);

    return {
      symbol,
      price: formatNumber(currentPrice, priceDigitsFor(symbol)),
      prev: formatNumber(previousPrice, priceDigitsFor(symbol)),
      tick: tickChangeText,
      change24h: `${formatNumber(change24h, 4)}%`,
      category: analysis.category,
      recommendation: reco.action,
      target: formatNumber(reco.targetPrice, priceDigitsFor(symbol)),
      lock: `${reco.lockRemaining}/${reco.horizon}`,
      validity: reco.validity,
      cacheSize: cacheSize,
      error: null,
    };
  } catch (err) {
    const message = err?.name === "AbortError" ? "Request timeout" : err.message;
    const state = recommendationState.get(symbol);

    return {
      symbol,
      price: "N/A",
      prev: "N/A",
      tick: "N/A",
      change24h: "N/A",
      category: "bear",
      recommendation: state?.action ?? "no entry",
      target: state ? formatNumber(state.targetPrice, priceDigitsFor(symbol)) : "N/A",
      lock: state ? `locked` : "N/A",
      validity: state ? `pending | ${lastRecommendationOutcome.get(symbol) ?? "n/a"}` : "n/a",
      cacheSize: (tickCache.get(symbol) ?? []).filter(p => p !== null).length,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function pingCoinglass() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    await fetch(PING_URL, {
      method: "GET",
      headers: { Accept: "text/html" },
      signal: controller.signal,
    });
    return { value: `${Date.now() - startedAt}ms`, error: null };
  } catch (err) {
    const message = err?.name === "AbortError" ? "timeout" : "failed";
    return { value: "N/A", error: message };
  } finally {
    clearTimeout(timeout);
  }
}

function render(results, ping) {
  console.clear();
  console.log(`Live Prices (${INTERVAL_MS}ms) - press Ctrl+C to stop\n`);
  const pingText = ping.error ? `${ping.value} (${ping.error})` : ping.value;
  console.log(
    `Ping to Coinglass: ${pingText} | Cache limit per symbol: ${MAX_TICKS} | Signal agg: ${SIGNAL_AGG_SECONDS}s\n`,
  );
  console.log(
    "SYMBOL | PRICE         | PREV          | TICK      | 24H       | CATEGORY    | RECO     | TARGET        | LOCK      | VALID",
  );
  console.log(
    "-------------------------------------------------------------------------------------------------------------------------",
  );

  for (const r of results) {
    if (r.error) {
      console.log(`${r.symbol.padEnd(6)} | ERROR: ${r.error} | RECO=${r.recommendation} | VALID=${r.validity}`);
      continue;
    }

    const line =
      `${r.symbol.padEnd(6)} | ` +
      `${String(r.price).padEnd(13)} | ` +
      `${String(r.prev).padEnd(13)} | ` +
      `${String(r.tick).padEnd(9)} | ` +
      `${String(r.change24h).padEnd(9)} | ` +
      `${String(r.category).padEnd(11)} | ` +
      `${String(r.recommendation).padEnd(8)} | ` +
      `${String(r.target).padEnd(13)} | ` +
      `${String(r.lock).padEnd(9)} | ` +
      `${r.validity}`;
    console.log(line);
  }

  console.log("\nPrediction Validity Summary");
  console.log("---------------------------");
  for (const symbol of SYMBOLS) {
    const stats = recommendationStats.get(symbol) ?? {
      valid: 0,
      total: 0,
      directionalValid: 0,
      directionalTotal: 0,
      gainCount: 0,
      gainSumPct: 0,
      lossCount: 0,
      lossSumPct: 0,
    };
    const avgGain = stats.gainCount > 0 ? stats.gainSumPct / stats.gainCount : 0;
    const avgLoss = stats.lossCount > 0 ? stats.lossSumPct / stats.lossCount : 0;
    const dirRate =
      stats.directionalTotal > 0 ? (stats.directionalValid / stats.directionalTotal) * 100 : 0;
    const sim = simulationStats.get(symbol) ?? { trades: 0, pnlUsd: 0 };
    console.log(
      `${symbol} prediction valid ${stats.valid} / ${stats.total} | ` +
        `dir ${stats.directionalValid}/${stats.directionalTotal} (${dirRate.toFixed(1)}%) | ` +
        `avg gain ${avgGain >= 0 ? "+" : ""}${avgGain.toFixed(3)}% | ` +
        `avg loss ${avgLoss.toFixed(3)}% | ` +
        `sim pnl $${sim.pnlUsd.toFixed(2)} (${sim.trades} trades @ $${SIM_MARGIN_USD} x${SIM_LEVERAGE})`,
    );
  }
  console.log(`TOTAL simulated PnL: $${simulationTotalPnlUsd.toFixed(2)}`);
}

async function tick() {
  if (isRunning) return;
  try {
    isRunning = true;
    const [results, ping] = await Promise.all([
      Promise.all(SYMBOLS.map((symbol) => fetchSymbol(symbol))),
      pingCoinglass(),
    ]);
    render(results, ping);
  } finally {
    isRunning = false;
  }
}

void tick();
const timer = setInterval(tick, INTERVAL_MS);

process.on("SIGINT", () => {
  clearInterval(timer);
  process.stdout.write("\nStopped.\n");
  process.exit(0);
});
