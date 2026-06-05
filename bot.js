/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Exchange: Coinbase Advanced Trade API (JWT auth, EC private key)
 * Market data: Binance public API (free, no auth)
 * Strategy: CoinsKid RSI 4H
 *
 * Local mode:  node bot.js
 * Cloud mode:  deployed to Railway on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["COINBASE_API_KEY", "COINBASE_API_SECRET"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — opening it for you to fill in...\n");
    writeFileSync(
      ".env",
      [
        "# Coinbase Advanced Trade credentials",
        "COINBASE_API_KEY=",
        "COINBASE_API_SECRET=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=40",
        "MAX_TRADE_SIZE_USD=7",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTC-USD",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try { execSync("open .env"); } catch {}
    console.log("Fill in your Coinbase credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try { execSync("open .env"); } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTC-USD",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "40"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "7"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  coinbase: {
    apiKey: process.env.COINBASE_API_KEY,
    apiSecret: process.env.COINBASE_API_SECRET,
    baseUrl: "https://api.coinbase.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Kraken public API — free, no auth, US-accessible) ─────────

async function fetchCandles(symbol, interval, limit = 500) {
  // Map Coinbase symbol format to Kraken pair
  const krakenPairMap = {
    "BTC-USD": "XBTUSD", "ETH-USD": "ETHUSD", "SOL-USD": "SOLUSD",
    "DOGE-USD": "XDGUSD", "XRP-USD": "XXRPZUSD", "ADA-USD": "ADAUSD",
    "AVAX-USD": "AVAXUSD", "MATIC-USD": "MATICUSD", "DOT-USD": "DOTUSD",
    "LINK-USD": "LINKUSD",
  };
  const krakenPair = krakenPairMap[symbol] || symbol.replace("-", "");

  // Kraken interval is in minutes
  const intervalMap = {
    "1m": 1, "5m": 5, "15m": 15, "30m": 30,
    "1H": 60, "4H": 240, "1D": 1440, "1W": 10080,
  };
  const krakenInterval = intervalMap[interval] || 240;

  const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=${krakenInterval}`;
  const res = await fetch(url, { headers: { "User-Agent": "trading-bot/1.0" } });
  if (!res.ok) throw new Error(`Kraken API error: ${res.status}`);
  const json = await res.json();

  if (json.error && json.error.length > 0) {
    throw new Error(`Kraken API error: ${json.error.join(", ")}`);
  }

  // Kraken returns {result: {PAIR: [[time, open, high, low, close, vwap, volume, count], ...]}}
  const pairKey = Object.keys(json.result).find((k) => k !== "last");
  const candles = json.result[pairKey];

  // Kraken returns oldest → newest; time is Unix seconds
  return candles.map((k) => ({
    time: parseInt(k[0]) * 1000, // convert to ms
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[6]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");
    check("Price above VWAP (buyers in control)", `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap);
    check("Price above EMA(8) (uptrend confirmed)", `> ${ema8.toFixed(2)}`, price.toFixed(2), price > ema8);
    check("RSI(3) below 30 (snap-back setup in uptrend)", "< 30", rsi3.toFixed(2), rsi3 < 30);
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${distFromVWAP.toFixed(2)}%`, distFromVWAP < 1.5);

  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");
    check("Price below VWAP (sellers in control)", `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);
    check("Price below EMA(8) (downtrend confirmed)", `< ${ema8.toFixed(2)}`, price.toFixed(2), price < ema8);
    check("RSI(3) above 70 (reversal setup in downtrend)", "> 70", rsi3.toFixed(2), rsi3 > 70);
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check("Price within 1.5% of VWAP (not overextended)", "< 1.5%", `${distFromVWAP.toFixed(2)}%`, distFromVWAP < 1.5);

  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({ label: "Market bias", required: "Bullish or bearish", actual: "Neutral", pass: false });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return false;
  }
  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);

  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);
  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(`🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`);
    return false;
  }
  console.log(`✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`);
  return true;
}

// ─── Coinbase Advanced Trade API (JWT auth) ──────────────────────────────────

function generateCoinbaseJWT(method, path) {
  const keyName = CONFIG.coinbase.apiKey;

  // Handle both literal \n strings and real newlines in the private key
  const rawSecret = CONFIG.coinbase.apiSecret.replace(/\\n/g, "\n").trim();

  // Ensure PEM headers are present
  const fullPEM = rawSecret.includes("-----BEGIN")
    ? rawSecret
    : `-----BEGIN EC PRIVATE KEY-----\n${rawSecret}\n-----END EC PRIVATE KEY-----`;

  const nonce = crypto.randomBytes(16).toString("hex");

  const header = { alg: "ES256", kid: keyName, nonce, typ: "JWT" };
  const payload = {
    sub: keyName,
    iss: "cdp",
    nbf: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 120,
    uri: `${method} api.coinbase.com${path}`,
  };

  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${b64url(header)}.${b64url(payload)}`;

  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  const signature = sign.sign(fullPEM, "base64url");

  return `${signingInput}.${signature}`;
}

async function placeCoinbaseOrder(symbol, side, sizeUSD, price) {
  const path = "/api/v3/brokerage/orders";
  const jwt = generateCoinbaseJWT("POST", path);

  const clientOrderId = `bot-${Date.now()}`;
  const baseSize = (sizeUSD / price).toFixed(8);

  const body = JSON.stringify({
    client_order_id: clientOrderId,
    product_id: symbol,         // e.g. "BTC-USD"
    side: side.toUpperCase(),   // "BUY" or "SELL"
    order_configuration: {
      market_market_ioc: {
        base_size: baseSize,
      },
    },
  });

  const res = await fetch(`${CONFIG.coinbase.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body,
  });

  const data = await res.json();

  if (!data.success) {
    const errMsg = data.error_response?.message || data.error || JSON.stringify(data);
    throw new Error(`Coinbase order failed: ${errMsg}`);
  }

  return data.order_id || clientOrderId;
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

const CSV_HEADERS = [
  "Date", "Time (UTC)", "Exchange", "Symbol", "Side",
  "Quantity", "Price", "Total USD", "Fee (est.)", "Net Amount",
  "Order ID", "Mode", "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(`📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`);
  }
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "", quantity = "", totalUSD = "", fee = "", netAmount = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED"; orderId = "BLOCKED"; notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(8);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.006).toFixed(4); // Coinbase ~0.6% taker fee
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER"; notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(8);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.006).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE"; notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date, time, "Coinbase", logEntry.symbol, side, quantity,
    logEntry.price.toFixed(2), totalUSD, fee, netAmount, orderId, mode, `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));
  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");
  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — Coinbase Advanced");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol} on Coinbase`);
      try {
        const orderId = await placeCoinbaseOrder(CONFIG.symbol, "buy", tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = orderId;
        console.log(`✅ ORDER PLACED — ${orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
