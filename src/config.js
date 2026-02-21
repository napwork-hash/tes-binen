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

const DEFAULT_COINS = ['1000PEPE', '1000FLOKI', '1000SHIBU', '1000BONK', '1000RATS']
const SYMBOLS = parseCoinsEnv(process.env.COIN_LIST) ?? DEFAULT_COINS

const MARKET_SYMBOL_OVERRIDES = {
  // Alias support: user-friendly symbol -> valid Binance futures market symbol.
  '1000SHIBU': '1000shibusdt',
}

function marketSymbolForCoin(symbol) {
  const override = MARKET_SYMBOL_OVERRIDES[symbol]
  if (override) return override
  return `${symbol.toLowerCase()}usdt`
}

const MARKET_SYMBOLS = Object.fromEntries(SYMBOLS.map((symbol) => [symbol, marketSymbolForCoin(symbol)]))

const HISTORY_INTERVAL = '5m'
const HISTORY_CANDLES = numEnv('HISTORY_CANDLES', 72)
const ANALYSIS_MIN_CANDLES = Math.max(20, Math.min(HISTORY_CANDLES, numEnv('ANALYSIS_MIN_CANDLES', 50)))
const DECISION_WINDOW_MS = numEnv('DECISION_WINDOW_MS', FIVE_MINUTES_MS)
const RENDER_INTERVAL_MS = numEnv('RENDER_INTERVAL_MS', 1_000)
const FLOW_LOOKBACK_MS = numEnv('FLOW_LOOKBACK_MS', 60_000)
const FLOW_MIN_SAMPLES = numEnv('FLOW_MIN_SAMPLES', 20)
const FLOW_CONFIRM_THRESHOLD = numEnv('FLOW_CONFIRM_THRESHOLD', 0.08)
const TRIGGER_MIN_PCT = numEnv('TRIGGER_MIN_PCT', 0.05)
const TRIGGER_MAX_PCT = numEnv('TRIGGER_MAX_PCT', 1.2)
const TRIGGER_ATR_WEIGHT = numEnv('TRIGGER_ATR_WEIGHT', 0.45)
const TRIGGER_VOL_WEIGHT = numEnv('TRIGGER_VOL_WEIGHT', 0.65)

// Simulation trade configuration
const SIM_MARGIN_USD = numEnv('SIM_MARGIN_USD', 1)
const SIM_LEVERAGE = numEnv('SIM_LEVERAGE', 10)
const SIM_SL_ROI_MIN_PCT = numEnv('SIM_SL_ROI_MIN_PCT', 8)
const SIM_SL_ROI_MAX_PCT = numEnv('SIM_SL_ROI_MAX_PCT', 15)
const SIM_TRAIL_ACTIVATE_ROI_MIN_PCT = numEnv('SIM_TRAIL_ACTIVATE_ROI_MIN_PCT', 6)
const SIM_TRAIL_ACTIVATE_ROI_MAX_PCT = numEnv('SIM_TRAIL_ACTIVATE_ROI_MAX_PCT', 12)
const SIM_TRAIL_DD_ROI_MIN_PCT = numEnv('SIM_TRAIL_DD_ROI_MIN_PCT', 1.5)
const SIM_TRAIL_DD_ROI_MAX_PCT = numEnv('SIM_TRAIL_DD_ROI_MAX_PCT', 3)
const SIM_MIN_NET_PROFIT_USD = numEnv('SIM_MIN_NET_PROFIT_USD', 0.03)
const SIM_FEE_RATE_PCT = numEnv('SIM_FEE_RATE_PCT', 0.05)

// Live trading (disabled by default)
const LIVE_TRADING_ENABLE = (process.env.LIVE_TRADING_ENABLE ?? '0') === '1'
const LIVE_TRADING_TESTNET = (process.env.LIVE_TRADING_TESTNET ?? '0') === '1'
const LIVE_TRADING_FORCE_ISOLATED = (process.env.LIVE_TRADING_FORCE_ISOLATED ?? '1') === '1'
const LIVE_ENTRY_MODE = (process.env.LIVE_ENTRY_MODE ?? 'LIMIT_GTX').toUpperCase()
const LIVE_GTX_TIMEOUT_MS = numEnv('LIVE_GTX_TIMEOUT_MS', 4_000)
const LIVE_GTX_POLL_MS = numEnv('LIVE_GTX_POLL_MS', 400)
const LIVE_GTX_FALLBACK_MARKET = (process.env.LIVE_GTX_FALLBACK_MARKET ?? '1') === '1'
const LIVE_INCOME_LOOKBACK_HOURS = numEnv('LIVE_INCOME_LOOKBACK_HOURS', 24)
const LIVE_SPREAD_MAX_BPS_DEFAULT = numEnv('LIVE_SPREAD_MAX_BPS_DEFAULT', 25)
const LIVE_SPREAD_MAX_BPS_BY_SYMBOL = {
  '1000PEPE': numEnv('LIVE_SPREAD_MAX_BPS_1000PEPE', 18),
  '1000FLOKI': numEnv('LIVE_SPREAD_MAX_BPS_1000FLOKI', 24),
  '1000SHIBU': numEnv('LIVE_SPREAD_MAX_BPS_1000SHIBU', 20),
  '1000BONK': numEnv('LIVE_SPREAD_MAX_BPS_1000BONK', 22),
  '1000RATS': numEnv('LIVE_SPREAD_MAX_BPS_1000RATS', 30),
}

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
  ANALYSIS_MIN_CANDLES,
  BINANCE_WS_URL,
  DECISION_WINDOW_MS,
  DISABLE_CONSOLE_CLEAR,
  FIVE_MINUTES_MS,
  FLOW_CONFIRM_THRESHOLD,
  FLOW_LOOKBACK_MS,
  FLOW_MIN_SAMPLES,
  HISTORY_CANDLES,
  HISTORY_INTERVAL,
  TRIGGER_ATR_WEIGHT,
  TRIGGER_MAX_PCT,
  TRIGGER_MIN_PCT,
  TRIGGER_VOL_WEIGHT,
  MARKET_SYMBOLS,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RENDER_INTERVAL_MS,
  LIVE_TRADING_ENABLE,
  LIVE_ENTRY_MODE,
  LIVE_GTX_FALLBACK_MARKET,
  LIVE_INCOME_LOOKBACK_HOURS,
  LIVE_GTX_POLL_MS,
  LIVE_GTX_TIMEOUT_MS,
  LIVE_SPREAD_MAX_BPS_BY_SYMBOL,
  LIVE_SPREAD_MAX_BPS_DEFAULT,
  LIVE_TRADING_FORCE_ISOLATED,
  LIVE_TRADING_TESTNET,
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
