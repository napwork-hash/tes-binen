'use strict'

const { DISABLE_CONSOLE_CLEAR } = require('./config')

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function formatNumber(value, digits = 4) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'N/A'
  return value.toFixed(digits)
}

function formatPrice(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'N/A'
  if (value >= 1000) return value.toFixed(2)
  if (value >= 1) return value.toFixed(4)
  if (value >= 0.01) return value.toFixed(6)
  return value.toFixed(8)
}

function stdDev(values) {
  if (!Array.isArray(values) || values.length < 2) return 0
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function safeClearConsole() {
  if (!DISABLE_CONSOLE_CLEAR) console.clear()
}

function formatMsToClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00'
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

module.exports = {
  clamp,
  formatMsToClock,
  formatNumber,
  formatPrice,
  safeClearConsole,
  stdDev,
}
