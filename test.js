const assert = require('assert'), { analyze } = require('./strategy');
const { analyze: an } = require('./strategy'), fx = require('./fixture');
const r = an(fx.htf, fx.ltf); console.log('strategy:', r.signal, r.entry.toFixed(2), r.sl.toFixed(2), r.tp.toFixed(2), r.rr, r.confidence + '%');
assert.equal(r.signal, 'SELL'); assert(r.sl > r.entry && r.tp < r.entry && r.rr > 1.5);
const T0 = Date.UTC(2026, 0, 1), H4 = 4 * 3600e3, M15 = 15 * 60e3, mk = (t, o, h, l, c) => ({ t, o, h, l, c });
// random data must never throw
for (let n = 0; n < 200; n++) { const rc = (cnt, st) => { let x = 100; return Array.from({ length: cnt }, (_, i) => { const o = x, c = x + (Math.random() - .5) * 2; x = c; return mk(T0 + i * st, o, Math.max(o, c) + Math.random(), Math.min(o, c) - Math.random(), c); }); }; analyze(rc(120, H4), rc(200, M15)); }
console.log('strategy fuzz ok');
// --- server e2e (DRY RUN, no external calls) ---
process.env.DATA_FILE = '/tmp/gf-test.json'; process.env.ADMIN_TOKEN = 'adm'; process.env.PORT = 18080; process.env.DRY_RUN = 'true';
try { require('fs').unlinkSync(process.env.DATA_FILE); } catch {}
const { app } = require('./server'); const srv = app.listen(18080, async () => {
  const B = 'http://127.0.0.1:18080', j = async (path, m = 'GET', body, h = {}) => { const r = await fetch(B + path, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: body && JSON.stringify(body) }); return { s: r.status, ...(await r.json()) }; };
  try {
    assert.equal((await j('/admin/keys')).s, 401, 'admin needs token');
    const A = { 'X-Admin': 'adm' };
    assert.equal((await j('/admin/keys', 'POST', { plan: 'bogus' }, A)).s, 400);
    const k = (await j('/admin/keys', 'POST', { client: 'Tom', ea: 'Robot', plan: '30d' }, A)).keys[0]; console.log('key', k);
    assert.equal((await j('/license/activate', 'POST', { key: 'GF-AAAA-BBBB-CCCC', device: 'd1' })).s, 400);
    assert.equal((await j('/license/activate', 'POST', { key: k, device: 'd1' })).ok, true);
    assert.equal((await j('/license/activate', 'POST', { key: k, device: 'd1' })).ok, true, 'same device ok');
    assert.equal((await j('/license/activate', 'POST', { key: k, device: 'd2' })).s, 403, 'single use');
    assert.equal((await j('/engine/start', 'POST', {}, { 'X-License': k })).s, 400, 'needs account');
    assert.equal((await j('/engine/state')).s, 401);
    assert.equal((await j('/scan', 'POST', { image: 'x' }, { 'X-License': k })).s, 501);
    const m = await j('/admin/mentors', 'POST', { email: 'Mentor@x.com' }, A); assert(/^MN-/.test(m.id));
    assert.equal((await j('/mentor/check?id=' + m.id + '&email=mentor@x.com')).ok, true);
    await j(`/admin/mentors/${m.id}/toggle`, 'POST', { active: false }, A);
    assert.equal((await j('/mentor/check?id=' + m.id + '&email=mentor@x.com')).ok, false, 'deactivated');
    const k2 = (await j('/admin/keys', 'POST', { client: 'A', plan: 'lifetime', mentorEmail: 'mentor@x.com' }, A)).keys[0];
    assert.equal((await j('/license/activate', 'POST', { key: k2, device: 'x' })).s, 403, 'mentor off blocks key');
    await j(`/admin/keys/${k}/revoke`, 'POST', { active: false }, A);
    assert.equal((await j('/engine/state', 'GET', null, { 'X-License': k })).s, 401, 'revoked');
    console.log('server e2e ok'); process.exit(0);
  } catch (e) { console.error('FAIL', e.message); process.exit(1); }
});
