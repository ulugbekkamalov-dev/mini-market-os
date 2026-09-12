const XLSX = require('xlsx');
const { all, run } = require('./db');

function preview(filePath) {
  try {
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    const valid = [], errors = [];
    rows.forEach((r, i) => {
      const name = String(r['Nomi'] || r['name'] || '').trim();
      const sale = Number(r['Sotish'] || r['sale'] || 0);
      if (!name || sale <= 0) { errors.push({ row: i + 2, name: name || '(bo\'sh)', errors: 'Nomi yoki Sotish narxi noto\'g\'ri' }); return; }
      valid.push({
        row: i + 2, name,
        barcode: String(r['Barcode'] || '').trim() || null,
        category: String(r['Kategoriya'] || '').trim() || null,
        cost: Number(r['Kelish'] || 0) || 0,
        sale,
        stock: Number(r['Qoldiq'] || 0) || 0,
        min: Number(r['Min'] || r['Min qoldiq'] || 0) || 0,
        image: String(r['Rasm'] || '').trim() || null
      });
    });
    return { ok: true, fileName: filePath.split(/[\\/]/).pop(), total: rows.length, valid, errors };
  } catch (e) { return { ok: false, error: e.message }; }
}
function ensureCategory(name) {
  if (!name) return null;
  let c = all('SELECT id FROM categories WHERE name=?', [name])[0];
  if (!c) { run('INSERT INTO categories (name) VALUES (?)', [name]); c = all('SELECT id FROM categories WHERE name=?', [name])[0]; }
  return c ? c.id : null;
}
function commitImport(rows) {
  let added = 0, updated = 0;
  for (const r of rows) {
    const catId = ensureCategory(r.category);
    let barcode = r.barcode;
    const existing = barcode ? all('SELECT id FROM products WHERE barcode=?', [barcode])[0] : all('SELECT id FROM products WHERE name=?', [r.name])[0];
    if (!barcode) barcode = '200' + String(Date.now()).slice(-9) + String(added).slice(-2);
    if (existing) {
      run('UPDATE products SET name=?, barcode=?, category_id=?, cost_price=?, sale_price=?, min_stock=?, image_url=? WHERE id=?',
        [r.name, barcode, catId, r.cost, r.sale, r.min, r.image, existing.id]);
      updated++;
    } else {
      run('INSERT INTO products (name, barcode, category_id, cost_price, sale_price, stock, min_stock, image_url) VALUES (?,?,?,?,?,?,?,?)',
        [r.name, barcode, catId, r.cost, r.sale, r.stock, r.min, r.image]);
      const id = all('SELECT last_insert_rowid() AS id')[0].id;
      if (r.stock > 0) run(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, note) VALUES (?,?,?,?,?,?)`,
        [id, 'INITIAL', r.stock, 'import', id, 'Excel import']);
      added++;
    }
  }
  return { ok: true, added, updated };
}
module.exports = { preview, commitImport };