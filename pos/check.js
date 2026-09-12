const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
const dbFile = path.join(process.env.APPDATA, 'pos', 'data', 'pos.db');

console.log('1) Ish papkasi (cwd) =', process.cwd());
try { console.log('2) sales.js VERSION =', require('./src/main/sales').VERSION || 'OLD'); }
catch (e) { console.log('2) sales.js yuklanmadi:', e.message); }
try { console.log('3) db.js mavjud =', fs.existsSync('./src/main/db.js')); } catch (e) {}

(async () => {
  try {
    const SQL = await initSqlJs({ locateFile: f => path.join(__dirname, 'node_modules', 'sql.js', 'dist', f) });
    const db = new SQL.Database(fs.readFileSync(dbFile));
    const q = s => { const st = db.prepare(s); const r = []; while (st.step()) r.push(st.getAsObject()); st.free(); return r; };
    console.log('4) DB fayl =', dbFile);
    console.log('5) sale_items ustunlari =', q('PRAGMA table_info(sale_items)').map(c => c.name).join(', '));
    console.log('6) sales jami =', q('SELECT COUNT(*) c FROM sales')[0].c);
    console.log('7) sale_items jami =', q('SELECT COUNT(*) c FROM sale_items')[0].c);
    console.log('8) Oxirgi 5 chek =', JSON.stringify(q('SELECT id, sale_number, total, created_at FROM sales ORDER BY id DESC LIMIT 5')));
    console.log('9) Har chekka mahsulot soni =', JSON.stringify(q('SELECT sale_id, COUNT(*) c FROM sale_items GROUP BY sale_id ORDER BY sale_id DESC LIMIT 5')));
  } catch (e) { console.log('DB xato:', e.message); }
})();