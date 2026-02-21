'use strict'

const { DECISION_WINDOW_MS, FLOW_CONFIRM_THRESHOLD, FLOW_MIN_SAMPLES, HISTORY_CANDLES } = require('./config')
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

function analyzeDecision(candles, lastPrice, msToNextCandle, flowContext = null) {
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

  const flowImbalanceRaw = Number(flowContext?.imbalance)
  const flowSamplesRaw = Number(flowContext?.samples)
  const hasFlow = Number.isFinite(flowImbalanceRaw) && Number.isFinite(flowSamplesRaw) && flowSamplesRaw >= FLOW_MIN_SAMPLES
  const flowImbalance = hasFlow ? flowImbalanceRaw : 0
  const flowSamples = hasFlow ? flowSamplesRaw : 0

  const flowConflict = hasFlow && ((trendPct > 0 && flowImbalance < -FLOW_CONFIRM_THRESHOLD) || (trendPct < 0 && flowImbalance > FLOW_CONFIRM_THRESHOLD))
  const flowSupport = hasFlow && ((trendPct > 0 && flowImbalance > FLOW_CONFIRM_THRESHOLD) || (trendPct < 0 && flowImbalance < -FLOW_CONFIRM_THRESHOLD))

  const triggerBasePct = atrPct * 0.6 + volPct * 0.8
  const triggerMultiplier = flowConflict ? 1.25 : flowSupport ? 0.85 : 1
  const triggerPct = clamp(triggerBasePct * triggerMultiplier, 0.08, 2.2)

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
      flowImbalance,
      flowSamples,
    }
  }

  const bias = trendPct >= 0 ? 'LONG_BIAS' : 'SHORT_BIAS'
  if (flowConflict) {
    return {
      status: 'SIDEWAYS',
      reason: `${bias} conflict flow ${flowImbalance.toFixed(2)} (${flowSamples})`,
      longAbove,
      shortBelow,
      triggerPct,
      flowImbalance,
      flowSamples,
    }
  }

  return {
    status: 'SETUP',
    reason: `${bias} | trigger ${triggerPct.toFixed(3)}% | vol x${volumeRatio.toFixed(2)} | flow ${flowImbalance.toFixed(2)}`,
    longAbove,
    shortBelow,
    triggerPct,
    flowImbalance,
    flowSamples,
  }
}

module.exports = {
  analyzeDecision,
}
