'use strict'

const { DECISION_WINDOW_MS, HISTORY_CANDLES } = require('./config')
const { clamp, stdDev } = require('./utils')

function ema(values, period) {
  if (!Array.isArray(values) || values.length === 0) return null

  const alpha = 2 / (period + 1)
  let value = values[0]

  for (let i = 1; i < values.length; i += 1) {
    value = alpha * values[i] + (1 - alpha) * value
  }

  return value
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  return values.reduce((acc, v) => acc + v, 0) / values.length
}

function analyzeDecision(candles, lastPrice, msToNextCandle) {
  if (typeof lastPrice !== 'number' || Number.isNaN(lastPrice)) {
    return {
      status: 'WAIT',
      reason: 'No live price',
      longAbove: null,
      shortBelow: null,
      triggerPct: 0,
    }
  }

  if (!Array.isArray(candles) || candles.length < HISTORY_CANDLES) {
    return {
      status: 'WAIT',
      reason: `Need ${HISTORY_CANDLES} candles (got ${candles?.length ?? 0})`,
      longAbove: null,
      shortBelow: null,
      triggerPct: 0,
    }
  }

  if (!Number.isFinite(msToNextCandle) || msToNextCandle > DECISION_WINDOW_MS) {
    return {
      status: 'WAIT',
      reason: 'Outside decision window',
      longAbove: null,
      shortBelow: null,
      triggerPct: 0,
    }
  }

  const closes = candles.map((c) => c.close)
  const returns = []
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1]
    const cur = closes[i]
    if (prev > 0 && cur > 0) returns.push((cur - prev) / prev)
  }

  const rangesPct = candles.slice(-14).map((c) => {
    if (!c.close) return 0
    return (Math.abs(c.high - c.low) / c.close) * 100
  })

  const atrPct = average(rangesPct)
  const volPct = stdDev(returns) * 100

  const fast = ema(closes.slice(-30), 9)
  const slow = ema(closes.slice(-40), 21)
  const trendPct = fast && slow ? ((fast - slow) / slow) * 100 : 0

  const volumes = candles.slice(-20).map((c) => c.volume)
  const lastVolume = candles[candles.length - 1]?.volume ?? 0
  const avgVolume = average(volumes)
  const volumeRatio = avgVolume > 0 ? lastVolume / avgVolume : 0

  const triggerPct = clamp(atrPct * 0.6 + volPct * 0.8, 0.08, 1.8)

  const longAbove = lastPrice * (1 + triggerPct / 100)
  const shortBelow = lastPrice * (1 - triggerPct / 100)

  const weakTrend = Math.abs(trendPct) < 0.08
  const weakVolume = volumeRatio < 0.75

  if (weakTrend && weakVolume) {
    return {
      status: 'SIDEWAYS',
      reason: `Weak trend ${trendPct.toFixed(3)}% + weak volume x${volumeRatio.toFixed(2)}`,
      longAbove,
      shortBelow,
      triggerPct,
    }
  }

  const bias = trendPct >= 0 ? 'LONG_BIAS' : 'SHORT_BIAS'

  return {
    status: 'SETUP',
    reason: `${bias} | trigger ${triggerPct.toFixed(3)}% | vol x${volumeRatio.toFixed(2)}`,
    longAbove,
    shortBelow,
    triggerPct,
  }
}

module.exports = {
  analyzeDecision,
}
