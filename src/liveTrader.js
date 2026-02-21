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

function roundUpToStep(value, stepSize) {
  const step = toNumber(stepSize, 0)
  if (!Number.isFinite(step) || step <= 0) return value

  const n = Math.ceil(value / step) * step
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
    this.forceIsolated = options.forceIsolated !== false
    this.entryMode = String(options.entryMode || 'LIMIT_GTX').toUpperCase()
    this.gtxTimeoutMs = Math.max(500, Math.floor(toNumber(options.gtxTimeoutMs, 4000)))
    this.gtxPollMs = Math.max(100, Math.floor(toNumber(options.gtxPollMs, 400)))
    this.gtxFallbackMarket = options.gtxFallbackMarket !== false
    this.spreadMaxBpsDefault = Math.max(0, toNumber(options.spreadMaxBpsDefault, 25))
    this.spreadMaxBpsByMarketSymbol = new Map(
      Object.entries(options.spreadMaxBpsByMarketSymbol || {}).map(([k, v]) => [String(k).toUpperCase(), toNumber(v, this.spreadMaxBpsDefault)]),
    )

    this.baseUrl = options.baseUrl || (this.testnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com')

    this.symbolMeta = new Map() // marketSymbolUpper -> { minQty, stepSize, tickSize }
    this.marginTypeBySymbol = new Map() // marketSymbolUpper -> ISOLATED/CROSSED/UNKNOWN
    this.maxLeverageBySymbol = new Map() // marketSymbolUpper -> max leverage from bracket
    this.effectiveLeverageBySymbol = new Map() // marketSymbolUpper -> leverage actually set/used
    this.lastSpreadBpsBySymbol = new Map() // marketSymbolUpper -> spread in bps (last entry check)
    this.activePositions = new Map() // marketSymbolUpper -> { side, quantity }
    this.inFlight = new Set()
    this.positionSnapshot = new Map() // marketSymbolUpper -> { side, quantity, entryPrice, markPrice, unrealizedPnlUsd, notionalUsd, marginUsd }
    this.incomeStats = new Map() // marketSymbolUpper -> { realizedPnlUsd, commissionUsd, fundingUsd, netUsd, events }
    this.lastActionBySymbol = new Map() // marketSymbolUpper -> short last action text
    this.incomeCursorTs = Date.now() - 60_000
    this.seenIncomeKeys = new Set()

    this.lastError = null
    this.ready = false
    this.isDualSidePosition = false
  }

  getStatus() {
    if (!this.enable) return 'OFF'
    if (!this.apiKey || !this.apiSecret) return 'ON (missing keys)'
    if (!this.ready) return 'ON (init...)'
    const posMode = this.isDualSidePosition ? 'HEDGE' : 'ONEWAY'
    const marginMode = this.forceIsolated ? 'ISOLATED' : 'MARGIN-AUTO'
    const entryMode = this.entryMode === 'LIMIT_GTX' ? `LIMIT+GTX${this.gtxFallbackMarket ? '->MKT' : ''}` : this.entryMode
    return `${this.testnet ? 'ON TESTNET' : 'ON REAL'} | ${posMode} | ${marginMode} | ${entryMode}`
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

      await this.loadPositionMode()
      await this.loadExchangeInfo(symbolsUpper)

      try {
        await this.loadLeverageBrackets(symbolsUpper)
      } catch {
        // leverage bracket is best-effort; we still can continue with fallback candidates
      }

      await Promise.all(symbolsUpper.map(async (symbolUpper) => this.configureMarginType(symbolUpper)))
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
      const priceFilter = Array.isArray(s.filters) ? s.filters.find((f) => f.filterType === 'PRICE_FILTER') : null
      const minQty = lot ? toNumber(lot.minQty, 0) : 0
      const stepSize = lot ? String(lot.stepSize) : '0.001'
      const tickSize = priceFilter ? String(priceFilter.tickSize) : '0.0001'

      this.symbolMeta.set(symbol, { minQty, stepSize, tickSize })
    }
  }

  async setLeverage(symbolUpper, leverage) {
    return this.requestSigned('POST', '/fapi/v1/leverage', {
      symbol: symbolUpper,
      leverage,
    })
  }

  async loadPositionMode() {
    const data = await this.requestSigned('GET', '/fapi/v1/positionSide/dual')
    const raw = data?.dualSidePosition
    this.isDualSidePosition = raw === true || String(raw).toLowerCase() === 'true'
  }

  async setMarginTypeIsolated(symbolUpper) {
    return this.requestSigned('POST', '/fapi/v1/marginType', {
      symbol: symbolUpper,
      marginType: 'ISOLATED',
    })
  }

  async configureMarginType(symbolUpper) {
    if (!this.forceIsolated) {
      this.marginTypeBySymbol.set(symbolUpper, 'AUTO')
      return 'AUTO'
    }

    try {
      await this.setMarginTypeIsolated(symbolUpper)
      this.marginTypeBySymbol.set(symbolUpper, 'ISOLATED')
      return 'ISOLATED'
    } catch (error) {
      const code = parseBinanceErrorCode(error)
      const message = String(error?.message || '')

      // Already isolated on this symbol.
      if (code === -4046 || message.includes('No need to change margin type.')) {
        this.marginTypeBySymbol.set(symbolUpper, 'ISOLATED')
        return 'ISOLATED'
      }

      // Could not switch now (often due existing position/order); keep running.
      this.marginTypeBySymbol.set(symbolUpper, 'UNKNOWN')
      return 'UNKNOWN'
    }
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

  normalizePrice(symbolUpper, priceRaw, side) {
    const meta = this.symbolMeta.get(symbolUpper)
    const price = toNumber(priceRaw, 0)
    if (!meta || !Number.isFinite(price) || price <= 0) return null

    const tickSize = meta.tickSize || '0.0001'
    const normalized = side === 'long' ? roundDownToStep(price, tickSize) : roundUpToStep(price, tickSize)
    if (!Number.isFinite(normalized) || normalized <= 0) return null
    return normalized
  }

  getSpreadMaxBps(symbolUpper) {
    const specific = this.spreadMaxBpsByMarketSymbol.get(symbolUpper)
    if (Number.isFinite(specific) && specific >= 0) return specific
    return this.spreadMaxBpsDefault
  }

  async fetchBookTicker(symbolUpper) {
    const row = await this.requestPublic('/fapi/v1/ticker/bookTicker', { symbol: symbolUpper })
    const bidPrice = toNumber(row?.bidPrice, 0)
    const askPrice = toNumber(row?.askPrice, 0)
    if (!Number.isFinite(bidPrice) || !Number.isFinite(askPrice) || bidPrice <= 0 || askPrice <= 0) {
      throw new Error(`Invalid bookTicker for ${symbolUpper}`)
    }
    const spreadBps = askPrice > bidPrice ? ((askPrice - bidPrice) / ((askPrice + bidPrice) / 2)) * 10_000 : 0
    this.lastSpreadBpsBySymbol.set(symbolUpper, spreadBps)
    return { bidPrice, askPrice, spreadBps }
  }

  async getOrder(symbolUpper, orderId) {
    return this.requestSigned('GET', '/fapi/v1/order', {
      symbol: symbolUpper,
      orderId,
    })
  }

  async cancelOrder(symbolUpper, orderId) {
    return this.requestSigned('DELETE', '/fapi/v1/order', {
      symbol: symbolUpper,
      orderId,
    })
  }

  async placeOpenMarket(symbolUpper, side, qty) {
    const orderSide = side === 'long' ? 'BUY' : 'SELL'
    const positionSide = this.getPositionSideParam(side)
    const orderParams = {
      symbol: symbolUpper,
      side: orderSide,
      type: 'MARKET',
      quantity: qty,
      newOrderRespType: 'RESULT',
    }
    if (positionSide) orderParams.positionSide = positionSide
    return this.requestSigned('POST', '/fapi/v1/order', orderParams)
  }

  async placeOpenLimitGtxWithFallback(symbolUpper, side, qty) {
    const { bidPrice, askPrice, spreadBps } = await this.fetchBookTicker(symbolUpper)
    const maxSpreadBps = this.getSpreadMaxBps(symbolUpper)
    if (Number.isFinite(spreadBps) && spreadBps > maxSpreadBps) {
      throw new Error(`Spread ${spreadBps.toFixed(2)} bps > max ${maxSpreadBps.toFixed(2)} bps`)
    }

    const makerPriceRaw = side === 'long' ? bidPrice : askPrice
    const makerPrice = this.normalizePrice(symbolUpper, makerPriceRaw, side)
    if (!makerPrice) throw new Error(`Invalid maker price for ${symbolUpper}`)

    const orderSide = side === 'long' ? 'BUY' : 'SELL'
    const positionSide = this.getPositionSideParam(side)
    const createParams = {
      symbol: symbolUpper,
      side: orderSide,
      type: 'LIMIT',
      timeInForce: 'GTX',
      price: makerPrice,
      quantity: qty,
      newOrderRespType: 'RESULT',
    }
    if (positionSide) createParams.positionSide = positionSide

    const created = await this.requestSigned('POST', '/fapi/v1/order', createParams)
    const orderId = toNumber(created?.orderId, 0)

    if (!(orderId > 0)) {
      const immediateQty = toNumber(created?.executedQty, 0)
      return {
        executedQty: immediateQty,
        orderId: created?.orderId ?? '-',
        route: 'GTX',
        spreadBps,
      }
    }

    const startedAt = Date.now()
    let status = created

    while (Date.now() - startedAt < this.gtxTimeoutMs) {
      await sleep(this.gtxPollMs)
      status = await this.getOrder(symbolUpper, orderId)
      const st = String(status?.status || '').toUpperCase()
      if (st === 'FILLED' || st === 'CANCELED' || st === 'EXPIRED' || st === 'REJECTED') break
    }

    try {
      status = await this.getOrder(symbolUpper, orderId)
    } catch {
      // keep previous status snapshot
    }

    const executedQty = toNumber(status?.executedQty, 0)
    const origQty = toNumber(status?.origQty, qty)
    let remainingQty = Math.max(0, origQty - executedQty)
    const st = String(status?.status || '').toUpperCase()

    if (remainingQty > 0 && st !== 'CANCELED' && st !== 'EXPIRED' && st !== 'REJECTED' && st !== 'FILLED') {
      try {
        await this.cancelOrder(symbolUpper, orderId)
      } catch {
        // ignore cancel race
      }
      try {
        status = await this.getOrder(symbolUpper, orderId)
      } catch {
        // keep last known status
      }
      const execAfterCancel = toNumber(status?.executedQty, executedQty)
      remainingQty = Math.max(0, origQty - execAfterCancel)
    }

    if (this.gtxFallbackMarket && remainingQty > 0) {
      const marketQty = this.normalizeQuantity(symbolUpper, remainingQty)
      if (marketQty && marketQty > 0) {
        const marketOrder = await this.placeOpenMarket(symbolUpper, side, marketQty)
        const marketExec = toNumber(marketOrder?.executedQty, marketQty)
        return {
          executedQty: Math.max(0, toNumber(status?.executedQty, 0)) + Math.max(0, marketExec),
          orderId: marketOrder?.orderId ?? orderId,
          route: 'GTX->MKT',
          spreadBps,
        }
      }
    }

    return {
      executedQty: Math.max(0, toNumber(status?.executedQty, 0)),
      orderId,
      route: 'GTX',
      spreadBps,
    }
  }

  getPositionSideParam(side) {
    if (!this.isDualSidePosition) return null
    return side === 'long' ? 'LONG' : 'SHORT'
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

      const useLimitGtx = this.entryMode === 'LIMIT_GTX'
      let result = null

      if (useLimitGtx) {
        try {
          result = await this.placeOpenLimitGtxWithFallback(symbolUpper, side, qty)
        } catch (error) {
          const code = parseBinanceErrorCode(error)
          const isPostOnlyImmediateMatch = code === -5022 || code === -2010
          if (this.gtxFallbackMarket && isPostOnlyImmediateMatch) {
            const fallbackMarket = await this.placeOpenMarket(symbolUpper, side, qty)
            result = {
              ...fallbackMarket,
              executedQty: toNumber(fallbackMarket?.executedQty, qty),
              route: 'MKT(FB-post-only)',
              spreadBps: this.lastSpreadBpsBySymbol.get(symbolUpper) ?? null,
            }
          } else {
            throw error
          }
        }
      } else {
        result = await this.placeOpenMarket(symbolUpper, side, qty)
      }

      const executedQty = toNumber(result?.executedQty, 0)
      if (!(executedQty > 0)) {
        throw new Error(`Order not filled for ${symbolUpper}`)
      }

      this.activePositions.set(symbolUpper, {
        side,
        quantity: executedQty,
      })

      const routeText = result?.route ? ` ${result.route}` : ''
      const spreadText = Number.isFinite(result?.spreadBps) ? ` | spread ${result.spreadBps.toFixed(2)}bps` : ''
      this.lastActionBySymbol.set(
        symbolUpper,
        `OPEN ${side.toUpperCase()} ok qty ${formatQty(executedQty)}${routeText}${spreadText} #${result?.orderId ?? '-'}`,
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
      const positionSide = this.getPositionSideParam(active.side)
      const orderParams = {
        symbol: symbolUpper,
        side: closeSide,
        type: 'MARKET',
        quantity: qty,
        newOrderRespType: 'RESULT',
      }
      if (positionSide) {
        orderParams.positionSide = positionSide
      } else {
        orderParams.reduceOnly = 'true'
      }

      const result = await this.requestSigned('POST', '/fapi/v1/order', orderParams)

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

      const positionSideRaw = String(p.positionSide || '').toUpperCase()
      const entryPrice = toNumber(p.entryPrice, 0)
      const markPrice = toNumber(p.markPrice, 0)
      const unrealizedPnlUsd = toNumber(p.unRealizedProfit, 0)
      const notionalUsd = Math.abs(toNumber(p.notional, 0))
      const marginUsd = Math.abs(toNumber(p.isolatedMargin, 0)) || this.marginUsd
      const leverage = Math.floor(toNumber(p.leverage, this.getEffectiveLeverage(symbol)))
      if (leverage > 0) this.effectiveLeverageBySymbol.set(symbol, Math.min(20, leverage))
      const marginType = String(p.marginType || '').toUpperCase()
      if (marginType) this.marginTypeBySymbol.set(symbol, marginType)

      let side = positionAmt > 0 ? 'long' : 'short'
      if (this.isDualSidePosition) {
        if (positionSideRaw === 'LONG') side = 'long'
        else if (positionSideRaw === 'SHORT') side = 'short'
      }
      const quantity = Math.abs(positionAmt)

      const existing = this.positionSnapshot.get(symbol)
      if (existing && existing.notionalUsd >= notionalUsd) continue

      this.positionSnapshot.set(symbol, {
        side,
        quantity,
        entryPrice,
        markPrice,
        unrealizedPnlUsd,
        notionalUsd,
        marginUsd,
        marginType: marginType || this.marginTypeBySymbol.get(symbol) || 'UNKNOWN',
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

  getLastSpreadBps(symbolUpper) {
    return this.lastSpreadBpsBySymbol.get(String(symbolUpper || '').toUpperCase()) ?? null
  }
}

function formatQty(value) {
  const n = toNumber(value, 0)
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1000) return n.toFixed(2)
  if (n >= 1) return n.toFixed(4)
  return n.toFixed(6)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = {
  LiveTrader,
}
