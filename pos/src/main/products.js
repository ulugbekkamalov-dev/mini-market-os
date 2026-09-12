const { all, run } = require('./db');

function listProducts() {
  return all(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.active=1 ORDER BY p.name`);
}
function addProduct(d) {
  if (!d.name || d.name.trim().length < 2) return { ok: false, error: 'Nomi kamida 2 belgi' };
  if (!d.sale_price || Number(d.sale_price) <= 0) return { ok: false, error: 'Sotish narxi kiriting' };
  let barcode = String(d.barcode || '').trim() || null;
  if (barcode && all('SELECT id FROM products WHERE barcode=?', [barcode])[0]) return { ok: false, error: 'Barcode band' };
  if (!barcode) barcode = '200' + String(Date.now()).slice(-9);
  run(`INSERT INTO products (name, barcode, category_id, cost_price, sale_price, stock, min_stock, image_url)
       VALUES (?,?,?,?,?,?,?,?)`,
    [d.name.trim(), barcode, d.category_id || null, Number(d.cost_price) || 0, Number(d.sale_price) || 0,
     Number(d.stock) || 0, Number(d.min_stock) || 0, d.image_url || null]);
  const id = all('SELECT last_insert_rowid() AS id')[0].id;
  if (Number(d.stock) || 0 > 0) run(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, note) VALUES (?,?,?,?,?,?)`,
    [id, 'INITIAL', Number(d.stock) || 0, 'product', id, 'Boshlang\'ich qoldiq']);
  return { ok: true, id };
}
function updateProduct(id, d) {
  const old = all('SELECT * FROM products WHERE id=?', [id])[0];
  if (!old) return { ok: false, error: 'Mahsulot topilmadi' };
  let barcode = String(d.barcode || '').trim() || null;
  if (barcode && all('SELECT id FROM products WHERE barcode=? AND id!=?', [barcode, id])[0]) return { ok: false, error: 'Barcode band' };
  run(`UPDATE products SET name=?, barcode=?, category_id=?, cost_price=?, sale_price=?, min_stock=?, image_url=? WHERE id=?`,
    [d.name.trim(), barcode, d.category_id || null, Number(d.cost_price) || 0, Number(d.sale_price) || 0, Number(d.min_stock) || 0,
     d.image_url !== undefined ? (d.image_url || null) : old.image_url, id]);
  if (old.sale_price !== Number(d.sale_price)) run(`INSERT INTO price_history (product_id, price_type, old_price, new_price) VALUES (?,?,?,?)`,
    [id, 'sale', old.sale_price, Number(d.sale_price)]);
  return { ok: true };
}
function listCategoriesWithCount() {
  return all(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id AND p.active=1) product_count FROM categories c ORDER BY c.name`);
}
function addCategory(name) {
  const n = String(name || '').trim();
  if (n.length < 2) return { ok: false, error: 'Nomi kamida 2 belgi' };
  if (all('SELECT id FROM categories WHERE name=?', [n])[0]) return { ok: false, error: 'Kategoriya bor' };
  run('INSERT INTO categories (name) VALUES (?)', [n]);
  return { ok: true };
}
module.exports = { listProducts, addProduct, updateProduct, listCategoriesWithCount, addCategory };