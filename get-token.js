'use strict';
/**
 * Helper para obtener tokens de Shopify y Meta Ads.
 * Uso: node get-token.js
 */
const https = require('https');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

function httpGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function checkMetaToken() {
  console.log('\n── META ADS TOKEN ──────────────────────────────────');
  console.log('Para obtener un token de Meta Ads:');
  console.log('1. Ve a: https://developers.facebook.com/tools/explorer/');
  console.log('2. Selecciona tu app y tu cuenta de anuncios');
  console.log('3. Agrega permisos: ads_read, ads_management, read_insights');
  console.log('4. Haz clic en "Generar token de acceso"\n');

  const token = await ask('Pega tu Meta Access Token aquí: ');
  const appId = await ask('Pega tu Meta App ID: ');
  const appSecret = await ask('Pega tu Meta App Secret: ');

  console.log('\nVerificando token...');

  const res = await httpGet({
    hostname: 'graph.facebook.com',
    path: `/debug_token?input_token=${token.trim()}&access_token=${appId.trim()}|${appSecret.trim()}`,
    method: 'GET'
  });

  if (res.status !== 200 || !res.body.data) {
    console.log('ERROR: No se pudo verificar el token:', res.body);
    return;
  }

  const data = res.body.data;
  if (data.is_valid) {
    const expiresAt = data.expires_at ? new Date(data.expires_at * 1000) : null;
    console.log('\n✓ Token válido');
    if (expiresAt) {
      const daysLeft = Math.floor((expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
      console.log(`  Expira: ${expiresAt.toLocaleDateString()} (en ${daysLeft} días)`);
      if (daysLeft < 60) {
        console.log('\nExtendiendo a token de larga duración...');
        const refreshRes = await httpGet({
          hostname: 'graph.facebook.com',
          path: `/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId.trim()}&client_secret=${appSecret.trim()}&fb_exchange_token=${token.trim()}`,
          method: 'GET'
        });
        if (refreshRes.body.access_token) {
          console.log('\n✓ Token extendido (60 días):');
          console.log(refreshRes.body.access_token);
        }
      }
    } else {
      console.log('  Sin fecha de expiración (token de sistema/permanente)');
    }
    console.log('\nScopes habilitados:', (data.scopes || []).join(', '));
  } else {
    console.log('ERROR: Token inválido');
    if (data.error) console.log('Motivo:', data.error.message);
  }
}

async function checkShopifyToken() {
  console.log('\n── SHOPIFY ACCESS TOKEN ─────────────────────────────');
  console.log('Para obtener un token de Shopify:');
  console.log('1. Ve al admin de tu tienda Shopify');
  console.log('2. Configuración → Aplicaciones y canales de venta');
  console.log('3. Desarrollar aplicaciones → Crear una aplicación');
  console.log('4. En "Configuración de la API", habilita:');
  console.log('   - read_orders');
  console.log('   - read_products');
  console.log('5. Instala la app → copia el "API access token"\n');

  const store = await ask('Nombre de tu tienda (sin .myshopify.com): ');
  const token = await ask('Pega tu Shopify Access Token: ');

  console.log('\nVerificando token...');

  const res = await httpGet({
    hostname: `${store.trim()}.myshopify.com`,
    path: '/admin/api/2024-01/shop.json',
    method: 'GET',
    headers: { 'X-Shopify-Access-Token': token.trim() }
  });

  if (res.status === 200 && res.body.shop) {
    console.log('\n✓ Token válido');
    console.log(`  Tienda: ${res.body.shop.name}`);
    console.log(`  Plan: ${res.body.shop.plan_name}`);
    console.log(`  Moneda: ${res.body.shop.currency}`);
    console.log(`  Timezone: ${res.body.shop.iana_timezone}`);
  } else {
    console.log('ERROR: Token inválido o tienda no encontrada (status:', res.status, ')');
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  PROFIT CALCULATOR — Verificador de Credenciales');
  console.log('═══════════════════════════════════════════════════');
  console.log('\n¿Qué quieres verificar?');
  console.log('1. Token de Shopify');
  console.log('2. Token de Meta Ads');
  console.log('3. Ambos\n');

  const choice = await ask('Opción (1/2/3): ');

  if (choice === '1' || choice === '3') await checkShopifyToken();
  if (choice === '2' || choice === '3') await checkMetaToken();

  console.log('\n¡Listo! Copia los tokens al archivo .env\n');
  rl.close();
}

main().catch(err => { console.error(err); rl.close(); });
