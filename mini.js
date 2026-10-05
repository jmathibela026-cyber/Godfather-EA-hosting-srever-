// Minimal express-like server on node:http (zero dependencies).
const http = require('http');
function express() {
  const mw = [], routes = [];
  const app = (req, res) => {
    const u = new URL(req.url, 'http://x'); req.path = u.pathname; req.query = Object.fromEntries(u.searchParams);
    req.get = h => req.headers[h.toLowerCase()];
    res.status = c => { res.statusCode = c; return res; };
    res.set = o => { for (const k in o) res.setHeader(k, o[k]); return res; };
    res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    res.sendStatus = c => { res.statusCode = c; res.end(); };
    const chunks = []; let size = 0, dead = false;
    req.on('data', d => { size += d.length; if (size > 10e6) { dead = true; res.status(413).json({ ok: false, error: 'Too large' }); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      if (dead) return;
      req.body = {};
      if (chunks.length) { try { req.body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return res.status(400).json({ ok: false, error: 'Bad JSON' }); } }
      const stack = [...mw];
      const route = routes.find(r => r.m === req.method && (req.params = match(r.p, req.path)));
      const run = i => {
        if (i < stack.length) return stack[i](req, res, () => run(i + 1));
        if (!route) return res.status(404).json({ ok: false, error: 'Not found' });
        let j = 0; const hs = route.h; const next = () => hs[j++](req, res, next); next();
      };
      try { run(0); } catch (e) { res.status(500).json({ ok: false }); }
    });
  };
  const match = (p, path) => { const a = p.split('/'), b = path.split('/'); if (a.length !== b.length) return null; const o = {}; for (let i = 0; i < a.length; i++) { if (a[i][0] === ':') o[a[i].slice(1)] = decodeURIComponent(b[i]); else if (a[i] !== b[i]) return null; } return o; };
  app.use = f => mw.push(f);
  for (const m of ['get', 'post']) app[m] = (p, ...h) => routes.push({ m: m.toUpperCase(), p, h });
  app.listen = (port, cb) => http.createServer(app).listen(port, cb);
  return app;
}
express.json = () => (q, s, n) => n();   // body parsing is built in
module.exports = express;
