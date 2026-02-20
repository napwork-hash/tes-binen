# Coinglass Live Price Viewer

Console-only live fetcher (no database, no Docker).

## Run

```powershell
node .\index.js
```

## Symbols

`XAU`, `BTC`, `ETH`, `PEPE`

## Optional env

Set fetch interval in milliseconds:

```powershell
$env:FETCH_INTERVAL_MS="1000"
node .\index.js
```
