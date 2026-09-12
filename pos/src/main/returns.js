// QAYTARISH SERVICE — savdo qaytarishlari (alohida hujjat sifatida)
const { all, run } = require('./db');
const inventory = require('./inventory');

function nextReturnId() {
  return all('SELECT IFNULL(MAX(id), 0) + 1 AS next FROM returns')[0].next;
}

function nextReturnNumber() {
  return all('SELECT IFNULL(MAX(return_number), 0) + 1 AS next FROM returns')[0].next;
}

// Sotuv bo'yicha qaytarish mumkin bo'lgan mahsulotlar
function getReturnable(saleId) {
  const sale = all('SELECT * FROM sales WHERE id = ?', [saleId])[0];
  if (!sale) return null;

  const items = all('SELECT * FROM sale_items WHERE sale_id = ?', [saleId]);
  const returned = all(`
    SELECT product_id, IFNULL(SUM(quantity), 0) AS returned_qty
    FROM return_items
    WHERE return_id IN (SELECT id FROM returns WHERE sale_id = ?)
    GROUP BY product_id
  `, [saleId]);

  const retMap = {};
  returned.forEach(r => { retMap[r.product_id] = Number(r.returned_qty); });

  return {
    sale,
    items: items.map(it => ({
      product_id: it.product_id,
      product_name: it.product_name,
      unit_price: it.unit_price,
      sold: it.quantity,
      returned: retMap[it.product_id] || 0,
      max: it.quantity - (retMap[it.product_id] || 0)
    }))
  };
}

function createReturn(data) {
  const sale = all('SELECT * FROM sales WHERE id = ?', [data.sale_id])[0];
  if (!sale) return { ok: false, error: "Sotuv topilmadi" };

  const reqItems = (data.items || []).filter(it => Number(it.quantity) > 0);
  if (reqItems.length === 0) return { ok: false, error: "Qaytariladigan mahsulot tanlanmagan" };

  const returnable = getReturnable(data.sale_id);
  const rows = [];
  for (const it of reqItems) {
    const orig = returnable.items.find(x => x.product_id === it.product_id);
    if (!orig) return { ok: false, error: "Mahsulot bu sotuvda yo'q" };
    const qty = Number(it.quantity);
    if (qty > orig.max) {
      return { ok: false, error: orig.product_name + ": ko'pi " + orig.max + " ta qaytarish mumkin" };
    }
    rows.push({ product_id: it.product_id, quantity: qty, unit_price: orig.unit_price, total: qty * orig.unit_price });
  }

  const total = rows.reduce((s, r) => s + r.total, 0);
  const id = nextReturnId();
  const number = nextReturnNumber();

  run('INSERT INTO returns (id, return_number, sale_id, reason, total) VALUES (?,?,?,?,?)',
    [id, number, data.sale_id, String(data.reason || '').trim() || null, total]);

  for (const r of rows) {
    run('INSERT INTO return_items (return_id, product_id, quantity, unit_price, total_price) VALUES (?,?,?,?,?)',
      [id, r.product_id, r.quantity, r.unit_price, r.total]);

    run('UPDATE products SET stock = stock + ? WHERE id = ?', [r.quantity, r.product_id]);
    inventory.move(r.product_id, 'RETURN_IN', r.quantity, {
      referenceType: 'return',
      referenceId: id,
      note: 'Qaytarish #' + number + ' (Chek #' + sale.sale_number + ')'
    });
  }

  console.log('[QAYTARISH] #' + number + ', chek #' + sale.sale_number + ', summa=' + total);
  return { ok: true, id, return_number: number, total };
}

function listReturns() {
  return all(`
    SELECT r.*, s.sale_number,
      (SELECT COUNT(*) FROM return_items ri WHERE ri.return_id = r.id) AS items_count
    FROM returns r
    LEFT JOIN sales s ON s.id = r.sale_id
    ORDER BY r.id DESC
    LIMIT 100
  `);
}

// Qaytarish cheki (mijozga ko'rsatish uchun)
function getReturn(id) {
  const r = all('SELECT * FROM returns WHERE id = ?', [id])[0];
  if (!r) return null;
  const items = all('SELECT * FROM return_items WHERE return_id = ?', [id]);
  const sale = all('SELECT sale_number FROM sales WHERE id = ?', [r.sale_id])[0];
  return { ret: r, items, sale_number: sale ? sale.sale_number : null };
}

module.exports = { getReturnable, createReturn, listReturns, getReturn };