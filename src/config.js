'use strict'

const FIVE_MINUTES_MS = 5 * 60 * 1000

function numEnv(key, def) {
  const value = Number(process.env[key])
  return Number.isFinite(value) ? value : def
}

function parseCoinsEnv(raw) {
  if (!raw || typeof raw !== 'string') return null
  const coins = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)

  if (coins.length === 0) return null
  return Array.from(new Set(coins))
}

const DEFAULT_COINS = ['1000PEPE', '1000FLOKI', 'DOGE', 'INIT', 'BAS', 'MYX', 'ASTER', 'WLFI', 'PIPPIN', 'ARB', 'POWER', 'YGG', 'ZAMA', 'SENT', 'AZTEC', 'COLLECT', 'EUL']
const SYMBOLS = parseCoinsEnv(process.env.COIN_LIST) ?? DEFAULT_COINS

const MARKET_SYMBOLS = Object.fromEntries(SYMBOLS.map((symbol) => [symbol, `${symbol.toLowerCase()}usdt`]))

const HISTORY_INTERVAL = '5m'
const HISTORY_CANDLES = numEnv('HISTORY_CANDLES', 72)
const DECISION_WINDOW_MS = numEnv('DECISION_WINDOW_MS', FIVE_MINUTES_MS)
const RENDER_INTERVAL_MS = numEnv('RENDER_INTERVAL_MS', 1_000)

// Simulation trade configuration
const SIM_MARGIN_USD = numEnv('SIM_MARGIN_USD', 10)
const SIM_LEVERAGE = numEnv('SIM_LEVERAGE', 20)
const SIM_SL_ROI_MIN_PCT = numEnv('SIM_SL_ROI_MIN_PCT', 8)
const SIM_SL_ROI_MAX_PCT = numEnv('SIM_SL_ROI_MAX_PCT', 15)
const SIM_TRAIL_ACTIVATE_ROI_MIN_PCT = numEnv('SIM_TRAIL_ACTIVATE_ROI_MIN_PCT', 10)
const SIM_TRAIL_ACTIVATE_ROI_MAX_PCT = numEnv('SIM_TRAIL_ACTIVATE_ROI_MAX_PCT', 20)
const SIM_TRAIL_DD_ROI_MIN_PCT = numEnv('SIM_TRAIL_DD_ROI_MIN_PCT', 2)
const SIM_TRAIL_DD_ROI_MAX_PCT = numEnv('SIM_TRAIL_DD_ROI_MAX_PCT', 4)
const SIM_MIN_NET_PROFIT_USD = numEnv('SIM_MIN_NET_PROFIT_USD', 0.2)
const SIM_FEE_RATE_PCT = numEnv('SIM_FEE_RATE_PCT', 0.05)

const BINANCE_FUTURES_REST_BASE = process.env.BINANCE_FUTURES_REST_BASE || 'https://fapi.binance.com'
const BINANCE_FUTURES_WS_BASE = process.env.BINANCE_FUTURES_WS_BASE || 'wss://fstream.binance.com/stream?streams='

const STREAM_TYPES = ['aggTrade', 'markPrice@1s', `kline_${HISTORY_INTERVAL}`]
const STREAM_NAMES = Object.values(MARKET_SYMBOLS).flatMap((marketSymbol) => STREAM_TYPES.map((streamType) => `${marketSymbol}@${streamType}`))
const BINANCE_WS_URL = `${BINANCE_FUTURES_WS_BASE}${STREAM_NAMES.join('/')}`

const RECONNECT_BASE_MS = numEnv('RECONNECT_BASE_MS', 1_000)
const RECONNECT_MAX_MS = numEnv('RECONNECT_MAX_MS', 15_000)
const WS_STALE_TIMEOUT_MS = numEnv('WS_STALE_TIMEOUT_MS', 45_000)
const WS_PING_INTERVAL_MS = numEnv('WS_PING_INTERVAL_MS', 15_000)

const DISABLE_CONSOLE_CLEAR = (process.env.DISABLE_CONSOLE_CLEAR ?? '0') === '1'

module.exports = {
  BINANCE_FUTURES_REST_BASE,
  BINANCE_WS_URL,
  DECISION_WINDOW_MS,
  DISABLE_CONSOLE_CLEAR,
  FIVE_MINUTES_MS,
  HISTORY_CANDLES,
  HISTORY_INTERVAL,
  MARKET_SYMBOLS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RENDER_INTERVAL_MS,
  SIM_FEE_RATE_PCT,
  SIM_LEVERAGE,
  SIM_MARGIN_USD,
  SIM_MIN_NET_PROFIT_USD,
  SIM_SL_ROI_MAX_PCT,
  SIM_SL_ROI_MIN_PCT,
  SIM_TRAIL_ACTIVATE_ROI_MAX_PCT,
  SIM_TRAIL_ACTIVATE_ROI_MIN_PCT,
  SIM_TRAIL_DD_ROI_MAX_PCT,
  SIM_TRAIL_DD_ROI_MIN_PCT,
  STREAM_NAMES,
  SYMBOLS,
  WS_PING_INTERVAL_MS,
  WS_STALE_TIMEOUT_MS,
}
