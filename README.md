# Binance Kline Live Price Viewer

Console-only live streamer from Binance websocket kline/candlestick feed (no database, no Docker).

## Run

```powershell
npm install
node .\index.js
```

## Symbols

`XAU` (via `PAXGUSDT`), `BTC`, `ETH`, `PEPE`

## Optional env

Set render interval in milliseconds:

```powershell
$env:FETCH_INTERVAL_MS="1000"
node .\index.js
```

Set Binance kline timeframe:

```powershell
$env:BINANCE_KLINE_INTERVAL="1m"
node .\index.js
```
