'use strict';
/**
 * Liquidity strategy (stop hunt -> CHoCH -> return to origin)
 *
 * Input  ctx = { symbol, m15, h4, d1 }
 *   candles are objects { t (ms, UTC), open, high, low, close, volume }, oldest -> newest.
 *   Use CLOSED candles only. m15 needs ~150+ bars. h4 is used for trend (optional).
 *   d1 is used for previous day/week/month levels (optional: falls back to m15 for day levels).
 *
 * Output analyze(ctx) -> { signal, status }
 *   signal = null, or { id, symbol, strategy:'Liquidity', side:'BUY'|'SELL', setup, entry, entryType,
 *            zone:[lo,hi], sl, tp, rr, confidence, level, sweep, choch, htfTrend, reasons[] }
 *   status = short text for the log / scanner (what the strategy is currently waiting for)
 *
 * Rules (from the Liquidity notes):
 *   1. Liquidity pools: PDH/PWH/PMH, swing highs, equal highs (BSL) and the mirror lows (SSL).
 *   2. Stop hunt (SH): price wicks beyond a pool and closes back inside.
 *   3. BMS / CHoCH: price closes beyond the last swing made before the sweep, in the reversal direction.
 *   4. Entry on the return to origin (RTO) into the swept level. Classified as quick RTO, late RTO
 *      (equal highs/lows built on the way back), SH + compression, or SH + confirmation re-entry.
 *   5. Trade in line with the H4 trend (opposite trend is skipped).
 *   SL beyond the sweep extreme; TP at the next opposite liquidity pool (min RR), else fixed RR.
 */

const DEFAULTS = {
  swingN: 2,
  atrPeriod: 14,
  sweepLookback: 60,   // M15 bars to look back for the stop hunt
  eqTolATR: 0.15,      // equal highs/lows tolerance
  rtoTolATR: 0.25,     // width of the entry zone around the swept level
  slBufferATR: 0.25,
  minRR: 2,
  minRiskATR: 0.3,
  maxRiskATR: 4,
  requireHtfTrend: true
};

/* ---------- helpers ---------- */
function mirror(ctx) {
  const m = a => a && a.map(c => ({ t: c.t, open: -c.open, high: -c.low, low: -c.high, close: -c.close, volume: c.volume }));
  return { symbol: ctx.symbol, m15: m(ctx.m15), h4: m(ctx.h4), d1: m(ctx.d1) };
}

function atrAt(c, end, n) {
  let sum = 0, cnt = 0;
  for (let i = Math.max(1, end - n + 1); i <= end; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    sum += tr; cnt++;
  }
  return cnt ? sum / cnt : 0;
}

function swings(c, n) {
  const H = [], L = [];
  for (let i = n; i < c.length - n; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= n; j++) {
      if (!(c[i].high > c[i - j].high && c[i].high >= c[i + j].high)) hi = false;
      if (!(c[i].low < c[i - j].low && c[i].low <= c[i + j].low)) lo = false;
    }
    if (hi) H.push({ i, price: c[i].high });
    if (lo) L.push({ i, price: c[i].low });
  }
  return { H, L };
}

function htfTrend(h4, cfg) {
  const s = swings(h4.slice(-150), 2);
  if (s.H.length < 2 || s.L.length < 2) return 'unknown';
  const hh = s.H[s.H.length - 1].price > s.H[s.H.length - 2].price;
  const hl = s.L[s.L.length - 1].price > s.L[s.L.length - 2].price;
  if (hh && hl) return 'up';
  if (!hh && !hl) return 'down';
  return 'range';
}

function groupKey(t, kind) {
  const day = Math.floor(t / 86400000);
  if (kind === 'day') return day;
  if (kind === 'week') return day - ((new Date(day * 86400000).getUTCDay() + 6) % 7); // Monday start
  const d = new Date(t);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

// high/low of the previous COMPLETED day/week/month
function prevPeriod(candles, kind) {
  if (!candles.length) return null;
  const cur = groupKey(candles[candles.length - 1].t, kind);
  let key = null, hi = -Infinity, lo = Infinity, found = false;
  for (let i = candles.length - 1; i >= 0; i--) {
    const k = groupKey(candles[i].t, kind);
    if (k === cur) continue;
    if (key === null) key = k;
    if (k !== key) break;
    hi = Math.max(hi, candles[i].high); lo = Math.min(lo, candles[i].low); found = true;
  }
  return found ? { high: hi, low: lo } : null;
}

// all liquidity pools that existed at M15 bar k
function levelsAsOf(ctx, k, cfg, atr) {
  const m = ctx.m15, t = m[k].t, out = [];
  const add = (side, price, label, htf, eq) => out.push({ side, price, label, htf: !!htf, eq: !!eq });
  const base = ctx.d1 && ctx.d1.length ? ctx.d1.filter(c => c.t <= t) : m.slice(0, k + 1);
  [['day', 'D'], ['week', 'W'], ['month', 'M']].forEach(([kind, ch]) => {
    const p = prevPeriod(base, kind);
    if (p) { add('BSL', p.high, 'P' + ch + 'H', true); add('SSL', p.low, 'P' + ch + 'L', true); }
  });
  const sw = swings(m.slice(Math.max(0, k - 150), k + 1), cfg.swingN);
  const tol = cfg.eqTolATR * atr;
  sw.H.forEach(p => add('BSL', p.price, 'Swing High', false, false));
  sw.L.forEach(p => add('SSL', p.price, 'Swing Low', false, false));
  const eq = (pts, side, label) => {
    const last = pts.slice(-8);
    for (let a = 0; a < last.length; a++) for (let b = a + 1; b < last.length; b++) {
      if (Math.abs(last[a].price - last[b].price) <= tol)
        add(side, side === 'BSL' ? Math.max(last[a].price, last[b].price) : Math.min(last[a].price, last[b].price), label, false, true);
    }
  };
  eq(sw.H, 'BSL', 'EQH'); eq(sw.L, 'SSL', 'EQL');
  return out;
}

/* ---------- core: SELL after a buy-side liquidity sweep ---------- */
function analyzeSell(ctx, cfg) {
  const px = x => (cfg._sign * x).toFixed(5);
  const m = ctx.m15, i = m.length - 1;
  if (!m || i < 60) return { signal: null, status: 'Not enough M15 candles' };
  const atr = atrAt(m, i, cfg.atrPeriod);
  if (!atr) return { signal: null, status: 'No volatility data' };
  const trend = ctx.h4 && ctx.h4.length > 20 ? htfTrend(ctx.h4, cfg) : 'unknown';
  if (cfg.requireHtfTrend && trend === 'up') return { signal: null, status: 'H4 trend up — sell setups skipped' };

  const tol = cfg.rtoTolATR * atr;
  let status = 'No liquidity sweep yet';

  for (let k = i - 2; k >= Math.max(31, i - cfg.sweepLookback); k--) {
    const levels = levelsAsOf(ctx, k, cfg, atr).filter(l => l.side === 'BSL' && m[k].high > l.price && m[k - 1].close <= l.price);
    if (!levels.length) continue;
    levels.sort((a, b) => (b.htf - a.htf) || (b.eq - a.eq) || (b.price - a.price));

    for (const L of levels) {
      // stop hunt: wick above the pool, close back below within 3 candles
      let j = -1;
      for (let q = k; q <= Math.min(k + 2, i); q++) if (m[q].close < L.price) { j = q; break; }
      if (j < 0) continue;
      // start of this excursion above the pool (a re-poke within 6 bars belongs to the same stop hunt)
      let s0 = k;
      for (let q = Math.max(1, k - 6); q < k; q++) if (m[q].high > L.price) { s0 = q; break; }
      let extreme = -Infinity;
      for (let q = s0; q <= j; q++) extreme = Math.max(extreme, m[q].high);
      let broken = false;
      for (let q = j + 1; q <= i; q++) if (m[q].high > extreme) { broken = true; break; }
      if (broken) continue;

      // BMS reference: last swing low before the sweep
      const off = Math.max(0, s0 - 40);
      const pre = swings(m.slice(off, s0 + 1), cfg.swingN).L.filter(p => p.i + off < s0);
      if (!pre.length) continue;
      const bms = pre[pre.length - 1].price;

      // CHoCH: first close below that low
      let c = -1;
      for (let q = j; q <= i; q++) if (m[q].close < bms) { c = q; break; }
      if (c < 0) { status = `${L.label} swept at ${px(L.price)} — waiting for CHoCH ${cfg._sign > 0 ? 'below' : 'above'} ${px(bms)}`; continue; }
      if (i <= c) { status = 'CHoCH confirmed — waiting for the return to ' + px(L.price); continue; }

      // price must have left the level and now be coming back
      let minLow = Infinity;
      for (let q = c; q < i; q++) minLow = Math.min(minLow, m[q].low);
      const inZone = x => m[x].high >= L.price - tol && m[x].high <= extreme;
      if (!inZone(i)) { status = 'CHoCH confirmed — waiting for the return to ' + px(L.price); continue; }
      if (minLow > L.price - atr) { status = 'CHoCH confirmed — price has not moved away from the level yet'; continue; }
      if (i - 1 > c && m[i - 1].high >= L.price - tol && m[i - 1].high <= extreme) { status = 'Already in the entry zone — entry already taken'; continue; }

      // classify the return
      let clusters = 0, was = false;
      for (let q = c + 1; q < i; q++) { const z = m[q].high >= L.price - tol; if (z && !was) clusters++; was = z; }
      const swb = swings(m.slice(c, i + 1), 1).H;
      let eqBetween = false;
      for (let a = 0; a < swb.length; a++) for (let b = a + 1; b < swb.length; b++)
        if (Math.abs(swb[a].price - swb[b].price) <= cfg.eqTolATR * atr && swb[a].price < L.price - tol) eqBetween = true;
      const recent = m.slice(i - 8, i);
      const recentATR = recent.reduce((s, x) => s + (x.high - x.low), 0) / recent.length;
      let flips = 0;
      for (let q = 2; q < recent.length; q++) if ((recent[q].close - recent[q - 1].close) * (recent[q - 1].close - recent[q - 2].close) < 0) flips++;
      const compression = flips >= 3 && recentATR < 0.75 * atr;

      let setup = 'SH + CHoCH, quick RTO', adj = -5;
      if (clusters > 0) { setup = 'SH + confirmation re-entry'; adj = 4; }
      else if (compression) { setup = 'SH + compression'; adj = 5; }
      else if (eqBetween) { setup = 'SH + CHoCH, late RTO'; adj = 3; }

      // entry / SL / TP
      const closeIn = m[i].close >= L.price - tol;
      const entry = closeIn ? m[i].close : L.price;
      const entryType = closeIn ? 'market' : 'limit';
      const sl = extreme + cfg.slBufferATR * atr;
      const risk = sl - entry;
      if (risk < cfg.minRiskATR * atr) { status = 'Setup skipped — stop loss too tight'; continue; }
      if (risk > cfg.maxRiskATR * atr) { status = 'Setup skipped — stop loss too wide'; continue; }
      const pools = levelsAsOf(ctx, i, cfg, atr).filter(l => l.side === 'SSL' && l.price < entry - cfg.minRR * risk).map(l => l.price);
      const poolTP = pools.length ? Math.max(...pools) : null;
      const tp = poolTP !== null ? poolTP : entry - cfg.minRR * risk;
      const rr = (entry - tp) / risk;

      // confidence
      const wick = (extreme - Math.max(m[j].open, m[j].close)) / Math.max(1e-9, extreme - Math.min(...m.slice(s0, j + 1).map(x => x.low)));
      const reasons = [`${L.label} liquidity swept (stop hunt)`, `CHoCH below ${px(bms)}`, setup];
      let conf = 55;
      if (trend === 'down') { conf += 15; reasons.push('H4 trend down (aligned)'); }
      conf += L.htf ? 8 : 4;
      if (L.eq) { conf += 6; reasons.push('equal highs liquidity'); }
      if (m[c].close < bms - 0.15 * atr) conf += 10; else conf += 5;
      if (wick > 0.5) { conf += 5; reasons.push('strong rejection wick'); }
      conf += adj;
      conf = Math.max(0, Math.min(99, Math.round(conf)));

      return {
        signal: {
          id: `${ctx.symbol}|LIQ|SELL|${m[s0].t}`, symbol: ctx.symbol, strategy: 'Liquidity', side: 'SELL', setup,
          entry, entryType, zone: [L.price - tol, L.price + tol], sl, tp, rr: Math.round(rr * 100) / 100, confidence: conf,
          level: { label: L.label, price: L.price }, sweep: { time: m[s0].t, extreme }, choch: { time: m[c].t, level: bms },
          htfTrend: trend, reasons
        },
        status: `${setup} — SELL signal`
      };
    }
  }
  return { signal: null, status };
}

function unmirrorSignal(s) {
  if (!s) return null;
  const sig = Object.assign({}, s, {
    side: 'BUY', entry: -s.entry, sl: -s.sl, tp: -s.tp, zone: [-s.zone[1], -s.zone[0]],
    level: { label: s.level.label.replace(/H$/, 'L').replace('Swing High', 'Swing Low').replace('EQH', 'EQL'), price: -s.level.price },
    sweep: { time: s.sweep.time, extreme: -s.sweep.extreme }, choch: { time: s.choch.time, level: -s.choch.level },
    htfTrend: s.htfTrend === 'up' ? 'down' : s.htfTrend === 'down' ? 'up' : s.htfTrend
  });
  sig.id = s.id.replace('|SELL|', '|BUY|');
  sig.reasons = s.reasons.map(r => r
    .replace('H4 trend down (aligned)', 'H4 trend up (aligned)')
    .replace('equal highs liquidity', 'equal lows liquidity')
    .replace('CHoCH below', 'CHoCH above')
    .replace(/(P[DWM])H liquidity/, '$1L liquidity').replace('Swing High liquidity', 'Swing Low liquidity').replace('EQH liquidity', 'EQL liquidity'));
  return sig;
}

/* ---------- public ---------- */
function analyze(ctx, opts) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const sell = analyzeSell(ctx, Object.assign({}, cfg, { _sign: 1 }));
  const buyRaw = analyzeSell(mirror(ctx), Object.assign({}, cfg, { _sign: -1 }));
  const buy = { signal: unmirrorSignal(buyRaw.signal), status: buyRaw.status };
  const sigs = [sell.signal, buy.signal].filter(Boolean).sort((a, b) => b.confidence - a.confidence);
  if (sigs.length) return { signal: sigs[0], status: sigs[0].setup + ' — ' + sigs[0].side + ' signal' };
  return { signal: null, status: `SELL: ${sell.status} | BUY: ${buy.status}` };
}

module.exports = { analyze, DEFAULTS };

/* Usage on the server, once per symbol on each new closed M15 candle:

   const liq = require('./liquidity-strategy');
   const { adConfirms } = require('./ad-confirm');          // optional confirmation filter

   if (engine.strats.includes('Liquidity')) {
     const { signal, status } = liq.analyze({ symbol, m15, h4, d1 });
     if (!signal) { log(`${symbol} Liquidity: ${status}`); }
     else if (signal.confidence >= engine.conf && !alreadyTraded(signal.id)) {
       if (engine.confirm.includes('ad') && !adConfirms(m15, signal.side).ok) return;
       placeOrder(symbol, signal.side, engine.lot, signal.sl, signal.tp);   // signal.entryType: 'market' | 'limit' @ signal.entry
       markTraded(signal.id);                                                // signal.id stops duplicate trades
     }
   }
*/
