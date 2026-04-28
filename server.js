'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── ENV ───────────────────────────────────────────────────────────────────────
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t[0] === '#') continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
})();

function loadStores() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'stores.json'), 'utf8'));
}

function env(storeId, key) {
  const prefix = storeId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return (process.env[`${prefix}_${key}`] || '').trim();
}

// ── TOKEN CACHE ───────────────────────────────────────────────────────────────
// Refreshed Meta tokens are persisted here so they survive restarts
const TOKEN_FILE = path.join(__dirname, 'tokens.json');

function readTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }
  catch { return {}; }
}

function writeTokens(t) {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2)); } catch {}
}

function getMetaToken(storeId) {
  return readTokens()[storeId]?.meta_token || env(storeId, 'META_ACCESS_TOKEN');
}

// ── DATES ─────────────────────────────────────────────────────────────────────
function localDate(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function getDateRange(range, tz = 'UTC') {
  const today     = localDate(tz);
  const yesterday = addDays(today, -1);

  const prevMonth = (() => {
    const [y, m] = today.split('-').map(Number);
    const pm  = m === 1 ? 12 : m - 1;
    const py  = m === 1 ? y - 1 : y;
    const pms = String(pm).padStart(2, '0');
    const lastDay = new Date(Date.UTC(y, m - 1, 0)).getUTCDate();
    return {
      start: `${py}-${pms}-01`,
      end:   `${py}-${pms}-${String(lastDay).padStart(2, '0')}`
    };
  })();

  const map = {
    today:      { start: today,                   end: today },
    yesterday:  { start: yesterday,               end: yesterday },
    '3d':       { start: addDays(yesterday, -2),  end: yesterday },
    '7d':       { start: addDays(yesterday, -6),  end: yesterday },
    '14d':      { start: addDays(yesterday, -13), end: yesterday },
    '30d':      { start: addDays(yesterday, -29), end: yesterday },
    this_month: { start: today.slice(0, 7) + '-01', end: today },
    last_month: prevMonth,
    max:        { start: '2020-01-01',            end: yesterday }
  };

  return map[range] || map['7d'];
}

function datesInRange(start, end) {
  const dates = [];
  const s = new Date(start + 'T12:00:00Z');
  const e = new Date(end   + 'T12:00:00Z');
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1))
    dates.push(d.toISOString().slice(0, 10));
  return dates;
}

// ── HTTP HELPER ───────────────────────────────────────────────────────────────
function apiGet(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'ProfitCalculator/2.0', ...headers }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function apiPost(urlStr, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(str),
        'User-Agent': 'ProfitCalculator/2.0',
        ...extraHeaders
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    req.write(str);
    req.end();
  });
}

// ── SHOPIFY ───────────────────────────────────────────────────────────────────
async function fetchShopifyOrders(storeId, start, end) {
  const store = env(storeId, 'SHOPIFY_STORE');
  const token = env(storeId, 'SHOPIFY_ACCESS_TOKEN');

  if (!store || !token)
    return { orders: [], error: `Shopify no configurado (${storeId.toUpperCase()}_SHOPIFY_STORE / _ACCESS_TOKEN)` };

  const orders = [];
  let nextUrl  = `https://${store}.myshopify.com/admin/api/2024-01/orders.json?` + new URLSearchParams({
    limit: '250', status: 'any', financial_status: 'paid',
    created_at_min: `${start}T00:00:00Z`,
    created_at_max: `${end}T23:59:59Z`,
    fields: 'id,created_at,total_price,refunds,line_items'
  });

  while (nextUrl) {
    let res;
    try { res = await apiGet(nextUrl, { 'X-Shopify-Access-Token': token }); }
    catch (e) { return { orders, error: `Shopify: ${e.message}` }; }

    if (res.status === 401) return { orders: [], error: 'Shopify: token inválido (401)' };
    if (res.status !== 200) return { orders, error: `Shopify API: status ${res.status}` };

    const batch = res.body.orders || [];
    orders.push(...batch);

    const link = res.headers.link || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = (next && batch.length === 250) ? next[1] : null;
  }

  return { orders };
}

// ── META ADS ─────────────────────────────────────────────────────────────────
async function refreshMetaTokenIfNeeded(storeId) {
  const token  = getMetaToken(storeId);
  const appId  = env(storeId, 'META_APP_ID') || (process.env['META_APP_ID'] || '').trim();
  const secret = env(storeId, 'META_APP_SECRET') || (process.env['META_APP_SECRET'] || '').trim();
  if (!token || !appId || !secret) return;

  try {
    const { body } = await apiGet(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(token)}&access_token=${appId}|${secret}`
    );
    if (!body?.data?.is_valid || !body.data.expires_at) return;

    const daysLeft = (body.data.expires_at * 1000 - Date.now()) / 86400000;
    if (daysLeft >= 7) return;

    console.log(`[${storeId}] Meta token vence en ${daysLeft.toFixed(0)} días — renovando...`);
    const { body: r } = await apiGet(
      `https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${secret}&fb_exchange_token=${encodeURIComponent(token)}`
    );

    if (r.access_token) {
      const cache = readTokens();
      cache[storeId] = { meta_token: r.access_token, refreshed_at: new Date().toISOString() };
      writeTokens(cache);
      console.log(`[${storeId}] Meta token renovado (nuevo: ${r.access_token.slice(0, 20)}…)`);
    }
  } catch (e) {
    console.error(`[${storeId}] Meta refresh falló:`, e.message);
  }
}

async function fetchMetaAds(storeId, start, end, campaignFilters) {
  const token     = getMetaToken(storeId);
  const accountId = env(storeId, 'META_AD_ACCOUNT_ID');

  if (!token || !accountId)
    return { data: [], error: `Meta Ads no configurado (${storeId.toUpperCase()}_META_ACCESS_TOKEN / _META_AD_ACCOUNT_ID)` };

  const actId = accountId.startsWith('act_') ? accountId : `act_${accountId}`;

  // If campaign filters defined, fetch at campaign level and filter by name
  const level  = campaignFilters?.length ? 'campaign' : 'account';
  const fields = campaignFilters?.length
    ? 'spend,impressions,clicks,actions,date_start,campaign_name'
    : 'spend,impressions,clicks,actions,date_start';

  const url = `https://graph.facebook.com/v19.0/${actId}/insights?` + new URLSearchParams({
    fields,
    time_range: JSON.stringify({ since: start, until: end }),
    time_increment: '1',
    level,
    limit: '1000',
    access_token: token
  });

  let res;
  try { res = await apiGet(url); }
  catch (e) { return { data: [], error: `Meta: ${e.message}` }; }

  if (res.status !== 200) {
    const msg = res.body?.error?.message || `status ${res.status}`;
    return { data: [], error: `Meta API: ${msg}` };
  }

  let rows = res.body.data || [];

  // Filter by campaign name patterns and merge by date
  if (campaignFilters?.length) {
    const filters = campaignFilters.map(f => f.toLowerCase());
    rows = rows.filter(r => filters.some(f => (r.campaign_name || '').toLowerCase().includes(f)));

    // Merge rows with same date into one entry
    const byDate = {};
    for (const r of rows) {
      const d = r.date_start;
      if (!byDate[d]) {
        byDate[d] = { date_start: d, spend: 0, impressions: 0, clicks: 0, actions: [] };
      }
      byDate[d].spend       += parseFloat(r.spend || 0);
      byDate[d].impressions += parseInt(r.impressions || 0);
      byDate[d].clicks      += parseInt(r.clicks || 0);
      for (const a of r.actions || []) {
        const existing = byDate[d].actions.find(x => x.action_type === a.action_type);
        if (existing) existing.value = String(parseFloat(existing.value || 0) + parseFloat(a.value || 0));
        else byDate[d].actions.push({ ...a });
      }
    }
    rows = Object.values(byDate);
  }

  return { data: rows };
}

// ── PRODUCT MATCHING ──────────────────────────────────────────────────────────
function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function matchProduct(title, cfg) {
  const t = normalize(title);
  if (!t.includes(normalize(cfg.match))) return false;
  if (cfg.match_exclude?.some(x => t.includes(normalize(x)))) return false;
  if (cfg.match_include?.length && !cfg.match_include.every(x => t.includes(normalize(x)))) return false;
  return true;
}

function tierCost(tiers, qty) {
  const tier = tiers.find(t => qty >= t.min && (t.max == null || qty <= t.max));
  return tier ? tier.cost : (tiers.at(-1)?.cost || 0);
}

// ── COGS ─────────────────────────────────────────────────────────────────────
function calcOrderCOGS(order, products) {
  const lineItems = order.line_items || [];

  // Group matched products and sum quantities
  const matched = new Map();
  for (const item of lineItems) {
    const cfg = products.find(p => matchProduct(item.title, p));
    if (!cfg) continue;
    const prev = matched.get(cfg.id);
    matched.set(cfg.id, { cfg, qty: (prev?.qty || 0) + (parseInt(item.quantity) || 1) });
  }

  const mainQty = [...matched.values()].find(m => m.cfg.type === 'main')?.qty || 0;

  let total = 0;
  const breakdown = [];

  for (const [id, { cfg, qty }] of matched) {
    let cost = 0;
    switch (cfg.type) {
      case 'main':
        cost = cfg.tiers ? tierCost(cfg.tiers, qty) : (cfg.cost_per_unit || 0) * qty;
        break;
      case 'gift':
        cost = (cfg.cost_per_unit || 0) * Math.min(qty, mainQty);
        break;
      case 'fixed':
        cost = cfg.tiers ? tierCost(cfg.tiers, qty) : (cfg.cost_per_unit || 0) * qty;
        break;
      case 'standalone_with_main_discount':
        cost = (mainQty > 0 ? (cfg.cost_with_main || 0) : (cfg.cost_standalone || 0)) * qty;
        break;
      default:
        cost = (cfg.cost_per_unit || 0) * qty;
    }
    total += cost;
    breakdown.push({ id, qty, cost });
  }

  return { total, breakdown };
}

// ── DATA PROCESSING ───────────────────────────────────────────────────────────
function processData(orders, metaData, store, start, end) {
  const rate       = store.exchange_rate || 1;
  const metaRate   = store.meta_exchange_rate || 1;
  const products   = store.products || [];
  const feeRate    = store.payment_fee_rate || 0;
  const dailyFixed = (store.monthly_fixed_costs_usd || 0) / 30;

  const daily = {};
  for (const d of datesInRange(start, end)) {
    daily[d] = { date: d,
      revenue: 0, revenue_local: 0, cogs: 0, cogs_local: 0,
      fees: dailyFixed,
      adSpend: 0, orders: 0, impressions: 0, clicks: 0, purchases: 0 };
  }

  const productMap = {};

  for (const order of orders) {
    const d = order.created_at.slice(0, 10);
    if (!daily[d]) continue;

    const revenueLocal          = parseFloat(order.total_price) || 0;
    const { total: cogsUSD, breakdown } = calcOrderCOGS(order, products);

    daily[d].revenue       += revenueLocal / rate;
    daily[d].revenue_local += revenueLocal;
    daily[d].cogs          += cogsUSD;
    daily[d].cogs_local    += cogsUSD * rate;
    daily[d].fees          += (revenueLocal / rate) * feeRate;
    daily[d].orders        += 1;

    for (const item of order.line_items || []) {
      const key = item.title || 'Sin nombre';
      if (!productMap[key])
        productMap[key] = { name: key, sku: item.sku || '', units: 0, revenue: 0, revenue_local: 0, cogs: 0, cogs_local: 0 };
      const qty = parseInt(item.quantity) || 1;
      productMap[key].units         += qty;
      productMap[key].revenue       += parseFloat(item.price) * qty / rate;
      productMap[key].revenue_local += parseFloat(item.price) * qty;
    }

    for (const { id, cost } of breakdown) {
      const cfg = products.find(p => p.id === id);
      if (!cfg) continue;
      for (const item of order.line_items || []) {
        if (matchProduct(item.title, cfg) && productMap[item.title]) {
          productMap[item.title].cogs       += cost;
          productMap[item.title].cogs_local += cost * rate;
        }
      }
    }
  }

  for (const ins of metaData) {
    const d = ins.date_start;
    if (!daily[d]) continue;
    daily[d].adSpend     += parseFloat(ins.spend || 0) / metaRate;
    daily[d].impressions += parseInt(ins.impressions || 0);
    daily[d].clicks      += parseInt(ins.clicks || 0);
    const purchase = (ins.actions || []).find(a =>
      a.action_type === 'purchase' ||
      a.action_type === 'offsite_conversion.fb_pixel_purchase'
    );
    if (purchase) daily[d].purchases += parseFloat(purchase.value || 0);
  }

  const dailyArr = Object.values(daily).sort((a, b) => a.date.localeCompare(b.date));
  for (const day of dailyArr) {
    day.grossProfit = day.revenue - day.cogs;
    day.netProfit   = day.grossProfit - day.adSpend - day.fees;
    day.netMargin   = day.revenue > 0 ? (day.netProfit / day.revenue) * 100 : 0;
    day.roas        = day.adSpend > 0 ? day.revenue / day.adSpend : 0;
    day.ctr         = day.impressions > 0 ? (day.clicks / day.impressions) * 100 : 0;
  }

  const totals = dailyArr.reduce((acc, d) => ({
    revenue:       acc.revenue       + d.revenue,
    revenue_local: acc.revenue_local + d.revenue_local,
    cogs:          acc.cogs          + d.cogs,
    cogs_local:    acc.cogs_local    + d.cogs_local,
    fees:          acc.fees          + d.fees,
    adSpend:       acc.adSpend       + d.adSpend,
    orders:        acc.orders        + d.orders,
    impressions:   acc.impressions   + d.impressions,
    clicks:        acc.clicks        + d.clicks,
    purchases:     acc.purchases     + d.purchases,
  }), { revenue: 0, revenue_local: 0, cogs: 0, cogs_local: 0, fees: 0,
        adSpend: 0, orders: 0, impressions: 0, clicks: 0, purchases: 0 });

  totals.grossProfit = totals.revenue - totals.cogs;
  totals.netProfit   = totals.grossProfit - totals.adSpend - totals.fees;
  totals.netMargin   = totals.revenue > 0 ? (totals.netProfit / totals.revenue) * 100 : 0;
  totals.roas        = totals.adSpend > 0 ? totals.revenue / totals.adSpend : 0;
  totals.ctr         = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  totals.cpa         = totals.purchases > 0 ? totals.adSpend / totals.purchases : 0;
  totals.aov         = totals.orders > 0 ? totals.revenue / totals.orders : 0;
  const contribution = totals.revenue - totals.cogs - totals.fees;
  totals.be_roas     = contribution > 0 ? totals.revenue / contribution : 0;

  const productTable = Object.values(productMap).map(p => ({
    ...p,
    grossProfit:       p.revenue - p.cogs,
    grossProfit_local: p.revenue_local - p.cogs_local,
    margin:            p.revenue > 0 ? ((p.revenue - p.cogs) / p.revenue) * 100 : 0
  })).sort((a, b) => b.revenue - a.revenue);

  return { daily: dailyArr, totals, productTable };
}

// ── GLOBAL AGGREGATION ────────────────────────────────────────────────────────
async function buildGlobalData(range) {
  const { stores } = loadStores();

  const results = await Promise.all(stores.map(async store => {
    const { start, end } = getDateRange(range, store.timezone || 'UTC');
    refreshMetaTokenIfNeeded(store.id).catch(() => {});
    const [shopify, meta] = await Promise.all([
      fetchShopifyOrders(store.id, start, end),
      fetchMetaAds(store.id, start, end, store.meta_campaigns)
    ]);
    const processed = processData(shopify.orders || [], meta.data || [], store, start, end);
    return { store, processed, errors: [shopify.error, meta.error].filter(Boolean) };
  }));

  const dailyMap  = {};
  const SUM_KEYS  = ['revenue', 'cogs', 'fees', 'adSpend', 'orders', 'impressions', 'clicks', 'purchases'];
  const gTotals   = Object.fromEntries(SUM_KEYS.map(k => [k, 0]));
  const prodMap   = {};
  const errors    = [];
  const breakEvens = [];

  for (const { store, processed, errors: errs } of results) {
    errors.push(...errs);
    breakEvens.push(store.break_even_roas || 2);

    for (const day of processed.daily) {
      if (!dailyMap[day.date])
        dailyMap[day.date] = { date: day.date, ...Object.fromEntries(SUM_KEYS.map(k => [k, 0])) };
      for (const k of SUM_KEYS) dailyMap[day.date][k] += day[k] || 0;
    }

    for (const k of SUM_KEYS) gTotals[k] += processed.totals[k] || 0;

    for (const p of processed.productTable) {
      if (!prodMap[p.name])
        prodMap[p.name] = { name: p.name, sku: p.sku, units: 0, revenue: 0, cogs: 0, grossProfit: 0 };
      prodMap[p.name].units       += p.units;
      prodMap[p.name].revenue     += p.revenue;
      prodMap[p.name].cogs        += p.cogs;
      prodMap[p.name].grossProfit += p.grossProfit;
    }
  }

  const dailyArr = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  for (const day of dailyArr) {
    day.grossProfit = day.revenue - day.cogs;
    day.netProfit   = day.grossProfit - day.adSpend;
    day.netMargin   = day.revenue > 0 ? (day.netProfit / day.revenue) * 100 : 0;
    day.roas        = day.adSpend > 0 ? day.revenue / day.adSpend : 0;
    day.ctr         = day.impressions > 0 ? (day.clicks / day.impressions) * 100 : 0;
  }

  gTotals.grossProfit = gTotals.revenue - gTotals.cogs;
  gTotals.netProfit   = gTotals.grossProfit - gTotals.adSpend - gTotals.fees;
  gTotals.netMargin   = gTotals.revenue > 0 ? (gTotals.netProfit / gTotals.revenue) * 100 : 0;
  gTotals.roas        = gTotals.adSpend > 0 ? gTotals.revenue / gTotals.adSpend : 0;
  gTotals.ctr         = gTotals.impressions > 0 ? (gTotals.clicks / gTotals.impressions) * 100 : 0;
  gTotals.cpa         = gTotals.purchases > 0 ? gTotals.adSpend / gTotals.purchases : 0;
  gTotals.aov         = gTotals.orders > 0 ? gTotals.revenue / gTotals.orders : 0;
  const gContrib      = gTotals.revenue - gTotals.cogs - gTotals.fees;
  gTotals.be_roas     = gContrib > 0 ? gTotals.revenue / gContrib : 0;

  const productTable = Object.values(prodMap)
    .map(p => ({ ...p, margin: p.revenue > 0 ? (p.grossProfit / p.revenue) * 100 : 0 }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    currency: 'USD', exchange_rate: 1,
    break_even_roas: gTotals.be_roas || (breakEvens.length ? breakEvens.reduce((a, b) => a + b, 0) / breakEvens.length : 2),
    daily: dailyArr, totals: gTotals, productTable, errors
  };
}

// ── SERVER UTILITIES ──────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u        = new URL(req.url, 'http://localhost');
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  const q        = Object.fromEntries(u.searchParams);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {

    // ── Dashboard HTML ──────────────────────────────────────────────────────
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8'));
      return;
    }

    // ── GET /api/stores ─────────────────────────────────────────────────────
    if (pathname === '/api/stores') {
      const { stores } = loadStores();
      return json(res, 200, {
        stores: stores.map(s => ({
          id: s.id, name: s.name,
          currency: s.currency || 'USD',
          break_even_roas: s.break_even_roas || 2,
          timezone: s.timezone || 'UTC'
        }))
      });
    }

    // ── GET /api/data ───────────────────────────────────────────────────────
    if (pathname === '/api/data') {
      const storeId = q.store || 'global';
      const range   = q.range || 'today';

      if (storeId === 'global') return json(res, 200, await buildGlobalData(range));

      const { stores } = loadStores();
      const store = stores.find(s => s.id === storeId);
      if (!store) return json(res, 404, { error: `Tienda "${storeId}" no encontrada en stores.json` });

      const { start, end } = getDateRange(range, store.timezone || 'UTC');
      refreshMetaTokenIfNeeded(storeId).catch(() => {});

      const [shopify, meta] = await Promise.all([
        fetchShopifyOrders(storeId, start, end),
        fetchMetaAds(storeId, start, end, store.meta_campaigns)
      ]);

      const processed = processData(shopify.orders || [], meta.data || [], store, start, end);

      return json(res, 200, {
        store: storeId, name: store.name,
        currency: store.currency || 'USD',
        exchange_rate: store.exchange_rate || 1,
        break_even_roas: processed.totals.be_roas || store.break_even_roas || 2,
        start, end,
        ...processed,
        errors: [shopify.error, meta.error].filter(Boolean)
      });
    }

    // ── POST /api/connect-store ─────────────────────────────────────────────
    if (pathname === '/api/connect-store' && req.method === 'POST') {
      const { storeId, shopDomain, accessToken } = await readBody(req);
      if (!storeId || !shopDomain || !accessToken)
        return json(res, 400, { error: 'Faltan: storeId, shopDomain, accessToken' });

      const shop = shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').replace('.myshopify.com', '');
      let r;
      try {
        r = await apiGet(`https://${shop}.myshopify.com/admin/api/2024-01/shop.json`,
                         { 'X-Shopify-Access-Token': accessToken });
      } catch (e) {
        return json(res, 500, { error: `No se pudo conectar: ${e.message}` });
      }

      if (r.status !== 200 || !r.body.shop)
        return json(res, 400, { error: `Token inválido (HTTP ${r.status})` });

      const prefix = storeId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      console.log(`\n✅ SHOPIFY CONECTADO: ${r.body.shop.name}`);
      console.log(`   ${prefix}_SHOPIFY_STORE=${shop}`);
      console.log(`   ${prefix}_SHOPIFY_ACCESS_TOKEN=${accessToken}\n`);

      return json(res, 200, {
        success: true,
        shopName: r.body.shop.name,
        currency: r.body.shop.currency,
        railwayVars: {
          [`${prefix}_SHOPIFY_STORE`]: shop,
          [`${prefix}_SHOPIFY_ACCESS_TOKEN`]: accessToken
        }
      });
    }

    res.writeHead(404); res.end('Not found');

  } catch (e) {
    console.error('[ERROR]', e.message);
    json(res, 500, { error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const { stores } = loadStores();
  console.log(`\n╔═══════════════════════════════════════════╗`);
  console.log(`║  Profit Calculator → http://localhost:${PORT}  ║`);
  console.log(`╚═══════════════════════════════════════════╝`);
  console.log(`Tiendas: ${stores.map(s => s.name).join(' · ')}\n`);
});
