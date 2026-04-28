'use strict';
const http  = require('http');
const https = require('https');

// ─── RELLENA ESTOS DOS DATOS ──────────────────────────────────────────────────
const APP_ID     = 'PEGA_AQUI_TU_APP_ID';
const APP_SECRET = 'PEGA_AQUI_TU_APP_SECRET';
// ─────────────────────────────────────────────────────────────────────────────

const PORT        = 3456;
const REDIRECT    = `http://localhost:${PORT}/callback`;
const SCOPE       = 'ads_read';
const STATE       = Math.random().toString(36).slice(2);

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET' }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const authUrl =
  `https://www.facebook.com/dialog/oauth?client_id=${APP_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&scope=${SCOPE}&state=${STATE}`;

console.log('\n════════════════════════════════════════════════');
console.log('  Meta Ads — Renovar Token de Acceso');
console.log('════════════════════════════════════════════════\n');
console.log('Abre esta URL en tu navegador:\n');
console.log('   ' + authUrl + '\n');
console.log('Esperando autorización...\n');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

  const code  = u.searchParams.get('code');
  const state = u.searchParams.get('state');

  if (!code || state !== STATE) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Error: código o state inválido</h2>');
    server.close();
    return;
  }

  // Paso 1: código → token de corta duración
  let shortToken;
  try {
    const r = await httpsGet(
      `https://graph.facebook.com/oauth/access_token` +
      `?client_id=${APP_ID}&client_secret=${APP_SECRET}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&code=${code}`
    );
    shortToken = r.access_token;
    if (!shortToken) throw new Error(JSON.stringify(r));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>Error paso 1: ${e.message}</h2>`);
    server.close();
    return;
  }

  // Paso 2: token corto → token largo (60 días)
  let longToken;
  try {
    const r = await httpsGet(
      `https://graph.facebook.com/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${APP_ID}&client_secret=${APP_SECRET}` +
      `&fb_exchange_token=${encodeURIComponent(shortToken)}`
    );
    longToken = r.access_token;
    if (!longToken) throw new Error(JSON.stringify(r));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>Error paso 2: ${e.message}</h2>`);
    server.close();
    return;
  }

  console.log('\n✅ TOKEN OBTENIDO (válido ~60 días):\n');
  console.log('   META_ACCESS_TOKEN=' + longToken + '\n');
  console.log('Cópialo en Railway como:');
  console.log('   POLAR_CHILE_META_ACCESS_TOKEN=' + longToken);
  console.log('   POLAR_MEXICO_META_ACCESS_TOKEN=' + longToken);
  console.log('   NATURALIZE_META_ACCESS_TOKEN=' + longToken + '\n');

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: sans-serif; max-width: 700px; margin: 60px auto; padding: 20px; background: #0d1117; color: #e6edf3; }
  h2 { color: #3fb950; }
  .box { background: #21262d; border-radius: 8px; padding: 14px 18px; margin: 14px 0; font-family: monospace; font-size: 13px; word-break: break-all; color: #79c0ff; }
  .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-top: 18px; margin-bottom: 4px; }
  p { color: #8b949e; }
</style></head>
<body>
  <h2>✅ Token de Meta renovado (~60 días)</h2>
  <p>Actualiza estas 3 variables en Railway → Variables:</p>
  <div class="label">POLAR_CHILE_META_ACCESS_TOKEN</div>
  <div class="box">${longToken}</div>
  <div class="label">POLAR_MEXICO_META_ACCESS_TOKEN</div>
  <div class="box">${longToken}</div>
  <div class="label">NATURALIZE_META_ACCESS_TOKEN</div>
  <div class="box">${longToken}</div>
</body></html>`);

  server.close();
});

server.listen(PORT, () => {
  console.log(`Servidor esperando en http://localhost:${PORT}`);
});
