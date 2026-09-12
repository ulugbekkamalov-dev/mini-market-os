const { all, run, exec, txn } = require('./db');

const VERSION = 'sales-v4';

function nowLocal() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function nextSaleNumber() { return all('SELECT IFNULL(MAX(sale_number),0)+1 AS n FROM sales')[0].n || 1; }

function createSale(data) {
  try {
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return { ok: false, error: "Savat bo'sh" };

    const cashierName = data.cashier_name || 'Kassir';
    const cashierId = data.cashier_id || null;
    const shiftId = data.shift_id || null;

    const fullItems = [];
    let subtotal = 0;
    for (const it of items) {
      const pid = Number(it.product_id);
      const qty = Number(it.quantity);
      if (!pid || !qty || qty <= 0) return { ok: false, error: "Mahsulot/miqdor noto'g'ri" };
      const p = all('SELECT * FROM products WHERE id=? AND active=1', [pid])[0];
      if (!p) return { ok: false, error: 'Mahsulot topilmadi' };
      if (Number(p.stock) < qty) return { ok: false, error: p.name + ' omborda yetarli emas (qoldiq ' + p.stock + ')' };
      const unit = Number(p.sale_price) || 0;
      const cost = Number(p.cost_price) || 0;
      const tot = unit * qty;
      subtotal += tot;
      fullItems.push({ product_id: p.id, name: p.name, barcode: p.barcode || null, quantity: qty, unit_price: unit, cost_snapshot: cost, total_price: tot });
    }

    const discount = Number(data.discount) || 0;
    const total = Math.max(0, subtotal - discount);

    let payments = [];
    if (Array.isArray(data.payments) && data.payments.length) {
      payments = data.payments.map(p => ({ payment_type: String(p.payment_type || '').trim(), amount: Number(p.amount) || 0 })).filter(p => p.payment_type && p.amount > 0);
    } else {
      const type = data.type || 'naqd';
      if (type === 'naqd') { const rec = Number(data.received) || 0; if (rec < total) return { ok: false, error: 'Naqd pul yetarli emas' }; }
      payments = [{ payment_type: type, amount: total }];
    }
    if (!payments.length) return { ok: false, error: "To'lov kiritilmagan" };
    const paySum = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    if (Math.round(paySum) !== Math.round(total)) return { ok: false, error: "To'lovlar jami (" + paySum + ") chek jami (" + total + ") ga teng bo'lsin" };

    const nasiyaAmount = payments.filter(p => p.payment_type === 'nasiya').reduce((s, p) => s + Number(p.amount || 0), 0);
    if (nasiyaAmount > 0 && !data.customer_id) return { ok: false, error: 'Nasiya uchun mijoz kerak' };

    const saleNumber = nextSaleNumber();
    let paid = paySum, changeAmount = 0;
    if (!Array.isArray(data.payments) && data.type === 'naqd') { paid = Number(data.received) || total; changeAmount = Math.max(0, paid - total); }

    let saleId = null;
    txn(() => {
      exec(`INSERT INTO sales (sale_number, cashier_name, cashier_id, shift_id, customer_id, subtotal, discount, total, paid, change_amount, note, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [saleNumber, cashierName, cashierId, shiftId, data.customer_id || null, subtotal, discount, total, paid, changeAmount, data.note || null, nowLocal()]);
      saleId = all('SELECT last_insert_rowid() AS id')[0].id;

      for (const it of fullItems) {
        exec(`INSERT INTO sale_items (sale_id, product_id, product_name, barcode, quantity, unit_price, cost_snapshot, total_price)
              VALUES (?,?,?,?,?,?,?,?)`,
          [saleId, it.product_id, it.name, it.barcode, it.quantity, it.unit_price, it.cost_snapshot, it.total_price]);
        exec('UPDATE products SET stock = stock - ? WHERE id=?', [it.quantity, it.product_id]);
        exec(`INSERT INTO inventory_movements (product_id, movement_type, quantity, reference_type, reference_id, note) VALUES (?,?,?,?,?,?)`,
          [it.product_id, 'SALE_OUT', -it.quantity, 'sale', saleId, 'Chek №' + saleNumber]);
      }
      for (const p of payments) exec('INSERT INTO payments (sale_id, payment_type, amount) VALUES (?,?,?)', [saleId, p.payment_type, p.amount]);
      if (nasiyaAmount > 0) {
        exec(`INSERT INTO debt_transactions (customer_id, type, amount, sale_id, note, created_by, status) VALUES (?,?,?,?,?,?,?)`,
          [data.customer_id, 'DEBT', nasiyaAmount, saleId, 'Chek №' + saleNumber, cashierName, 'open']);
      }
    });

    return { ok: true, sale_id: saleId, sale_number: saleNumber, total, payments, nasiya_amount: nasiyaAmount, change_amount: changeAmount };
  } catch (e) {
    return { ok: false, error: 'DB xato: ' + (e && e.message ? e.message : e) };
  }
}

// Subquery'lar: JOIN xatosiz, aniq soni + mahsulot nomlari ro'yxati
function listSales() {
  return all(`
    SELECT
      s.*,
      (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items_count,
      (SELECT GROUP_CONCAT(si.product_name || ' ×' || si.quantity, ', ') FROM sale_items si WHERE si.sale_id = s.id) AS products_summary,
      (SELECT GROUP_CONCAT(DISTINCT p.payment_type) FROM payments p WHERE p.sale_id = s.id) AS payment_types,
      c.name AS customer_name,
      (SELECT COUNT(*) FROM returns r WHERE r.sale_id = s.id) AS returns_count
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    ORDER BY s.id DESC
    LIMIT 200
  `);
}

// Agar sale_items bo'lmasa, inventory_movements orqali tiklash
function getSale(id) {
  const sale = all(`SELECT s.*, c.name AS customer_name, c.phone AS customer_phone
    FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.id=?`, [id])[0];
  if (!sale) return null;

  let items = all('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id', [id]);

  if (!items.length) {
    const old = all(`SELECT im.product_id, ABS(im.quantity) AS quantity, p.name AS product_name, p.barcode
      FROM inventory_movements im LEFT JOIN products p ON p.id = im.product_id
      WHERE im.reference_type='sale' AND im.reference_id=? AND im.movement_type='SALE_OUT' ORDER BY im.id`, [id]);
    items = old.map(i => ({
      id: null, sale_id: id, product_id: i.product_id,
      product_name: i.product_name || "Noma'lum mahsulot",
      barcode: i.barcode || null,
      quantity: Number(i.quantity) || 0,
      unit_price: null, total_price: null, restored: true
    }));
  }

  const payments = all('SELECT * FROM payments WHERE sale_id=? ORDER BY id', [id]);
  return { sale, items, payments };
}

module.exports = { createSale, listSales, getSale, VERSION };