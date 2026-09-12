const { all } = require('./db');

function dstr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

function resolveRange(q) {
  const t = new Date(); const p = q.period || 'today';
  if (p === 'custom' && q.from && q.to) return { f: q.from, t: q.to, p };
  if (p === 'yesterday') { const d = new Date(t); d.setDate(d.getDate() - 1); const s = dstr(d); return { f: s, t: s, p }; }
  if (p === '7d') { const d = new Date(t); d.setDate(d.getDate() - 6); return { f: dstr(d), t: dstr(t), p }; }
  if (p === 'month') return { f: dstr(new Date(t.getFullYear(), t.getMonth(), 1)), t: dstr(t), p };
  if (p === 'all') return { f: '2000-01-01', t: '2099-12-31', p };
  const s = dstr(t); return { f: s, t: s, p };
}

function getReport(q) {
  const { f, t, p } = resolveRange(q);
  const totals = all('SELECT COUNT(*) checks, IFNULL(SUM(total),0) revenue FROM sales WHERE date(created_at) BETWEEN ? AND ?', [f, t])[0];
  const profit = Number(all(`SELECT IFNULL(SUM(si.total_price - IFNULL(si.cost_snapshot,0)*si.quantity),0) v
    FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE date(s.created_at) BETWEEN ? AND ?`, [f, t])[0].v);
  const payments = all(`SELECT p.payment_type, IFNULL(SUM(p.amount),0) sum FROM payments p JOIN sales s ON s.id=p.sale_id
    WHERE date(s.created_at) BETWEEN ? AND ? GROUP BY p.payment_type`, [f, t]);
  const top = all(`SELECT si.product_name, SUM(si.quantity) qty, SUM(si.total_price) sum FROM sale_items si JOIN sales s ON s.id=si.sale_id
    WHERE date(s.created_at) BETWEEN ? AND ? GROUP BY si.product_id ORDER BY sum DESC LIMIT 10`, [f, t]);
  const cashiers = all(`SELECT cashier_name, COUNT(*) checks, IFNULL(SUM(total),0) sum FROM sales WHERE date(created_at) BETWEEN ? AND ?
    GROUP BY cashier_name ORDER BY sum DESC`, [f, t]);
  const ret = all(`SELECT COUNT(*) c, IFNULL(SUM(r.total),0) sum FROM returns r JOIN sales s ON s.id=r.sale_id WHERE date(s.created_at) BETWEEN ? AND ?`, [f, t])[0];

  let series;
  if (p === 'today' || p === 'yesterday') {
    series = all(`SELECT strftime('%H:00', s.created_at) lbl, SUM(si.total_price) revenue,
      SUM(si.total_price - IFNULL(si.cost_snapshot,0)*si.quantity) profit
      FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE date(s.created_at) BETWEEN ? AND ? GROUP BY lbl ORDER BY lbl`, [f, t]);
  } else {
    series = all(`SELECT date(s.created_at) lbl, SUM(si.total_price) revenue,
      SUM(si.total_price - IFNULL(si.cost_snapshot,0)*si.quantity) profit
      FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE date(s.created_at) BETWEEN ? AND ? GROUP BY lbl ORDER BY lbl`, [f, t]);
  }

  return { from: f, to: t, checks: Number(totals.checks), revenue: Number(totals.revenue), profit,
    payments, top, cashiers, returns: { count: Number(ret.c), sum: Number(ret.sum) }, series };
}

module.exports = { getReport };