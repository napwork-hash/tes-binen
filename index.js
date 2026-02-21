/* eslint-disable no-console */

// =========================================================
// Binance Futures Multi-Stream Kline Monitor + Recommendation + Futures Bot
// Refactor: cleaner structure + safer runtime + optional file logging
// =========================================================

'use strict'

// =========================
// Node deps (optional)
// =========================
let fs = null
let path = null
try {
  // eslint-disable-next-line global-require
  fs = require('fs')
  // eslint-disable-next-line global-require
  path = require('path')
} catch {
  // Running in non-Node environment
}

// =========================
// Config
// =========================
const SYMBOL_STREAMS = {
  XAU: 'paxgusdt',
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  MYX: 'myxusdt',
}
const SYMBOLS = Object.keys(SYMBOL_STREAMS)

const INTERVAL_MS = Number(process.env.FETCH_INTERVAL_MS || 1000)
const KLINE_INTERVAL = process.env.BINANCE_KLINE_INTERVAL || '1m'

// Binance Futures WebSocket (not Spot)
const BINANCE_WS_URL = `wss://fstream.binance.com/stream?streams=` + SYMBOLS.map((symbol) => `${SYMBOL_STREAMS[symbol]}@kline_${KLINE_INTERVAL}`).join('/')

const MAX_TICKS = 1000
const SIGNAL_AGG_SECONDS = Math.max(1, Number(process.env.SIGNAL_AGG_SECONDS || 5))

// Recommendation simulation
const SIM_MARGIN_USD = Number(process.env.SIM_MARGIN_USD || 10)
const BASE_SIM_LEVERAGE = Number(process.env.SIM_LEVERAGE || 40)

// Futures bot (sim)
// Safe number parser for env vars (avoids NaN)
function numEnv(key, def) {
  const v = Number(process.env[key])
  return Number.isFinite(v) ? v : def
}

// Futures Bot Configuration (fixed + safer)
const FUTURES_BOT_CONFIG = {
  marginUsd: numEnv('FUTURES_MARGIN_USD', 3),

  // NOTE: TP/SL are PRICE % moves (not ROI)
  takeProfitPct: numEnv('FUTURES_TP_PCT', 30),
  stopLossPct: numEnv('FUTURES_SL_PCT', 15),

  minEntryScore: numEnv('FUTURES_MIN_ENTRY_SCORE', 0.5),
  minWarmupTicks: numEnv('FUTURES_MIN_WARMUP_TICKS', 20),

  // Prevent instant flip-flops / noisy exits
  minHoldTicks: numEnv('FUTURES_MIN_HOLD_TICKS', 5),

  // Cooldowns after closing trades (in ticks)
  cooldownAfterAnyCloseTicks: numEnv('FUTURES_COOLDOWN_AFTER_ANY_CLOSE_TICKS', 3),
  cooldownAfterLossTicks: numEnv('FUTURES_COOLDOWN_AFTER_LOSS_TICKS', 25),

  // Per-symbol hard-cut cooldowns (fixed structure)
  cooldownAfterHardCutTicks: {
    MYX: numEnv('FUTURES_COOLDOWN_HARDCUT_MYX', 120),
    BTC: numEnv('FUTURES_COOLDOWN_HARDCUT_BTC', 30),
    ETH: numEnv('FUTURES_COOLDOWN_HARDCUT_ETH', 30),
    XAU: numEnv('FUTURES_COOLDOWN_HARDCUT_XAU', 30),
  },

  // Trailing stop (ROI-based)
  trailing: {
    enable: (process.env.FUTURES_TRAILING_ENABLE ?? '1') !== '0',
    activateRoiPct: numEnv('FUTURES_TRAILING_ACTIVATE_ROI_PCT', 15),
    drawdownRoiPct: numEnv('FUTURES_TRAILING_DD_ROI_PCT', 3),
  },

  // Hard cut loss (ROI-based)
  hardCutLossRoiPct: numEnv('FUTURES_HARD_CUT_LOSS_ROI_PCT', 12),

  // Algo/tick-based cut loss
  algoCut: {
    enable: (process.env.FUTURES_ALGO_CUT_ENABLE ?? '1') !== '0',
    adverseTicks: numEnv('FUTURES_ALGO_CUT_ADVERSE_TICKS', 25),
    minAbsScore: numEnv('FUTURES_ALGO_CUT_MIN_ABS_SCORE', 0.2),
  },
}

const DAY_MS = 24 * 60 * 60 * 1000

// WebSocket reconnect / health
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 15000
const WS_STALE_TIMEOUT_MS = Number(process.env.WS_STALE_TIMEOUT_MS || 45_000)
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 15_000)

// EMA + vol
const EMA20_ALPHA = 2 / 21
const EMA100_ALPHA = 2 / 101
const VOL_LOOKBACK = 120

// Console
const DISABLE_CONSOLE_CLEAR = (process.env.DISABLE_CONSOLE_CLEAR ?? '0') === '1'

// Futures trade logging
const FUTURES_LOG_ENABLE = (process.env.FUTURES_LOG_ENABLE ?? '1') !== '0'
const FUTURES_LOG_DIR = process.env.FUTURES_LOG_DIR || './logs'
const FUTURES_LOG_FILE = process.env.FUTURES_LOG_FILE || 'futures_trades.txt'
const FUTURES_TRADES_LOG = fs && path ? path.join(FUTURES_LOG_DIR, FUTURES_LOG_FILE) : null

// =========================
// Symbol Profile
// costPctRoundTrip is PERCENT (0.06 means 0.06%)
// =========================
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
    maxLeverage: 80,
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
    maxLeverage: 60,
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
    maxLeverage: 50,
  },
  MYX: {
    entryScore: 1.7,
    strongScore: 2.9,
    sidewaysBand: 0.5,
    costPctRoundTrip: 0.14,
    minMoveCostMultiple: 4.0,
    longHorizonScore: 1.7,
    volMin: 0.00008,
    volMax: 0.0055,
    cooldownTicks: 110,
    maxLeverage: 30,
  },
}

// =========================
// State
// =========================
const previousPrices = new Map() // symbol -> last price

// Tick cache (circular buffer)
const tickCache = new Map() // symbol -> Array(MAX_TICKS)
const circularBufferIndices = new Map() // symbol -> writeIdx
const symbolTickCounter = new Map() // symbol -> total ticks

// Analytics caches
const emaCache = new Map() // symbol -> { ema20, ema100 }
const volCache = new Map() // symbol -> smoothedVol

// Recommendation state
const recommendationState = new Map()
const lastRecommendationOutcome = new Map()
const recommendationStats = new Map()
const cooldownUntilTick = new Map()

// Simulation stats
const simulationStats = new Map()
let simulationTotalPnlUsd = 0

// Latest UI rows
const latestSymbolRows = new Map()

// 24h baseline from closed klines
const closedKlineHistory = new Map() // symbol -> [{ts, close}]

// Stream -> symbol lookup
const streamSymbolLookup = new Map(Object.entries(SYMBOL_STREAMS).map(([symbol, stream]) => [stream, symbol]))

// Futures bot state
const futuresBotState = {
  activeTrades: new Map(),
  tradeHistory: new Map(),
  stats: new Map(),
}

// Futures bot cooldown gate (prevents rapid re-entry after losses)
const futuresCooldownUntilTick = new Map()

// WebSocket state
let ws = null
let wsConnected = false
let wsLastMessageAt = 0
let wsLastError = null
let reconnectTimer = null
let reconnectAttempt = 0
let pingTimer = null

let isRendering = false

let WebSocketImpl = globalThis.WebSocket
if (typeof WebSocketImpl !== 'function') {
  try {
    // eslint-disable-next-line global-require
    WebSocketImpl = require('ws')
  } catch {
    WebSocketImpl = null
  }
}

const WS_STATE_CONNECTING = 0
const WS_STATE_OPEN = 1

// =========================
// Helpers
// =========================
function getProfile(symbol) {
  return SYMBOL_PROFILE[symbol] ?? SYMBOL_PROFILE.BTC
}

function formatNumber(value, digits = 2) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'N/A'
  return value.toFixed(digits)
}

function priceDigitsFor(symbol) {
  return symbol === 'MYX' ? 10 : 2
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function pctReturn(fromPrice, toPrice) {
  if (typeof fromPrice !== 'number' || typeof toPrice !== 'number' || Number.isNaN(fromPrice) || Number.isNaN(toPrice) || fromPrice === 0) {
    return 0
  }
  return (toPrice - fromPrice) / fromPrice
}

function stdDev(values) {
  if (!Array.isArray(values) || values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((acc, x) => acc + (x - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function safeClearConsole() {
  if (!DISABLE_CONSOLE_CLEAR) console.clear()
}

// =========================
// Futures trade file logging
// =========================
function ensureDir(dir) {
  if (!fs) return
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // ignore
  }
}

function appendLineToFile(filepath, line) {
  if (!fs || !filepath) return
  try {
    fs.appendFileSync(filepath, line + '\n', 'utf8')
  } catch {
    // ignore
  }
}

function formatTradeLine(t) {
  const dt = new Date(t.exitTime || Date.now()).toISOString()
  const sign = t.netPnl >= 0 ? '+' : ''
  const roi = t.marginUsd ? (t.netPnl / t.marginUsd) * 100 : 0
  const exitFee = typeof t.exitFee === 'number' ? t.exitFee : 0
  const entryFee = typeof t.fee === 'number' ? t.fee : 0
  const totalFees = typeof t.totalFees === 'number' ? t.totalFees : entryFee + exitFee

  return [
    dt,
    t.symbol,
    t.side?.toUpperCase?.() ?? 'N/A',
    `reason=${t.exitReason}`,
    `entry=${Number(t.entryPrice).toFixed(priceDigitsFor(t.symbol))}`,
    `exit=${Number(t.exitPrice).toFixed(priceDigitsFor(t.symbol))}`,
    `lev=${t.leverage}x`,
    `margin=${Number(t.marginUsd).toFixed(2)}`,
    `pos=${Number(t.positionValueUsd).toFixed(2)}`,
    `netPnl=${sign}${Number(t.netPnl).toFixed(4)}`,
    `roi=${roi.toFixed(2)}%`,
    `fees=${Number(totalFees).toFixed(4)}`,
  ].join(' | ')
}

function logClosedTrade(trade) {
  if (!FUTURES_LOG_ENABLE) return
  if (!FUTURES_TRADES_LOG) return
  ensureDir(FUTURES_LOG_DIR)
  appendLineToFile(FUTURES_TRADES_LOG, formatTradeLine(trade))
}

// =========================
// Volatility & leverage
// =========================
function calculateDynamicLeverage(vol, symbol) {
  const profile = getProfile(symbol)
  const volRatio = profile.volMax > 0 ? vol / profile.volMax : 1

  let leverage
  if (volRatio < 0.3) leverage = BASE_SIM_LEVERAGE * 1.5
  else if (volRatio < 0.6) leverage = BASE_SIM_LEVERAGE
  else if (volRatio < 1.0) leverage = BASE_SIM_LEVERAGE * 0.7
  else leverage = BASE_SIM_LEVERAGE * 0.5

  return Math.max(5, Math.min(profile.maxLeverage ?? 125, Math.round(leverage)))
}

// =========================
// Futures bot
// =========================
function ensureFuturesBotSymbol(symbol) {
  if (futuresBotState.activeTrades.has(symbol)) return

  futuresBotState.activeTrades.set(symbol, null)
  futuresBotState.tradeHistory.set(symbol, [])
  futuresBotState.stats.set(symbol, {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnl: 0,
    feesPaid: 0,
    profitTrades: 0,
    lossTrades: 0,
  })
}

function getActiveTrade(symbol) {
  return futuresBotState.activeTrades.get(symbol) ?? null
}

function shouldEnterPosition(analysis, currentTick, symbol) {
  if (currentTick < FUTURES_BOT_CONFIG.minWarmupTicks) return null
  if (analysis.absScore < FUTURES_BOT_CONFIG.minEntryScore) return null

  // extra filter for MYX
  if (symbol === 'MYX') {
    if (analysis.category === 'sideways') return null
    if (analysis.trendDirection === 'up' && analysis.score > 0.4) return 'long'
    if (analysis.trendDirection === 'down' && analysis.score < -0.4) return 'short'
    return null
  }

  // existing behavior for others
  if (analysis.trendDirection === 'up') return 'long'
  if (analysis.trendDirection === 'down') return 'short'
  if (analysis.score > 0.3) return 'long'
  if (analysis.score < -0.3) return 'short'
  return 'long'
}

function openPosition(symbol, currentPrice, side, analysis, currentTick) {
  const profile = getProfile(symbol)
  const dynamicLeverage = calculateDynamicLeverage(analysis.vol, symbol)

  const marginUsd = FUTURES_BOT_CONFIG.marginUsd
  const positionValueUsd = marginUsd * dynamicLeverage
  const positionSize = positionValueUsd / currentPrice

  // costPctRoundTrip is TOTAL round-trip cost in percent (e.g. 0.06 means 0.06% for entry+exit)
  const fee = (positionValueUsd * profile.costPctRoundTrip) / 100

  let targetPrice
  let stopPrice
  if (side === 'long') {
    targetPrice = currentPrice * (1 + FUTURES_BOT_CONFIG.takeProfitPct / 100)
    stopPrice = currentPrice * (1 - FUTURES_BOT_CONFIG.stopLossPct / 100)
  } else {
    targetPrice = currentPrice * (1 - FUTURES_BOT_CONFIG.takeProfitPct / 100)
    stopPrice = currentPrice * (1 + FUTURES_BOT_CONFIG.stopLossPct / 100)
  }

  const trade = {
    symbol,
    side,
    entryPrice: currentPrice,
    entryTime: Date.now(),
    entryTick: currentTick,
    positionSize,
    positionValueUsd,
    marginUsd,
    targetPrice,
    stopPrice,
    leverage: dynamicLeverage,
    fee,

    // trailing / algo tracking
    peakRoiPct: 0,
    trailingActive: false,
    adverseTickCount: 0,
  }

  futuresBotState.activeTrades.set(symbol, trade)
  return trade
}

function closePosition(symbol, trade, currentPrice, exitReason) {
  const profile = getProfile(symbol)
  const stats = futuresBotState.stats.get(symbol)

  let pnl
  if (trade.side === 'long') pnl = trade.positionSize * (currentPrice - trade.entryPrice)
  else pnl = trade.positionSize * (trade.entryPrice - currentPrice)

  const totalFees = typeof trade.fee === 'number' ? trade.fee : 0
  const netPnl = pnl - totalFees

  const isWin = netPnl > 0

  stats.totalTrades += 1
  if (isWin) {
    stats.wins += 1
    stats.profitTrades = (stats.profitTrades || 0) + 1
  } else {
    stats.losses += 1
    stats.lossTrades = (stats.lossTrades || 0) + 1
  }
  stats.realizedPnl += netPnl
  stats.feesPaid += totalFees

  const completedTrade = {
    ...trade,
    exitPrice: currentPrice,
    exitTime: Date.now(),
    exitReason,
    pnl,
    netPnl,
    isWin,
    totalFees,
    exitFee: 0,
  }

  const history = futuresBotState.tradeHistory.get(symbol) ?? []
  history.push(completedTrade)
  if (history.length > 50) history.shift()
  futuresBotState.tradeHistory.set(symbol, history)

  futuresBotState.activeTrades.set(symbol, null)

  // file log
  logClosedTrade(completedTrade)

  return completedTrade
}

function updateFuturesBot(symbol, currentPrice, analysis, currentTick) {
  ensureFuturesBotSymbol(symbol)
  const activeTrade = getActiveTrade(symbol)

  const coolUntil = futuresCooldownUntilTick.get(symbol) ?? 0

  // No active trade -> maybe enter
  if (!activeTrade) {
    if (currentTick < coolUntil) return null
    const side = shouldEnterPosition(analysis, currentTick)
    if (!side) return null

    const opened = openPosition(symbol, currentPrice, side, analysis, currentTick)
    return {
      ...opened,
      unrealizedPnl: 0,
      pctToTp: 0,
      roiPct: 0,
      isOpen: true,
    }
  }

  const isLong = activeTrade.side === 'long'

  const closeWithCooldown = (reason) => {
    const closed = closePosition(symbol, activeTrade, currentPrice, reason)
    if (!closed) return closed

    const anyCd = FUTURES_BOT_CONFIG.cooldownAfterAnyCloseTicks || 0
    const lossCd = FUTURES_BOT_CONFIG.cooldownAfterLossTicks || 0
    const hardCd = FUTURES_BOT_CONFIG.cooldownAfterHardCutTicks || 0

    let cd = anyCd
    if (!closed.isWin) cd = Math.max(cd, lossCd)
    if (reason === 'HARD_CUT') cd = Math.max(cd, hardCd)

    if (cd > 0) futuresCooldownUntilTick.set(symbol, currentTick + cd)
    return closed
  }

  // Fixed TP/SL crosses
  if (isLong) {
    if (currentPrice >= activeTrade.targetPrice) return closeWithCooldown('TP')
    if (currentPrice <= activeTrade.stopPrice) return closeWithCooldown('SL')
  } else {
    if (currentPrice <= activeTrade.targetPrice) return closeWithCooldown('TP')
    if (currentPrice >= activeTrade.stopPrice) return closeWithCooldown('SL')
  }

  // Unrealized PnL
  const unrealizedPnl = isLong ? activeTrade.positionSize * (currentPrice - activeTrade.entryPrice) : activeTrade.positionSize * (activeTrade.entryPrice - currentPrice)

  const netUnrealizedPnl = unrealizedPnl - (activeTrade.fee || 0)

  // ROI net of estimated round-trip costs if closed now
  const roiPct = (netUnrealizedPnl / activeTrade.marginUsd) * 100

  // Hard cut loss
  if (FUTURES_BOT_CONFIG.hardCutLossRoiPct && roiPct <= -FUTURES_BOT_CONFIG.hardCutLossRoiPct) {
    return closeWithCooldown('HARD_CUT')
  }

  // Algo/tick cut
  if (FUTURES_BOT_CONFIG.algoCut?.enable) {
    const againstTrend = (isLong && analysis.trendDirection === 'down') || (!isLong && analysis.trendDirection === 'up')

    const weakSignal = analysis.absScore < FUTURES_BOT_CONFIG.algoCut.minAbsScore

    if (againstTrend && weakSignal) {
      activeTrade.adverseTickCount = (activeTrade.adverseTickCount || 0) + 1
    } else {
      activeTrade.adverseTickCount = 0
    }

    if (activeTrade.adverseTickCount >= FUTURES_BOT_CONFIG.algoCut.adverseTicks) {
      const held = currentTick - (activeTrade.entryTick || currentTick)
      if (held >= (FUTURES_BOT_CONFIG.minHoldTicks || 0)) {
        return closeWithCooldown('ALGO_CUT')
      }
      // if too early, keep counting but don't close yet
    }
  }

  // Trailing ROI
  if (FUTURES_BOT_CONFIG.trailing?.enable) {
    activeTrade.peakRoiPct = Math.max(activeTrade.peakRoiPct || 0, roiPct)

    if (!activeTrade.trailingActive && roiPct >= FUTURES_BOT_CONFIG.trailing.activateRoiPct) {
      activeTrade.trailingActive = true
    }

    if (activeTrade.trailingActive) {
      const dd = (activeTrade.peakRoiPct || 0) - roiPct
      if (dd >= FUTURES_BOT_CONFIG.trailing.drawdownRoiPct) {
        return closeWithCooldown('TRAIL')
      }
    }
  }

  const pctToTp = isLong ? ((currentPrice - activeTrade.entryPrice) / (activeTrade.targetPrice - activeTrade.entryPrice)) * 100 : ((activeTrade.entryPrice - currentPrice) / (activeTrade.entryPrice - activeTrade.targetPrice)) * 100

  return {
    ...activeTrade,
    unrealizedPnl,
    roiPct,
    pctToTp,
    isOpen: true,
  }
}

// =========================
// Tick cache
// =========================
function updateTickCache(symbol, price) {
  if (typeof price !== 'number' || Number.isNaN(price)) return null

  let buffer = tickCache.get(symbol)
  let writeIdx = circularBufferIndices.get(symbol) ?? 0

  if (!buffer) {
    buffer = new Array(MAX_TICKS).fill(null)
    tickCache.set(symbol, buffer)
    writeIdx = 0
    circularBufferIndices.set(symbol, writeIdx)
  }

  buffer[writeIdx] = { ts: Date.now(), price }
  writeIdx = (writeIdx + 1) % MAX_TICKS
  circularBufferIndices.set(symbol, writeIdx)

  const currentTick = (symbolTickCounter.get(symbol) ?? 0) + 1
  symbolTickCounter.set(symbol, currentTick)

  return { buffer, currentTick }
}

function getSignalSeries(rawSeries, writeIdx) {
  const len = rawSeries.length
  const linearSeries = []

  for (let i = 0; i < len; i++) {
    const idx = (writeIdx + i) % len
    const point = rawSeries[idx]
    if (point) linearSeries.push(point)
  }

  if (SIGNAL_AGG_SECONDS <= 1 || linearSeries.length <= 2) return linearSeries

  const bucketMs = SIGNAL_AGG_SECONDS * 1000
  const out = []
  let currentBucket = -1
  let lastPoint = null

  for (const p of linearSeries) {
    const bucket = Math.floor(p.ts / bucketMs)
    if (bucket !== currentBucket) {
      if (lastPoint) out.push(lastPoint)
      currentBucket = bucket
    }
    lastPoint = p
  }
  if (lastPoint) out.push(lastPoint)

  return out
}

// =========================
// Market analysis
// =========================
function normalizedMove(series, lookback, vol, currentPrice) {
  const idx = series.length - 1 - lookback
  if (idx < 0) return 0
  const raw = pctReturn(series[idx].price, currentPrice)
  const denom = Math.max(vol * Math.sqrt(lookback), 1e-6)
  return raw / denom
}

function analyzeMarket(symbol, series, currentPrice, change24h) {
  const profile = getProfile(symbol)

  if (series.length < 30 || typeof currentPrice !== 'number') {
    const fallbackCategory = typeof change24h === 'number' && change24h >= 0 ? 'bull' : 'bear'
    return { category: fallbackCategory, score: 0, vol: 0, absScore: 0 }
  }

  const returnWindow = Math.min(VOL_LOOKBACK, series.length - 1)
  const returns = []

  for (let i = series.length - returnWindow; i < series.length; i += 1) {
    const prev = series[i - 1]?.price
    const cur = series[i]?.price
    if (typeof prev === 'number' && typeof cur === 'number') returns.push(pctReturn(prev, cur))
  }

  // Cache volatility for reuse across symbols
  let vol = volCache.get(symbol)
  if (!vol || returns.length < 30) {
    vol = stdDev(returns)
    if (returns.length >= 30) volCache.set(symbol, vol)
  }

  const z10 = normalizedMove(series, 10, vol, currentPrice)
  const z60 = normalizedMove(series, 60, vol, currentPrice)
  const z300 = normalizedMove(series, 300, vol, currentPrice)

  // EMA tracking (incremental)
  let emaState = emaCache.get(symbol)

  if (!emaState || series.length < 100) {
    const ema20 = series.slice(-20).reduce((a, b) => a + b.price, 0) / Math.min(20, series.length)
    const ema100 = series.slice(-100).reduce((a, b) => a + b.price, 0) / Math.min(100, series.length)
    if (series.length >= 100) {
      emaState = { ema20, ema100 }
      emaCache.set(symbol, emaState)
    }
  } else {
    emaState.ema20 += EMA20_ALPHA * (currentPrice - emaState.ema20)
    emaState.ema100 += EMA100_ALPHA * (currentPrice - emaState.ema100)
  }

  const ema20 = emaState?.ema20 ?? series.slice(-20).reduce((a, b) => a + b.price, 0) / Math.min(20, series.length)
  const ema100 = emaState?.ema100 ?? series.slice(-100).reduce((a, b) => a + b.price, 0) / Math.min(100, series.length)

  const trend = pctReturn(ema100, ema20)
  const trendZ = trend / Math.max(vol * Math.sqrt(40), 1e-6)
  const dailyBias = typeof change24h === 'number' ? change24h / 100 : 0

  const score = z10 * 0.35 + z60 * 0.3 + z300 * 0.2 + trendZ * 0.25 + dailyBias * 0.1
  const absScore = Math.abs(score)

  let category = 'bear'
  if (score >= profile.strongScore) category = 'strong bull'
  else if (score <= -profile.strongScore) category = 'strong bear'
  else if (absScore < profile.sidewaysBand) category = 'sideways'
  else if (score > 0) category = 'bull'

  const trendDirection = ema20 > ema100 ? 'up' : 'down'
  return { category, score, vol, absScore, trendDirection, z10, z60, z300, dailyBias }
}

// =========================
// Recommendation engine
// =========================
function buildRecommendation(symbol, currentPrice, rawSeriesLength, analysis) {
  const profile = getProfile(symbol)

  if (rawSeriesLength < 100) {
    return {
      action: 'no entry',
      horizon: 100,
      expectedMovePct: 0,
      targetPrice: currentPrice,
      stopPrice: currentPrice,
      riskMovePct: 0,
      rewardMovePct: 0,
    }
  }

  const useLongHorizon = rawSeriesLength >= 300 && analysis.absScore >= profile.longHorizonScore
  const horizon = useLongHorizon || analysis.vol < profile.volMin * 1.25 ? 300 : 100

  let action = 'hold'
  const momentumUp = analysis.z10 > 0 && analysis.z60 > 0 && analysis.z300 > 0
  const momentumDown = analysis.z10 < 0 && analysis.z60 < 0 && analysis.z300 < 0
  const biasUp = analysis.dailyBias >= 0.0015
  const biasDown = analysis.dailyBias <= -0.0015
  const fullyWarmed = rawSeriesLength >= 300

  if (analysis.category === 'strong bull' && momentumUp && biasUp && fullyWarmed) action = 'long'
  else if (analysis.category === 'bull' && analysis.absScore >= profile.entryScore && momentumUp && biasUp && fullyWarmed) action = 'long'
  else if (analysis.category === 'strong bear' && momentumDown && biasDown && fullyWarmed) action = 'short'
  else if (analysis.category === 'bear' && analysis.absScore >= profile.entryScore && momentumDown && biasDown && fullyWarmed) action = 'short'
  else if (analysis.category === 'sideways') action = analysis.absScore < profile.sidewaysBand * 0.55 ? 'no entry' : 'hold'

  const volPct = analysis.vol * 100
  let expectedMovePct = clamp(volPct * Math.sqrt(horizon) * 1.1 + analysis.absScore * 0.12, 0.08, 8)

  if ((action === 'long' || action === 'short') && analysis.absScore < profile.entryScore) action = 'hold'

  const minRequiredMovePct = profile.costPctRoundTrip * profile.minMoveCostMultiple
  if ((action === 'long' || action === 'short') && expectedMovePct < minRequiredMovePct) action = 'no entry'

  const dynamicVolMin = profile.volMin * (1 - Math.max(0, Math.min(0.2, (analysis.absScore - profile.entryScore) / 3)))
  const dynamicVolMax = profile.volMax * (1 + Math.max(0, Math.min(0.3, (analysis.absScore - profile.strongScore) / 2)))
  const outOfVolBand = analysis.vol < dynamicVolMin || analysis.vol > dynamicVolMax
  if ((action === 'long' || action === 'short') && outOfVolBand) action = 'no entry'

  if (action === 'long' && analysis.trendDirection !== 'up') action = 'hold'
  if (action === 'short' && analysis.trendDirection !== 'down') action = 'hold'

  if (action === 'hold' || action === 'no entry') expectedMovePct = clamp(expectedMovePct, 0.05, 0.35)

  const riskMovePct = clamp(expectedMovePct * 0.8, 0.05, 6)
  const rewardMovePct = clamp(expectedMovePct * 1.2, 0.08, 10)

  let targetPrice = currentPrice
  let stopPrice = currentPrice

  if (action === 'long') {
    targetPrice = currentPrice * (1 + rewardMovePct / 100)
    stopPrice = currentPrice * (1 - riskMovePct / 100)
  } else if (action === 'short') {
    targetPrice = currentPrice * (1 - rewardMovePct / 100)
    stopPrice = currentPrice * (1 + riskMovePct / 100)
  }

  return { action, horizon, expectedMovePct, targetPrice, stopPrice, riskMovePct, rewardMovePct }
}

function evaluateRecommendation(rec, currentPrice) {
  if (rec.finalizedOutcome) return rec.finalizedOutcome

  const realizedPct = pctReturn(rec.entryPrice, currentPrice) * 100
  const profile = getProfile(rec.symbol)
  const netCost = profile.costPctRoundTrip

  let valid = false

  if (rec.action === 'long') {
    const directional = realizedPct > 0
    const targetHit = currentPrice >= rec.targetPrice
    const stopHit = currentPrice <= rec.stopPrice
    const netRealized = realizedPct - netCost
    valid = !stopHit && (targetHit || (directional && netRealized >= Math.max(rec.expectedMovePct * 0.45, netCost * 1.1)))
  } else if (rec.action === 'short') {
    const directional = realizedPct < 0
    const targetHit = currentPrice <= rec.targetPrice
    const stopHit = currentPrice >= rec.stopPrice
    const netRealized = -realizedPct - netCost
    valid = !stopHit && (targetHit || (directional && netRealized >= Math.max(rec.expectedMovePct * 0.45, netCost * 1.1)))
  } else if (rec.action === 'hold') {
    valid = Math.abs(realizedPct) <= Math.max(0.25, rec.expectedMovePct * 1.2)
  } else {
    valid = Math.abs(realizedPct) <= 0.35
  }

  const tag = valid ? 'valid' : 'invalid'
  const sign = realizedPct > 0 ? '+' : ''
  return { valid, realizedPct, text: `${tag} (${sign}${realizedPct.toFixed(3)}%)`, exit: 'expiry' }
}

function updateSimulation(symbol, rec, realizedPct, volatility) {
  if (rec.action !== 'long' && rec.action !== 'short') return
  const profile = getProfile(symbol)

  const signedReturnPct = rec.action === 'long' ? realizedPct : -realizedPct
  const netReturnPct = signedReturnPct - profile.costPctRoundTrip

  const dynamicLeverage = volatility ? calculateDynamicLeverage(volatility, symbol) : BASE_SIM_LEVERAGE
  const pnlUsd = (SIM_MARGIN_USD * (dynamicLeverage * netReturnPct)) / 100

  const stats = simulationStats.get(symbol) ?? { trades: 0, pnlUsd: 0 }
  stats.trades += 1
  stats.pnlUsd += pnlUsd
  simulationStats.set(symbol, stats)
  simulationTotalPnlUsd += pnlUsd
}

function maybeFinalizeTradePath(rec, currentPrice) {
  if (!rec || rec.finalizedOutcome) return
  if (rec.action !== 'long' && rec.action !== 'short') return

  if (rec.action === 'long') {
    if (currentPrice >= rec.targetPrice) {
      const realizedPct = pctReturn(rec.entryPrice, rec.targetPrice) * 100
      rec.finalizedOutcome = { valid: true, realizedPct, text: `valid (+${realizedPct.toFixed(3)}%)`, exit: 'tp' }
      return
    }
    if (currentPrice <= rec.stopPrice) {
      const realizedPct = pctReturn(rec.entryPrice, rec.stopPrice) * 100
      rec.finalizedOutcome = { valid: false, realizedPct, text: `invalid (${realizedPct.toFixed(3)}%)`, exit: 'sl' }
    }
    return
  }

  // short
  if (currentPrice <= rec.targetPrice) {
    const realizedPct = pctReturn(rec.entryPrice, rec.targetPrice) * 100
    rec.finalizedOutcome = { valid: true, realizedPct, text: `valid (${realizedPct.toFixed(3)}%)`, exit: 'tp' }
    return
  }
  if (currentPrice >= rec.stopPrice) {
    const realizedPct = pctReturn(rec.entryPrice, rec.stopPrice) * 100
    rec.finalizedOutcome = { valid: false, realizedPct, text: `invalid (+${realizedPct.toFixed(3)}%)`, exit: 'sl' }
  }
}

function updateRecommendation(symbol, currentPrice, seriesLength, analysis, currentTick) {
  const profile = getProfile(symbol)
  const cooldownTick = cooldownUntilTick.get(symbol) ?? 0

  const state = recommendationState.get(symbol)
  if (state) maybeFinalizeTradePath(state, currentPrice)

  if (state && currentTick <= state.expiresTick) {
    const validityText = state.finalizedOutcome ? state.finalizedOutcome.text : `pending | ${lastRecommendationOutcome.get(symbol) ?? 'n/a'}`

    return {
      action: state.action,
      targetPrice: state.targetPrice,
      horizon: state.horizon,
      lockRemaining: state.expiresTick - currentTick + 1,
      validity: validityText,
    }
  }

  if (state && currentTick > state.expiresTick) {
    const outcome = evaluateRecommendation(state, currentPrice)
    updateSimulation(symbol, state, outcome.realizedPct, analysis.vol)
    lastRecommendationOutcome.set(symbol, outcome.text)

    const stats = recommendationStats.get(symbol) ?? {
      valid: 0,
      total: 0,
      directionalValid: 0,
      directionalTotal: 0,
      gainCount: 0,
      gainSumPct: 0,
      lossCount: 0,
      lossSumPct: 0,
    }

    stats.total += 1
    if (outcome.valid) stats.valid += 1

    if (state.action === 'long' || state.action === 'short') {
      stats.directionalTotal += 1
      if (outcome.valid) stats.directionalValid += 1
    }

    if (outcome.realizedPct > 0) {
      stats.gainCount += 1
      stats.gainSumPct += outcome.realizedPct
    } else if (outcome.realizedPct < 0) {
      stats.lossCount += 1
      stats.lossSumPct += outcome.realizedPct
    }

    recommendationStats.set(symbol, stats)

    if (!outcome.valid && (state.action === 'long' || state.action === 'short')) {
      cooldownUntilTick.set(symbol, currentTick + profile.cooldownTicks)
    }
  }

  const next = buildRecommendation(symbol, currentPrice, seriesLength, analysis)
  if (currentTick <= cooldownTick && (next.action === 'long' || next.action === 'short')) next.action = 'no entry'

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
  }
  recommendationState.set(symbol, newState)

  return {
    action: newState.action,
    targetPrice: newState.targetPrice,
    horizon: newState.horizon,
    lockRemaining: newState.expiresTick - currentTick + 1,
    validity: `pending | ${lastRecommendationOutcome.get(symbol) ?? 'n/a'}`,
  }
}

// =========================
// Error row builder
// =========================
function buildErrorResult(symbol, errorMessage) {
  const state = recommendationState.get(symbol)
  return {
    symbol,
    price: 'N/A',
    prev: 'N/A',
    tick: 'N/A',
    change24h: 'N/A',
    category: 'bear',
    recommendation: state?.action ?? 'no entry',
    target: state ? formatNumber(state.targetPrice, priceDigitsFor(symbol)) : 'N/A',
    lock: state ? 'locked' : 'N/A',
    validity: state ? (state.finalizedOutcome?.text ?? `pending | ${lastRecommendationOutcome.get(symbol) ?? 'n/a'}`) : 'n/a',
    cacheSize: Math.min(symbolTickCounter.get(symbol) ?? 0, MAX_TICKS),
    error: errorMessage,
    futuresBot: null,
  }
}

// =========================
// 24h change tracking
// =========================
function updateChange24h(symbol, candleCloseTime, currentPrice, candleOpenPrice, isClosed) {
  const history = closedKlineHistory.get(symbol) ?? []
  const closeTs = Number.isFinite(candleCloseTime) ? candleCloseTime : Date.now()

  if (isClosed) {
    const last = history[history.length - 1]
    if (!last || last.ts !== closeTs) history.push({ ts: closeTs, close: currentPrice })
  }

  const keepFrom = closeTs - DAY_MS - 60_000
  while (history.length > 0 && history[0].ts < keepFrom) history.shift()
  closedKlineHistory.set(symbol, history)

  const baselineTs = closeTs - DAY_MS
  for (const point of history) {
    if (point.ts >= baselineTs && point.close !== 0) {
      return ((currentPrice - point.close) / point.close) * 100
    }
  }

  if (typeof candleOpenPrice === 'number' && !Number.isNaN(candleOpenPrice) && candleOpenPrice !== 0) {
    return ((currentPrice - candleOpenPrice) / candleOpenPrice) * 100
  }

  return null
}

// =========================
// WS message normalization
// =========================
function normalizeKlineMessage(payload) {
  const data = payload?.data ?? payload
  if (data?.e !== 'kline' || !data.k) return null

  const stream = typeof payload?.stream === 'string' ? payload.stream.split('@')[0] : null
  const marketSymbol = typeof data.s === 'string' ? data.s.toLowerCase() : typeof stream === 'string' ? stream : null
  if (!marketSymbol) return null

  const symbol = streamSymbolLookup.get(marketSymbol)
  if (!symbol) return null

  const currentPrice = Number(data.k.c)
  if (Number.isNaN(currentPrice)) return null

  const candleOpenPrice = Number(data.k.o)
  const candleCloseTime = Number(data.k.T)

  return {
    symbol,
    currentPrice,
    candleOpenPrice: Number.isNaN(candleOpenPrice) ? null : candleOpenPrice,
    candleCloseTime: Number.isNaN(candleCloseTime) ? Date.now() : candleCloseTime,
    isClosed: Boolean(data.k.x),
  }
}

function handleKlineMessage(payload) {
  const normalized = normalizeKlineMessage(payload)
  if (!normalized) return

  const { symbol, currentPrice, candleOpenPrice, candleCloseTime, isClosed } = normalized
  const previousPrice = previousPrices.get(symbol) ?? null

  let tickChangeText = 'N/A'
  if (previousPrice !== null && previousPrice !== 0) {
    const tickPercent = ((currentPrice - previousPrice) / previousPrice) * 100
    const sign = tickPercent > 0 ? '+' : ''
    tickChangeText = `${sign}${formatNumber(tickPercent, 4)}%`
  }

  const change24h = updateChange24h(symbol, candleCloseTime, currentPrice, candleOpenPrice, isClosed)

  const cacheInfo = updateTickCache(symbol, currentPrice)
  const buffer = cacheInfo?.buffer ?? tickCache.get(symbol) ?? []
  const writeIdx = circularBufferIndices.get(symbol) ?? 0
  const currentTick = cacheInfo?.currentTick ?? symbolTickCounter.get(symbol) ?? 0
  const cacheSize = Math.min(currentTick, MAX_TICKS)

  const signalSeries = getSignalSeries(buffer, writeIdx)

  previousPrices.set(symbol, currentPrice)

  const analysis = analyzeMarket(symbol, signalSeries, currentPrice, change24h)
  const reco = updateRecommendation(symbol, currentPrice, cacheSize, analysis, currentTick)

  const futuresBot = updateFuturesBot(symbol, currentPrice, analysis, currentTick)

  latestSymbolRows.set(symbol, {
    symbol,
    price: formatNumber(currentPrice, priceDigitsFor(symbol)),
    prev: formatNumber(previousPrice, priceDigitsFor(symbol)),
    tick: tickChangeText,
    change24h: typeof change24h === 'number' ? `${formatNumber(change24h, 4)}%` : 'N/A',
    category: analysis.category,
    recommendation: reco.action,
    target: formatNumber(reco.targetPrice, priceDigitsFor(symbol)),
    lock: `${reco.lockRemaining}/${reco.horizon}`,
    validity: reco.validity,
    cacheSize,
    error: null,
    futuresBot,
  })
}

// =========================
// WebSocket plumbing
// =========================
function onSocketEvent(socket, eventName, handler) {
  if (typeof socket.addEventListener === 'function') return socket.addEventListener(eventName, handler)
  if (typeof socket.on === 'function') return socket.on(eventName, handler)
  return null
}

function parseSocketMessage(messageArg) {
  if (typeof messageArg === 'string') return messageArg
  if (Buffer.isBuffer(messageArg)) return messageArg.toString('utf8')

  const data = messageArg?.data
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.from(data).toString('utf8')

  return null
}

function parseSocketClose(codeOrEvent, reasonBuffer) {
  if (typeof codeOrEvent === 'number') {
    const reason = typeof reasonBuffer === 'string' ? reasonBuffer : Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf8') : ''
    return { code: codeOrEvent, reason }
  }

  return {
    code: typeof codeOrEvent?.code === 'number' ? codeOrEvent.code : 'n/a',
    reason: typeof codeOrEvent?.reason === 'string' ? codeOrEvent.reason : '',
  }
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }
}

function startPing() {
  stopPing()
  if (!ws) return
  if (typeof ws.ping !== 'function') return

  pingTimer = setInterval(() => {
    try {
      if (ws && ws.readyState === WS_STATE_OPEN) ws.ping()
    } catch {
      // ignore
    }
  }, WS_PING_INTERVAL_MS)
}

function scheduleReconnect() {
  if (reconnectTimer) return
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS)
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectBinanceWebSocket()
  }, delay)
}

function connectBinanceWebSocket() {
  if (typeof WebSocketImpl !== 'function') {
    wsLastError = 'WebSocket is unavailable (install `ws` package or use newer Node)'
    return
  }

  if (ws && (ws.readyState === WS_STATE_OPEN || ws.readyState === WS_STATE_CONNECTING)) return

  stopPing()

  ws = new WebSocketImpl(BINANCE_WS_URL)

  onSocketEvent(ws, 'open', () => {
    wsConnected = true
    wsLastError = null
    reconnectAttempt = 0
    startPing()
  })

  onSocketEvent(ws, 'message', (messageArg) => {
    wsLastMessageAt = Date.now()

    const raw = parseSocketMessage(messageArg)
    if (!raw) return

    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      wsLastError = 'Invalid websocket JSON payload'
      return
    }

    if (typeof payload?.code === 'number' && typeof payload?.msg === 'string') {
      const failedStream = payload.stream || payload.data?.stream || 'unknown'
      wsLastError = `Stream error ${payload.code}: ${payload.msg} (${failedStream})`
      console.error(`[WebSocket Error] ${wsLastError}`)
      return
    }

    handleKlineMessage(payload)
  })

  onSocketEvent(ws, 'error', () => {
    wsLastError = 'Websocket error'
  })

  onSocketEvent(ws, 'close', (codeOrEvent, reasonBuffer) => {
    wsConnected = false
    stopPing()

    const closeInfo = parseSocketClose(codeOrEvent, reasonBuffer)
    const reason = closeInfo.reason ? `: ${closeInfo.reason}` : ''
    wsLastError = `Closed (${closeInfo.code}${reason})`

    ws = null
    scheduleReconnect()
  })
}

function connectionStatusText() {
  const status = wsConnected ? 'connected' : 'disconnected'
  const age = wsLastMessageAt > 0 ? `${Date.now() - wsLastMessageAt}ms` : 'N/A'
  const errorText = wsLastError ? ` | last error: ${wsLastError}` : ''
  return `${status} | last msg: ${age}${errorText}`
}

function ensureWebsocketHealthy() {
  if (!wsConnected) return
  if (!wsLastMessageAt) return

  const age = Date.now() - wsLastMessageAt
  if (age > WS_STALE_TIMEOUT_MS) {
    wsLastError = `Stale feed (${age}ms > ${WS_STALE_TIMEOUT_MS}ms), reconnecting...`
    try {
      if (ws && (ws.readyState === WS_STATE_OPEN || ws.readyState === WS_STATE_CONNECTING)) {
        ws.close(4000, 'stale')
      }
    } catch {
      // ignore
    }
  }
}

// =========================
// Render helpers
// =========================
function formatTradeShort(t) {
  const sign = t.netPnl >= 0 ? '+' : ''
  const roi = t.marginUsd ? (t.netPnl / t.marginUsd) * 100 : 0
  return `${t.exitReason} | net ${sign}${t.netPnl.toFixed(2)} | roi ${roi.toFixed(1)}% | ${t.entryPrice.toFixed(2)} -> ${t.exitPrice.toFixed(2)}`
}

function printLastTrades(symbol, n = 3) {
  const history = futuresBotState.tradeHistory.get(symbol) ?? []
  const last = history.slice(-n)
  if (last.length === 0) return

  console.log(`  Last trades:`)
  for (const t of last) console.log(`   - ${formatTradeShort(t)}`)

  if (FUTURES_LOG_ENABLE && FUTURES_TRADES_LOG) {
    console.log(`  Log file: ${FUTURES_TRADES_LOG}`)
  }
}

// =========================
// Render
// =========================
function render(results) {
  safeClearConsole()

  console.log(`Live Binance Prices (${INTERVAL_MS}ms render) - press Ctrl+C to stop\n`)
  console.log(`Binance websocket ${KLINE_INTERVAL} kline: ${connectionStatusText()} | Cache limit per symbol: ${MAX_TICKS} | Signal agg: ${SIGNAL_AGG_SECONDS}s\n`)

  console.log('SYMBOL | PRICE         | PREV          | TICK      | 24H       | CATEGORY    | RECO     | TARGET        | LOCK      | VALID')
  console.log('-------------------------------------------------------------------------------------------------------------------------')

  for (const r of results) {
    if (r.error) {
      console.log(`${r.symbol.padEnd(6)} | ERROR: ${r.error} | RECO=${r.recommendation} | VALID=${r.validity}`)
      continue
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
      `${r.validity}`

    console.log(line)
  }

  console.log('\nPrediction Validity Summary')
  console.log('---------------------------')
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
    }

    const avgGain = stats.gainCount > 0 ? stats.gainSumPct / stats.gainCount : 0
    const avgLoss = stats.lossCount > 0 ? stats.lossSumPct / stats.lossCount : 0
    const dirRate = stats.directionalTotal > 0 ? (stats.directionalValid / stats.directionalTotal) * 100 : 0
    const sim = simulationStats.get(symbol) ?? { trades: 0, pnlUsd: 0 }

    console.log(
      `${symbol} prediction valid ${stats.valid} / ${stats.total} | ` +
        `dir ${stats.directionalValid}/${stats.directionalTotal} (${dirRate.toFixed(1)}%) | ` +
        `avg gain ${avgGain >= 0 ? '+' : ''}${avgGain.toFixed(3)}% | ` +
        `avg loss ${avgLoss.toFixed(3)}% | ` +
        `sim pnl $${sim.pnlUsd.toFixed(2)} (${sim.trades} trades @ $${SIM_MARGIN_USD} x${BASE_SIM_LEVERAGE}*)`,
    )
  }
  console.log(`TOTAL simulated PnL: $${simulationTotalPnlUsd.toFixed(2)} (with dynamic leverage)`)

  console.log('\n' + '='.repeat(110))
  console.log(`FUTURES BOT SIMULATION ($${FUTURES_BOT_CONFIG.marginUsd} Margin, ${FUTURES_BOT_CONFIG.takeProfitPct}% TP, ${FUTURES_BOT_CONFIG.stopLossPct}% SL)`)
  console.log('='.repeat(110))

  for (const symbol of SYMBOLS) {
    // Always show state from futuresBotState (history persists even when no trade on this tick)
    ensureFuturesBotSymbol(symbol)

    const activeTrade = futuresBotState.activeTrades.get(symbol)
    const currentPrice = previousPrices.get(symbol)

    if (!activeTrade || typeof currentPrice !== 'number' || Number.isNaN(currentPrice)) {
      const stats = futuresBotState.stats.get(symbol) ?? {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        realizedPnl: 0,
        feesPaid: 0,
        profitTrades: 0,
        lossTrades: 0,
      }
      const winRate = stats.totalTrades > 0 ? (stats.wins / stats.totalTrades) * 100 : 0

      console.log(
        `${symbol.padEnd(6)} | WAITING | ` +
          `Trades: ${stats.totalTrades} | ` +
          `Profit: ${stats.profitTrades || 0} | ` +
          `Loss: ${stats.lossTrades || 0} | ` +
          `Win Rate: ${winRate.toFixed(1)}% | ` +
          `PnL: $${stats.realizedPnl.toFixed(2)} | ` +
          `Fees: $${stats.feesPaid.toFixed(2)}`,
      )

      printLastTrades(symbol, 3)
      continue
    }

    // Active trade: compute live PnL for display
    const isLong = activeTrade.side === 'long'
    const unrealizedPnl = isLong ? activeTrade.positionSize * (currentPrice - activeTrade.entryPrice) : activeTrade.positionSize * (activeTrade.entryPrice - currentPrice)

    const netUnrealizedPnl = unrealizedPnl - (activeTrade.fee || 0)

    // ROI net of estimated round-trip costs if closed now
    const roiPct = (netUnrealizedPnl / activeTrade.marginUsd) * 100
    const elapsedMin = ((Date.now() - activeTrade.entryTime) / 60000).toFixed(1)
    const pnlSign = unrealizedPnl >= 0 ? '+' : ''

    console.log(
      `${symbol.padEnd(6)} | ` +
        `${activeTrade.side.toUpperCase().padEnd(6)} | ` +
        `Entry: ${formatNumber(activeTrade.entryPrice, priceDigitsFor(symbol))} | ` +
        `TP: ${formatNumber(activeTrade.targetPrice, priceDigitsFor(symbol))} | ` +
        `SL: ${formatNumber(activeTrade.stopPrice, priceDigitsFor(symbol))} | ` +
        `LEV: ${activeTrade.leverage}x | ` +
        `Margin: $${activeTrade.marginUsd.toFixed(2)} | ` +
        `Pos: $${activeTrade.positionValueUsd.toFixed(2)} | ` +
        `PnL: $${pnlSign}${unrealizedPnl.toFixed(4)} (${roiPct.toFixed(1)}%) | ` +
        `peakROI: ${(activeTrade.peakRoiPct ?? 0).toFixed(1)}% | ` +
        `trail: ${activeTrade.trailingActive ? 'ON' : 'OFF'} | ` +
        `Time: ${elapsedMin}m`,
    )

    printLastTrades(symbol, 2)
  }
}

// =========================
// Main tick loop
// =========================
function tick() {
  if (isRendering) return
  isRendering = true

  ensureWebsocketHealthy()

  const waitingReason = wsConnected ? 'Waiting for first kline message' : (wsLastError ?? 'Connecting websocket')
  const results = SYMBOLS.map((symbol) => latestSymbolRows.get(symbol) ?? buildErrorResult(symbol, waitingReason))

  render(results)

  isRendering = false
}

// =========================
// Startup
// =========================
connectBinanceWebSocket()

// Make sure log dir exists up-front
if (FUTURES_LOG_ENABLE && FUTURES_TRADES_LOG) ensureDir(FUTURES_LOG_DIR)

tick()
const timer = setInterval(tick, INTERVAL_MS)

function shutdown() {
  try {
    clearInterval(timer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    stopPing()

    if (ws && (ws.readyState === WS_STATE_OPEN || ws.readyState === WS_STATE_CONNECTING)) {
      ws.close(1000, 'shutdown')
    }

    process.stdout.write('\nStopped.\n')
    process.exit(0)
  } catch {
    process.exit(0)
  }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
