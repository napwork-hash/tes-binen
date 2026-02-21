/* eslint-disable no-console */

'use strict'

const {
  BINANCE_WS_URL,
  DECISION_WINDOW_MS,
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
  SYMBOLS,
  WS_PING_INTERVAL_MS,
  WS_STALE_TIMEOUT_MS,
} = require('./config')

const { formatMsToClock, formatNumber, formatPrice, safeClearConsole } = require('./utils')

const { fetchKlineHistory, normalizeStreamEvent, parseRawSocketMessage, parseSocketPayload } = require('./binance')

const { analyzeDecision } = require('./strategy')

const { createSymbolSimState, getOpenTradeMetrics, maybeOpenTrade, updateOpenTrade } = require('./simulator')

const SIM_CONFIG = {
  marginUsd: SIM_MARGIN_USD,
  leverage: SIM_LEVERAGE,
  stopLossRoiMinPct: SIM_SL_ROI_MIN_PCT,
  stopLossRoiMaxPct: SIM_SL_ROI_MAX_PCT,
  trailActivateRoiMinPct: SIM_TRAIL_ACTIVATE_ROI_MIN_PCT,
  trailActivateRoiMaxPct: SIM_TRAIL_ACTIVATE_ROI_MAX_PCT,
  trailDdRoiMinPct: SIM_TRAIL_DD_ROI_MIN_PCT,
  trailDdRoiMaxPct: SIM_TRAIL_DD_ROI_MAX_PCT,
  minNetProfitUsd: SIM_MIN_NET_PROFIT_USD,
  feeRatePct: SIM_FEE_RATE_PCT,
}

const symbolByMarket = new Map(Object.entries(MARKET_SYMBOLS).map(([symbol, marketSymbol]) => [marketSymbol, symbol]))

const symbolState = new Map(
  SYMBOLS.map((symbol) => [
    symbol,
    {
      symbol,
      marketSymbol: MARKET_SYMBOLS[symbol],
      candles: [],
      markPrice: null,
      markTs: null,
      tradePrice: null,
      tradeQty: null,
      tradeTs: null,
      lastVolume5m: null,
      nextCandleCloseTs: null,
      lastStreamAt: null,
      error: null,
    },
  ]),
)

const decisionPlanBySymbol = new Map(SYMBOLS.map((symbol) => [symbol, null]))
const simStateBySymbol = new Map(SYMBOLS.map((symbol) => [symbol, createSymbolSimState()]))

let ws = null
let wsConnected = false
let wsLastMessageAt = 0
let wsLastError = null
let reconnectTimer = null
let reconnectAttempt = 0
let pingTimer = null
let renderTimer = null
let hasShutdownHandlers = false

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

function onSocketEvent(socket, eventName, handler) {
  if (typeof socket.addEventListener === 'function') return socket.addEventListener(eventName, handler)
  if (typeof socket.on === 'function') return socket.on(eventName, handler)
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

function ensureState(symbol) {
  const state = symbolState.get(symbol)
  if (state) return state

  const nextState = {
    symbol,
    marketSymbol: MARKET_SYMBOLS[symbol],
    candles: [],
    markPrice: null,
    markTs: null,
    tradePrice: null,
    tradeQty: null,
    tradeTs: null,
    lastVolume5m: null,
    nextCandleCloseTs: null,
    lastStreamAt: null,
    error: null,
  }

  symbolState.set(symbol, nextState)
  return nextState
}

function ensureSimState(symbol) {
  if (!simStateBySymbol.has(symbol)) {
    simStateBySymbol.set(symbol, createSymbolSimState())
  }
  return simStateBySymbol.get(symbol)
}

function compactNumber(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'N/A'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`
  return formatNumber(value, 2)
}

function upsertClosedCandle(state, candle) {
  const last = state.candles[state.candles.length - 1]

  if (!last || candle.closeTime > last.closeTime) {
    state.candles.push(candle)
  } else if (candle.closeTime === last.closeTime) {
    state.candles[state.candles.length - 1] = candle
  }

  if (state.candles.length > HISTORY_CANDLES) {
    state.candles = state.candles.slice(-HISTORY_CANDLES)
  }
}

function applyStreamEvent(event) {
  const symbol = symbolByMarket.get(event.marketSymbol)
  if (!symbol) return

  const state = ensureState(symbol)
  state.lastStreamAt = Date.now()
  state.error = null

  if (event.type === 'trade') {
    if (Number.isFinite(event.price)) state.tradePrice = event.price
    if (Number.isFinite(event.qty)) state.tradeQty = event.qty
    if (Number.isFinite(event.ts)) state.tradeTs = event.ts
    return
  }

  if (event.type === 'mark') {
    if (Number.isFinite(event.price)) state.markPrice = event.price
    if (Number.isFinite(event.ts)) state.markTs = event.ts
    return
  }

  if (event.type === 'kline') {
    if (Number.isFinite(event.volume)) state.lastVolume5m = event.volume
    if (Number.isFinite(event.closeTime)) state.nextCandleCloseTs = event.isClosed ? event.closeTime + FIVE_MINUTES_MS : event.closeTime

    const closed = {
      openTime: event.openTime,
      open: event.open,
      high: event.high,
      low: event.low,
      close: event.close,
      volume: event.volume,
      closeTime: event.closeTime,
    }

    if (event.isClosed) upsertClosedCandle(state, closed)
  }
}

function getLivePrice(state) {
  if (typeof state.tradePrice === 'number' && !Number.isNaN(state.tradePrice)) return state.tradePrice
  if (typeof state.markPrice === 'number' && !Number.isNaN(state.markPrice)) return state.markPrice
  const lastClose = state.candles[state.candles.length - 1]?.close
  if (typeof lastClose === 'number' && !Number.isNaN(lastClose)) return lastClose
  return null
}

function getMsToNextCandle(state) {
  const now = Date.now()

  if (Number.isFinite(state.nextCandleCloseTs)) return Math.max(0, state.nextCandleCloseTs - now)

  const lastClose = state.candles[state.candles.length - 1]?.closeTime
  if (Number.isFinite(lastClose)) return Math.max(0, lastClose + FIVE_MINUTES_MS - now)

  return Number.POSITIVE_INFINITY
}

function getCurrentCycleId(state) {
  if (Number.isFinite(state.nextCandleCloseTs)) return state.nextCandleCloseTs

  const lastClose = state.candles[state.candles.length - 1]?.closeTime
  if (Number.isFinite(lastClose)) return lastClose + FIVE_MINUTES_MS

  return null
}

function isFinitePrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value) && value > 0
}

function syncDecisionPlan(symbol, state, analysis, livePrice, now) {
  const cycleId = getCurrentCycleId(state)
  const prevPlan = decisionPlanBySymbol.get(symbol) ?? null

  if (!Number.isFinite(cycleId)) {
    decisionPlanBySymbol.set(symbol, null)
    return null
  }

  const canBuild = (analysis.status === 'SETUP' || analysis.status === 'SIDEWAYS') && isFinitePrice(livePrice) && isFinitePrice(analysis.longAbove) && isFinitePrice(analysis.shortBelow)

  if (!prevPlan || prevPlan.cycleId !== cycleId) {
    const nextPlan = canBuild
      ? {
          cycleId,
          status: analysis.status,
          reason: analysis.reason,
          triggerPct: analysis.triggerPct,
          basePrice: livePrice,
          longAbove: analysis.longAbove,
          shortBelow: analysis.shortBelow,
          createdAt: now,
          hasTriggered: false,
        }
      : null

    decisionPlanBySymbol.set(symbol, nextPlan)
    return nextPlan
  }

  // Promote plan from SIDEWAYS to SETUP once per candle and keep threshold fixed after SETUP created.
  if (prevPlan.status !== 'SETUP' && analysis.status === 'SETUP' && canBuild) {
    prevPlan.status = analysis.status
    prevPlan.reason = analysis.reason
    prevPlan.triggerPct = analysis.triggerPct
    prevPlan.basePrice = livePrice
    prevPlan.longAbove = analysis.longAbove
    prevPlan.shortBelow = analysis.shortBelow
  }

  return prevPlan
}

function connectionStatusText() {
  const status = wsConnected ? 'connected' : 'disconnected'
  const age = wsLastMessageAt > 0 ? `${Date.now() - wsLastMessageAt}ms` : 'N/A'
  const errorText = wsLastError ? ` | last error: ${wsLastError}` : ''
  return `${status} | last msg: ${age}${errorText}`
}

function buildRows(now) {
  const rows = []

  for (const symbol of SYMBOLS) {
    const state = ensureState(symbol)
    const livePrice = getLivePrice(state)
    const msToNext = getMsToNextCandle(state)
    const analysis = analyzeDecision(state.candles, livePrice, msToNext)
    const decisionPlan = syncDecisionPlan(symbol, state, analysis, livePrice, now)

    const sim = ensureSimState(symbol)

    if (isFinitePrice(livePrice)) {
      updateOpenTrade(sim, livePrice, now)
      maybeOpenTrade(sim, decisionPlan, livePrice, now, SIM_CONFIG)
    }

    const simOpenMetrics = getOpenTradeMetrics(sim, livePrice)

    rows.push({
      symbol,
      state,
      livePrice,
      msToNext,
      analysis,
      decisionPlan,
      sim,
      simOpenMetrics,
    })
  }

  return rows
}

function render(rows) {
  safeClearConsole()

  console.log('Live Binance Futures Monitor (Trade + Mark + Volume)')
  console.log(
    `History: ${HISTORY_CANDLES} candles x ${HISTORY_INTERVAL} (6 jam) | Decision window: < ${Math.floor(DECISION_WINDOW_MS / 1000)} detik | ` +
      `Sim: $${SIM_CONFIG.marginUsd} x${SIM_CONFIG.leverage} | ` +
      `SL -${SIM_CONFIG.stopLossRoiMinPct}-${SIM_CONFIG.stopLossRoiMaxPct}% ROI | ` +
      `Trail aktif ${SIM_CONFIG.trailActivateRoiMinPct}-${SIM_CONFIG.trailActivateRoiMaxPct}% ROI | ` +
      `Trail DD ${SIM_CONFIG.trailDdRoiMinPct}-${SIM_CONFIG.trailDdRoiMaxPct}% ROI | ` +
      `Min net +$${SIM_CONFIG.minNetProfitUsd.toFixed(2)} | ` +
      `Fee ${SIM_CONFIG.feeRatePct}%/side\n`,
  )
  console.log(`WebSocket: ${connectionStatusText()}`)
  console.log('SYMBOL | MARK         | TRADE        | VOL 5M   | NEXT   | PLAN      | LONG IF >     | SHORT IF <    | SIM  | NOTE')
  console.log('--------------------------------------------------------------------------------------------------------------------------------')

  for (const row of rows) {
    const { symbol, state, msToNext, analysis, decisionPlan, sim } = row

    const plan = decisionPlan ?? null
    const planStatus = (plan?.status ?? analysis.status).padEnd(9)
    const longText = isFinitePrice(plan?.longAbove) ? formatPrice(plan.longAbove).padEnd(13) : '-'.padEnd(13)
    const shortText = isFinitePrice(plan?.shortBelow) ? formatPrice(plan.shortBelow).padEnd(13) : '-'.padEnd(13)

    const noteBase = state.error ? `ERR: ${state.error}` : (plan?.reason ?? analysis.reason)
    const note = String(noteBase || '-').slice(0, 40)

    const simTag = sim.activeTrade ? sim.activeTrade.side.toUpperCase() : 'IDLE'

    console.log(
      `${symbol.padEnd(8)} | ` +
        `${formatPrice(state.markPrice).padEnd(12)} | ` +
        `${formatPrice(state.tradePrice).padEnd(12)} | ` +
        `${compactNumber(state.lastVolume5m).padEnd(8)} | ` +
        `${formatMsToClock(msToNext).padEnd(6)} | ` +
        `${planStatus} | ` +
        `${longText} | ` +
        `${shortText} | ` +
        `${simTag.padEnd(4)} | ` +
        `${note}`,
    )
  }

  console.log('\nSimulation Trades')
  console.log('-----------------')

  for (const row of rows) {
    const { symbol, livePrice, sim, simOpenMetrics } = row

    if (sim.activeTrade) {
      const trade = sim.activeTrade
      const grossPnlUsd = simOpenMetrics?.grossPnlUsd ?? 0
      const pnlUsd = simOpenMetrics?.netPnlUsd ?? 0
      const feesUsd = simOpenMetrics?.feesUsd ?? 0
      const roiPct = simOpenMetrics?.roiPct ?? 0
      const peakRoiPct = simOpenMetrics?.peakRoiPct ?? 0
      const pnlSign = pnlUsd >= 0 ? '+' : ''
      const grossSign = grossPnlUsd >= 0 ? '+' : ''

      console.log(
        `${symbol} OPEN ${trade.side.toUpperCase()} | ` +
          `entry ${formatPrice(trade.entryPrice)} | ` +
          `last ${formatPrice(livePrice)} | ` +
          `slROI -${trade.stopLossRoiPct}% | ` +
          `trail ${trade.trailingArmed ? 'ON' : 'OFF'} (act ${trade.trailActivateRoiPct.toFixed(2)}% / dd ${trade.trailDdRoiPct.toFixed(2)}%) | ` +
          `peakROI ${peakRoiPct.toFixed(2)}% | ` +
          `gross ${grossSign}$${grossPnlUsd.toFixed(4)} | ` +
          `fee $${feesUsd.toFixed(4)} | ` +
          `net ${pnlSign}$${pnlUsd.toFixed(4)} (${roiPct.toFixed(2)}%)`,
      )

      continue
    }

    const stats = sim.stats
    const winRate = stats.total > 0 ? (stats.wins / stats.total) * 100 : 0

    const last = sim.lastClosed ? `${sim.lastClosed.exitReason} ${sim.lastClosed.pnlUsd >= 0 ? '+' : ''}$${sim.lastClosed.pnlUsd.toFixed(4)}` : 'none'

    console.log(`${symbol} IDLE | ` + `trades ${stats.total} | ` + `win ${stats.wins}/${stats.total} (${winRate.toFixed(1)}%) | ` + `realized ${stats.realizedPnlUsd >= 0 ? '+' : ''}$${stats.realizedPnlUsd.toFixed(4)} | ` + `last ${last}`)
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
  if (!ws || typeof ws.ping !== 'function') return

  pingTimer = setInterval(() => {
    try {
      if (ws && ws.readyState === WS_STATE_OPEN) ws.ping()
    } catch {
      // ignore ping errors
    }
  }, WS_PING_INTERVAL_MS)
}

function scheduleReconnect() {
  if (reconnectTimer) return

  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS)
  reconnectAttempt += 1

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectWebSocket()
  }, delay)
}

function connectWebSocket() {
  if (typeof WebSocketImpl !== 'function') {
    wsLastError = 'WebSocket implementation unavailable (install `ws`)'
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

    const raw = parseRawSocketMessage(messageArg)
    const payload = parseSocketPayload(raw)

    if (!payload) {
      wsLastError = 'Invalid websocket JSON payload'
      return
    }

    if (typeof payload?.code === 'number' && typeof payload?.msg === 'string') {
      wsLastError = `Stream error ${payload.code}: ${payload.msg}`
      return
    }

    const event = normalizeStreamEvent(payload)
    if (!event || !event.marketSymbol) return

    applyStreamEvent(event)
  })

  onSocketEvent(ws, 'error', () => {
    wsLastError = 'WebSocket error'
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

function ensureWebsocketHealthy() {
  if (!wsConnected || !wsLastMessageAt) return

  const age = Date.now() - wsLastMessageAt
  if (age <= WS_STALE_TIMEOUT_MS) return

  wsLastError = `Stale feed (${age}ms > ${WS_STALE_TIMEOUT_MS}ms), reconnecting`

  try {
    if (ws && (ws.readyState === WS_STATE_OPEN || ws.readyState === WS_STATE_CONNECTING)) {
      ws.close(4000, 'stale')
    }
  } catch {
    // ignore close errors
  }
}

async function hydrateHistoryForSymbol(symbol) {
  const state = ensureState(symbol)

  try {
    const candles = await fetchKlineHistory(state.marketSymbol)

    state.candles = candles.slice(-HISTORY_CANDLES)
    state.lastVolume5m = state.candles[state.candles.length - 1]?.volume ?? null

    const lastCloseTime = state.candles[state.candles.length - 1]?.closeTime
    state.nextCandleCloseTs = Number.isFinite(lastCloseTime) ? lastCloseTime + FIVE_MINUTES_MS : null

    state.error = null
  } catch (error) {
    state.error = `History load failed: ${error.message}`
  }
}

async function hydrateHistory() {
  await Promise.all(SYMBOLS.map((symbol) => hydrateHistoryForSymbol(symbol)))
}

function tick() {
  ensureWebsocketHealthy()
  const rows = buildRows(Date.now())
  render(rows)
}

function shutdown() {
  try {
    if (renderTimer) {
      clearInterval(renderTimer)
      renderTimer = null
    }

    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

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

async function boot() {
  await hydrateHistory()

  connectWebSocket()
  tick()

  renderTimer = setInterval(tick, RENDER_INTERVAL_MS)

  if (!hasShutdownHandlers) {
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    hasShutdownHandlers = true
  }
}

function start() {
  if (renderTimer) return

  boot().catch((error) => {
    wsLastError = `Startup failed: ${error.message}`
    tick()
  })
}

module.exports = {
  start,
}
