'use strict'

function toNumber(value, fallback) {
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

function isValidPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(value) && value > 0
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function createDefaults(simConfig) {
  const slMin = Math.max(1, toNumber(simConfig.stopLossRoiMinPct, 8))
  const slMax = Math.max(slMin, toNumber(simConfig.stopLossRoiMaxPct, 15))

  const trailActivateMin = Math.max(0.1, toNumber(simConfig.trailActivateRoiMinPct, 10))
  const trailActivateMax = Math.max(trailActivateMin, toNumber(simConfig.trailActivateRoiMaxPct, 20))

  const trailDdMin = Math.max(0.1, toNumber(simConfig.trailDdRoiMinPct, 2))
  const trailDdMax = Math.max(trailDdMin, toNumber(simConfig.trailDdRoiMaxPct, 4))

  return {
    marginUsd: Math.max(0.1, toNumber(simConfig.marginUsd, 10)),
    leverage: Math.max(1, toNumber(simConfig.leverage, 20)),
    stopLossRoiMinPct: slMin,
    stopLossRoiMaxPct: slMax,
    trailActivateRoiMinPct: trailActivateMin,
    trailActivateRoiMaxPct: trailActivateMax,
    trailDdRoiMinPct: trailDdMin,
    trailDdRoiMaxPct: trailDdMax,
    minNetProfitUsd: Math.max(0, toNumber(simConfig.minNetProfitUsd, 0.03)),
    feeRatePct: Math.max(0, toNumber(simConfig.feeRatePct, 0.05)),
  }
}

function createSymbolSimState() {
  return {
    activeTrade: null,
    history: [],
    stats: {
      total: 0,
      wins: 0,
      losses: 0,
      realizedPnlUsd: 0,
    },
    lastClosed: null,
  }
}

function calculateRoiPct(pnlUsd, marginUsd) {
  if (typeof pnlUsd !== 'number' || typeof marginUsd !== 'number' || marginUsd === 0) return 0
  return (pnlUsd / marginUsd) * 100
}

function interpolateByTrigger(min, max, triggerPct) {
  const floor = 0.08
  const ceiling = 1.8
  const safeTrigger = Number.isFinite(triggerPct) ? triggerPct : floor
  const t = clamp((safeTrigger - floor) / (ceiling - floor), 0, 1)
  return min + (max - min) * t
}

function createTrade(side, entryPrice, now, config, meta = {}) {
  if (!isValidPrice(entryPrice)) return null

  const stopLossRoiPct = interpolateByTrigger(config.stopLossRoiMinPct, config.stopLossRoiMaxPct, meta.setupTriggerPct)
  const trailActivateRoiPct = interpolateByTrigger(config.trailActivateRoiMinPct, config.trailActivateRoiMaxPct, meta.setupTriggerPct)
  const trailDdRoiPct = interpolateByTrigger(config.trailDdRoiMinPct, config.trailDdRoiMaxPct, meta.setupTriggerPct)

  const positionValueUsd = config.marginUsd * config.leverage
  const quantity = positionValueUsd / entryPrice
  if (!Number.isFinite(quantity) || quantity <= 0) return null

  const entryFeeUsd = (positionValueUsd * config.feeRatePct) / 100
  const estimatedExitFeeUsd = (positionValueUsd * config.feeRatePct) / 100
  const netAtEntryUsd = -(entryFeeUsd + estimatedExitFeeUsd)
  const minNetProfitUsd = Math.max(config.minNetProfitUsd, (entryFeeUsd + estimatedExitFeeUsd) * 1.25)

  return {
    side,
    entryPrice,
    entryTime: now,
    marginUsd: config.marginUsd,
    leverage: config.leverage,
    positionValueUsd,
    quantity,

    stopLossRoiPct,
    trailActivateRoiPct,
    trailDdRoiPct,
    minNetProfitUsd,
    feeRatePct: config.feeRatePct,

    entryFeeUsd,
    estimatedExitFeeUsd,

    trailingArmed: false,
    peakNetPnlUsd: netAtEntryUsd,
    peakRoiPct: calculateRoiPct(netAtEntryUsd, config.marginUsd),

    meta,
  }
}

function calculateGrossPnl(trade, price) {
  if (!trade || !isValidPrice(price) || !Number.isFinite(trade.quantity)) return 0
  if (trade.side === 'long') return (price - trade.entryPrice) * trade.quantity
  return (trade.entryPrice - price) * trade.quantity
}

function calculateNetPnl(trade, price) {
  const grossPnlUsd = calculateGrossPnl(trade, price)
  const exitNotionalUsd = Math.abs((trade.quantity || 0) * price)
  const exitFeeUsd = (exitNotionalUsd * (trade.feeRatePct || 0)) / 100
  const totalFeesUsd = (trade.entryFeeUsd || 0) + exitFeeUsd
  const netPnlUsd = grossPnlUsd - totalFeesUsd

  return {
    grossPnlUsd,
    totalFeesUsd,
    netPnlUsd,
  }
}

function closeTrade(simState, price, now, reason) {
  const trade = simState.activeTrade
  if (!trade) return null

  const calc = calculateNetPnl(trade, price)
  if (!Number.isFinite(calc.netPnlUsd)) return null

  const roiPct = calculateRoiPct(calc.netPnlUsd, trade.marginUsd)
  const isWin = calc.netPnlUsd > 0

  const closed = {
    ...trade,
    exitPrice: price,
    exitTime: now,
    exitReason: reason,
    grossPnlUsd: calc.grossPnlUsd,
    feesUsd: calc.totalFeesUsd,
    pnlUsd: calc.netPnlUsd,
    roiPct,
    isWin,
  }

  simState.activeTrade = null
  simState.lastClosed = closed

  simState.history.push(closed)
  if (simState.history.length > 30) simState.history.shift()

  simState.stats.total += 1
  if (isWin) simState.stats.wins += 1
  else simState.stats.losses += 1
  simState.stats.realizedPnlUsd += calc.netPnlUsd

  return closed
}

function maybeOpenTrade(simState, decisionPlan, livePrice, now, simConfig) {
  if (simState.activeTrade) return null
  if (!decisionPlan || decisionPlan.status !== 'SETUP' || decisionPlan.hasTriggered) return null
  if (!isValidPrice(livePrice)) return null
  if (!isValidPrice(decisionPlan.longAbove) || !isValidPrice(decisionPlan.shortBelow)) return null

  const side = livePrice >= decisionPlan.longAbove ? 'long' : livePrice <= decisionPlan.shortBelow ? 'short' : null
  if (!side) return null

  if (Number.isFinite(decisionPlan.flowImbalance) && Number.isFinite(decisionPlan.flowSamples) && decisionPlan.flowSamples >= 20) {
    if (side === 'long' && decisionPlan.flowImbalance < -0.05) return null
    if (side === 'short' && decisionPlan.flowImbalance > 0.05) return null
  }

  const config = createDefaults(simConfig)
  const nextTrade = createTrade(side, livePrice, now, config, {
    cycleId: decisionPlan.cycleId,
    triggerLongAbove: decisionPlan.longAbove,
    triggerShortBelow: decisionPlan.shortBelow,
    setupTriggerPct: decisionPlan.triggerPct,
  })
  if (!nextTrade) return null

  simState.activeTrade = nextTrade

  decisionPlan.hasTriggered = true
  return simState.activeTrade
}

function updateOpenTrade(simState, livePrice, now) {
  const trade = simState.activeTrade
  if (!trade) return null
  if (!isValidPrice(livePrice)) return null

  const calc = calculateNetPnl(trade, livePrice)
  const roiPct = calculateRoiPct(calc.netPnlUsd, trade.marginUsd)

  if (roiPct <= -trade.stopLossRoiPct) return closeTrade(simState, livePrice, now, 'SL_ROI')

  if (calc.netPnlUsd > trade.peakNetPnlUsd) {
    trade.peakNetPnlUsd = calc.netPnlUsd
    trade.peakRoiPct = roiPct
  }

  if (!trade.trailingArmed && roiPct >= trade.trailActivateRoiPct) {
    trade.trailingArmed = true
  }

  if (trade.trailingArmed) {
    const drawdownRoiPct = trade.peakRoiPct - roiPct

    if (drawdownRoiPct >= trade.trailDdRoiPct && calc.netPnlUsd >= trade.minNetProfitUsd) {
      return closeTrade(simState, livePrice, now, 'TRAIL_ROI')
    }

    if (trade.peakNetPnlUsd >= trade.minNetProfitUsd && calc.netPnlUsd <= trade.minNetProfitUsd) {
      return closeTrade(simState, livePrice, now, 'LOCK_PROFIT')
    }
  }

  return null
}

function getOpenTradeMetrics(simState, livePrice) {
  const trade = simState.activeTrade
  if (!trade) return null

  const calc = calculateNetPnl(trade, livePrice)
  const roiPct = calculateRoiPct(calc.netPnlUsd, trade.marginUsd)

  return {
    grossPnlUsd: calc.grossPnlUsd,
    netPnlUsd: calc.netPnlUsd,
    feesUsd: calc.totalFeesUsd,
    roiPct,
    peakRoiPct: trade.peakRoiPct,
  }
}

module.exports = {
  createDefaults,
  createSymbolSimState,
  getOpenTradeMetrics,
  maybeOpenTrade,
  updateOpenTrade,
}
