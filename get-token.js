'use strict';
/**
 * Shopify OAuth helper — obtiene un access token para una Partners app.
 * Uso: node get-token.js
 */
const http = require('http');
const https = require('https');
const readline = require('readline');

const PORT = 3456;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(resolve => rl.question(q, resolve));

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

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

async function main() {
  console.log('\n════════════════════════════════════════════════');
  console.log('  Shopify OAuth — Obtener Access Token');
  console.log('════════════════════════════════════════════════\n');

  const shop     = (await ask('Nombre de tu tienda (sin .myshopify.com): ')).trim();
  const clientId = (await ask('Client ID de tu app: ')).trim();
  const secret   = (await ask('Client Secret de tu app: ')).trim();
  rl.close();

  const redirectUri = `http://localhost:${PORT}/callback`;
  const scopes      = 'read_orders,read_products';
  const state       = Math.random().toString(36).slice(2);

  const authUrl = `https://${shop}.myshopify.com/admin/oauth/authorize` +
    `?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

  console.log('\n✅ Todo listo. Ahora:\n');
  console.log('1. Abre esta URL en tu navegador:');
  console.log('\n   ' + authUrl + '\n');
  console.log('2. Acepta los permisos en Shopify');
  console.log('3. El token aparecerá automáticamente en el navegador\n');
  console.log('Esperando autorización...\n');

  // Local server waiting for callback
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

    const code      = u.searchParams.get('code');
    const returnedState = u.searchParams.get('state');

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Error: no se recibió el código de autorización</h2>');
      server.close();
      return;
    }

    if (returnedState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Error: state no coincide (posible CSRF)</h2>');
      server.close();
      return;
    }

    // Exchange code for token
    let tokenRes;
    try {
      tokenRes = await httpsPost(`${shop}.myshopify.com`, '/admin/oauth/access_token', {
        client_id: clientId, client_secret: secret, code
      });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<h2>Error al obtener token: ${e.message}</h2>`);
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
    console.log('   POLAR_CHILE_SHOPIFY_STORE=' + shop);
    console.log('   POLAR_CHILE_SHOPIFY_ACCESS_TOKEN=' + token + '\n');

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: sans-serif; max-width: 680px; margin: 60px auto; padding: 20px; background: #0d1117; color: #e6edf3; }
  h2 { color: #3fb950; }
  .box { background: #21262d; border-radius: 8px; padding: 14px 18px; margin: 14px 0; font-family: monospace; font-size: 15px; word-break: break-all; color: #79c0ff; }
  p { color: #8b949e; }
  .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-top: 18px; margin-bottom: 4px; }
</style></head>
<body>
  <h2>✅ ¡Token obtenido!</h2>
  <p>Copia estas dos variables y pégalas en Railway → Variables:</p>
  <div class="label">Variable 1</div>
  <div class="box">POLAR_CHILE_SHOPIFY_STORE=${shop}</div>
  <div class="label">Variable 2</div>
  <div class="box">POLAR_CHILE_SHOPIFY_ACCESS_TOKEN=${token}</div>
  <p style="margin-top:24px">Una vez que las cargues en Railway, avísale a Claude Code y seguimos con Meta Ads.</p>
</body></html>`);

    server.close();
  });

  server.listen(PORT, () => {
    console.log(`Servidor local escuchando en http://localhost:${PORT}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
