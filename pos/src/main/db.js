const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
let db = null, savedPath = null;

async function initDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  savedPath = path.join(dataDir, 'pos.db');
  const wasmDir = path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist');
  const SQL = await initSqlJs({ locateFile: f => path.join(wasmDir, f) });
  db = fs.existsSync(savedPath) ? new SQL.Database(fs.readFileSync(savedPath)) : new SQL.Database();
  migrate(); save();
  return savedPath;
}

function runTolerant(sql) {
  const parts = sql.split(';').map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    try { db.run(p); }
    catch (e) {
      const msg = String(e && e.message || '');
      if (!/duplicate column|already exists/i.test(msg)) throw e;
    }
  }
}

function migrate() {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const M = [
    { v: 1, sql: `CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, barcode TEXT UNIQUE, sku TEXT, category_id INTEGER, unit TEXT DEFAULT 'dona', cost_price INTEGER DEFAULT 0, sale_price INTEGER DEFAULT 0, min_stock INTEGER DEFAULT 0, stock INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now','localtime')))` },
    { v: 2, sql: `ALTER TABLE products ADD COLUMN source TEXT DEFAULT 'manual'` },
    { v: 3, sql: `CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, price_type TEXT DEFAULT 'sale', old_price INTEGER, new_price INTEGER, changed_at TEXT DEFAULT (datetime('now','localtime')))` },
    { v: 4, sql: `CREATE TABLE IF NOT EXISTS inventory_movements (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, movement_type TEXT NOT NULL, quantity INTEGER NOT NULL, reference_type TEXT, reference_id INTEGER, note TEXT, created_at TEXT DEFAULT (datetime('now','localtime')))` },
    { v: 5, sql: `CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, note TEXT);
      CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER, doc_number TEXT, status TEXT DEFAULT 'draft', total_amount INTEGER DEFAULT 0, note TEXT, created_at TEXT DEFAULT (datetime('now','localtime')), confirmed_at TEXT);
      CREATE TABLE IF NOT EXISTS purchase_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, cost_price INTEGER NOT NULL)` },
    { v: 6, sql: `CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_number INTEGER, cashier_name TEXT DEFAULT 'Kassir', subtotal INTEGER DEFAULT 0, discount INTEGER DEFAULT 0, total INTEGER DEFAULT 0, paid INTEGER DEFAULT 0, change_amount INTEGER DEFAULT 0, note TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
      CREATE TABLE IF NOT EXISTS sale_items (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, product_id INTEGER NOT NULL, product_name TEXT, barcode TEXT, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL, total_price INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL, payment_type TEXT NOT NULL, amount INTEGER NOT NULL)` },
    { v: 7, sql: `CREATE TABLE IF NOT EXISTS returns (id INTEGER PRIMARY KEY AUTOINCREMENT, return_number INTEGER, sale_id INTEGER NOT NULL, reason TEXT, total INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')));
      CREATE TABLE IF NOT EXISTS return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id INTEGER NOT NULL, product_id INTEGER NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL, total_price INTEGER NOT NULL)` },
    { v: 8, sql: `CREATE TABLE IF NOT EXISTS branches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, activation_code TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, full_name TEXT, role TEXT NOT NULL DEFAULT 'kassir', branch_id INTEGER, salt TEXT NOT NULL, pin_hash TEXT NOT NULL, active INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, opening_cash INTEGER DEFAULT 0, expected_cash INTEGER, actual_cash INTEGER, cash_diff INTEGER, status TEXT DEFAULT 'open', note TEXT, opened_at TEXT DEFAULT (datetime('now','localtime')), closed_at TEXT);
      ALTER TABLE sales ADD COLUMN cashier_id INTEGER;
      ALTER TABLE sales ADD COLUMN shift_id INTEGER` },
    { v: 9, sql: `ALTER TABLE sale_items ADD COLUMN cost_snapshot INTEGER;
      ALTER TABLE users ADD COLUMN phone TEXT` },
    { v: 10, sql: `CREATE TABLE IF NOT EXISTS sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, event_type TEXT NOT NULL, payload TEXT NOT NULL, sent_at TEXT);
      ALTER TABLE sales ADD COLUMN synced_at TEXT;
      ALTER TABLE returns ADD COLUMN synced_at TEXT;
      ALTER TABLE purchases ADD COLUMN synced_at TEXT` },
    { v: 11, sql: `CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, debt_limit INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now','localtime')));
      CREATE TABLE IF NOT EXISTS debt_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL, sale_id INTEGER, note TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
      CREATE TABLE IF NOT EXISTS cash_ins (id INTEGER PRIMARY KEY AUTOINCREMENT, shift_id INTEGER NOT NULL, amount INTEGER NOT NULL, note TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
      ALTER TABLE sales ADD COLUMN customer_id INTEGER` },
    { v: 12, sql: `ALTER TABLE debt_transactions ADD COLUMN status TEXT DEFAULT 'open';
      ALTER TABLE debt_transactions ADD COLUMN paid_at TEXT` },
    { v: 13, sql: `ALTER TABLE products ADD COLUMN image_url TEXT` },
    { v: 14, sql: `CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, action TEXT, detail TEXT, created_at TEXT DEFAULT (datetime('now','localtime')))` }
  ];
  for (const m of M) {
    const done = all('SELECT version FROM schema_migrations WHERE version=?', [m.v]);
    runTolerant(m.sql);
    if (!done.length) db.run('INSERT INTO schema_migrations (version) VALUES (?)', [m.v]);
  }
}

function save() { if (db && savedPath) fs.writeFileSync(savedPath, Buffer.from(db.export())); }
function all(sql, params = []) { const s = db.prepare(sql); s.bind(params); const r = []; while (s.step()) r.push(s.getAsObject()); s.free(); return r; }
function run(sql, params = []) { db.run(sql, params); save(); }
function exec(sql, params = []) { db.run(sql, params); }   // saqlamasdan (tranzaksiya ichida)
function txn(fn) {
  db.run('BEGIN TRANSACTION');
  try { fn(); db.run('COMMIT'); save(); return true; }
  catch (e) { try { db.run('ROLLBACK'); } catch (_) {} throw e; }
}
module.exports = { initDb, all, run, exec, txn, save };