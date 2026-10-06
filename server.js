const express = require('./mini'), fs = require('fs'), crypto = require('crypto');
const { analyze } = require('./strategy');
const E = process.env, PORT = +E.PORT || 8080, DRY = (E.DRY_RUN || 'true') !== 'false';
const DATA = E.DATA_FILE || './data.json', SCAN_MS = (+E.SCAN_SECONDS || 60) * 1000;
const PROV = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';
const CLIENT = E.METAAPI_CLIENT_HOST || 'https://mt-client-api-v1.new-york.agiliumtrade.ai';
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------- store (JSON file, atomic writes) ---------- */
let db = { keys: {}, lic: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA, 'utf8'))); } catch {}
let dirty = false;
const save = () => { dirty = true; };
setInterval(() => { if (!dirty) return; dirty = false; try { fs.writeFileSync(DATA + '.tmp', JSON.stringify(db)); fs.renameSync(DATA + '.tmp', DATA); } catch (e) { console.error('save', e.message); } }, 2000);

/* ---------- licence keys (same format/checksum as the app) ---------- */
const chk = s => { let a = 7; for (const c of s.replace(/-/g, '')) a = (a * 31 + c.charCodeAt(0)) % ALPH.length; return ALPH[a]; };
const rnd = n => Array.from(crypto.randomBytes(n), b => ALPH[b % ALPH.length]).join('');
const newKey = () => { const b = `GF-${rnd(4)}-${rnd(4)}-${rnd(3)}`; return b + chk(b); };
const expired = k => k.days != null && k.activated && Date.now() > k.activated + k.days * 864e5;
const mentorOff = k => { if (!k.mentorEmail) return false; const m = Object.values(db.mentors || {}).find(x => x.email === k.mentorEmail); return !!m && !m.active; };
const validFmt = k => /^GF-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(k) && k.slice(-1) === chk(k.slice(0, -1));

const app = express();
app.use((req, res, next) => {
  res.set({ 'Access-Control-Allow-Origin': E.ALLOWED_ORIGIN || '*', 'Access-Control-Allow-Headers': 'Content-Type,X-License,X-Admin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Vary': 'Origin' });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '8mb' }));
const wrap = f => (req, res) => Promise.resolve(f(req, res)).catch(e => { console.error(e); res.status(500).json({ ok: false, error: 'Server error' }); });

const admin = (req, res, next) => (E.ADMIN_TOKEN && req.get('X-Admin') === E.ADMIN_TOKEN) ? next() : res.status(401).json({ ok: false, error: 'Unauthorized' });
db.robots = db.robots || {};
app.post('/admin/robots', admin, (req, res) => {          // {name, author, platform, cover(dataURL)}
  const b = req.body || {}, name = String(b.name || '').trim().slice(0, 60); if (!name) return res.status(400).json({ ok: false, error: 'Robot name required' });
  const cover = String(b.cover || ''); if (cover && (!/^data:image\/(jpeg|png|webp);base64,/.test(cover) || cover.length > 400000)) return res.status(400).json({ ok: false, error: 'Cover must be a small jpeg/png/webp image' });
  if (Object.values(db.robots).some(r => r.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ ok: false, error: 'A robot with this name exists' });
  const id = 'RB-' + rnd(5); db.robots[id] = { name, author: String(b.author || '').slice(0, 60), platform: b.platform === 'MT4' ? 'MT4' : 'MT5', cover, active: true, created: Date.now() };
  save(); res.json({ ok: true, id });
});
app.get('/admin/robots', admin, (req, res) => res.json({ ok: true, robots: db.robots }));
app.post('/admin/robots/:id/toggle', admin, (req, res) => { const r = db.robots[req.params.id]; if (!r) return res.status(404).json({ ok: false }); r.active = req.body.active === true; save(); res.json({ ok: true, active: r.active }); });
const PLANS = { '3d': 3, '5d': 5, '30d': 30, '3m': 90, '6m': 180, '1y': 365, lifetime: null };
app.post('/admin/keys', admin, (req, res) => {           // {client, ea, plan, mentorEmail, count}
  const b = req.body || {}; if (!(b.plan in PLANS)) return res.status(400).json({ ok: false, error: 'Bad plan' });
  const rb = b.robotId ? db.robots[b.robotId] : null; if (b.robotId && !rb) return res.status(400).json({ ok: false, error: 'Unknown robot' });
  const out = []; for (let i = 0; i < Math.min(+b.count || 1, 100); i++) { const k = newKey(); db.keys[k] = { created: Date.now(), client: String(b.client || '').slice(0, 80), robotId: b.robotId || null, ea: rb ? rb.name : String(b.ea || '').slice(0, 80), plan: b.plan, days: PLANS[b.plan], mentorEmail: String(b.mentorEmail || '').toLowerCase(), device: null, active: true }; out.push(k); }
  save(); res.json({ ok: true, keys: out });
});
app.get('/admin/keys', admin, (req, res) => res.json({ ok: true, keys: db.keys }));
app.post('/admin/keys/:k/revoke', admin, (req, res) => { const k = db.keys[req.params.k]; if (!k) return res.status(404).json({ ok: false }); k.active = req.body.active === true; if (!k.active && db.lic[req.params.k]) db.lic[req.params.k].running = false; save(); res.json({ ok: true, active: k.active }); });
// mentors: ID + email, can be activated/deactivated
db.mentors = db.mentors || {};
app.post('/admin/mentors', admin, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Valid email required' });
  const ex = Object.entries(db.mentors).find(([, m]) => m.email === email); if (ex) return res.json({ ok: true, id: ex[0], existing: true });
  const id = 'MN-' + rnd(6); db.mentors[id] = { email, active: true, created: Date.now() }; save(); res.json({ ok: true, id });
});
app.get('/admin/mentors', admin, (req, res) => res.json({ ok: true, mentors: db.mentors }));
app.post('/admin/mentors/:id/toggle', admin, (req, res) => { const m = db.mentors[req.params.id]; if (!m) return res.status(404).json({ ok: false }); m.active = req.body.active === true; save(); res.json({ ok: true, active: m.active }); });
app.get('/mentor/check', (req, res) => { const m = db.mentors[String(req.query.id || '').toUpperCase()]; res.json({ ok: !!(m && m.active && m.email === String(req.query.email || '').toLowerCase()) }); });

app.post('/license/activate', wrap((req, res) => {
  const key = String(req.body.key || '').toUpperCase(), dev = String(req.body.device || '').slice(0, 300);
  const k = db.keys[key];
  if (!validFmt(key) || !k) return res.status(400).json({ ok: false, error: 'Invalid licence key.' });
  if (!k.active) return res.status(403).json({ ok: false, error: 'This key has been revoked.' });
  if (mentorOff(k)) return res.status(403).json({ ok: false, error: 'Your mentor account is deactivated.' });
  if (expired(k)) return res.status(403).json({ ok: false, error: 'This licence has expired.' });
  if (k.device && k.device !== dev) return res.status(403).json({ ok: false, error: 'Key already used on another device.' });
  k.device = dev; k.activated = k.activated || Date.now(); db.lic[key] = db.lic[key] || { logs: [], running: false, cfg: {}, acct: null, seen: {} };
  const rb = k.robotId && db.robots[k.robotId];
  if (rb && !rb.active) return res.status(403).json({ ok: false, error: 'This robot is currently unavailable.' });
  save(); res.json({ ok: true, robot: rb ? { name: rb.name, author: rb.author, platform: rb.platform, cover: rb.cover } : null });
}));
const auth = (req, res, next) => { const k = (req.get('X-License') || '').toUpperCase(); const kk = db.keys[k]; if (!kk || !kk.active || expired(kk) || mentorOff(kk) || !db.lic[k]) return res.status(401).json({ ok: false, error: 'Not licensed' }); req.key = k; req.L = db.lic[k]; next(); };
const llog = (L, m) => { L.logs.push({ t: Date.now(), m: `[${new Date().toTimeString().slice(0, 8)}] ${m}` }); if (L.logs.length > 500) L.logs.splice(0, L.logs.length - 500); save(); };

/* ---------- MetaAPI ---------- */
const mh = () => ({ 'auth-token': E.METAAPI_TOKEN, 'Content-Type': 'application/json' });
async function mreq(url, method = 'GET', body) {
  if (!E.METAAPI_TOKEN) throw new Error('METAAPI_TOKEN not set');
  const r = await fetch(url, { method, headers: mh(), body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = { raw: txt }; }
  if (!r.ok) throw new Error(j.message || j.error || `MetaAPI ${r.status}`);
  return j;
}
app.post('/accounts/link', auth, wrap(async (req, res) => {
  const { platform, server, login, password, symbols, lot } = req.body;
  if (!server || !login || !password) return res.status(400).json({ ok: false, error: 'Missing fields' });
  try {
    const a = await mreq(`${PROV}/users/current/accounts`, 'POST', { name: `GF-${req.key.slice(3, 7)}-${login}`, type: 'cloud-g2', login: String(login), password, server, platform: String(platform).toLowerCase() === 'mt4' ? 'mt4' : 'mt5', magic: 777, application: 'MetaApi' });
    try { await mreq(`${PROV}/users/current/accounts/${a.id}/deploy`, 'POST'); } catch {}
    req.L.acct = { id: a.id, platform, server, login: String(login), suffix: req.L.acct?.suffix || '' };
  } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  req.L.cfg = Object.assign(req.L.cfg, { symbols: symbols || [], lot: +lot || .05 });
  llog(req.L, `Account ${login} linked (${platform})`); save(); res.json({ ok: true });
}));

/* ---------- market data (Twelve Data) ---------- */
const map = s => ({ XAUUSD: 'XAU/USD', BTCUSD: 'BTC/USD' }[s] || (/^[A-Z]{6}$/.test(s) ? s.slice(0, 3) + '/' + s.slice(3) : null));
const cache = new Map();
async function candles(sym, interval, size) {
  const ck = sym + interval, c = cache.get(ck), ttl = interval === '4h' ? 600000 : 45000;
  if (c && Date.now() - c.t < ttl) return c.d;
  const m = map(sym); if (!m) throw new Error('unsupported symbol ' + sym);
  if (!E.TWELVE_DATA_KEY) throw new Error('TWELVE_DATA_KEY not set');
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(m)}&interval=${interval}&outputsize=${size}&timezone=UTC&apikey=${E.TWELVE_DATA_KEY}`);
  const j = await r.json(); if (j.status === 'error' || !j.values) throw new Error(j.message || 'no data');
  const d = j.values.map(v => ({ t: Date.parse(v.datetime.replace(' ', 'T') + 'Z'), o: +v.open, h: +v.high, l: +v.low, c: +v.close })).reverse();
  // drop the still-forming candle
  const step = interval === '4h' ? 4 * 3600e3 : 15 * 60e3; if (d.length && d[d.length - 1].t + step > Date.now()) d.pop();
  cache.set(ck, { t: Date.now(), d }); return d;
}

/* ---------- engine ---------- */
const digits = p => p > 500 ? 2 : p > 20 ? 3 : 5;
async function scanOne(key, L) {
  const cfg = L.cfg, minConf = cfg.conf ?? 85, maxT = cfg.maxt ?? 5;
  let open = []; if (!DRY && L.acct) { try { open = await mreq(`${CLIENT}/users/current/accounts/${L.acct.id}/positions`); } catch (e) { llog(L, 'Positions error: ' + e.message); } }
  for (const sym of cfg.symbols || []) {
    try {
      const [htf, ltf] = [await candles(sym, '4h', 120), await candles(sym, '15min', 200)];
      const r = analyze(htf, ltf, { buffer: (htf[htf.length - 1].c) * 0.0002 });
      if (r.signal === 'WAIT') { llog(L, `${sym}: WAIT — ${r.reason}`); continue; }
      const id = `${sym}|${r.signal}|${r.sweep.t}`;
      if (L.seen[id]) continue;
      if (r.confidence < minConf) { llog(L, `${sym}: ${r.signal} setup ${r.confidence}% < ${minConf}% — skipped`); continue; }
      if (open.length >= maxT) { llog(L, `${sym}: ${r.signal} ${r.confidence}% — max trades (${maxT}) reached`); continue; }
      const d = digits(r.entry), f = x => +x.toFixed(d);
      const msg = `${sym}: ${r.signal} @${f(r.entry)} SL ${f(r.sl)} TP ${f(r.tp)} RR ${r.rr} (${r.confidence}%)`;
      if (DRY) { llog(L, '[DRY RUN] ' + msg); L.seen[id] = Date.now(); continue; }
      if (!L.acct) { llog(L, 'No linked account'); continue; }
      const last = ltf[ltf.length - 1].c, sell = r.signal === 'SELL';
      const type = sell ? (last < r.entry ? 'ORDER_TYPE_SELL_LIMIT' : 'ORDER_TYPE_SELL') : (last > r.entry ? 'ORDER_TYPE_BUY_LIMIT' : 'ORDER_TYPE_BUY');
      const body = { actionType: type, symbol: sym + (L.acct.suffix || ''), volume: cfg.lot || .05, stopLoss: f(r.sl), takeProfit: f(r.tp), comment: 'Godfather-EA' };
      if (type.endsWith('LIMIT')) body.openPrice = f(r.entry);
      const o = await mreq(`${CLIENT}/users/current/accounts/${L.acct.id}/trade`, 'POST', body);
      L.seen[id] = Date.now(); llog(L, `ORDER SENT ${msg} → ${o.stringCode || o.message || 'ok'}`);
    } catch (e) { llog(L, `${sym}: ${e.message}`); }
  }
  for (const k of Object.keys(L.seen)) if (Date.now() - L.seen[k] > 3 * 864e5) delete L.seen[k];
}
let busy = false;
setInterval(async () => {
  if (busy) return; busy = true;
  try { for (const [k, L] of Object.entries(db.lic)) if (L.running && db.keys[k]?.active && !expired(db.keys[k])) await scanOne(k, L); } finally { busy = false; }
}, SCAN_MS);

app.post('/engine/start', auth, (req, res) => {
  const b = req.body || {};
  if (!req.L.acct) return res.status(400).json({ ok: false, error: 'Link an account first' });
  req.L.cfg = Object.assign(req.L.cfg, { symbols: b.symbols || req.L.cfg.symbols || [], lot: +b.lot || req.L.cfg.lot || .05, conf: +b.conf || 85, maxt: +b.maxt || 5, strats: b.strats || [] });
  req.L.running = true; llog(req.L, `Engine started${DRY ? ' (DRY RUN — no orders)' : ''}: ${req.L.cfg.symbols.join(', ')} · min ${req.L.cfg.conf}%`);
  save(); res.json({ ok: true, dryRun: DRY });
});
app.post('/engine/stop', auth, (req, res) => { req.L.running = false; llog(req.L, 'Engine stopped'); res.json({ ok: true }); });
app.get('/engine/state', auth, wrap(async (req, res) => {
  const since = +req.query.since || 0; let positions = [];
  if (!DRY && req.L.acct) { try { positions = (await mreq(`${CLIENT}/users/current/accounts/${req.L.acct.id}/positions`)).map(p => ({ id: p.id, sym: p.symbol, side: p.type.includes('SELL') ? 'SELL' : 'BUY', lot: p.volume, sl: p.stopLoss ?? '-', tp: p.takeProfit ?? '-', pl: p.profit ?? 0 })); } catch {} }
  const log = req.L.logs.filter(l => l.t > since);
  res.json({ ok: true, running: req.L.running, dryRun: DRY, positions, log: log.map(l => l.m), next: log.length ? log[log.length - 1].t : since });
}));
app.post('/positions/close', auth, wrap(async (req, res) => {
  if (DRY || !req.L.acct) return res.status(400).json({ ok: false, error: 'Dry run / no account' });
  await mreq(`${CLIENT}/users/current/accounts/${req.L.acct.id}/trade`, 'POST', { actionType: 'POSITION_CLOSE_ID', positionId: String(req.body.id) });
  llog(req.L, `Closed position ${req.body.id}`); res.json({ ok: true });
}));

/* ---------- live scanner: strategy rules on real candles ---------- */
app.post('/scan/live', auth, async (req, res) => {
  try {
    const sym = String(req.body.symbol || '').toUpperCase(); if (!map(sym)) return res.status(400).json({ ok: false, error: 'Unsupported symbol' });
    const htf = await candles(sym, '4h', 120), ltf = await candles(sym, '15min', 200);
    const r = analyze(htf, ltf, { buffer: htf[htf.length - 1].c * 0.0002 });
    if (r.signal === 'WAIT') return res.json({ ok: true, bias: 'WAIT', entry: '—', sl: '—', tp: '—', note: r.reason });
    const d = digits(r.entry), f = x => (+x).toFixed(d);
    res.json({ ok: true, bias: r.signal, entry: f(r.entry), sl: f(r.sl), tp: f(r.tp), note: `RR ${r.rr} · confidence ${r.confidence}% · ${r.reason}` });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

/* ---------- chart scanner (vision): Gemini preferred, Anthropic optional ---------- */
const SCAN_PROMPT = 'You read trading chart screenshots using the liquidity-sweep method (higher-timeframe liquidity sweep, lower-timeframe CHoCH, entry at order block/FVG, stop beyond the order block, take profit at the next swing). Respond with ONLY JSON: {"bias":"BUY|SELL|WAIT","entry":"price or zone","sl":"price","tp":"price","note":"one sentence; say clearly if prices are unreadable"}. Never invent prices that are not visible on the chart.';
const parseJson = t => { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('No JSON in reply'); return JSON.parse(t.slice(a, b + 1)); };
app.post('/scan', auth, wrap(async (req, res) => {
  if (!E.GEMINI_API_KEY && !E.ANTHROPIC_API_KEY) return res.status(501).json({ ok: false, error: 'Scanner not configured (set GEMINI_API_KEY)' });
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(req.body.image || ''); if (!m) return res.status(400).json({ ok: false, error: 'Bad image' });
  let text;
  if (E.GEMINI_API_KEY) {
    const base = E.GEMINI_BASE || 'https://generativelanguage.googleapis.com', model = E.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await fetch(`${base}/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': E.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: SCAN_PROMPT }, { inline_data: { mime_type: m[1], data: m[2] } }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 600 } }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) return res.status(502).json({ ok: false, error: j.error?.message || 'Scan failed' });
    text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!text) return res.status(502).json({ ok: false, error: 'Scanner returned no result (image may have been blocked)' });
  } else {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: E.SCAN_MODEL || 'claude-sonnet-5-5', max_tokens: 400, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: SCAN_PROMPT }] }] }) });
    const j = await r.json(); if (!r.ok) return res.status(502).json({ ok: false, error: j.error?.message || 'Scan failed' });
    text = (j.content || []).map(c => c.text || '').join('');
  }
  let o; try { o = parseJson(text); } catch { return res.status(502).json({ ok: false, error: 'Could not understand the scan result, try again' }); }
  const bias = ['BUY', 'SELL', 'WAIT'].includes(String(o.bias).toUpperCase()) ? String(o.bias).toUpperCase() : 'WAIT';
  res.json({ ok: true, bias, entry: String(o.entry ?? '—'), sl: String(o.sl ?? '—'), tp: String(o.tp ?? '—'), note: String(o.note ?? '') });
}));

app.get('/health', (q, r) => r.json({ ok: true, dryRun: DRY }));
if (require.main === module) app.listen(PORT, () => console.log(`Godfather-EA server :${PORT} dryRun=${DRY}`));
module.exports = { app, cache };
