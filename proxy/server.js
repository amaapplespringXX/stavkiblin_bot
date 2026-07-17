/* Тонкий HTTPS-фронт для Render free tier: прозрачно проксирует всё на wispbyte-бэк.
   Render даёт HTTPS и домен *.onrender.com (не в AdGuard-блоклистах, в отличие от *.workers.dev).
   Start Command на Render: node proxy/server.js, env BACKEND_URL=http://<sub>.duckdns.org:<порт>. */
'use strict';

const http = require('http');

const BACKEND_URL = process.env.BACKEND_URL || '';
const PORT = Number(process.env.PORT || 10000);

if (!BACKEND_URL) {
  console.error('[proxy] не задан BACKEND_URL (например http://stavkiblin.duckdns.org:9255)');
  process.exit(1);
}
const target = new URL(BACKEND_URL);

http.createServer((req, res) => {
  if (req.url === '/proxy-health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  const up = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    },
    (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    },
  );
  up.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('backend unavailable');
  });
  req.pipe(up);
}).listen(PORT, () => console.log(`[proxy] :${PORT} -> ${BACKEND_URL}`));
