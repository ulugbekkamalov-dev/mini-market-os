const path = require('path'), fs = require('fs'), initSqlJs = require('sql.js');
const dbFile = path.join(process.env.APPDATA, 'pos', 'data', 'pos.db');
const bdir = path.join(process.env.APPDATA, 'pos', 'backups');
(async () => {
  const SQL = await initSqlJs({ locateFile: f => path.join(__dirname, 'node_modules', 'sql.js', 'dist', f) });
  const q = (db, s) => { const st = db.prepare(s); const r = []; while (st.step()) r.push(st.getAsObject()); st.free(); return r; };
  console.log('DB fayl =', dbFile, '| mavjud =', fs.existsSync(dbFile));
  if (fs.existsSync(dbFile)) {
    const db = new SQL.Database(fs.readFileSync(dbFile));
    console.log('products soni =', q(db, 'SELECT COUNT(*) c FROM products')[0].c);
    console.log('sales soni   =', q(db, 'SELECT COUNT(*) c FROM sales')[0].c);
    console.log('oxirgi 3 mahsulot =', JSON.stringify(q(db, 'SELECT id,name,stock FROM products ORDER BY id DESC LIMIT 3')));
  }
  console.log('--- Backups papkasi ---');
  if (fs.existsSync(bdir)) fs.readdirSync(bdir).forEach(f => console.log('  ', f, '|', fs.statSync(path.join(bdir, f)).mtime.toString().slice(0, 21)));
  else console.log('   (backups yo\'q)');
})();
