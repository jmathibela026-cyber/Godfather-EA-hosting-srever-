# Godfather-EA server

Zero npm dependencies (Node 18+). Handles licence keys (single-use, plans, expiry, revoke), mentors, MetaAPI linking/execution, the H4/M15 liquidity-sweep engine (Twelve Data) and the optional chart scanner.

## Run
    cp .env.example .env   # fill in, then export the vars (or set them in your host's dashboard)
    node server.js
    node test.js           # strategy + API tests

## Deploy (Render / Railway / Fly)
Start command `node server.js`. Set env vars from `.env.example`. Mount a persistent disk and point DATA_FILE at it, otherwise keys are lost on redeploy.
Set ALLOWED_ORIGIN to your GitHub Pages origin (https://<user>.github.io).

## Safety
DRY_RUN=true (default): the engine only LOGS signals. Test on a demo account first, then set DRY_RUN=false to send real orders.
Signals use limit orders at the OTE/OB entry; SL beyond the order block; TP at the next swing.

## Endpoints
Admin (header X-Admin): POST/GET /admin/keys, POST /admin/keys/:k/revoke, POST/GET /admin/mentors, POST /admin/mentors/:id/toggle
App (header X-License): POST /license/activate, /accounts/link, /engine/start, /engine/stop, /positions/close, /scan; GET /engine/state
