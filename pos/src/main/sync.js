const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { all, run } = require('./db');
const DEV_SERVER = 'http://127.0.0.1:8000';

function settingsFile() { return path.join(app.getPath('userData'), 'cloud.json'); }
function loadSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch (e) { return null; } }
function saveSettings(s) { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); }

let timer = null, syncing = false;
let lastStatus = { online: false, pending: 0, lastSync: null, error: null, activated: false, branch: null };

function netError(e, url) {
  const cause = e && e.cause ? (e.cause.code || e.cause.message || '') : '';
  return 'Tarmoq xatosi: ' + (e && e.message ? e.message : String(e)) + (cause ? ' (' + cause + ')' : '') + ' | server: ' + url;
}

async function api(p, opts) {
  const s = loadSettings();
  const url = (s && s.server_url ? s.server_url : DEV_SERVER) + p;
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function activate(code, serverUrl) {
  const s = loadSettings() || {};
  s.server_url = (serverUrl || s.server_url || DEV_SERVER).replace(/\/+$/, '');
  saveSettings(s);
  let res;
  try {
    res = await fetch(s.server_url + '/api/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
  } catch (e) {
    return { ok: false, error: netError(e, s.server_url) };
  }
  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j && j.detail) detail = j.detail; } catch (e) {}
    return { ok: false, error: detail };
  }
  const r = await res.json();
  s.token = r.token; s.branch_id = r.branch_id; s.branch_name = r.branch_name;
  saveSettings(s);
  lastStatus.activated = true; lastStatus.branch = r.branch_name;
  return r;
}

function ensureTables() {
  run('CREATE TABLE IF NOT EXISTS catalog_sync (product_id INTEGER PRIMARY KEY, sig TEXT)');
}

function enqueue() {
  const sales = all('SELECT * FROM sales WHERE synced_at IS NULL ORDER BY id LIMIT 50');
  for (const s of sales) {
    const items = all('SELECT * FROM sale_items WHERE sale_id=?', [s.id]);
    const payments = all('SELECT payment_type, amount FROM payments WHERE sale_id=?', [s.id]);
    const eid = 'sale_' + s.id;
    if (!all('SELECT id FROM sync_log WHERE event_id=?', [eid])[0])
      run('INSERT INTO sync_log (event_id, event_type, payload) VALUES (?,?,?)', [eid, 'SALE_CREATED', JSON.stringify({ sale: s, items, payments })]);
    run("UPDATE sales SET synced_at=datetime('now') WHERE id=?", [s.id]);
  }
  const rets = all('SELECT * FROM returns WHERE synced_at IS NULL ORDER BY id LIMIT 50');
  for (const r of rets) {
    const items = all('SELECT * FROM return_items WHERE return_id=?', [r.id]);
    const eid = 'return_' + r.id;
    if (!all('SELECT id FROM sync_log WHERE event_id=?', [eid])[0])
      run('INSERT INTO sync_log (event_id, event_type, payload) VALUES (?,?,?)', [eid, 'RETURN_CREATED', JSON.stringify({ ret: r, items })]);
    run("UPDATE returns SET synced_at=datetime('now') WHERE id=?", [r.id]);
  }
  const purs = all('SELECT * FROM purchases WHERE synced_at IS NULL ORDER BY id LIMIT 50');
  for (const p of purs) {
    const items = all('SELECT * FROM purchase_items WHERE purchase_id=?', [p.id]);
    const eid = 'purchase_' + p.id;
    if (!all('SELECT id FROM sync_log WHERE event_id=?', [eid])[0])
      run('INSERT INTO sync_log (event_id, event_type, payload) VALUES (?,?,?)', [eid, 'PURCHASE_CREATED', JSON.stringify({ purchase: p, items })]);
    run("UPDATE purchases SET synced_at=datetime('now') WHERE id=?", [p.id]);
  }
}

function enqueueCatalog() {
  ensureTables();
  const prods = all('SELECT * FROM products WHERE active=1 LIMIT 300');
  for (const p of prods) {
    const sig = [p.name, p.sale_price, p.cost_price, p.stock, p.min_stock, p.category_id].join('|');
    const prev = all('SELECT sig FROM catalog_sync WHERE product_id=?', [p.id])[0];
    if (prev && prev.sig === sig) continue;
    const eid = 'prod_' + p.id + '_' + Buffer.from(sig).toString('hex').slice(0, 12);
    if (!all('SELECT id FROM sync_log WHERE event_id=?', [eid])[0]) {
      const cat = p.category_id ? all('SELECT name FROM categories WHERE id=?', [p.category_id])[0] : null;
      run('INSERT INTO sync_log (event_id, event_type, payload) VALUES (?,?,?)',
        [eid, 'PRODUCT_UPSERT', JSON.stringify({ product_id: p.id, name: p.name, category: cat ? cat.name : null, price: p.sale_price, cost: p.cost_price, stock: p.stock, min: p.min_stock })]);
    }
    run('INSERT INTO catalog_sync (product_id, sig) VALUES (?,?) ON CONFLICT(product_id) DO UPDATE SET sig=excluded.sig', [p.id, sig]);
  }
}

async function pullAndApply() {
  const s = loadSettings();
  if (!s || !s.token) return;
  const r = await api('/api/sync/pull', { headers: { 'Authorization': s.token } });
  const cmds = (r && r.cmds) || [];
  if (!cmds.length) return;
  const ids = [];
  for (const cmd of cmds) {
    const target = all('SELECT id, sale_price FROM products WHERE name=? AND active=1', [cmd.product_name])[0];
    if (target) {
      run('UPDATE products SET sale_price=? WHERE id=?', [cmd.new_price, target.id]);
      run('INSERT INTO price_history (product_id, price_type, old_price, new_price) VALUES (?,?,?,?)',
        [target.id, 'sale', target.sale_price, cmd.new_price]);
    }
    ids.push(cmd.id);
  }
  if (ids.length) {
    await api('/api/sync/ack', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': s.token }, body: JSON.stringify({ ids }) });
  }
}

async function push() {
  const s = loadSettings();
  if (!s || !s.token) return;
  const pending = all('SELECT * FROM sync_log WHERE sent_at IS NULL ORDER BY id LIMIT 100');
  if (!pending.length) return;
  const events = pending.map(p => ({ event_id: p.event_id, event_type: p.event_type, payload: JSON.parse(p.payload) }));
  const r = await api('/api/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': s.token, 'X-App-Version': app.getVersion() },
    body: JSON.stringify({ events })
  });
  if (r.ok) for (const p of pending) run("UPDATE sync_log SET sent_at=datetime('now') WHERE id=?", [p.id]);
}

async function tick() {
  if (syncing) return; syncing = true;
  try {
    const s = loadSettings();
    lastStatus.activated = !!(s && s.token);
    lastStatus.branch = s ? s.branch_name : null;
    if (s && s.token) {
      enqueue();
      enqueueCatalog();
      await push();
      await pullAndApply();
      enqueueCatalog();
    }
    await api('/api/health', {});
    lastStatus.online = true; lastStatus.lastSync = new Date().toISOString(); lastStatus.error = null;
  } catch (e) {
    lastStatus.online = false;
    lastStatus.error = netError(e, (loadSettings() || {}).server_url || DEV_SERVER);
  } finally {
    lastStatus.pending = all('SELECT COUNT(*) c FROM sync_log WHERE sent_at IS NULL')[0].c;
    syncing = false;
  }
}

function start() { if (!timer) timer = setInterval(tick, 15000); tick(); }
function status() { return lastStatus; }
module.exports = { start, status, activate };