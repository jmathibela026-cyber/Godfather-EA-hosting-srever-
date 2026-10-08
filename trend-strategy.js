'use strict';
/**
 * Trend Following strategy (50/200 EMA trend + MACD trigger)
 *
 * Input  ctx = { symbol, h1 }   h1 = closed candles { t, open, high, low, close, volume }, oldest -> newest
 *                               (needs 300+ bars so the 200 EMA is settled; 500+ is better)
 *
 * Rules (from "How to Trade Trends"):
 *   1. Trend: price above BOTH the 50 and 200 EMA = uptrend (BUY only). Below both = downtrend (SELL only).
 *   2. Trigger: MACD (12,26,9) crosses up through its signal line in an uptrend (down in a downtrend).
 *      MACD signals against the EMA trend are ignored.
 *   3. Stop loss: just below the latest swing low (above the swing high for sells).
 *   4. Exit: two or more candles close beyond either EMA -> use shouldExit() on every new candle.
 *      The PDF has no fixed take profit, so tp is null unless you set opts.tpRR (e.g. 3 = 3R).
 */

const DEFAULTS = {
  fast: 12, slow: 26, signal: 9,
  emaFast: 50, emaSlow: 200,
  swingN: 3,
  atrPeriod: 14,
  slBufferATR: 0.25,
  minRiskATR: 0.5,
  maxRiskATR: 5,
  tpRR: null            // null = exit only by the EMA rule; or a number such as 3 for a fixed 3R target
};

function ema(values, n) {
  const k = 2 / (n + 1), out = new Array(values.length);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) { prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

function atrAt(c, end, n) {
  let sum = 0, cnt = 0;
  for (let i = Math.max(1, end - n + 1); i <= end; i++) {
    sum += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close)); cnt++;
  }
  return cnt ? sum / cnt : 0;
}

function swingLows(c, n) {
  const L = [];
  for (let i = n; i < c.length - n; i++) {
    let ok = true;
    for (let j = 1; j <= n; j++) if (!(c[i].low < c[i - j].low && c[i].low <= c[i + j].low)) ok = false;
    if (ok) L.push({ i, price: c[i].low });
  }
  return L;
}

function mirror(c) {
  return c.map(x => ({ t: x.t, open: -x.open, high: -x.low, low: -x.high, close: -x.close, volume: x.volume }));
}

function indicators(c, cfg) {
  const close = c.map(x => x.close);
  const eF = ema(close, cfg.emaFast), eS = ema(close, cfg.emaSlow);
  const mf = ema(close, cfg.fast), ms = ema(close, cfg.slow);
  const macd = mf.map((v, i) => v - ms[i]);
  const sig = ema(macd, cfg.signal);
  const hist = macd.map((v, i) => v - sig[i]);
  return { eF, eS, macd, sig, hist };
}

/* BUY side logic; SELL is run on mirrored candles */
function analyzeBuy(symbol, c, cfg, px) {
  const i = c.length - 1;
  if (i < cfg.emaSlow + 50) return { signal: null, status: 'Not enough candles for the 200 EMA' };
  const ind = indicators(c, cfg);
  const atr = atrAt(c, i, cfg.atrPeriod);
  if (!atr) return { signal: null, status: 'No volatility data' };

  const up = c[i].close > ind.eF[i] && c[i].close > ind.eS[i];
  if (!up) return { signal: null, status: 'Price not above both EMAs' };
  const crossed = ind.hist[i] > 0 && ind.hist[i - 1] <= 0;
  if (!crossed) return { signal: null, status: 'Uptrend — waiting for the MACD cross' };

  // stop loss below the latest swing low that sits under the entry (and is not too tight)
  const entry = c[i].close;
  const lows = swingLows(c.slice(-200), cfg.swingN);
  const off = Math.max(0, c.length - 200);
  let sl = null;
  for (let q = lows.length - 1; q >= 0; q--) {
    const cand = lows[q].price - cfg.slBufferATR * atr;
    if (cand < entry && entry - cand >= cfg.minRiskATR * atr) { sl = cand; break; }
  }
  if (sl === null) return { signal: null, status: 'Setup skipped — no valid swing low for the stop loss' };
  const risk = entry - sl;
  if (risk > cfg.maxRiskATR * atr) return { signal: null, status: 'Setup skipped — stop loss too wide' };
  const tp = cfg.tpRR ? entry + cfg.tpRR * risk : null;

  const reasons = ['Price above 50 & 200 EMA', 'MACD crossed up'];
  let conf = 60;
  if (ind.eF[i] > ind.eS[i]) { conf += 10; reasons.push('50 EMA above 200 EMA'); }
  if (ind.eF[i] > ind.eF[i - 10] && ind.eS[i] > ind.eS[i - 10]) { conf += 8; reasons.push('both EMAs rising'); }
  if (ind.macd[i] < 0) { conf += 7; reasons.push('MACD crossed up from below zero (pullback entry)'); }
  if (entry - ind.eF[i] < 2 * atr) { conf += 5; reasons.push('price close to the 50 EMA (not stretched)'); }
  if (ind.hist[i] > 0 && ind.hist[i] > ind.hist[i - 1]) conf += 5;
  conf = Math.min(99, conf);

  return {
    signal: {
      id: `${symbol}|TREND|BUY|${c[i].t}`, symbol, strategy: 'Trend Following', side: 'BUY', setup: 'EMA trend + MACD cross',
      entry, entryType: 'market', sl, tp, rr: tp ? Math.round(((tp - entry) / risk) * 100) / 100 : null, confidence: conf,
      ema50: ind.eF[i], ema200: ind.eS[i], reasons
    },
    status: 'Trend + MACD cross — BUY signal'
  };
}

function flipSignal(s) {
  if (!s) return null;
  const o = Object.assign({}, s, { side: 'SELL', entry: -s.entry, sl: -s.sl, tp: s.tp === null ? null : -s.tp, ema50: -s.ema50, ema200: -s.ema200 });
  o.id = s.id.replace('|BUY|', '|SELL|');
  o.reasons = s.reasons.map(r => r.replace('above 50 & 200 EMA', 'below 50 & 200 EMA').replace('crossed up from below zero', 'crossed down from above zero')
    .replace('MACD crossed up', 'MACD crossed down').replace('50 EMA above 200 EMA', '50 EMA below 200 EMA').replace('both EMAs rising', 'both EMAs falling'));
  return o;
}

/* ---------- public ---------- */
function analyze(ctx, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const buy = analyzeBuy(ctx.symbol, ctx.h1, cfg);
  const sellRaw = analyzeBuy(ctx.symbol, mirror(ctx.h1), cfg);
  const sell = { signal: flipSignal(sellRaw.signal), status: sellRaw.status };
  if (buy.signal) return buy;
  if (sell.signal) return { signal: sell.signal, status: 'Trend + MACD cross — SELL signal' };
  const st = buy.status.startsWith('Price not above') ? sell.status.replace('above', 'below').replace('Uptrend', 'Downtrend') : buy.status;
  return { signal: null, status: st };
}

// Exit rule: two closes in a row beyond either EMA. Call on every new closed candle for each open trend trade.
function shouldExit(side, h1, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const c = side === 'SELL' ? mirror(h1) : h1;
  if (c.length < cfg.emaSlow + 5) return { exit: false, reason: 'not enough candles' };
  const ind = indicators(c, cfg), i = c.length - 1;
  for (const [name, e] of [['50 EMA', ind.eF], ['200 EMA', ind.eS]]) {
    if (c[i].close < e[i] && c[i - 1].close < e[i - 1]) return { exit: true, reason: `two closes ${side === 'SELL' ? 'above' : 'below'} the ${name}` };
  }
  return { exit: false, reason: 'trend intact' };
}

module.exports = { analyze, shouldExit, DEFAULTS };

/* Usage on the server (new closed H1 candle, per symbol):

   const trend = require('./trend-strategy');
   const { adConfirms } = require('./ad-confirm');          // optional confirmation filter

   if (engine.strats.includes('Trend Following')) {
     const { signal, status } = trend.analyze({ symbol, h1 });
     if (signal && signal.confidence >= engine.conf && !alreadyTraded(signal.id)) {
       if (engine.confirm.includes('ad') && !adConfirms(h1, signal.side).ok) return;
       placeOrder(symbol, signal.side, engine.lot, signal.sl, signal.tp);   // tp may be null -> no take profit
       markTraded(signal.id, 'Trend Following');
     } else if (!signal) log(`${symbol} Trend: ${status}`);
   }
   // every new H1 candle, for each open Trend Following position:
   //   const x = trend.shouldExit(position.side, h1); if (x.exit) closePosition(position.id), log(x.reason);
*/
