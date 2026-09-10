const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const pArg = process.argv.find(a => a.startsWith('--profile='));
if (pArg) app.setPath('userData', path.join(app.getPath('appData'), 'MiniMarketOS-' + pArg.split('=')[1]));

const { initDb, all, run } = require('./db');
const products = require('./products');
const importer = require('./importer');
const inventory = require('./inventory');
const purchases = require('./purchases');
const sales = require('./sales');
const returns = require('./returns');
const auth = require('./auth');
const reports = require('./reports');
const backups = require('./backups');
const sync = require('./sync');
const nasiya = require('./nasiya');

console.log('[BOOT] sales.js version =', sales.VERSION || 'OLD');

let dbPath;
let mainWindow = null;

function audit(user, action, detail) {
  try {
    run('INSERT INTO audit_log (user_id, username, action, detail) VALUES (?,?,?,?)',
      [user ? user.id : null, user ? user.username : 'system', action, detail || '']);
    const eid = 'audit_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    run('INSERT INTO sync_log (event_id, event_type, payload) VALUES (?,?,?)',
      [eid, 'AUDIT', JSON.stringify({ action, detail, username: user ? user.username : 'system', at: new Date().toISOString() })]);
  } catch (e) { console.log('[AUDIT] skip:', e.message); }
}

function cloudSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'cloud.json'), 'utf8')); } catch (e) { return null; }
}
async function checkUpdate(win) {
  const s = cloudSettings();
  if (!s || !s.server_url) return;
  try {
    const r = await fetch(s.server_url + '/api/app/version');
    if (!r.ok) return;
    const j = await r.json();
    const cur = app.getVersion();
    if (j.version && j.version !== cur && j.url && win && !win.isDestroyed()) {
      win.webContents.send('update-available', { version: j.version, url: j.url });
    }
  } catch (e) {}
}

async function createWindow() {
  const win = new BrowserWindow({ width: 1360, height: 860, title: 'Mini Market OS',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow = win;
  return win;
}

app.whenReady().then(async () => {
  dbPath = await initDb(path.join(app.getPath('userData'), 'data'));
  backups.autoDaily(); sync.start();

  ipcMain.handle('sync:status', () => sync.status());
  ipcMain.handle('sync:now', () => { sync.start(); return sync.status(); });
  ipcMain.handle('sync:activate', (e, c, u) => sync.activate(c, u));

  ipcMain.handle('update:check', () => { if (mainWindow) checkUpdate(mainWindow); return { ok: true, version: app.getVersion() }; });
  ipcMain.handle('update:open', (e, url) => { shell.openExternal(url); return { ok: true }; });

  ipcMain.handle('auth:needsSetup', () => auth.needsSetup());
  ipcMain.handle('auth:setupOwner', (e, d) => auth.setupOwner(d));
  ipcMain.handle('auth:users', () => auth.listUsers());
  ipcMain.handle('auth:login', (e, u, p) => auth.login(u, p));
  ipcMain.handle('auth:addUser', (e, d, r) => auth.addUser(d, r));
  ipcMain.handle('auth:resetPin', (e, id, p, r) => auth.resetPin(id, p, r));
  ipcMain.handle('auth:openShift', (e, id, c) => auth.openShift(id, c));
  ipcMain.handle('auth:getOpenShift', (e, id) => auth.getOpenShift(id));
  ipcMain.handle('auth:shiftStats', (e, id) => auth.shiftStats(id));
  ipcMain.handle('auth:closeShift', (e, id, c, n) => auth.closeShift(id, c, n));
  ipcMain.handle('auth:shifts', () => auth.listShifts());

  ipcMain.handle('staff:update', (e, id, d, actor) => {
    const t = all('SELECT * FROM users WHERE id=?', [id])[0];
    if (!t) return { ok: false, error: 'Xodim topilmadi' };
    run('UPDATE users SET full_name=?, phone=?, role=?, active=? WHERE id=?',
      [d.full_name || t.full_name, d.phone !== undefined ? d.phone : t.phone, d.role || t.role, d.active !== undefined ? (d.active ? 1 : 0) : t.active, id]);
    audit(actor, 'STAFF_UPDATE', 'Xodim tahrirlandi: ' + (d.full_name || t.full_name));
    return { ok: true };
  });
  ipcMain.handle('profile:update', (e, id, d, actor) => {
    run('UPDATE users SET full_name=?, phone=? WHERE id=?', [d.full_name, d.phone || '', id]);
    audit(actor, 'PROFILE_UPDATE', 'Profil tahrirlandi: ' + d.full_name);
    return { ok: true };
  });
  ipcMain.handle('audit:log', (e, u, a, d) => { audit(u, a, d); return { ok: true }; });
  ipcMain.handle('audit:list', () => { try { return all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200'); } catch (e) { return []; } });

  ipcMain.handle('nasiya:customers', () => nasiya.listCustomers());
  ipcMain.handle('nasiya:addCustomer', (e, d) => nasiya.addCustomer(d));
  ipcMain.handle('nasiya:openDebts', () => nasiya.listOpenDebts());
  ipcMain.handle('nasiya:settle', (e, id, s, by) => nasiya.settleDebt(id, s, by));
  ipcMain.handle('nasiya:history', (e, id) => nasiya.customerHistory(id));

  ipcMain.handle('products:list', () => products.listProducts());
  ipcMain.handle('products:add', (e, d) => products.addProduct(d));
  ipcMain.handle('products:update', (e, id, d, actor) => {
    const old = all('SELECT * FROM products WHERE id=?', [id])[0];
    const r = products.updateProduct(id, d);
    if (r.ok && old) {
      if (old.sale_price !== Number(d.sale_price)) audit(actor, 'PRICE_CHANGE', old.name + ': narx ' + old.sale_price + ' -> ' + d.sale_price);
      if (old.name !== d.name) audit(actor, 'RENAME', 'Mahsulot nomi: ' + old.name + ' -> ' + d.name);
    }
    return r;
  });
  ipcMain.handle('products:setImage', (e, id, url) => { try { run('UPDATE products SET image_url=? WHERE id=?', [url || null, id]); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; } });
  ipcMain.handle('categories:list', () => products.listCategoriesWithCount());
  ipcMain.handle('categories:add', (e, n) => products.addCategory(n));

  ipcMain.handle('inventory:summary', () => inventory.getSummary());
  ipcMain.handle('inventory:stock', () => inventory.listStock());
  ipcMain.handle('inventory:movements', () => inventory.listMovements(50));

  ipcMain.handle('suppliers:list', () => purchases.listSuppliers());
  ipcMain.handle('suppliers:add', (e, n, p) => purchases.addSupplier(n, p));
  ipcMain.handle('purchases:list', () => purchases.listPurchases());
  ipcMain.handle('purchases:create', (e, d) => purchases.createPurchase(d));
  ipcMain.handle('purchases:confirm', (e, id) => purchases.confirmPurchase(id));

  ipcMain.handle('sales:create', (e, d) => sales.createSale(d));
  ipcMain.handle('sales:list', () => sales.listSales());
  ipcMain.handle('sales:get', (e, id) => sales.getSale(id));

  ipcMain.handle('returns:returnable', (e, id) => returns.getReturnable(id));
  ipcMain.handle('returns:create', (e, d) => returns.createReturn(d));
  ipcMain.handle('returns:list', () => returns.listReturns());
  ipcMain.handle('returns:get', (e, id) => returns.getReturn(id));

  ipcMain.handle('reports:get', (e, q) => reports.getReport(q));

  ipcMain.handle('backup:list', () => backups.listBackups());
  ipcMain.handle('backup:create', () => backups.createBackup());
  ipcMain.handle('backup:restore', (e, f) => backups.restoreBackup(f));
  ipcMain.handle('app:relaunch', () => { app.relaunch(); app.exit(0); });

  ipcMain.handle('import:pick', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Excel/CSV', extensions: ['xlsx', 'xls', 'csv'] }] });
    if (res.canceled) return { ok: false };
    return importer.preview(res.filePaths[0]);
  });
  ipcMain.handle('import:commit', (e, rows) => importer.commitImport(rows));

  ipcMain.handle('db:info', () => ({ path: dbPath, salesVersion: sales.VERSION || 'OLD', appVersion: app.getVersion() }));

  const win = await createWindow();
  setTimeout(() => checkUpdate(win), 5000);
});
app.on('window-all-closed', () => app.quit());