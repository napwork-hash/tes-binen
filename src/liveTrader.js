'use strict'

const crypto = require('crypto')

function toNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function decimalsFromStep(stepSize) {
  const s = String(stepSize)
  if (!s.includes('.')) return 0
  return s.replace(/0+$/, '').split('.')[1]?.length ?? 0
}

function roundDownToStep(value, stepSize) {
  const step = toNumber(stepSize, 0)
  if (!Number.isFinite(step) || step <= 0) return value

  const n = Math.floor(value / step) * step
  const decimals = decimalsFromStep(stepSize)
  return Number(n.toFixed(decimals))
}

function parseBinanceErrorCode(error) {
  const message = String(error?.message || '')
  const match = message.match(/"code"\s*:\s*(-?\d+)/)
  if (!match) return null
  const code = Number(match[1])
  return Number.isFinite(code) ? code : null
}

class LiveTrader {
  constructor(options = {}) {
    this.enable = Boolean(options.enable)
    this.testnet = Boolean(options.testnet)

    this.apiKey = options.apiKey || process.env.BINANCE_FUTURES_API_KEY || process.env.BINANCE_API_KEY || ''
    this.apiSecret = options.apiSecret || process.env.BINANCE_FUTURES_API_SECRET || process.env.BINANCE_API_SECRET || ''

    this.marginUsd = Math.max(0.1, toNumber(options.marginUsd, 1))
    this.leverage = Math.min(20, Math.max(1, Math.floor(toNumber(options.leverage, 20))))

    this.baseUrl = options.baseUrl || (this.testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com')

    this.symbolMeta = new Map() // marketSymbolUpper -> { minQty, stepSize }
    this.maxLeverageBySymbol = new Map() // marketSymbolUpper -> max leverage from bracket
    this.effectiveLeverageBySymbol = new Map() // marketSymbolUpper -> leverage actually set/used
    this.activePositions = new Map() // marketSymbolUpper -> { side, quantity }
    this.inFlight = new Set()
    this.positionSnapshot = new Map() // marketSymbolUpper -> { side, quantity, entryPrice, markPrice, unrealizedPnlUsd, notionalUsd, marginUsd }
    this.incomeStats = new Map() // marketSymbolUpper -> { realizedPnlUsd, commissionUsd, fundingUsd, netUsd, events }
    this.lastActionBySymbol = new Map() // marketSymbolUpper -> short last action text
    this.incomeCursorTs = Date.now() - 60_000
    this.seenIncomeKeys = new Set()

    this.lastError = null
    this.ready = false
  }

  getStatus() {
    if (!this.enable) return 'OFF'
    if (!this.apiKey || !this.apiSecret) return 'ON (missing keys)'
    if (!this.ready) return 'ON (init...)'
    return this.testnet ? 'ON TESTNET' : 'ON REAL'
  }

  isEnabled() {
    return this.enable
  }

  hasCredentials() {
    return Boolean(this.apiKey && this.apiSecret)
  }

  async bootstrap(marketSymbols = []) {
    if (!this.enable) return
    if (!this.hasCredentials()) {
      this.lastError = 'Live trading enabled but API credentials missing'
      return
    }

    try {
      const symbolsUpper = (marketSymbols || []).map((s) => String(s).toUpperCase()).filter(Boolean)

      await this.loadExchangeInfo(symbolsUpper)

      try {
        await this.loadLeverageBrackets(symbolsUpper)
      } catch {
        // leverage bracket is best-effort; we still can continue with fallback candidates
      }

      await Promise.all(symbolsUpper.map(async (symbolUpper) => this.configureLeverage(symbolUpper)))
      await this.syncRuntime(symbolsUpper)
      this.ready = true
      this.lastError = null
    } catch (error) {
      this.lastError = `Bootstrap failed: ${error.message}`
      this.ready = false
    }
  }

  async loadExchangeInfo(marketSymbols = []) {
    const data = await this.requestPublic('/fapi/v1/exchangeInfo')
    const wanted = new Set(marketSymbols.map((s) => s.toUpperCase()))

    for (const s of data?.symbols ?? []) {
      const symbol = String(s?.symbol || '').toUpperCase()
      if (!symbol || (wanted.size > 0 && !wanted.has(symbol))) continue

      const lot = Array.isArray(s.filters) ? s.filters.find((f) => f.filterType === 'LOT_SIZE') : null
      const minQty = lot ? toNumber(lot.minQty, 0) : 0
      const stepSize = lot ? String(lot.stepSize) : '0.001'

      this.symbolMeta.set(symbol, { minQty, stepSize })
    }
  }

  async setLeverage(symbolUpper, leverage) {
    return this.requestSigned('POST', '/fapi/v1/leverage', {
      symbol: symbolUpper,
      leverage,
    })
  }

  async loadLeverageBrackets(marketSymbols = []) {
    const wanted = new Set((marketSymbols || []).map((s) => String(s).toUpperCase()).filter(Boolean))
    const data = await this.requestSigned('GET', '/fapi/v1/leverageBracket')
    const rows = Array.isArray(data) ? data : data ? [data] : []

    this.maxLeverageBySymbol.clear()

    for (const row of rows) {
      const symbol = String(row?.symbol || '').toUpperCase()
      if (!symbol || (wanted.size > 0 && !wanted.has(symbol))) continue

      let maxLeverage = 0
      for (const bracket of row?.brackets ?? []) {
        const lv = Math.floor(toNumber(bracket?.initialLeverage, 0))
        if (lv > maxLeverage) maxLeverage = lv
      }

      if (maxLeverage > 0) this.maxLeverageBySymbol.set(symbol, maxLeverage)
    }
  }

  getLeverageCandidates(symbolUpper) {
    const cap = Math.min(20, Math.max(1, Math.floor(toNumber(this.maxLeverageBySymbol.get(symbolUpper), 20))))
    const target = Math.min(cap, this.leverage)
    const seeds = [target, 20, 15, 12, 10, 8, 5, 3, 2, 1]
    const out = []

    for (const seed of seeds) {
      const bounded = Math.min(cap, Math.max(1, Math.floor(seed)))
      if (!out.includes(bounded)) out.push(bounded)
    }

    return out
  }

  getEffectiveLeverage(symbolUpper) {
    const symbol = String(symbolUpper || '').toUpperCase()
    const saved = Math.floor(toNumber(this.effectiveLeverageBySymbol.get(symbol), 0))
    if (saved > 0) return saved
    return this.leverage
  }

  async configureLeverage(symbolUpper) {
    const candidates = this.getLeverageCandidates(symbolUpper)
    let lastError = null

    for (const candidate of candidates) {
      try {
        const response = await this.setLeverage(symbolUpper, candidate)
        const accepted = Math.floor(toNumber(response?.leverage, candidate))
        const effective = Math.min(20, Math.max(1, accepted))
        this.effectiveLeverageBySymbol.set(symbolUpper, effective)
        return effective
      } catch (error) {
        lastError = error
        const errorCode = parseBinanceErrorCode(error)
        // Retry only when request rejected for invalid leverage level.
        if (errorCode !== -4028) break
      }
    }

    // Continue bootstrap with safest fallback when leverage API keeps rejecting this symbol.
    this.effectiveLeverageBySymbol.set(symbolUpper, 1)
    return lastError
  }

  normalizeQuantity(symbolUpper, qtyRaw) {
    const meta = this.symbolMeta.get(symbolUpper)
    if (!meta) return null

    let qty = roundDownToStep(qtyRaw, meta.stepSize)
    if (!Number.isFinite(qty) || qty <= 0) return null
    if (qty < meta.minQty) return null

    return qty
  }

  async openPosition(symbol, marketSymbol, side, price) {
    if (!this.enable || !this.ready) return null

    const symbolUpper = String(marketSymbol || symbol).toUpperCase()
    if (this.activePositions.has(symbolUpper)) return null
    if (this.inFlight.has(symbolUpper)) return null

    this.inFlight.add(symbolUpper)
    try {
      const leverage = this.getEffectiveLeverage(symbolUpper)
      const rawQty = (this.marginUsd * leverage) / price
      const qty = this.normalizeQuantity(symbolUpper, rawQty)
      if (!qty) throw new Error(`Quantity too small or invalid for ${symbolUpper}`)

      const orderSide = side === 'long' ? 'BUY' : 'SELL'
      const result = await this.requestSigned('POST', '/fapi/v1/order', {
        symbol: symbolUpper,
        side: orderSide,
        type: 'MARKET',
        quantity: qty,
        newOrderRespType: 'RESULT',
      })

      const executedQty = toNumber(result?.executedQty, qty)
      this.activePositions.set(symbolUpper, {
        side,
        quantity: executedQty > 0 ? executedQty : qty,
      })

      this.lastActionBySymbol.set(
        symbolUpper,
        `OPEN ${side.toUpperCase()} ok qty ${formatQty(executedQty > 0 ? executedQty : qty)} #${result?.orderId ?? '-'}`,
      )
      this.lastError = null
      await this.syncPositions()
      return result
    } catch (error) {
      this.lastActionBySymbol.set(symbolUpper, `OPEN ${side.toUpperCase()} fail`)
      this.lastError = `Open ${symbolUpper} failed: ${error.message}`
      return null
    } finally {
      this.inFlight.delete(symbolUpper)
    }
  }

  async closePosition(symbol, marketSymbol) {
    if (!this.enable || !this.ready) return null

    const symbolUpper = String(marketSymbol || symbol).toUpperCase()
    const active = this.activePositions.get(symbolUpper) || this.positionSnapshot.get(symbolUpper)
    if (!active) return null
    if (this.inFlight.has(symbolUpper)) return null

    this.inFlight.add(symbolUpper)
    try {
      const qty = this.normalizeQuantity(symbolUpper, active.quantity)
      if (!qty) throw new Error(`Close quantity invalid for ${symbolUpper}`)

      const closeSide = active.side === 'long' ? 'SELL' : 'BUY'
      const result = await this.requestSigned('POST', '/fapi/v1/order', {
        symbol: symbolUpper,
        side: closeSide,
        type: 'MARKET',
        reduceOnly: 'true',
        quantity: qty,
        newOrderRespType: 'RESULT',
      })

      this.activePositions.delete(symbolUpper)
      this.lastActionBySymbol.set(symbolUpper, `CLOSE ${active.side.toUpperCase()} ok qty ${formatQty(qty)} #${result?.orderId ?? '-'}`)
      this.lastError = null
      await this.syncPositions()
      return result
    } catch (error) {
      this.lastActionBySymbol.set(symbolUpper, `CLOSE ${active.side.toUpperCase()} fail`)
      this.lastError = `Close ${symbolUpper} failed: ${error.message}`
      return null
    } finally {
      this.inFlight.delete(symbolUpper)
    }
  }

  async requestPublic(path, params = {}) {
    const qs = new URLSearchParams(params).toString()
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`

    const response = await fetch(url)
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status} ${text}`)

    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Invalid JSON response')
    }
  }

  async requestSigned(method, path, params = {}) {
    if (!this.hasCredentials()) throw new Error('Missing API credentials')

    const allParams = {
      ...params,
      timestamp: Date.now(),
      recvWindow: 5000,
    }

    const query = new URLSearchParams(allParams).toString()
    const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex')
    const qs = `${query}&signature=${signature}`

    const url = `${this.baseUrl}${path}?${qs}`
    const response = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': this.apiKey,
      },
    })

    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status} ${text}`)

    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Invalid JSON response')
    }
  }

  async syncRuntime(marketSymbols = []) {
    if (!this.enable || !this.hasCredentials()) return
    try {
      await this.syncPositions()
      await this.syncIncome(marketSymbols)
    } catch (error) {
      this.lastError = `Sync failed: ${error.message}`
    }
  }

  async syncPositions() {
    if (!this.enable || !this.hasCredentials()) return

    const rows = await this.requestSigned('GET', '/fapi/v2/positionRisk')
    if (!Array.isArray(rows)) return

    this.positionSnapshot.clear()
    this.activePositions.clear()

    for (const p of rows) {
      const symbol = String(p?.symbol || '').toUpperCase()
      if (!symbol) continue

      const positionAmt = toNumber(p.positionAmt, 0)
      if (!Number.isFinite(positionAmt) || positionAmt === 0) continue

      const entryPrice = toNumber(p.entryPrice, 0)
      const markPrice = toNumber(p.markPrice, 0)
      const unrealizedPnlUsd = toNumber(p.unRealizedProfit, 0)
      const notionalUsd = Math.abs(toNumber(p.notional, 0))
      const marginUsd = Math.abs(toNumber(p.isolatedMargin, 0)) || this.marginUsd
      const leverage = Math.floor(toNumber(p.leverage, this.getEffectiveLeverage(symbol)))
      if (leverage > 0) this.effectiveLeverageBySymbol.set(symbol, Math.min(20, leverage))

      const side = positionAmt > 0 ? 'long' : 'short'
      const quantity = Math.abs(positionAmt)

      this.positionSnapshot.set(symbol, {
        side,
        quantity,
        entryPrice,
        markPrice,
        unrealizedPnlUsd,
        notionalUsd,
        marginUsd,
      })

      this.activePositions.set(symbol, { side, quantity })
    }
  }

  async syncIncome(marketSymbols = []) {
    if (!this.enable || !this.hasCredentials()) return

    const symbolsSet = new Set((marketSymbols || []).map((s) => String(s).toUpperCase()))
    const rows = await this.requestSigned('GET', '/fapi/v1/income', {
      startTime: this.incomeCursorTs,
      limit: 1000,
    })
    if (!Array.isArray(rows)) return

    let maxTs = this.incomeCursorTs
    for (const it of rows) {
      const symbol = String(it?.symbol || '').toUpperCase()
      if (!symbol) continue
      if (symbolsSet.size > 0 && !symbolsSet.has(symbol)) continue

      const ts = toNumber(it?.time, 0)
      if (ts > maxTs) maxTs = ts

      const key = `${it?.tranId ?? 'na'}:${symbol}:${it?.incomeType ?? 'NA'}:${ts}:${it?.income ?? '0'}`
      if (this.seenIncomeKeys.has(key)) continue
      this.seenIncomeKeys.add(key)

      const incomeType = String(it?.incomeType || '')
      const incomeUsd = toNumber(it?.income, 0)

      const stats =
        this.incomeStats.get(symbol) ??
        {
          realizedPnlUsd: 0,
          commissionUsd: 0,
          fundingUsd: 0,
          netUsd: 0,
          events: 0,
        }

      if (incomeType === 'REALIZED_PNL') stats.realizedPnlUsd += incomeUsd
      else if (incomeType === 'COMMISSION') stats.commissionUsd += incomeUsd
      else if (incomeType === 'FUNDING_FEE') stats.fundingUsd += incomeUsd

      stats.netUsd += incomeUsd
      stats.events += 1

      this.incomeStats.set(symbol, stats)
    }

    this.incomeCursorTs = maxTs + 1
  }

  getPosition(symbolUpper) {
    return this.positionSnapshot.get(String(symbolUpper || '').toUpperCase()) ?? null
  }

  getIncomeStats(symbolUpper) {
    return (
      this.incomeStats.get(String(symbolUpper || '').toUpperCase()) ?? {
        realizedPnlUsd: 0,
        commissionUsd: 0,
        fundingUsd: 0,
        netUsd: 0,
        events: 0,
      }
    )
  }

  getLastAction(symbolUpper) {
    return this.lastActionBySymbol.get(String(symbolUpper || '').toUpperCase()) ?? 'none'
  }
}

function formatQty(value) {
  const n = toNumber(value, 0)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  return n.toFixed(6)
}

module.exports = {
  LiveTrader,
}
