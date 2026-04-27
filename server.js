'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
// url module not needed — using built-in URL class

// ── CONFIG ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'stores.json');
let CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Reload config without restart (useful for Railway env changes)
function reloadConfig() {
  try { CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
}

const PORT = process.env.PORT || 3000;

// ── ENV HELPERS ───────────────────────────────────────────────────────────────

function env(storeId, key) {
  const prefix = storeId.toUpperCase().replace(/-/g, '_').replace(/\./g, '_');
  return (process.env[`${prefix}_${key}`] || '').trim();
}

// ── HTTP HELPER ───────────────────────────────────────────────────────────────

function apiRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── DATE HELPERS ──────────────────────────────────────────────────────────────

function todayInTimezone(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function firstDayOfMonth(dateStr) {
  return dateStr.slice(0, 7) + '-01';
}

function lastDayOfPrevMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 0));
  return d.toISOString().split('T')[0];
}

function firstDayOfPrevMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().split('T')[0];
}

function getDateRange(range, timezone) {
  const tz   = timezone || 'UTC';
  const today = todayInTimezone(tz);
  const yesterday = addDays(today, -1);

  switch (range) {
    case 'today':       return { start: today,               end: today };
    case 'yesterday':   return { start: yesterday,           end: yesterday };
    case '3d':          return { start: addDays(yesterday, -2), end: yesterday };
    case '7d':          return { start: addDays(yesterday, -6), end: yesterday };
    case '14d':         return { start: addDays(yesterday,-13), end: yesterday };
    case '30d':         return { start: addDays(yesterday,-29), end: yesterday };
    case 'this_month':  return { start: firstDayOfMonth(today), end: today };
    case 'last_month':  return { start: firstDayOfPrevMonth(today), end: lastDayOfPrevMonth(today) };
    case 'max':         return { start: addDays(yesterday,-89), end: yesterday };
    default:            return { start: today,               end: today };
  }
}

function dateRange(start, end) {
  const dates = [];
  const s = new Date(start + 'T12:00:00Z');
  const e = new Date(end   + 'T12:00:00Z');
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

// ── PRODUCT MATCHING ──────────────────────────────────────────────────────────

function matchProduct(title, cfg) {
  const t = (title || '').toLowerCase();
  const needle = (cfg.match || '').toLowerCase();
  if (!t.includes(needle)) return false;

  if (cfg.match_exclude && cfg.match_exclude.length) {
    for (const x of cfg.match_exclude) {
      if (t.includes(x.toLowerCase())) return false;
    }
  }
  if (cfg.match_include && cfg.match_include.length) {
    for (const inc of cfg.match_include) {
      if (t.includes(inc.toLowerCase())) return true;
    }
    return false;
  }
  return true;
}

function tierCost(tiers, qty) {
  for (const tier of tiers) {
    if (qty >= tier.min && (tier.max === null || tier.max === undefined || qty <= tier.max)) {
      return tier.cost_per_unit !== undefined ? tier.cost_per_unit * qty : (tier.cost || 0);
    }
  }
  return 0;
}

// ── COGS CALCULATION ──────────────────────────────────────────────────────────

function calcOrderCOGS(order, storeConfig) {
  const products  = storeConfig.products || [];
  const lineItems = order.line_items    || [];

  // Identify matched products in this order
  const matched = {}; // prodId → { config, quantity }

  for (const item of lineItems) {
    for (const cfg of products) {
      if (matchProduct(item.title, cfg)) {
        if (!matched[cfg.id]) matched[cfg.id] = { cfg, qty: 0 };
        matched[cfg.id].qty += parseInt(item.quantity, 10) || 1;
        break;
      }
    }
  }

  // Main product quantity (for gift limits)
  let mainQty = 0;
  for (const [, v] of Object.entries(matched)) {
    if (v.cfg.type === 'main') { mainQty = v.qty; break; }
  }

  let total = 0;
  const breakdown = [];

  for (const [id, { cfg, qty }] of Object.entries(matched)) {
    let cost = 0;

    switch (cfg.type) {
      case 'main': {
        cost = cfg.tiers ? tierCost(cfg.tiers, qty) : (cfg.cost_per_unit || 0) * qty;
        break;
      }
      case 'gift': {
        const effectiveQty = Math.min(qty, mainQty);
        cost = (cfg.cost_per_unit || 0) * effectiveQty;
        break;
      }
      case 'fixed': {
        cost = cfg.tiers ? tierCost(cfg.tiers, qty) : (cfg.cost_per_unit || 0) * qty;
        break;
      }
      case 'standalone_with_main_discount': {
        const withMain = mainQty > 0;
        const unitCost = withMain ? (cfg.cost_with_main || cfg.cost_per_unit || 0)
                                  : (cfg.cost_standalone || cfg.cost_per_unit || 0);
        cost = unitCost * qty;
        break;
      }
      default:
        cost = (cfg.cost_per_unit || 0) * qty;
    }

    total += cost;
    breakdown.push({ id, qty, cost });
  }

  return { total, breakdown };
}

// ── SHOPIFY API ───────────────────────────────────────────────────────────────

async function fetchShopifyOrders(storeId, start, end) {
  const store = env(storeId, 'SHOPIFY_STORE');
  const token = env(storeId, 'SHOPIFY_ACCESS_TOKEN');

  if (!store || !token) {
    return { orders: [], error: `Shopify no configurado (falta ${storeId.toUpperCase()}_SHOPIFY_STORE o _ACCESS_TOKEN)` };
  }

  const orders   = [];
  let pageInfo   = null;
  let hasNext    = true;

  while (hasNext) {
    let queryPath;
    if (pageInfo) {
      queryPath = `/admin/api/2024-01/orders.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`;
    } else {
      queryPath = `/admin/api/2024-01/orders.json?limit=250&status=any`
        + `&financial_status=paid`
        + `&created_at_min=${start}T00:00:00-00:00`
        + `&created_at_max=${end}T23:59:59-00:00`;
    }

    let res;
    try {
      res = await apiRequest({
        hostname: `${store}.myshopify.com`,
        path: queryPath,
        method: 'GET',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return { orders, error: `Shopify request failed: ${e.message}` };
    }

    if (res.status === 401) return { orders: [], error: 'Shopify: token inválido (401)' };
    if (res.status !== 200) return { orders, error: `Shopify API error ${res.status}` };

    const batch = res.body.orders || [];
    orders.push(...batch);

    const link = res.headers.link || '';
    const nextMatch = link.match(/<[^>]*[?&]page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
    if (nextMatch && batch.length === 250) {
      pageInfo = nextMatch[1];
    } else {
      hasNext = false;
    }
  }

  return { orders };
}

// ── META ADS API ──────────────────────────────────────────────────────────────

async function tryRefreshMetaToken(storeId) {
  const token     = env(storeId, 'META_ACCESS_TOKEN');
  const appId     = env(storeId, 'META_APP_ID');
  const appSecret = env(storeId, 'META_APP_SECRET');
  if (!token || !appId || !appSecret) return;

  try {
    const debug = await apiRequest({
      hostname: 'graph.facebook.com',
      path: `/debug_token?input_token=${encodeURIComponent(token)}&access_token=${appId}|${appSecret}`,
      method: 'GET'
    });

    if (debug.status !== 200 || !debug.body.data) return;
    const { expires_at, is_valid } = debug.body.data;
    if (!is_valid || !expires_at) return;

    const daysLeft = (expires_at * 1000 - Date.now()) / 86400000;
    if (daysLeft < 7) {
      const ref = await apiRequest({
        hostname: 'graph.facebook.com',
        path: `/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${encodeURIComponent(token)}`,
        method: 'GET'
      });
      if (ref.body.access_token) {
        console.log(`[${storeId}] Meta token renovado (expiraba en ${Math.round(daysLeft)} días)`);
        // Note: In production, persist this new token to .env or a secrets store
      }
    }
  } catch {}
}

async function fetchMetaAds(storeId, start, end) {
  const token     = env(storeId, 'META_ACCESS_TOKEN');
  const adAccount = env(storeId, 'META_AD_ACCOUNT_ID');

  if (!token || !adAccount) {
    return { data: [], error: `Meta Ads no configurado (falta ${storeId.toUpperCase()}_META_ACCESS_TOKEN o _AD_ACCOUNT_ID)` };
  }

  const accountId = adAccount.startsWith('act_') ? adAccount : `act_${adAccount}`;
  const fields    = 'spend,impressions,clicks,actions,action_values';
  const timeRange = encodeURIComponent(JSON.stringify({ since: start, until: end }));
  const queryPath = `/v19.0/${accountId}/insights?fields=${fields}&time_range=${timeRange}&time_increment=1&limit=500&access_token=${encodeURIComponent(token)}`;

  let res;
  try {
    res = await apiRequest({ hostname: 'graph.facebook.com', path: queryPath, method: 'GET' });
  } catch (e) {
    return { data: [], error: `Meta request failed: ${e.message}` };
  }

  if (res.status === 190 || (res.body.error && res.body.error.code === 190)) {
    return { data: [], error: 'Meta: token expirado o inválido' };
  }
  if (res.status !== 200) {
    const msg = res.body.error ? res.body.error.message : `status ${res.status}`;
    return { data: [], error: `Meta API error: ${msg}` };
  }

  return { data: res.body.data || [] };
}

// ── DATA PROCESSING ───────────────────────────────────────────────────────────

function processStoreData(orders, metaData, storeConfig, start, end) {
  const rate = storeConfig.exchange_rate || 1;

  // Initialize daily buckets for every date in range
  const daily = {};
  for (const d of dateRange(start, end)) {
    daily[d] = {
      date: d, revenue: 0, revenue_local: 0,
      orders: 0, cogs: 0, cogs_local: 0,
      adSpend: 0, adSpend_local: 0,
      impressions: 0, clicks: 0, purchases: 0
    };
  }

  const productMap = {}; // title → stats

  for (const order of orders) {
    const d = order.created_at.split('T')[0];
    if (!daily[d]) continue;

    const revenueLocal = parseFloat(order.total_price) || 0;
    const revenueUSD   = revenueLocal / rate;

    const { total: cogsLocal, breakdown } = calcOrderCOGS(order, storeConfig);
    const cogsUSD = cogsLocal / rate;

    daily[d].revenue       += revenueUSD;
    daily[d].revenue_local += revenueLocal;
    daily[d].orders        += 1;
    daily[d].cogs          += cogsUSD;
    daily[d].cogs_local    += cogsLocal;

    // Product-level stats
    for (const item of (order.line_items || [])) {
      const key = item.title || 'Sin nombre';
      if (!productMap[key]) {
        productMap[key] = { name: key, sku: item.sku || '', units: 0, revenue: 0, revenue_local: 0, cogs: 0, cogs_local: 0 };
      }
      const qty = parseInt(item.quantity, 10) || 1;
      const itemRevLocal = parseFloat(item.price) * qty;
      productMap[key].units        += qty;
      productMap[key].revenue      += itemRevLocal / rate;
      productMap[key].revenue_local += itemRevLocal;
    }

    // Attribute COGS to products via breakdown
    for (const { id, cost } of breakdown) {
      const cfg = (storeConfig.products || []).find(p => p.id === id);
      if (!cfg) continue;
      for (const item of (order.line_items || [])) {
        if (matchProduct(item.title, cfg)) {
          const key = item.title || 'Sin nombre';
          if (productMap[key]) {
            productMap[key].cogs       += cost / rate;
            productMap[key].cogs_local += cost;
          }
        }
      }
    }
  }

  // Meta Ads daily
  for (const ins of metaData) {
    const d = ins.date_start;
    if (!daily[d]) continue;

    const spendUSD   = parseFloat(ins.spend || 0) / rate;
    const spendLocal = parseFloat(ins.spend || 0);

    daily[d].adSpend       += spendUSD;
    daily[d].adSpend_local += spendLocal;
    daily[d].impressions   += parseInt(ins.impressions || 0, 10);
    daily[d].clicks        += parseInt(ins.clicks      || 0, 10);

    const purchase = (ins.actions || []).find(a =>
      a.action_type === 'purchase' ||
      a.action_type === 'offsite_conversion.fb_pixel_purchase'
    );
    if (purchase) daily[d].purchases += parseFloat(purchase.value || 0);
  }

  // Derive metrics per day
  const dailyArr = Object.values(daily).sort((a, b) => a.date.localeCompare(b.date));
  for (const day of dailyArr) {
    day.grossProfit = day.revenue - day.cogs;
    day.netProfit   = day.grossProfit - day.adSpend;
    day.netMargin   = day.revenue > 0 ? (day.netProfit / day.revenue) * 100 : 0;
    day.roas        = day.adSpend > 0 ? day.revenue / day.adSpend : 0;
    day.ctr         = day.impressions > 0 ? (day.clicks / day.impressions) * 100 : 0;
    day.cpa         = day.purchases > 0 ? day.adSpend / day.purchases : 0;
    day.aov         = day.orders > 0 ? day.revenue / day.orders : 0;
  }

  // Aggregate totals
  const totals = dailyArr.reduce((acc, d) => ({
    revenue: acc.revenue + d.revenue,
    revenue_local: acc.revenue_local + d.revenue_local,
    adSpend: acc.adSpend + d.adSpend,
    adSpend_local: acc.adSpend_local + d.adSpend_local,
    cogs: acc.cogs + d.cogs,
    cogs_local: acc.cogs_local + d.cogs_local,
    orders: acc.orders + d.orders,
    impressions: acc.impressions + d.impressions,
    clicks: acc.clicks + d.clicks,
    purchases: acc.purchases + d.purchases,
  }), {
    revenue: 0, revenue_local: 0,
    adSpend: 0, adSpend_local: 0,
    cogs: 0, cogs_local: 0,
    orders: 0, impressions: 0, clicks: 0, purchases: 0
  });

  totals.grossProfit  = totals.revenue - totals.cogs;
  totals.netProfit    = totals.grossProfit - totals.adSpend;
  totals.netMargin    = totals.revenue > 0 ? (totals.netProfit / totals.revenue) * 100 : 0;
  totals.roas         = totals.adSpend > 0 ? totals.revenue / totals.adSpend : 0;
  totals.ctr          = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  totals.cpa          = totals.purchases > 0 ? totals.adSpend / totals.purchases : 0;
  totals.aov          = totals.orders > 0 ? totals.revenue / totals.orders : 0;

  // Product table
  const productTable = Object.values(productMap).map(p => ({
    ...p,
    grossProfit: p.revenue - p.cogs,
    grossProfit_local: p.revenue_local - p.cogs_local,
    margin: p.revenue > 0 ? ((p.revenue - p.cogs) / p.revenue) * 100 : 0
  })).sort((a, b) => b.revenue - a.revenue);

  return { daily: dailyArr, totals, productTable };
}

// ── GLOBAL AGGREGATION ────────────────────────────────────────────────────────

async function buildGlobalData(range) {
  const allResults = await Promise.all(CONFIG.stores.map(async (storeConfig) => {
    const { start, end } = getDateRange(range, storeConfig.timezone || 'UTC');
    const [shopify, meta] = await Promise.all([
      fetchShopifyOrders(storeConfig.id, start, end),
      fetchMetaAds(storeConfig.id, start, end)
    ]);
    const processed = processStoreData(shopify.orders || [], meta.data || [], storeConfig, start, end);
    return { storeConfig, processed, start, end, errors: [shopify.error, meta.error].filter(Boolean) };
  }));

  const globalDaily   = {};
  const globalTotals  = { revenue: 0, adSpend: 0, cogs: 0, grossProfit: 0, netProfit: 0, orders: 0, impressions: 0, clicks: 0, purchases: 0 };
  const globalProds   = {};
  const allErrors     = [];
  const breakEvens    = [];

  for (const { storeConfig, processed, errors } of allResults) {
    allErrors.push(...errors);
    breakEvens.push(storeConfig.break_even_roas || 2);

    for (const day of processed.daily) {
      if (!globalDaily[day.date]) {
        globalDaily[day.date] = { date: day.date, revenue: 0, adSpend: 0, cogs: 0, orders: 0, impressions: 0, clicks: 0, purchases: 0 };
      }
      const g = globalDaily[day.date];
      g.revenue     += day.revenue;
      g.adSpend     += day.adSpend;
      g.cogs        += day.cogs;
      g.orders      += day.orders;
      g.impressions += day.impressions;
      g.clicks      += day.clicks;
      g.purchases   += day.purchases;
    }

    const t = processed.totals;
    globalTotals.revenue     += t.revenue;
    globalTotals.adSpend     += t.adSpend;
    globalTotals.cogs        += t.cogs;
    globalTotals.grossProfit += t.grossProfit;
    globalTotals.netProfit   += t.netProfit;
    globalTotals.orders      += t.orders;
    globalTotals.impressions += t.impressions;
    globalTotals.clicks      += t.clicks;
    globalTotals.purchases   += t.purchases;

    for (const p of processed.productTable) {
      if (!globalProds[p.name]) {
        globalProds[p.name] = { name: p.name, sku: p.sku, units: 0, revenue: 0, cogs: 0, grossProfit: 0 };
      }
      const g = globalProds[p.name];
      g.units       += p.units;
      g.revenue     += p.revenue;
      g.cogs        += p.cogs;
      g.grossProfit += p.grossProfit;
    }
  }

  const dailyArr = Object.values(globalDaily).sort((a, b) => a.date.localeCompare(b.date));
  for (const day of dailyArr) {
    day.grossProfit = day.revenue - day.cogs;
    day.netProfit   = day.grossProfit - day.adSpend;
    day.netMargin   = day.revenue > 0 ? (day.netProfit / day.revenue) * 100 : 0;
    day.roas        = day.adSpend > 0 ? day.revenue / day.adSpend : 0;
    day.ctr         = day.impressions > 0 ? (day.clicks / day.impressions) * 100 : 0;
    day.cpa         = day.purchases > 0 ? day.adSpend / day.purchases : 0;
    day.aov         = day.orders > 0 ? day.revenue / day.orders : 0;
  }

  globalTotals.netMargin  = globalTotals.revenue > 0 ? (globalTotals.netProfit / globalTotals.revenue) * 100 : 0;
  globalTotals.roas       = globalTotals.adSpend > 0 ? globalTotals.revenue / globalTotals.adSpend : 0;
  globalTotals.ctr        = globalTotals.impressions > 0 ? (globalTotals.clicks / globalTotals.impressions) * 100 : 0;
  globalTotals.cpa        = globalTotals.purchases > 0 ? globalTotals.adSpend / globalTotals.purchases : 0;
  globalTotals.aov        = globalTotals.orders > 0 ? globalTotals.revenue / globalTotals.orders : 0;

  const productTable = Object.values(globalProds).map(p => ({
    ...p,
    margin: p.revenue > 0 ? (p.grossProfit / p.revenue) * 100 : 0
  })).sort((a, b) => b.revenue - a.revenue);

  return {
    store: 'global',
    currency: 'USD',
    daily: dailyArr,
    totals: globalTotals,
    productTable,
    break_even_roas: breakEvens.length ? (breakEvens.reduce((a, b) => a + b, 0) / breakEvens.length) : 2,
    errors: allErrors
  };
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed   = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const query    = Object.fromEntries(parsed.searchParams);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ── Dashboard ──
    if (pathname === '/' || pathname === '/dashboard.html') {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // ── Store list ──
    if (pathname === '/api/stores') {
      reloadConfig();
      const list = CONFIG.stores.map(s => ({
        id: s.id,
        name: s.name,
        currency: s.currency || 'USD',
        break_even_roas: s.break_even_roas || 2,
        timezone: s.timezone || 'UTC'
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stores: list }));
      return;
    }

    // ── Data ──
    if (pathname === '/api/data') {
      reloadConfig();
      const storeId = query.store || 'global';
      const range   = query.range  || 'today';

      if (storeId === 'global') {
        const data = await buildGlobalData(range);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
      }

      const storeConfig = CONFIG.stores.find(s => s.id === storeId);
      if (!storeConfig) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Tienda "${storeId}" no encontrada en stores.json` }));
        return;
      }

      const { start, end } = getDateRange(range, storeConfig.timezone || 'UTC');

      // Kick off token refresh in background
      tryRefreshMetaToken(storeId).catch(() => {});

      const [shopify, meta] = await Promise.all([
        fetchShopifyOrders(storeId, start, end),
        fetchMetaAds(storeId, start, end)
      ]);

      const processed = processStoreData(
        shopify.orders || [],
        meta.data      || [],
        storeConfig,
        start,
        end
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        store: storeId,
        name: storeConfig.name,
        currency: storeConfig.currency || 'USD',
        exchange_rate: storeConfig.exchange_rate || 1,
        break_even_roas: storeConfig.break_even_roas || 2,
        start,
        end,
        daily:        processed.daily,
        totals:       processed.totals,
        productTable: processed.productTable,
        errors:       [shopify.error, meta.error].filter(Boolean)
      }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (err) {
    console.error('[ERROR]', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║   Profit Calculator  →  http://localhost:${PORT} ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`Tiendas: ${CONFIG.stores.map(s => s.name).join(' | ')}\n`);
});
