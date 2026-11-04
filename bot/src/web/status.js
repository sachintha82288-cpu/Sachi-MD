const http=require('http');const config=require('../config');const whatsapp=require('../whatsapp/client');const downloader=require('../services/downloader/manager');const log=require('../utils/logger');

/** Build the status request handler. token = optional shared secret. */
function createRequestHandler(token = String(process.env.STATUS_TOKEN || '').trim()) {
  return function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    // Optional shared-secret gate: set STATUS_TOKEN in .env to require
    // ?token=… (or an Authorization: Bearer … header) on status requests.
    if (token) {
      const u = new URL(req.url, 'http://x');
      const given = String(u.searchParams.get('token') || '');
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (given !== token && bearer !== token) { res.statusCode = 403; res.end(JSON.stringify({ error: 'forbidden' })); return; }
    }
    const body = { status: whatsapp.status().connected ? 'connected' : 'starting', bot: config.botName, version: config.version, whatsapp: whatsapp.status(), downloader: downloader.status(), uptime: Math.floor(process.uptime()) };
    res.end(JSON.stringify(body, null, 2));
  };
}

function start(){
  const token = String(process.env.STATUS_TOKEN || '').trim();
  const server = http.createServer(createRequestHandler(token));
  // Clear diagnosis instead of an uncaught EADDRINUSE crash later.
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') log.error(`Status server could not start: port ${config.port} is already in use (another bot copy running?). The bot itself keeps running.`);
    else log.error(`Status server error: ${e && e.message ? e.message : e}`);
  });
  server.listen(config.port, '0.0.0.0', () => console.log(`[Sachi MD] Status server listening on :${config.port}${token ? ' (token-protected)' : ' (OPEN — set STATUS_TOKEN in .env to protect it)'}`));
  return server;
}
module.exports = { start, createRequestHandler };