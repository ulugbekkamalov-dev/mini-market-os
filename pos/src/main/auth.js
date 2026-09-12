const crypto = require('crypto');
const { all, run } = require('./db');

function hashPin(pin, salt) { return crypto.createHash('sha256').update(salt + ':' + String(pin)).digest('hex'); }

function checkPassword(p) {
  const s = String(p || '');
  if (s.length < 8) return 'Parol kamida 8 belgi bo\'lishi kerak';
  if (!/[a-zA-Z]/.test(s)) return 'Parolda kamida bitta HARF bo\'lishi kerak';
  if (!/\d/.test(s)) return 'Parolda kamida bitta RAQAM bo\'lishi kerak';
  if (s.includes(' ')) return 'Parolda bo\'shliq bo\'lmasin';
  if (['12345678','password','parol123','admin123','11111111'].includes(s.toLowerCase())) return 'Parol juda sodda';
  return null;
}

function checkUsername(u) {
  const s = String(u || '').trim();
  if (s.length < 4) return 'Login kamida 4 belgi';
  if (!/^[a-zA-Z][a-zA-Z0-9_.]*$/.test(s)) return 'Login lotin harfi bilan boshlansin';
  if (['admin','owner','user','test','root','kassir'].includes(s.toLowerCase())) return 'Login juda sodda';
  return null;
}
function pinTaken(pin, excludeId) {
  return all('SELECT id, salt, pin_hash FROM users').some(r => r.id !== excludeId && hashPin(pin, r.salt) === r.pin_hash);
}
function checkNames(f, l) {
  if (!f || f.trim().length < 2) return 'Ism kamida 2 belgi';
  if (!l || l.trim().length < 2) return 'Familiya kamida 2 belgi';
  return null;
}
function insertUser(d) {
  const salt = crypto.randomBytes(8).toString('hex');
  run('INSERT INTO users (username, full_name, role, branch_id, phone, salt, pin_hash) VALUES (?,?,?,?,?,?,?)',
    [d.username.trim(), (d.first_name.trim() + ' ' + d.last_name.trim()), d.role, d.branch_id || null, String(d.phone || '').trim() || null, salt, hashPin(d.pin, salt)]);
}

function needsSetup() { return all('SELECT COUNT(*) AS c FROM users')[0].c === 0; }

function setupOwner(d) {
  if (!needsSetup()) return { ok: false, error: 'Tizim allaqachon sozlangan' };
  let e = checkNames(d.first_name, d.last_name); if (e) return { ok: false, error: e };
  e = checkUsername(d.username); if (e) return { ok: false, error: e };
  e = checkPassword(d.pin); if (e) return { ok: false, error: e };
  if (pinTaken(d.pin)) return { ok: false, error: 'Bu parol boshqa xodimda' };
  const bn = (d.branch_name || '').trim() || 'Filial-1';
  let b = all('SELECT * FROM branches ORDER BY id LIMIT 1')[0];
  if (!b) { run('INSERT INTO branches (name) VALUES (?)', [bn]); b = all('SELECT * FROM branches ORDER BY id LIMIT 1')[0]; }
  else run('UPDATE branches SET name=? WHERE id=?', [bn, b.id]);
  insertUser({ ...d, role: 'owner', branch_id: b.id });
  const o = all("SELECT id, username FROM users WHERE role='owner' LIMIT 1")[0];
  return { ok: true, ownerId: o ? o.id : null, ownerUsername: o ? o.username : null };
}

function listUsers() {
  return all(`SELECT u.id, u.username, u.full_name, u.role, u.active, u.phone, b.name AS branch_name
    FROM users u LEFT JOIN branches b ON b.id=u.branch_id ORDER BY u.id`);
}
function login(username, pin) {
  const u = all(`SELECT u.*, b.name AS branch_name FROM users u LEFT JOIN branches b ON b.id=u.branch_id
    WHERE u.username=? AND u.active=1`, [username])[0];
  if (!u) return { ok: false, error: 'Foydalanuvchi topilmadi' };
  if (hashPin(pin, u.salt) !== u.pin_hash) return { ok: false, error: 'Parol noto\'g\'ri' };
  return { ok: true, user: { id: u.id, username: u.username, full_name: u.full_name, role: u.role, branch_id: u.branch_id, branch_name: u.branch_name, phone: u.phone } };
}
function addUser(d, creatorRole) {
  let e = checkNames(d.first_name, d.last_name); if (e) return { ok: false, error: e };
  e = checkUsername(d.username); if (e) return { ok: false, error: e };
  e = checkPassword(d.pin); if (e) return { ok: false, error: e };
  const allowed = (creatorRole === 'owner' || creatorRole === 'admin') ? ['kassir','menejer','omborchi','admin','owner'] : ['kassir','omborchi'];
  if (!allowed.includes(d.role)) return { ok: false, error: 'Bu rolni yaratish huquqi yo\'q' };
  if (all('SELECT id FROM users WHERE username=?', [d.username.trim()])[0]) return { ok: false, error: 'Login band' };
  if (pinTaken(d.pin)) return { ok: false, error: 'Parol boshqa xodimda' };
  const b = all('SELECT id FROM branches ORDER BY id LIMIT 1')[0];
  insertUser({ ...d, branch_id: b ? b.id : null });
  return { ok: true };
}
function resetPin(targetId, newPin, actorRole) {
  if (actorRole !== 'owner' && actorRole !== 'admin') return { ok: false, error: 'Faqat owner/admin tiklay oladi' };
  const t = all('SELECT * FROM users WHERE id=?', [targetId])[0];
  if (!t) return { ok: false, error: 'Xodim topilmadi' };
  const e = checkPassword(newPin); if (e) return { ok: false, error: e };
  if (pinTaken(newPin, targetId)) return { ok: false, error: 'Parol boshqa xodimda' };
  const salt = crypto.randomBytes(8).toString('hex');
  run('UPDATE users SET salt=?, pin_hash=? WHERE id=?', [salt, hashPin(newPin, salt), targetId]);
  return { ok: true };
}

function getOpenShift(userId) { return all("SELECT * FROM shifts WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1", [userId])[0] || null; }
function nextShiftId() { return all('SELECT IFNULL(MAX(id),0)+1 AS next FROM shifts')[0].next; }
function openShift(userId, openingCash) {
  if (getOpenShift(userId)) return { ok: false, error: 'Ochiq smena bor' };
  const id = nextShiftId();
  run('INSERT INTO shifts (id, user_id, opening_cash) VALUES (?,?,?)', [id, userId, Number(openingCash) || 0]);
  return { ok: true, shift: getOpenShift(userId) };
}
function shiftStats(shiftId) {
  const cashIn = Number(all("SELECT IFNULL(SUM(p.amount),0) v FROM payments p JOIN sales s ON s.id=p.sale_id WHERE s.shift_id=? AND p.payment_type='naqd'", [shiftId])[0].v);
  const cardIn = Number(all("SELECT IFNULL(SUM(p.amount),0) v FROM payments p JOIN sales s ON s.id=p.sale_id WHERE s.shift_id=? AND p.payment_type='karta'", [shiftId])[0].v);
  const retOut = Number(all('SELECT IFNULL(SUM(r.total),0) v FROM returns r JOIN sales s ON s.id=r.sale_id WHERE s.shift_id=?', [shiftId])[0].v);
  const cashIns = Number(all('SELECT IFNULL(SUM(amount),0) v FROM cash_ins WHERE shift_id=?', [shiftId])[0].v);
  const nasiyaSum = Number(all("SELECT IFNULL(SUM(p.amount),0) v FROM payments p JOIN sales s ON s.id=p.sale_id WHERE s.shift_id=? AND p.payment_type='nasiya'", [shiftId])[0].v);
  const salesCount = Number(all('SELECT COUNT(*) c FROM sales WHERE shift_id=?', [shiftId])[0].c);
  return { cashIn, cardIn, retOut, cashIns, nasiyaSum, salesCount };
}
function closeShift(shiftId, actualCash, note) {
  const sh = all('SELECT * FROM shifts WHERE id=?', [shiftId])[0];
  if (!sh) return { ok: false, error: 'Smena topilmadi' };
  if (sh.status !== 'open') return { ok: false, error: 'Smena allaqachon yopiq' };
  const actual = Number(actualCash);
  if (isNaN(actual) || actual < 0) return { ok: false, error: 'Real pulni kiriting' };
  const st = shiftStats(shiftId);
  const expected = Number(sh.opening_cash) + st.cashIn - st.retOut + st.cashIns;
  const diff = actual - expected;
  run("UPDATE shifts SET status='closed', closed_at=datetime('now'), expected_cash=?, actual_cash=?, cash_diff=?, note=? WHERE id=?",
    [expected, actual, diff, String(note || '').trim() || null, shiftId]);
  return { ok: true, expected, diff };
}
function listShifts() {
  return all(`SELECT sh.*, u.full_name AS user_name FROM shifts sh LEFT JOIN users u ON u.id=sh.user_id ORDER BY sh.id DESC LIMIT 100`);
}

module.exports = { needsSetup, setupOwner, listUsers, login, addUser, resetPin, getOpenShift, openShift, shiftStats, closeShift, listShifts, checkPassword };