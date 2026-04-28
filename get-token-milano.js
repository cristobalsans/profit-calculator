'use strict';
const http  = require('http');
const https = require('https');

const PORT      = 3456;
const shop      = 'chs57m-bp';
const clientId  = 'PEGA_AQUI_CLIENT_ID';
const secret    = 'PEGA_AQUI_CLIENT_SECRET';

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const str = JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(str) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(str);
    req.end();
  });
}

const redirectUri = `http://localhost:${PORT}/callback`;
const scopes      = 'read_orders,read_products';
const state       = Math.random().toString(36).slice(2);

const authUrl = `https://${shop}.myshopify.com/admin/oauth/authorize` +
  `?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

console.log('\n════════════════════════════════════════════════');
console.log('  Shopify OAuth — Milano Chile');
console.log('════════════════════════════════════════════════\n');
console.log('Abre esta URL en tu navegador:\n');
console.log('   ' + authUrl + '\n');
console.log('Esperando autorización...\n');

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

  const code          = u.searchParams.get('code');
  const returnedState = u.searchParams.get('state');

  if (!code || returnedState !== state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Error: código o state inválido</h2>');
    server.close();
    return;
  }

  let tokenRes;
  try {
    tokenRes = await httpsPost(`${shop}.myshopify.com`, '/admin/oauth/access_token', {
      client_id: clientId, client_secret: secret, code
    });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>Error: ${e.message}</h2>`);
    server.close();
    return;
  }

  const token = tokenRes.body.access_token;
  if (!token) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>Error: ${JSON.stringify(tokenRes.body)}</h2>`);
    server.close();
    return;
  }

  console.log('\n✅ TOKEN OBTENIDO:\n');
  console.log('   MILANO_CHILE_SHOPIFY_STORE=' + shop);
  console.log('   MILANO_CHILE_SHOPIFY_ACCESS_TOKEN=' + token + '\n');

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: sans-serif; max-width: 680px; margin: 60px auto; padding: 20px; background: #0d1117; color: #e6edf3; }
  h2 { color: #3fb950; }
  .box { background: #21262d; border-radius: 8px; padding: 14px 18px; margin: 14px 0; font-family: monospace; font-size: 15px; word-break: break-all; color: #79c0ff; }
  .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-top: 18px; margin-bottom: 4px; }
</style></head>
<body>
  <h2>✅ Token de Milano Chile obtenido</h2>
  <p>Copia estas variables en Railway → Variables:</p>
  <div class="label">Variable 1</div>
  <div class="box">MILANO_CHILE_SHOPIFY_STORE=${shop}</div>
  <div class="label">Variable 2</div>
  <div class="box">MILANO_CHILE_SHOPIFY_ACCESS_TOKEN=${token}</div>
</body></html>`);

  server.close();
});

server.listen(PORT, () => {
  console.log(`Servidor esperando en http://localhost:${PORT}`);
});
