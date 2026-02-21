'use strict'

const https = require('https')

const { BINANCE_FUTURES_REST_BASE, HISTORY_CANDLES, HISTORY_INTERVAL } = require('./config')

function fetchJson(url) {
  if (typeof fetch === 'function') {
    return fetch(url).then(async (response) => {
      if (!response.ok) {
        const body = await response.text()
        throw new Error(`HTTP ${response.status} ${body}`)
      }
      return response.json()
    })
  }

  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let raw = ''
      res.on('data', (chunk) => {
        raw += chunk
      })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} ${raw}`))
          return
        }

        try {
          resolve(JSON.parse(raw))
        } catch {
          reject(new Error('Invalid JSON response'))
        }
      })
    })

    req.on('error', reject)
  })
}

async function fetchKlineHistory(marketSymbol, interval = HISTORY_INTERVAL, limit = HISTORY_CANDLES) {
  const symbol = marketSymbol.toUpperCase()
  const endpoint = `${BINANCE_FUTURES_REST_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  const rows = await fetchJson(endpoint)

  if (!Array.isArray(rows)) {
    throw new Error(`Unexpected history payload for ${symbol}`)
  }

  return rows
    .map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: Number(r[6]),
    }))
    .filter((c) => Number.isFinite(c.closeTime) && Number.isFinite(c.close))
}

function parseRawSocketMessage(messageArg) {
  if (typeof messageArg === 'string') return messageArg
  if (Buffer.isBuffer(messageArg)) return messageArg.toString('utf8')

  const data = messageArg?.data
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.from(data).toString('utf8')

  return null
}

function parseSocketPayload(rawMessage) {
  if (!rawMessage) return null

  try {
    return JSON.parse(rawMessage)
  } catch {
    return null
  }
}

function normalizeStreamEvent(payload) {
  const data = payload?.data ?? payload
  if (!data || typeof data !== 'object') return null

  const stream = typeof payload?.stream === 'string' ? payload.stream : ''
  const streamMarketSymbol = stream.split('@')[0]

  if (data.e === 'trade') {
    const marketSymbol = (data.s || streamMarketSymbol || '').toLowerCase()
    return {
      type: 'trade',
      marketSymbol,
      price: Number(data.p),
      qty: Number(data.q),
      ts: Number(data.T),
    }
  }

  if (data.e === 'markPriceUpdate') {
    const marketSymbol = (data.s || streamMarketSymbol || '').toLowerCase()
    return {
      type: 'mark',
      marketSymbol,
      price: Number(data.p),
      ts: Number(data.E),
    }
  }

  if (data.e === 'kline' && data.k) {
    const marketSymbol = (data.s || streamMarketSymbol || '').toLowerCase()
    return {
      type: 'kline',
      marketSymbol,
      isClosed: Boolean(data.k.x),
      open: Number(data.k.o),
      high: Number(data.k.h),
      low: Number(data.k.l),
      close: Number(data.k.c),
      volume: Number(data.k.v),
      closeTime: Number(data.k.T),
      openTime: Number(data.k.t),
    }
  }

  return null
}

module.exports = {
  fetchKlineHistory,
  normalizeStreamEvent,
  parseRawSocketMessage,
  parseSocketPayload,
}
