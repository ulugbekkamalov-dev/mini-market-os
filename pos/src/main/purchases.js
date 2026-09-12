const { all, run } = require('./db');

function listSuppliers() { return all('SELECT * FROM suppliers ORDER BY name'); }
function addSupplier(name, phone) {
  const n = String(name || '').trim();
  if (n.length < 2) return { ok: false, error: 'Nomi kamida 2 belgi' };
  run('INSERT INTO suppliers (name, phone) VALUES (?,?)', [n, String(phone || '').trim() || null]);
  return { ok: true };
}
function listPurchases() {
  return all(`SELECT p.*, s.name supplier_name, (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id=p.id) items_count
    FROM purchases p LEFT JOIN suppliers s ON s.id=p.supplier_id ORDER BY p.id DESC`);
}
function createPurchase(d) {
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) return { ok: false, error: "Mahsulot qo'shing" };
  const total = items.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.cost_price || 0), 0);
  run(`INSERT INTO purchases (supplier_id, doc_number, status, total_amount) VALUES (?,?,?,?)`,
    [d.supplier_id || null, String(d.doc_number || '').trim() || null, d.status === 'confirmed' ? 'confirmed' : 'draft', total]);
  const id = all('SELECT last_insert_rowid() AS id')[0].id;
  for (const i of items) run('INSERT INTO purchase_items (purchase_id, product_id, quantity, cost_price) VALUES (?,?,?,?)',
    [id, i.product_id, Number(i.quantity) || 0, Number(i.cost_price) || 0]);
  if (d.status === 'confirmed') applyStock(id);
  return { ok: true, id };
}
function applyStock(id) {
  const items = all('SELECT * FROM purchase_items WHERE purchase_id=?', [id]);
  for (const i of items) {
    run('UPDATE products SET stock = stock + ?, cost_price = ? WHERE id=?', [i.quantity, i.cost_price, i.product_id]);
    run(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, note) VALUES (?,?,?,?,?,?)`,
      [i.product_id, 'PURCHASE_IN', i.quantity, 'purchase', id, 'Kirim #' + id]);
  }
}
function confirmPurchase(id) {
  const p = all('SELECT * FROM purchases WHERE id=?', [id])[0];
  if (!p) return { ok: false, error: 'Kirim topilmadi' };
  if (p.status === 'confirmed') return { ok: false, error: 'Allaqachon tasdiqlangan' };
  run("UPDATE purchases SET status='confirmed', confirmed_at=datetime('now') WHERE id=?", [id]);
  applyStock(id);
  return { ok: true };
}
module.exports = { listSuppliers, addSupplier, listPurchases, createPurchase, confirmPurchase };