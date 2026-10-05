// Liquidity Sweep strategy (ICT): H4 liquidity sweep -> M15 CHoCH -> entry on OB/FVG (OTE if they disagree),
// SL beyond the order block, TP at the next swing point. Candles: [{t,o,h,l,c}] oldest -> newest, CLOSED candles only.
function swings(c, n = 2) {
  const hi = [], lo = [];
  for (let i = n; i < c.length - n; i++) {
    let h = true, l = true;
    for (let k = 1; k <= n; k++) {
      if (c[i].h <= c[i - k].h || c[i].h <= c[i + k].h) h = false;
      if (c[i].l >= c[i - k].l || c[i].l >= c[i + k].l) l = false;
    }
    if (h) hi.push({ i, p: c[i].h });
    if (l) lo.push({ i, p: c[i].l });
  }
  return { hi, lo };
}
// Most recent HTF sweep within the last `look` candles: wick beyond a prior swing, close back inside.
function findSweep(htf, look = 4) {
  const { hi, lo } = swings(htf);
  for (let i = htf.length - 1; i >= htf.length - look && i > 5; i--) {
    const k = htf[i];
    const ph = hi.filter(s => s.i < i - 1).pop(), pl = lo.filter(s => s.i < i - 1).pop();
    const range = Math.max(k.h - k.l, 1e-9);
    if (ph && k.h > ph.p && k.c < ph.p) return { dir: 'SELL', level: ph.p, extreme: k.h, t: k.t, idx: i, quality: Math.min(1, (k.h - Math.max(k.o, k.c)) / range * 2) };
    if (pl && k.l < pl.p && k.c > pl.p) return { dir: 'BUY', level: pl.p, extreme: k.l, t: k.t, idx: i, quality: Math.min(1, (Math.min(k.o, k.c) - k.l) / range * 2) };
  }
  return null;
}
// LTF CHoCH after the sweep: SELL -> close below the swing low that preceded the latest swing high.
function findChoch(ltf, sweep) {
  const c = ltf.filter(x => x.t >= sweep.t), base = ltf.length - c.length;
  if (c.length < 8) return null;
  const { hi, lo } = swings(c, 2);
  if (sweep.dir === 'SELL') {
    const h = hi[hi.length - 1]; if (!h) return null;
    const l = lo.filter(s => s.i < h.i).pop(); if (!l) return null;
    for (let i = h.i + 1; i < c.length; i++) if (c[i].c < l.p) {
      const legLow = Math.min(...c.slice(h.i, i + 1).map(x => x.l));
      return { brokeIdx: i + base, swingHigh: h.p, swingHighIdx: h.i + base, legLow, level: l.p, disp: (l.p - c[i].c) / Math.max(h.p - l.p, 1e-9) };
    }
  } else {
    const l = lo[lo.length - 1]; if (!l) return null;
    const h = hi.filter(s => s.i < l.i).pop(); if (!h) return null;
    for (let i = l.i + 1; i < c.length; i++) if (c[i].c > h.p) {
      const legHigh = Math.max(...c.slice(l.i, i + 1).map(x => x.h));
      return { brokeIdx: i + base, swingLow: l.p, swingLowIdx: l.i + base, legHigh, level: h.p, disp: (c[i].c - h.p) / Math.max(h.p - l.p, 1e-9) };
    }
  }
  return null;
}
function analyze(htf, ltf, opts = {}) {
  const buf = opts.buffer ?? 0;
  const sweep = findSweep(htf); if (!sweep) return { signal: 'WAIT', reason: 'No HTF liquidity sweep' };
  const ch = findChoch(ltf, sweep); if (!ch) return { signal: 'WAIT', reason: `${sweep.dir} sweep found, waiting for M15 CHoCH`, sweep };
  const sell = sweep.dir === 'SELL';
  // Order block: last opposite-colour candle before the impulse from the swing extreme.
  const from = sell ? ch.swingHighIdx : ch.swingLowIdx;
  let ob = null;
  for (let i = from; i >= Math.max(0, from - 6); i--) {
    const k = ltf[i]; if (sell ? k.c > k.o : k.c < k.o) { ob = { hi: k.h, lo: k.l, mid: (k.h + k.l) / 2 }; break; }
  }
  if (!ob) { const k = ltf[from]; ob = { hi: k.h, lo: k.l, mid: (k.h + k.l) / 2 }; }
  // FVG inside the displacement leg.
  let fvg = null;
  for (let i = from + 1; i <= Math.min(ch.brokeIdx, ltf.length - 1) - 1 && i < ltf.length - 1; i++) {
    const a = ltf[i - 1], b = ltf[i + 1];
    if (sell && a.l > b.h) fvg = { hi: a.l, lo: b.h, mid: (a.l + b.h) / 2 };
    if (!sell && a.h < b.l) fvg = { hi: b.l, lo: a.h, mid: (b.l + a.h) / 2 };
  }
  // OTE 61.8%-78.6% retrace of the leg.
  const top = sell ? ch.swingHigh : ch.legHigh, bot = sell ? ch.legLow : ch.swingLow, rng = top - bot;
  const ote = sell ? { lo: bot + rng * .618, hi: bot + rng * .786 } : { lo: top - rng * .786, hi: top - rng * .618 };
  const oteMid = (ote.lo + ote.hi) / 2;
  const zoneMid = fvg ? (ob.mid + fvg.mid) / 2 : ob.mid;
  const inOte = zoneMid >= ote.lo && zoneMid <= ote.hi;
  const entry = inOte ? zoneMid : oteMid; // OTE wins when it disagrees with OB/FVG
  const sl = sell ? ob.hi + buf : ob.lo - buf;
  // TP: next swing beyond the leg on LTF/HTF.
  const sh = swings(htf), sl2 = swings(ltf);
  let tp;
  if (sell) { const c = [...sh.lo, ...sl2.lo].map(s => s.p).filter(p => p < entry).sort((a, b) => b - a); tp = c[0] ?? ch.legLow; }
  else { const c = [...sh.hi, ...sl2.hi].map(s => s.p).filter(p => p > entry).sort((a, b) => a - b); tp = c[0] ?? ch.legHigh; }
  const risk = Math.abs(entry - sl), rr = risk > 0 ? Math.abs(tp - entry) / risk : 0;
  if (!(risk > 0) || (sell ? !(sl > entry && tp < entry) : !(sl < entry && tp > entry))) return { signal: 'WAIT', reason: 'Invalid geometry (SL/TP vs entry)', sweep };
  let conf = 50 + sweep.quality * 15 + Math.min(1, ch.disp * 2) * 15 + (fvg ? 10 : 0) + (inOte ? 5 : 0) + (rr >= 2 ? 10 : rr >= 1.5 ? 5 : 0);
  conf = Math.round(Math.min(99, conf));
  const last = ltf[ltf.length - 1].c;
  // Stale only if price already invalidated the setup (hit SL) or reached the target.
  if (sell ? (last >= sl || last <= tp) : (last <= sl || last >= tp)) return { signal: 'WAIT', reason: 'Setup invalidated or target already reached', sweep };
  return { signal: sell ? 'SELL' : 'BUY', entry, sl, tp, rr: +rr.toFixed(2), confidence: conf, ob, fvg, ote, sweep: { level: sweep.level, t: sweep.t }, reason: `${sweep.dir} sweep @${sweep.level} + M15 CHoCH` };
}
module.exports = { analyze, swings, findSweep, findChoch };
