const { all, run } = require('./db');

function customerDebt(id) {
  return Number(all(`SELECT IFNULL(SUM(CASE WHEN type='DEBT' THEN amount ELSE -amount END),0) v FROM debt_transactions WHERE customer_id=?`, [id])[0].v);
}
function listCustomers() {
  return all('SELECT * FROM customers ORDER BY name').map(c => ({ ...c, debt: customerDebt(c.id) }));
}
function addCustomer(d) {
  const name = String(d.name || '').trim();
  if (name.length < 2) return { ok: false, error: 'Ism kamida 2 belgi' };
  run('INSERT INTO customers (name, phone, debt_limit) VALUES (?,?,?)', [name, String(d.phone || '').trim() || null, Number(d.debt_limit) || 0]);
  return { ok: true, id: all('SELECT last_insert_rowid() AS id')[0].id };
}
function listOpenDebts() {
  return all(`SELECT d.id, d.amount, d.created_at, c.name customer_name, c.phone, s.id sale_id, s.sale_number
    FROM debt_transactions d JOIN customers c ON c.id=d.customer_id LEFT JOIN sales s ON s.id=d.sale_id
    WHERE d.type='DEBT' AND IFNULL(d.status,'open')='open' ORDER BY d.id DESC`)
    .map(d => ({ ...d, products: all('SELECT product_name, quantity FROM sale_items WHERE sale_id=?', [d.sale_id]).map(i => i.product_name + ' x' + i.quantity).join(', ') }));
}
function settleDebt(debtId, shiftId, createdBy) {
  const d = all("SELECT * FROM debt_transactions WHERE id=? AND type='DEBT'", [debtId])[0];
  if (!d) return { ok: false, error: 'Qarz topilmadi' };
  if (d.status === 'paid') return { ok: false, error: 'Allaqachon to\'langan' };
  run("UPDATE debt_transactions SET status='paid', paid_at=datetime('now') WHERE id=?", [debtId]);
  run(`INSERT INTO debt_transactions (customer_id, type, amount, sale_id, note, created_by) VALUES (?,?,?,?,?,?)`,
    [d.customer_id, 'PAYMENT', d.amount, d.sale_id, "To'landi", createdBy || null]);
  if (shiftId) run('INSERT INTO cash_ins (shift_id, amount, note) VALUES (?,?,?)', [shiftId, d.amount, "Nasiya to'lovi"]);
  return { ok: true };
}
function customerHistory(id) { return all('SELECT * FROM debt_transactions WHERE customer_id=? ORDER BY id DESC LIMIT 50', [id]); }
module.exports = { listCustomers, addCustomer, listOpenDebts, settleDebt, customerHistory, customerDebt };