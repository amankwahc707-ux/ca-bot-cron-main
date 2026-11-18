// signals.js — Signal engine for CA Bot Cron
// Includes 1h/4h entry triggers + timeframe-aware stops
// Runs in Node (GitHub Actions) — includes window/STATE shims

// ═══ NODE SHIMS (browser globals that signalFrom() references) ═══
const STATE = {
  mode: "MEDIUM",
  news: { sentiment: {} },
  oiHistory: {},
  bookCache: {},
  mids: {},
};
const window = {
  macroEventSoon: false,
  whaleBias: {},
  whaleRatio: {},
  _rejectionLong: false,
  _rejectionShort: false,
};

// ═══ CONFIG ═══
const BYBIT_API = "https://api.bybit.com";
const BIQUOTE_API = "https://biquote.io/api";
const IV_MS = { "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 };
const BYBIT_IV = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };

const CRYPTO_UNIVERSE = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","LINK","AVAX","LTC","BCH","SUI","NEAR","APT","ARB","OP","INJ","TIA","SEI","ATOM","DOT","AAVE","PEPE","WIF","AR","TON","TRX","FIL","ENA","WLD","ONDO","FET","RENDER","JUP","PYTH","STRK","W","LDO","ORDI","STX","IMX","HBAR","GRT","SAND","MANA","AXS","FTM","GALA"];
const FOREX_UNIVERSE = [];
const COMMODITY_UNIVERSE = [];

function getAssetClass(sym) {
  if (FOREX_SYMBOLS.has(sym)) return "FOREX";
  if (COMMODITY_SYMBOLS.has(sym)) return "COMMODITY";
  return "CRYPTO";
}

// ═══ MODES ═══
const MODES = {
  LOOSE: {
    id: "LOOSE", label: "🟢 LOOSE", color: "#2ecc83",
    scoreBuy: 68, scoreWait: 43,
    adx5Buy: 20, adx15Buy: 10, volBuy: 0.9, softBuy: 3, conflictBuy: 1,
    pullbackLow: -0.9, pullbackHigh: 0.4, breakoutVol: 1.0,
    waitGatesMissing: 8,
    sellAdxGate: 20, sellBearGate: 55, sellVolGate: 0.9, sellSoft: 3,
    sellGatesRequired: 7, sellRelaxedH1: true,
    scalpVolSurge: 1.1, scalpBarRange: 0.5,
    scalpRsiLongMin: 38, scalpRsiLongMax: 78,
    scalpRsiShortMin: 22, scalpRsiShortMax: 62,
    scalpRequireSlope: false,
    autoConfidence: ["CONFIDENT", "CERTAIN"],
    autoNotionalPct: 2000, autoRiskPct: 8, autoMaxStopPct: 7,
    autoTrailDD: 10, autoCorrCap: 3, autoSectorCap: 60,
    autoSwingCooldown: 1 * 60 * 1000, autoScalpCooldown: 1 * 60 * 1000,
    autoStaleSwing: 2, autoStaleScalp: { "5m": 0.25, "15m": 0.5, "1h": 1.5, "4h": 4 },
    defaultLeverage: 10, fastVolSurge: 1.1
  },
  MEDIUM: {
    id: "MEDIUM", label: "🟡 MEDIUM", color: "#f0b429",
    scoreBuy: 72, scoreWait: 48,
    adx5Buy: 24, adx15Buy: 12, volBuy: 1.0, softBuy: 4, conflictBuy: 0,
    pullbackLow: -0.7, pullbackHigh: 0.3, breakoutVol: 1.15,
    waitGatesMissing: 7,
    sellAdxGate: 24, sellBearGate: 62, sellVolGate: 1.0, sellSoft: 3,
    sellGatesRequired: 7, sellRelaxedH1: true,
    scalpVolSurge: 1.3, scalpBarRange: 0.6,
    scalpRsiLongMin: 40, scalpRsiLongMax: 75,
    scalpRsiShortMin: 25, scalpRsiShortMax: 60,
    scalpRequireSlope: false,
    autoConfidence: ["CERTAIN", "CONFIDENT"],
    autoNotionalPct: 1200, autoRiskPct: 5, autoMaxStopPct: 6,
    autoTrailDD: 8, autoCorrCap: 2, autoSectorCap: 60,
    autoSwingCooldown: 3 * 60 * 1000, autoScalpCooldown: 1 * 60 * 1000,
    autoStaleSwing: 4, autoStaleScalp: { "5m": 0.5, "15m": 1, "1h": 3, "4h": 8 },
    defaultLeverage: 8, fastVolSurge: 1.3
  },
  STRICT: {
    id: "STRICT", label: "🔴 STRICT", color: "#ff5d68",
    scoreBuy: 75, scoreWait: 53,
    adx5Buy: 27, adx15Buy: 17, volBuy: 1.15, softBuy: 4, conflictBuy: 0,
    pullbackLow: -0.8, pullbackHigh: 0.35, breakoutVol: 1.1,
    waitGatesMissing: 6,
    sellAdxGate: 25, sellBearGate: 65, sellVolGate: 1.0, sellSoft: 4,
    sellGatesRequired: 7, sellRelaxedH1: false,
    scalpVolSurge: 1.4, scalpBarRange: 0.7,
    scalpRsiLongMin: 42, scalpRsiLongMax: 72,
    scalpRsiShortMin: 28, scalpRsiShortMax: 58,
    scalpRequireSlope: false,
    autoConfidence: ["CERTAIN"],
    autoNotionalPct: 800, autoRiskPct: 3, autoMaxStopPct: 5,
    autoTrailDD: 6, autoCorrCap: 2, autoSectorCap: 60,
    autoSwingCooldown: 5 * 60 * 1000, autoScalpCooldown: 2 * 60 * 1000,
    autoStaleSwing: 6, autoStaleScalp: { "5m": 1, "15m": 2, "1h": 4, "4h": 12 },
    defaultLeverage: 6, fastVolSurge: 1.4
  }
};

// ═══ INDICATORS ═══
function ema(vals, n) {
  if (vals.length < n) return null;
  const k = 2 / (n + 1);
  let e = vals.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}
function emaSeries(vals, n) {
  if (vals.length < n) return [];
  const k = 2 / (n + 1);
  let e = vals.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const out = [e];
  for (let i = n; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function wilderLast(vals, n) {
  if (vals.length < n) return null;
  let a = vals.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < vals.length; i++) a = (a * (n - 1) + vals[i]) / n;
  return a;
}
function wilderSeries(vals, n) {
  if (vals.length < n) return [];
  let a = vals.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const out = [a];
  for (let i = n; i < vals.length; i++) { a = (a * (n - 1) + vals[i]) / n; out.push(a); }
  return out;
}
function rsi(cs, n = 14) {
  if (cs.length <= n + 1) return null;
  const g = [], l = [];
  for (let i = 1; i < cs.length; i++) {
    g.push(Math.max(cs[i] - cs[i - 1], 0));
    l.push(Math.max(cs[i - 1] - cs[i], 0));
  }
  const ag = wilderLast(g, n), al = wilderLast(l, n);
  if (ag == null || al == null) return null;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function atr(cs, n = 14) {
  if (cs.length <= n) return null;
  const trs = [];
  for (let i = 1; i < cs.length; i++) trs.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c)));
  return wilderLast(trs, n);
}
function adx(cs, n = 14) {
  if (cs.length < 2 * n + 1) return { adx: null };
  const pdm = [], mdm = [], trs = [];
  for (let i = 1; i < cs.length; i++) {
    const up = cs[i].h - cs[i-1].h, dn = cs[i-1].l - cs[i].l;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c)));
  }
  const st = wilderSeries(trs, n), sp = wilderSeries(pdm, n), sm = wilderSeries(mdm, n);
  if (!st.length) return { adx: null };
  const dx = [];
  for (let i = 0; i < st.length; i++) {
    if (st[i] === 0) { dx.push(0); continue; }
    const lp = 100 * sp[i] / st[i], lm = 100 * sm[i] / st[i];
    dx.push((lp + lm) === 0 ? 0 : 100 * Math.abs(lp - lm) / (lp + lm));
  }
  const as = wilderSeries(dx, n);
  return { adx: as.length ? as[as.length - 1] : null };
}
function volRatio(cs) {
  if (cs.length < 12) return 1;
  const recent = cs.slice(-6).map(c => c.v);
  const base = cs.length >= 72 ? cs.slice(-72, -6).map(c => c.v) : cs.slice(0, -6).map(c => c.v);
  const mR = recent.reduce((a,b)=>a+b,0)/recent.length;
  const mB = base.reduce((a,b)=>a+b,0)/Math.max(base.length, 1);
  return mB > 0 ? mR / mB : 1;
}

// ═══ CANDLES ═══
async function fetchHLCandles(symbol, interval, lookback = 250) {
  const infoUrl = "https://api.hyperliquid-testnet.xyz/info";
  const ivMs = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 }[interval];
  const end = Date.now();
  const start = end - (ivMs * lookback);
  
  try {
    const res = await fetch(infoUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "candleSnapshot",
        req: { coin: symbol, interval, startTime: start, endTime: end }
      })
    });
    const raw = await res.json();
    if (!Array.isArray(raw)) throw new Error("Invalid HL response");
    return raw.map(c => ({ t: c.t, T: c.T, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v }));
  } catch (e) {
    console.error(`HL ${symbol} ${interval}:`, e.message);
    throw e;
  }
}

async function fetchCandles(coin, interval, lookback = 320) {
  return fetchHLCandles(coin, interval, lookback);
}
const candleCache = new Map();
async function getCandles(coin, interval, lookback = 320) {
  const key = `${coin}|${interval}`;
  if (candleCache.has(key)) return candleCache.get(key);
  try {
    const data = await fetchCandles(coin, interval, lookback);
    candleCache.set(key, data);
    return data;
  } catch (e) {
    if (candleCache.has(key)) return candleCache.get(key);
    throw e;
  }
}

// ═══ TF BUILDER ═══
function tf(candles, livePrice) {
  if (!candles || candles.length < 10) return null;
  const cs = candles.map(c => ({ ...c }));
  const last = cs[cs.length - 1];
  if (livePrice > 0) { last.c = livePrice; last.h = Math.max(last.h, livePrice); last.l = Math.min(last.l, livePrice); }
  const closes = cs.map(c => c.c);
  return {
    candles: cs, closes,
    e20: ema(closes, 20), e50: ema(closes, 50), e200: ema(closes, 200),
    e20s: emaSeries(closes, 20), e50s: emaSeries(closes, 50),
    rsi: rsi(closes), atr: atr(cs), adx: adx(cs).adx,
    price: livePrice || closes[closes.length - 1]
  };
}
function trendOf(t) {
  if (!t || t.e20 == null || t.e50 == null) return "FLAT";
  const up = t.e20 > t.e50 && (t.e200 == null || t.e50 > t.e200) && t.price > t.e50;
  const dn = t.e20 < t.e50 && (t.e200 == null || t.e50 < t.e200) && t.price < t.e50;
  if (t.e20s.length >= 6 && t.e50s.length >= 6) {
    let upCount = 0, dnCount = 0;
    const off = t.closes.length - t.e20s.length;
    for (let i = t.e20s.length - 6; i < t.e20s.length - 1; i++) {
      const c = t.closes[i + off];
      if (t.e20s[i] > t.e50s[i] && c > t.e50s[i]) upCount++;
      if (t.e20s[i] < t.e50s[i] && c < t.e50s[i]) dnCount++;
    }
    let fresh = false;
    for (let i = Math.max(2, t.e20s.length - 3); i < t.e20s.length; i++) {
      if ((t.e20s[i-1] - t.e50s[i-1]) * (t.e20s[i] - t.e50s[i]) < 0) { fresh = true; break; }
    }
    if (fresh) return "FLAT";
    if (up && upCount >= 4) return "UP";
    if (dn && dnCount >= 4) return "DOWN";
  }
  return "FLAT";
}

// ═══ SCORE ═══
function computeBullScore(T, adx5, volR, setupOk, momentumOk) {
  let s = 0;
  if (T["4h"]?.trend === "UP") s += 20;
  if (T["1h"]?.trend === "UP") s += 20;
  if (T["15m"]?.trend === "UP") s += 10;
  if (adx5 >= 35) s += 15; else if (adx5 >= 30) s += 10; else if (adx5 >= 25) s += 5;
  if (volR >= 1.8) s += 15; else if (volR >= 1.5) s += 10; else if (volR >= 1.2) s += 5;
  if (setupOk) s += 10;
  if (momentumOk) s += 10;
  if (T["1d"]?.trend === "UP") s += 10;
  return Math.min(100, s);
}
function computeBearScore(T, price, atr5, adx5, volR, rsi5) {
  let s = 0;
  const t1 = T["1h"], t4 = T["4h"], t5 = T["5m"];
  if (t1?.trend === "DOWN") s += 25; else if (t1?.e50 && price < t1.e50) s += 15;
  if (t4?.trend === "DOWN") s += 20;
  if (t5?.trend === "DOWN") s += 8;
  if (adx5 >= 30) s += 22; else if (adx5 >= 25) s += 18; else if (adx5 < 15) s -= 8;
  if (volR >= 1.5) s += 12; else if (volR >= 1.2) s += 7;
  if (rsi5 < 30) s += 12; else if (rsi5 < 40) s += 8; else if (rsi5 < 45) s += 4; else if (rsi5 > 55) s -= 8;
  if (t1?.e50 && atr5 > 0) {
    const d = (price - t1.e50) / atr5;
    if (d < -2) s += 10; else if (d < -1) s += 5;
  }
  return Math.max(0, Math.min(100, s));
}

// ═══ FAST TRIGGER ═══
function checkFastTrigger(T, price, a5, volR, rsi5, rsi1, meta) {
  const mode = MODES[STATE.mode] || MODES.MEDIUM;
  const cs = T["5m"].candles;
  if (!cs || cs.length < 3) return null;
  const c1 = cs[cs.length - 2];
  const c2 = cs[cs.length - 3];
  if (!c1 || !c2) return null;
  const baseline = cs.slice(-20, -2);
  const baselineVol = baseline.reduce((s, c) => s + c.v, 0) / baseline.length;
  if (baselineVol <= 0) return null;
  const volRatio20 = (c1.v + c2.v) / 2 / baselineVol;
  const twoRed = c1.c < c1.o && c2.c < c2.o && c1.c < c2.c;
  const twoGreen = c1.c > c1.o && c2.c > c2.o && c1.c > c2.c;
  const dropSize = c2.o - c1.c;
  const riseSize = c1.c - c2.o;

  if (twoRed && T["4h"].trend !== "UP" && rsi1 != null && rsi1 < 55 && rsi1 > 25) {
    if (volRatio20 >= mode.fastVolSurge && dropSize >= 0.6 * a5) {
      const stop = c2.h + 0.3 * a5;
      const risk = stop - price;
      if (risk > 0 && risk < a5 * 2) {
        const tp1 = price - risk;
        const tp2 = price - 2 * risk;
        return {
          signal: "SELL",
          setup: "FAST_BREAKDOWN",
          confidence: volRatio20 >= mode.fastVolSurge * 1.5 ? "CERTAIN" : "CONFIDENT",
          score: computeBearScore(T, price, a5, T["5m"].adx || 0, volR, rsi5 || 50),
          price, entry: price, stop, tp1, tp2, atr: a5,
          why: `⚡ Fast bear: ${volRatio20.toFixed(1)}x vol`,
          gatesPassed: 7, gatesTotal: 7, soft: 0, trend: T, fast: true,
          trigger_tf: "5m", highest_tf: "5m"
        };
      }
    }
  }

  if (twoGreen && T["4h"].trend !== "DOWN" && rsi5 != null && rsi5 > 45 && rsi5 < 75) {
    if (volRatio20 >= mode.fastVolSurge && riseSize >= 0.6 * a5) {
      const stop = c2.l - 0.3 * a5;
      const risk = price - stop;
      if (risk > 0 && risk < a5 * 2) {
        const tp1 = price + risk;
        const tp2 = price + 2 * risk;
        return {
          signal: "BUY",
          setup: "FAST_BREAKOUT",
          confidence: volRatio20 >= mode.fastVolSurge * 1.5 ? "CERTAIN" : "CONFIDENT",
          score: computeBullScore(T, T["5m"].adx || 0, volR, true, true),
          price, entry: price, stop, tp1, tp2, atr: a5,
          why: `⚡ Fast bull: ${volRatio20.toFixed(1)}x vol`,
          gatesPassed: 13, gatesTotal: 13, soft: 0, trend: T, fast: true,
          trigger_tf: "5m", highest_tf: "5m"
        };
      }
    }
  }
  return null;
}
// ═══ MAIN SIGNAL ENGINE ═══
function signalFrom(candlesByTf, livePrice, meta = null) {
  const _hourUTC = new Date().getUTCHours();
  const _isCrypto = meta?.assetClass === "CRYPTO";
  if (_isCrypto && _hourUTC >= 2 && _hourUTC < 4) {
    return { signal: "NEUTRAL", confidence: "LOW", score: 0, price: livePrice, why: "🕒 Low-liquidity hour (2-4am UTC)", gatesPassed: 0, gatesTotal: 13 };
  }
  if (window.macroEventSoon) {
    return { signal: "NEUTRAL", confidence: "LOW", score: 0, price: livePrice, why: "⚠️ Macro event approaching", gatesPassed: 0, gatesTotal: 13 };
  }
  if (!candlesByTf["5m"] || !candlesByTf["1h"] || !candlesByTf["4h"]) return null;
  const mode = MODES[STATE.mode] || MODES.MEDIUM;
  const T = {};
  for (const iv of ["5m","15m","1h","4h","1d"]) {
    if (!candlesByTf[iv]) continue;
    const t = tf(candlesByTf[iv], livePrice);
    if (t) { t.trend = trendOf(t); T[iv] = t; }
  }
  if (!T["5m"] || !T["1h"] || !T["4h"]) return null;
  const price = T["5m"].price;
  if (!price || price <= 0) return null;
  const a5 = T["5m"].atr || 0;
  if (T["1h"]?.e50 && a5 > 0) {
    const distFromEma1h = Math.abs(price - T["1h"].e50) / a5;
    if (distFromEma1h > 2.5) {
      return { signal: "NEUTRAL", confidence: "LOW", score: 0, price, atr: a5, why: `🚫 Overextended ${distFromEma1h.toFixed(1)}x ATR`, gatesPassed: 0, gatesTotal: 14, trend: T };
    }
  }
  if (a5 <= 0) return null;
  const isCrypto = meta?.assetClass === "CRYPTO";
  const volPct = a5 / price;
  if (volPct < 0.0002) return { signal: "NEUTRAL", confidence: "LOW", score: 0, price, atr: a5, why: "Market too quiet", gatesPassed: 0, gatesTotal: 14, trend: T };
  if (volPct > 0.03) return { signal: "NEUTRAL", confidence: "LOW", score: 0, price, atr: a5, why: "Market chaos", gatesPassed: 0, gatesTotal: 14, trend: T };
  const adx1Regime = T["1h"].adx;
  if (adx1Regime == null || adx1Regime < 20) {
    return { signal: "NEUTRAL", confidence: "LOW", score: 0, price, atr: a5, why: "Choppy regime (1h ADX <20)", gatesPassed: 0, gatesTotal: 14, trend: T };
  }
  const rsi5 = T["5m"].rsi, rsi1 = T["1h"].rsi;
  const adx5 = T["5m"].adx, adx15 = T["15m"]?.adx, adx1 = T["1h"].adx;
  const volR = volRatio(T["5m"].candles);

  const lastClosed = T["5m"].candles[T["5m"].candles.length - 2];
  if (lastClosed) {
    const candleRange = lastClosed.h - lastClosed.l;
    const lowerWick = Math.min(lastClosed.o, lastClosed.c) - lastClosed.l;
    const upperWick = lastClosed.h - Math.max(lastClosed.o, lastClosed.c);
    const lowerWickPct = candleRange > 0 ? lowerWick / candleRange : 0;
    const upperWickPct = candleRange > 0 ? upperWick / candleRange : 0;
    const closePct = candleRange > 0 ? (lastClosed.c - lastClosed.l) / candleRange : 0.5;
    const avgVol20 = T["5m"].candles.slice(-22, -2).reduce((s, c) => s + c.v, 0) / 20;
    const volumeConfirmed = lastClosed.v >= avgVol20 * 1.5;
    window._rejectionLong = lowerWickPct >= 0.5 && closePct >= 0.6 && volumeConfirmed;
    window._rejectionShort = upperWickPct >= 0.5 && closePct <= 0.4 && volumeConfirmed;
  }
  if (volR < 0.7) return { signal: "NEUTRAL", confidence: "LOW", score: 0, price, atr: a5, why: "📊 Volume below baseline", gatesPassed: 0, gatesTotal: 14, trend: T };

  const fast = checkFastTrigger(T, price, a5, volR, rsi5, rsi1, meta);
  if (fast) return fast;

  const regime = adx1 > 25 ? "TRENDING" : (adx1 < 20 ? "RANGING" : "TRANSITION");
  const regimeFactor = regime === "TRENDING" ? 0.85 : 1.0;

  const newsObj = STATE.news.sentiment[meta?.coin];
  const newsScore = (newsObj && typeof newsObj === "object" ? newsObj.score : newsObj) || 0;
  const newsSrc = (newsObj && typeof newsObj === "object" ? newsObj.src : null) || "none";
  const newsApplicable = isCrypto || newsSrc === "ticker";
  const newsBull = newsApplicable && newsScore > 0.4;
  const newsBear = newsApplicable && newsScore < -0.4;
  const funding = isCrypto ? (meta?.funding || 0) : 0;
  const fundingContrarian = isCrypto && funding < -0.00005;
  const fundingCrowdedLong = isCrypto && funding > 0.0003;
  const premium = isCrypto ? (meta?.premium || 0) : 0;
  const premiumHot = isCrypto && premium > 0.005;
  const oiHist = STATE.oiHistory[meta?.coin] || [];
  let oiRising = false;
  if (isCrypto && oiHist.length >= 3) {
    const delta = (oiHist[oiHist.length-1] - oiHist[oiHist.length-3]) / (oiHist[oiHist.length-3] || 1);
    if (delta > 0.01) oiRising = true;
  }
  const book = STATE.bookCache[meta?.coin];
  const orderFlowVetoBuy = book && book.imbalance < 0.35;
  const orderFlowVetoSell = book && book.imbalance > 0.65;
  const anyUptrend = T["4h"].trend !== "DOWN" && T["1h"].trend !== "DOWN";

  if (!anyUptrend) {
    const bear = computeBearScore(T, price, a5, adx5 || 0, volR, rsi5 || 50);
    const sellGates = [
      { name: "1-hour trend is down", pass: mode.sellRelaxedH1 ? (T["1h"].trend === "DOWN" || T["4h"].trend === "DOWN") : (T["1h"].trend === "DOWN" || (T["1h"].e50 && price < T["1h"].e50)) },
      { name: "4-hour trend is weak", pass: (T["4h"].e20 && T["4h"].e20 < T["4h"].e50) || (T["4h"].e50 && price < T["4h"].e50) },
      { name: `Trend strong (ADX ${mode.sellAdxGate}+)`, pass: adx5 != null && adx5 >= mode.sellAdxGate },
      { name: `Bearish strength (${mode.sellBearGate}+)`, pass: bear >= mode.sellBearGate },
      { name: `Volume (${mode.sellVolGate}x+)`, pass: volR >= mode.sellVolGate },
      { name: "Momentum negative", pass: (() => { const c = T["5m"].closes; if (c.length < 4) return false; return !(c[c.length-2] > c[c.length-3] && c[c.length-3] > c[c.length-4]); })() },
      { name: "Not already oversold", pass: rsi1 != null && rsi1 > 28 },
      { name: "Wick rejection + volume surge", pass: window._rejectionShort === true },
    ];
    const passed = sellGates.filter(g => g.pass).length;
    const allPass = passed >= mode.sellGatesRequired;
    const conflicts = [];
    const whaleBias = window.whaleBias && window.whaleBias[meta?.coin];
    if (whaleBias === "BEARISH") conflicts.push("whales net selling");
    if (newsBull) conflicts.push("bullish news");
    if (orderFlowVetoSell) conflicts.push("order book bid");
    if (allPass && rsi1 != null && rsi1 < 25) conflicts.push("already oversold");
    if (allPass && T["1h"].e50 && a5 > 0 && price < T["1h"].e50 - 6 * a5) conflicts.push("exhaustion");
    const tfT = [T["1d"]?.trend, T["4h"].trend, T["1h"].trend].filter(x => x && x !== "FLAT");
    if (tfT.length >= 2 && new Set(tfT).size >= 2) conflicts.push("timeframes disagree");
    const soft = [
      T["1d"]?.trend === "DOWN", adx5 != null && adx5 >= 30, adx1 != null && adx1 >= 20,
      volR >= 1.4, rsi5 != null && rsi5 >= 55 && rsi5 <= 70, newsBear, fundingCrowdedLong,
      T["1h"].e50 && a5 > 0 && Math.abs(price - T["1h"].e50) / a5 < 2,
    ].filter(Boolean).length;
    if (allPass && conflicts.length === 0 && soft >= mode.sellSoft) {
      const a15 = T["15m"]?.atr || a5 * 1.8;
      const c15 = T["15m"]?.candles || [];
      const structBars = c15.length >= 20 ? c15.slice(-20) : T["5m"].candles.slice(-40);
      const swingHigh = Math.max(...structBars.map(c => c.h));
      const structuralStop = swingHigh + 0.3 * a15;
      const stopDist = structuralStop - price;
      const minStopDist = 1.2 * a15;
      const maxStopDist = 3.5 * a15;
      const clampedDist = Math.max(minStopDist, Math.min(stopDist, maxStopDist));
      let stop = price + clampedDist;
      const risk = stop - price;
      const tier = soft >= mode.sellSoft + 2 ? "CERTAIN" : "CONFIDENT";
      const tp1Mult = tier === "CERTAIN" ? 1.2 : 1.0;
      const tp2Mult = tier === "CERTAIN" ? 3.5 : 2.5;
      return { signal: "SELL", setup: "BREAKDOWN", confidence: tier, score: bear, price, entry: price, stop, tp1: price - tp1Mult * risk, tp2: price - tp2Mult * risk, atr: a5, why: "1h trend broken; momentum negative.", gatesPassed: passed, gatesTotal: sellGates.length, soft, trend: T, trigger_tf: "1h", highest_tf: "1h" };
    }
    const failed = sellGates.filter(g => !g.pass).map(g => g.name);
    let why = "No SELL. ";
    if (failed.length) why += "Missing: " + failed.join(", ") + ". ";
    if (conflicts.length) why += "Conflicts: " + conflicts.join("; ") + ".";
    return { signal: "NEUTRAL", confidence: "LOW", score: bear, price, atr: a5, why, gatesPassed: passed, gatesTotal: sellGates.length, soft, trend: T };
  }

  const t5c = T["5m"].candles, e20_5 = T["5m"].e20;
  const distEma = e20_5 ? (price - e20_5) / a5 : 0;
  const bounced = (() => {
    if (!e20_5 || t5c.length < 4) return false;
    for (let i = t5c.length - 4; i < t5c.length - 1; i++) {
      if (t5c[i].l <= e20_5 * 1.002 && t5c[i].c > e20_5) return true;
    }
    return false;
  })();
  const pbLow = mode.pullbackLow * regimeFactor;
  const pbHigh = mode.pullbackHigh * regimeFactor;

  // 5m trigger
  const pullbackOk = distEma >= pbLow && distEma <= pbHigh && rsi5 != null && rsi5 >= 45 && rsi5 <= 70 && bounced;
  const breakoutOk = (() => {
    if (t5c.length < 24) return false;
    for (let i = t5c.length - 4; i < t5c.length - 1; i++) {
      const hi = Math.max(...t5c.slice(i - 20, i).map(c => c.h));
      const base = t5c.slice(Math.max(0, i - 72), Math.max(1, i - 6));
      const baseAvg = base.length ? base.reduce((s, c) => s + c.v, 0) / base.length : t5c[i].v;
      if (t5c[i].c > hi && baseAvg > 0 && t5c[i].v / baseAvg >= mode.breakoutVol) return true;
    }
    return false;
  })();

  // 15m trigger
  const t15c = T["15m"]?.candles || [];
  const e20_15 = T["15m"]?.e20;
  const a15 = T["15m"]?.atr || a5 * 1.8;
  const rsi15 = T["15m"]?.rsi;
  const distEma15 = e20_15 ? (price - e20_15) / a15 : 999;
  const bounced15 = (() => {
    if (!e20_15 || t15c.length < 4) return false;
    for (let i = t15c.length - 4; i < t15c.length - 1; i++) {
      if (t15c[i].l <= e20_15 * 1.002 && t15c[i].c > e20_15) return true;
    }
    return false;
  })();
  const pullback15Ok = distEma15 >= pbLow && distEma15 <= pbHigh && rsi15 != null && rsi15 >= 45 && rsi15 <= 70 && bounced15;
  const breakout15Ok = (() => {
    if (t15c.length < 24) return false;
    for (let i = t15c.length - 4; i < t15c.length - 1; i++) {
      const hi = Math.max(...t15c.slice(i - 20, i).map(c => c.h));
      const base = t15c.slice(Math.max(0, i - 72), Math.max(1, i - 6));
      const baseAvg = base.length ? base.reduce((s, c) => s + c.v, 0) / base.length : t15c[i].v;
      if (t15c[i].c > hi && baseAvg > 0 && t15c[i].v / baseAvg >= mode.breakoutVol) return true;
    }
    return false;
  })();

  // 1h trigger
  const t1hc = T["1h"]?.candles || [];
  const e20_1h = T["1h"]?.e20;
  const a1h = T["1h"]?.atr || a5 * 3;
  const distEma1h = e20_1h ? (price - e20_1h) / a1h : 999;
  const bounced1h = (() => {
    if (!e20_1h || t1hc.length < 4) return false;
    for (let i = t1hc.length - 4; i < t1hc.length - 1; i++) {
      if (t1hc[i].l <= e20_1h * 1.002 && t1hc[i].c > e20_1h) return true;
    }
    return false;
  })();
  const pullback1hOk = distEma1h >= pbLow && distEma1h <= pbHigh && rsi1 != null && rsi1 >= 45 && rsi1 <= 70 && bounced1h;
  const breakout1hOk = (() => {
    if (t1hc.length < 24) return false;
    for (let i = t1hc.length - 4; i < t1hc.length - 1; i++) {
      const hi = Math.max(...t1hc.slice(i - 20, i).map(c => c.h));
      const base = t1hc.slice(Math.max(0, i - 72), Math.max(1, i - 6));
      const baseAvg = base.length ? base.reduce((s, c) => s + c.v, 0) / base.length : t1hc[i].v;
      if (t1hc[i].c > hi && baseAvg > 0 && t1hc[i].v / baseAvg >= mode.breakoutVol) return true;
    }
    return false;
  })();

  // 4h trigger
  const t4hc = T["4h"]?.candles || [];
  const e20_4h = T["4h"]?.e20;
  const a4h = T["4h"]?.atr || a5 * 12;
  const rsi4h = T["4h"]?.rsi;
  const distEma4h = e20_4h ? (price - e20_4h) / a4h : 999;
  const bounced4h = (() => {
    if (!e20_4h || t4hc.length < 4) return false;
    for (let i = t4hc.length - 4; i < t4hc.length - 1; i++) {
      if (t4hc[i].l <= e20_4h * 1.002 && t4hc[i].c > e20_4h) return true;
    }
    return false;
  })();
  const pullback4hOk = distEma4h >= pbLow && distEma4h <= pbHigh && rsi4h != null && rsi4h >= 45 && rsi4h <= 70 && bounced4h;
  const breakout4hOk = (() => {
    if (t4hc.length < 24) return false;
    for (let i = t4hc.length - 4; i < t4hc.length - 1; i++) {
      const hi = Math.max(...t4hc.slice(i - 20, i).map(c => c.h));
      const base = t4hc.slice(Math.max(0, i - 72), Math.max(1, i - 6));
      const baseAvg = base.length ? base.reduce((s, c) => s + c.v, 0) / base.length : t4hc[i].v;
      if (t4hc[i].c > hi && baseAvg > 0 && t4hc[i].v / baseAvg >= mode.breakoutVol) return true;
    }
    return false;
  })();

    const trigger_tf = [];
  if (pullbackOk || breakoutOk) trigger_tf.push("5m");
  if (pullback15Ok || breakout15Ok) trigger_tf.push("15m");
  if (pullback1hOk || breakout1hOk) trigger_tf.push("1h");
  if (pullback4hOk || breakout4hOk) trigger_tf.push("4h");
  const trigger_tf_str = trigger_tf.join("+");
  const highest_tf = trigger_tf.includes("4h") ? "4h" : trigger_tf.includes("1h") ? "1h" : trigger_tf.includes("15m") ? "15m" : trigger_tf.includes("5m") ? "5m" : null;
  const setupOk = trigger_tf.length > 0;
  const highCertaintySetup = trigger_tf.length >= 2; // 🆕 Multi-TF confluence
  const momentumOk = (() => {
    const c = T["5m"].closes; if (c.length < 4) return false;
    return !(c[c.length-2] < c[c.length-3] && c[c.length-3] < c[c.length-4]);
  })();

  const gates = [
    { name: "1-day trend is up", pass: T["1d"] ? (T["1d"].trend === "UP" || (T["1d"].e50 && a5 > 0 && Math.abs(price - T["1d"].e50) / a5 < 3)) : true },
    { name: "4-hour trend is up", pass: T["4h"].trend === "UP" },
    { name: "1-hour trend is up", pass: T["1h"].trend === "UP" || T["1h"].trend === "FLAT" },
    { name: "15-minute trend is up", pass: T["15m"] ? (T["15m"].trend === "UP" || T["15m"].trend === "FLAT") : false },
    { name: "Price above key levels", pass: T["4h"].e50 && T["1h"].e50 && price > T["4h"].e50 && price > T["1h"].e50 },
    { name: "Good entry spot", pass: setupOk },
    { name: `ADX ${mode.adx5Buy}+`, pass: adx5 != null && adx5 >= mode.adx5Buy },
    { name: `ADX15 ${mode.adx15Buy}+`, pass: adx15 != null && adx15 >= mode.adx15Buy },
    { name: `Volume ${mode.volBuy}x+`, pass: volR >= mode.volBuy },
    { name: "Momentum up", pass: momentumOk },
    { name: "Not overbought", pass: rsi1 != null && rsi1 < 75 },
    { name: "Near trend line", pass: T["1h"].e50 && a5 > 0 && Math.abs(price - T["1h"].e50) / a5 <= 5 },
    { name: "Wick rejection + volume surge", pass: window._rejectionLong === true },
  ];
  const bullScore = computeBullScore(T, adx5 || 0, volR, setupOk, momentumOk);
  gates.push({ name: `Score ${mode.scoreBuy}+`, pass: bullScore >= mode.scoreBuy });
  const passed = gates.filter(g => g.pass).length;

  const soft = [
    T["1d"]?.trend === "UP", adx5 != null && adx5 >= 30, adx1 != null && adx1 >= 20,
    volR >= 1.4, rsi5 != null && rsi5 >= 55 && rsi5 <= 70,
    T["1h"].e50 && a5 > 0 && Math.abs(price - T["1h"].e50) / a5 < 2,
    rsi1 != null && rsi1 >= 45 && rsi1 <= 65,
    newsBull, fundingContrarian, oiRising,
    T["1d"]?.e50 && T["4h"].e50 && T["1h"].e50 && T["15m"]?.e50 && T["5m"].e50 && price > T["1d"].e50 && price > T["4h"].e50 && price > T["1h"].e50 && price > T["15m"].e50 && price > T["5m"].e50,
  ].filter(Boolean).length;

  const conflicts = [];
  const whaleBiasSell = window.whaleBias && window.whaleBias[meta?.coin];
  if (whaleBiasSell === "BULLISH") conflicts.push("whales net buying");
  if (newsBear) conflicts.push("bearish news");
  if (orderFlowVetoBuy) conflicts.push("order book offered");
  if (fundingCrowdedLong) conflicts.push("funding crowded longs");
  if (oiRising && !momentumOk) conflicts.push("OI rising but price falling");
  if (premiumHot) conflicts.push("perp >0.5% over oracle");
  if (rsi1 != null && rsi1 > 80) conflicts.push("overbought");
  if (T["1h"].e50 && a5 > 0 && price > T["1h"].e50 + 8 * a5) conflicts.push("chasing");
  const tfT = [T["1d"]?.trend, T["4h"].trend, T["1h"].trend].filter(x => x && x !== "FLAT");
  if (tfT.length >= 2 && new Set(tfT).size >= 2) conflicts.push("timeframes disagree");

  const allPass = passed === gates.length;
  if (allPass && conflicts.length <= mode.conflictBuy && soft >= mode.softBuy) {
    let stopAtr, stopCandles;
    if (highest_tf === "4h") { stopAtr = T["4h"]?.atr || a5 * 12; stopCandles = T["4h"]?.candles || []; }
    else if (highest_tf === "1h") { stopAtr = T["1h"]?.atr || a5 * 3; stopCandles = T["1h"]?.candles || []; }
    else { stopAtr = T["15m"]?.atr || a5 * 1.8; stopCandles = T["15m"]?.candles || []; }
    const structBars = stopCandles.length >= 20 ? stopCandles.slice(-20) : t5c.slice(-40);
    const swingLow = Math.min(...structBars.map(c => c.l));
    const structuralStop = swingLow - 0.3 * stopAtr;
    const stopDist = price - structuralStop;
    const minStopDist = 1.2 * stopAtr;
    const maxStopDist = 3.5 * stopAtr;
    const clampedDist = Math.max(minStopDist, Math.min(stopDist, maxStopDist));
    let stop = price - clampedDist;
    const risk = price - stop;
    const tier = (soft >= mode.softBuy + 3 || highCertaintySetup) ? "CERTAIN" : "CONFIDENT";
    const tp1Mult = tier === "CERTAIN" ? 1.2 : 1.0;
    const tp2Mult = tier === "CERTAIN" ? 3.5 : 2.5;
    return { signal: "BUY", setup: pullbackOk ? "PULLBACK" : "BREAKOUT", confidence: tier, score: bullScore, price, entry: price, stop, tp1: price + tp1Mult * risk, tp2: price + tp2Mult * risk, atr: a5, why: "4h + 1h + 15m up. Pullback with volume.", gatesPassed: passed, gatesTotal: gates.length, soft, trend: T, trigger_tf: trigger_tf_str, highest_tf };
  }
  if (bullScore >= mode.scoreWait && passed >= gates.length - mode.waitGatesMissing && conflicts.length <= mode.conflictBuy) {
    const failed = gates.filter(g => !g.pass).map(g => g.name);
    return { signal: "WAIT", confidence: "MED", score: bullScore, price, entryZone: e20_5 ? e20_5 - 0.25 * a5 : price, atr: a5, why: "Uptrend but no safe entry. Missing: " + failed.join(", ") + ".", gatesPassed: passed, gatesTotal: gates.length, soft, trend: T };
  }
  const failed = gates.filter(g => !g.pass).map(g => g.name);
  return { signal: "NEUTRAL", confidence: "LOW", score: bullScore, price, atr: a5, why: "No signal. Missing: " + failed.slice(0, 3).join(", ") + ".", gatesPassed: passed, gatesTotal: gates.length, soft, trend: T };
}

// ═══ ORCHESTRATOR ═══
async function runScanForMode(modeName) {
  if (!MODES[modeName]) throw new Error(`Unknown mode: ${modeName}`);
  STATE.mode = modeName;
  candleCache.clear();

  const universe = [
    ...CRYPTO_UNIVERSE.map(c => ({ coin: c, assetClass: "CRYPTO" })),
  ];

  const results = {};

  // Batch of 5 to respect Bybit rate limits
  for (let i = 0; i < universe.length; i += 5) {
    const batch = universe.slice(i, i + 5);
    await Promise.all(batch.map(async (m) => {
      try {
        const candles = {};
        await Promise.all(["5m", "15m", "1h", "4h", "1d"].map(async (iv) => {
          try { candles[iv] = await getCandles(m.coin, iv, 250); } catch(e) {}
        }));
        const live = candles["5m"]?.[candles["5m"].length - 1]?.c || 0;
        if (!live) return;
       const sig = signalFrom(candles, live, m);
      if (sig) {
        results[m.coin] = { ...sig, coin: m.coin, assetClass: m.assetClass };
      } else if (live) {
        results[m.coin] = {
          coin: m.coin,
          assetClass: m.assetClass,
          signal: "NEUTRAL",
          confidence: "LOW",
          score: 0,
          price: live,
          why: "Insufficient data",
        };
      }
      } catch (e) {
        console.error(`  ${m.coin}: ${e.message}`);
      }
    }));
    await new Promise(r => setTimeout(r, 200));
  }

  return {
    coins: results,
    watchlist: Object.keys(results),
    lastScan: Date.now(),
    mode: modeName,
  };
}

module.exports = {
  MODES,
  runScanForMode,
  fetchCandles,
  getCandles,
};
