const URL = "https://fapi.coinglass.com/api/coin/v2/info?symbol=PEPE";
const INTERVAL_MS = 1000;
const REQUEST_TIMEOUT_MS = 8000;

let isRunning = false;
let previousPrice = null;

function formatNumber(value, digits = 2) {
  if (typeof value !== "number" || Number.isNaN(value)) return "N/A";
  return value.toFixed(digits);
}

function renderLine(text) {
  process.stdout.write(`\r${text}   `);
}

async function fetchOnce() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    const data = json?.data ?? {};
    const currentPrice = typeof data.price === "number" ? data.price : null;
    let tickChangeText = "N/A";

    if (currentPrice !== null && previousPrice !== null && previousPrice !== 0) {
      const tickPercent = ((currentPrice - previousPrice) / previousPrice) * 100;
      const sign = tickPercent > 0 ? "+" : "";
      tickChangeText = `${sign}${formatNumber(tickPercent, 4)}%`;
    }

    const line =
      `symbol=${data.symbol ?? "N/A"} ` +
      `price=${formatNumber(currentPrice, 10)} ` +
      `prev=${formatNumber(previousPrice, 10)} ` +
      `tick=${tickChangeText} ` +
      `24h=${formatNumber(data.priceChangePercent24h, 4)}%`;

    renderLine(line);
    previousPrice = currentPrice;
  } catch (err) {
    const message = err?.name === "AbortError" ? "Request timeout" : err.message;
    renderLine(`Error: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function tick() {
  if (isRunning) return;
  isRunning = true;
  await fetchOnce();
  isRunning = false;
}

console.log("Starting PEPE live fetch (every 1s). Press Ctrl+C to stop.");
void tick();
const timer = setInterval(tick, INTERVAL_MS);

process.on("SIGINT", () => {
  clearInterval(timer);
  process.stdout.write("\nStopped.\n");
  process.exit(0);
});
