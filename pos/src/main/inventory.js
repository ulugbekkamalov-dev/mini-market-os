const { all } = require('./db');

function getSummary() {
  const s = all(`SELECT IFNULL(SUM(stock*cost_price),0) stock_value, IFNULL(SUM(stock),0) total_units,
    IFNULL(SUM(CASE WHEN stock<min_stock THEN 1 ELSE 0 END),0) low_count FROM products WHERE active=1`)[0];
  return { stock_value: Number(s.stock_value), total_units: Number(s.total_units), low_count: Number(s.low_count) };
}
function listStock() {
  return all(`SELECT id, name, stock, min_stock, (CASE WHEN stock<min_stock THEN 1 ELSE 0 END) is_low FROM products WHERE active=1 ORDER BY is_low DESC, name`);
}
function listMovements(limit) {
  return all(`SELECT m.*, p.name product_name FROM inventory_movements m LEFT JOIN products p ON p.id=m.product_id ORDER BY m.id DESC LIMIT ?`, [limit || 50]);
}
module.exports = { getSummary, listStock, listMovements };