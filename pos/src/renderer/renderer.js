const $ = (id) => document.getElementById(id);
const fmt = n => Number(n || 0).toLocaleString();
function on(id, e, f) { const el = $(id); if (el) el.addEventListener(e, f); }
const LS = {
  get(k, d) { try { const v = localStorage.getItem('mmos_' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { localStorage.setItem('mmos_' + k, JSON.stringify(v)); },
  del(k) { localStorage.removeItem('mmos_' + k); }
};

let productsCache = [], stockCache = [], cart = [], purItems = [], session = null;
let editingId = null, returnState = null, selectedCustomerId = null, mixedCustomerId = null, nasiyaBusy = false;
let currentPage = 'home', repPeriod = 'today', repTab = 'sold', closeExpected = 0, pendingImage = null;
let endOfDayShown = false;

const TYPE_LABELS = { INITIAL:"🆕", PURCHASE_IN:'🚚 Kirim', SALE_OUT:'🛒 Sotuv', RETURN_IN:'↩️ Qaytarish', ADJUSTMENT:'🔧', WRITE_OFF:'🗑️' };
const ROLE_PAGES = {
  owner:['home','pos','sales','nasiya','products','stock','purchase','reports','staff','profile','settings'],
  admin:['home','pos','sales','nasiya','products','stock','purchase','reports','staff','profile','settings'],
  menejer:['home','pos','sales','nasiya','products','stock','purchase','reports','staff','profile','settings'],
  kassir:['home','pos','sales','nasiya','profile','settings'],
  omborchi:['home','stock','purchase','profile','settings']
};

function showModal(title, fields) {
  return new Promise(res => {
    const ov = $('modal-overlay'); if (!ov) return res(null);
    $('modal-title').textContent = title;
    $('modal-fields').innerHTML = fields.map(f => `<div class="ov-field"><label>${f.label}</label>${f.type === 'select' ? `<select id="mf-${f.id}">${(f.options || []).map(o => `<option value="${o}" ${o === f.value ? 'selected' : ''}>${o}</option>`).join('')}</select>` : `<input id="mf-${f.id}" type="${f.type || 'text'}" value="${f.value || ''}">`}</div>`).join('');
    ov.style.display = 'flex';
    const first = $('modal-fields').querySelector('input,select'); if (first) first.focus();
    const close = v => { ov.style.display = 'none'; $('modal-ok').onclick = null; $('modal-cancel').onclick = null; res(v); };
    $('modal-ok').onclick = () => { const o = {}; fields.forEach(f => { const el = $('mf-' + f.id); o[f.id] = el ? el.value : ''; }); close(o); };
    $('modal-cancel').onclick = () => close(null);
  });
}
function confirmModal(msg) {
  return new Promise(res => {
    const ov = $('modal-overlay'); if (!ov) return res(false);
    $('modal-title').textContent = msg; $('modal-fields').innerHTML = '';
    ov.style.display = 'flex';
    $('modal-ok').onclick = () => { ov.style.display = 'none'; res(true); };
    $('modal-cancel').onclick = () => { ov.style.display = 'none'; res(false); };
  });
}

const PHONE_PREFIX = '+998 ';
function maskPhone(inp) {
  if (!inp) return;
  inp.addEventListener('focus', () => { if (!inp.value.trim()) inp.value = PHONE_PREFIX; setTimeout(() => { try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {} }, 0); });
  inp.addEventListener('input', () => {
    let d = inp.value.replace(/\D/g, ''); if (d.startsWith('998')) d = d.slice(3); d = d.slice(0, 9);
    let o = PHONE_PREFIX;
    if (d.length > 0) o += d.slice(0, 2);
    if (d.length > 2) o += ' ' + d.slice(2, 5);
    if (d.length > 5) o += ' ' + d.slice(5, 7);
    if (d.length > 7) o += ' ' + d.slice(7, 9);
    inp.value = o; try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e) {}
  });
}
function phoneVal(inp) { if (!inp) return ''; const d = (inp.value || '').replace(/\D/g, ''); return d.length ? inp.value.trim() : ''; }
['su-phone','st-phone','no-phone','mix-phone','prof-phone','set-phone'].forEach(id => maskPhone($(id)));

function readImage(file, cb) {
  const fr = new FileReader();
  fr.onload = () => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); const s = Math.min(1, 160 / Math.max(img.width, img.height)); c.width = img.width * s; c.height = img.height * s; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); cb(c.toDataURL('image/jpeg', .7)); }; img.src = fr.result; };
  fr.readAsDataURL(file);
}
function prodImg(p) { return p.image_url || LS.get('img_' + p.id, null); }

function drawLine(canvas, data, tip) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.clientWidth || 600, H = canvas.height = 220;
  ctx.clearRect(0, 0, W, H);
  if (!data || !data.length) { ctx.fillStyle = '#9ca3af'; ctx.font = '12px Segoe UI'; ctx.fillText("Ma'lumot yo'q", 20, H / 2); canvas.onmousemove = null; return; }
  const pad = 44, max = Math.max(...data.map(d => Number(d.revenue) || 0), 1);
  const x = i => pad + i * (W - pad - 12) / Math.max(data.length - 1, 1);
  const y = v => H - 26 - (Number(v) || 0) / max * (H - 50);
  ctx.font = '10px Segoe UI';
  for (let g = 0; g <= 4; g++) { const val = max * (1 - g / 4); const gy = y(val); ctx.strokeStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(W - 12, gy); ctx.stroke(); ctx.fillStyle = '#9ca3af'; ctx.fillText(fmt(Math.round(val)), 4, gy + 3); }
  const step = Math.max(1, Math.floor(data.length / 6));
  ctx.fillStyle = '#9ca3af';
  for (let i = 0; i < data.length; i += step) ctx.fillText(data[i].lbl, x(i) - 12, H - 8);
  function line(key, color) { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); data.forEach((d, i) => { const px = x(i), py = y(d[key]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.stroke(); ctx.fillStyle = color; data.forEach((d, i) => { ctx.beginPath(); ctx.arc(x(i), y(d[key]), 3, 0, Math.PI * 2); ctx.fill(); }); }
  line('revenue', '#2563eb'); line('profit', '#16a34a');
  canvas.onmousemove = e => {
    const r = canvas.getBoundingClientRect();
    let idx = Math.round((e.clientX - r.left - pad) / ((W - pad - 12) / Math.max(data.length - 1, 1)));
    idx = Math.max(0, Math.min(data.length - 1, idx));
    const d = data[idx]; if (!tip) return;
    tip.style.display = 'block';
    tip.style.left = Math.min(x(idx) + 10, W - 170) + 'px';
    tip.style.top = Math.max(y(d.revenue) - 14, 4) + 'px';
    tip.innerHTML = '<b>' + d.lbl + '</b><br>Savdo: ' + fmt(d.revenue) + "<br>Foyda: " + fmt(d.profit);
  };
  canvas.onmouseleave = () => { if (tip) tip.style.display = 'none'; };
}
function drawDonut(canvas, payments) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.clientWidth || 220, H = canvas.height = 160;
  ctx.clearRect(0, 0, W, H);
  const total = payments.reduce((s, p) => s + Number(p.sum || 0), 0);
  const lg = $('donut-legend');
  if (!total) { if (lg) lg.innerHTML = '<span class="muted">Bu davrda to\'lov yo\'q</span>'; return; }
  const labels = { naqd: 'Naqd', karta: 'Karta', nasiya: 'Nasiya' };
  const colors = { naqd:'#16a34a', karta:'#2563eb', nasiya:'#d97706' };
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 6;
  let a0 = -Math.PI / 2;
  payments.forEach(p => { const v = Number(p.sum || 0); const f = v / total; const a1 = a0 + f * Math.PI * 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a0, a1); ctx.closePath(); ctx.fillStyle = colors[p.payment_type] || '#9ca3af'; ctx.fill(); a0 = a1; });
  ctx.beginPath(); ctx.arc(cx, cy, R * .55, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  if (lg) {
    lg.innerHTML = payments.map(p => {
      const v = Number(p.sum || 0);
      const pct = Math.round(v / total * 100);
      return `<div style="display:flex;justify-content:space-between;gap:12px;margin:5px 0"><span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${colors[p.payment_type] || '#9ca3af'}"></i> ${labels[p.payment_type] || p.payment_type}</span><b>${fmt(v)} (${pct}%)</b></div>`;
    }).join('');
  }
}

function switchPage(n) {
  currentPage = n;
  document.querySelectorAll('#sb-nav .nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === n));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + n));
  const t = { home:'Bosh sahifa', pos:'Kassa', sales:'Sotuvlar', nasiya:'Nasiya', products:'Mahsulotlar', stock:'Ombor', purchase:'Kirim', reports:'Hisobotlar', staff:'Xodimlar', profile:'Profil', settings:'Sozlamalar' };
  $('page-title').textContent = t[n] || '';
  if (!session) return;
  if (n === 'home') loadHome();
  if (n === 'reports') loadReport();
  if (n === 'nasiya') loadNasiya();
  if (n === 'settings') loadSettings();
  if (n === 'profile') loadProfile();
  if (n === 'products') loadCategoriesTable();
}
document.querySelectorAll('#sb-nav .nav-item').forEach(i => i.addEventListener('click', () => switchPage(i.dataset.page)));
function applyRole() {
  const pg = ROLE_PAGES[session.user.role] || ROLE_PAGES.kassir;
  document.querySelectorAll('#sb-nav .nav-item').forEach(i => { i.style.display = pg.includes(i.dataset.page) ? '' : 'none'; });
  if (!pg.includes(currentPage)) switchPage(pg[0]);
}

async function pollSync() {
  try {
    const st = await window.api.syncStatus();
    const el = $('sb-sync');
    if (el) {
      if (!st.activated) { el.textContent = '☁️ ulanmagan'; el.className = 'err'; }
      else if (st.online) { el.textContent = '☁️ ' + (st.branch || '') + ' | ' + st.pending; el.className = 'ok'; }
      else { el.textContent = '☁️ OFFLINE | ' + st.pending; el.className = 'err'; }
    }
    const ss = $('set-sync-state'); if (ss) ss.textContent = 'Holat: ' + (st.online ? 'online' : 'offline') + ' | navbat: ' + st.pending;
  } catch (e) {}
}
setInterval(pollSync, 10000);
on('btn-cloud', 'click', async () => {
  const f = await showModal('☁️ Cloudga ulanish', [{ id:'url', label:'Server (https://...)' }, { id:'code', label:'Aktivatsiya kodi' }]);
  if (!f || !f.code.trim()) return;
  const r = await window.api.syncActivate(f.code.trim(), (f.url || '').trim() || undefined);
  alert(r && r.ok ? '✅ ' + (r.branch_name || '') : '⚠️ ' + ((r && r.error) || 'Ulanmadi'));
  pollSync();
});
on('btn-sync-now', 'click', async () => { await window.api.syncNow(); pollSync(); });

function storeName() { return LS.get('store_name', 'Mini Market'); }
function applyBrand() { $('sb-name').textContent = storeName(); $('login-store').textContent = '🛒 ' + storeName(); document.title = storeName(); }
async function boot() {
  applyBrand();
  const need = await window.api.needsSetup();
  if (need) { $('setup-overlay').style.display = 'flex'; return; }
  showLogin(); pollSync();
  setInterval(checkEndOfDay, 60000);
  setTimeout(checkEndOfDay, 2000);
}
async function showLogin() {
  $('login-overlay').style.display = 'flex';
  await loadLoginUsers();
  const rem = LS.get('remember', null);
  if (rem) { $('login-user').value = rem.username || ''; $('login-pin').value = rem.password || ''; $('login-remember').checked = true; }
  setTimeout(() => { if ($('login-user').value) $('login-pin').focus(); else $('login-user').focus(); }, 50);
}
async function loadLoginUsers() {
  const u = await window.api.getUsers();
  $('login-user').innerHTML = '<option value="">— tanlang —</option>' + u.filter(x => x.active).map(x => `<option value="${x.username}">${x.full_name} (${x.role})</option>`).join('');
}
async function doLogin() {
  const un = $('login-user').value, m = $('login-msg');
  if (!un) { m.textContent = '⚠️ Foydalanuvchini tanlang'; return; }
  const res = await window.api.login(un, $('login-pin').value);
  if (!res.ok) { m.textContent = '⚠️ ' + res.error; return; }
  if ($('login-remember').checked) LS.set('remember', { username: un, password: $('login-pin').value }); else LS.del('remember');
  session = { user: res.user, shift: null, mustCloseOld: false };
  $('login-pin').value = ''; m.textContent = '';
  $('login-overlay').style.display = 'none';
  const os = await window.api.getOpenShift(res.user.id);
  const today = new Date().toISOString().slice(0, 10);
  if (os && String(os.opened_at || '').slice(0, 10) === today) { session.shift = os; enterApp(); }
  else if (os) { session.shift = os; session.mustCloseOld = true; openCloseOverlay(true); }
  else { $('shift-open-user').textContent = session.user.full_name; $('shift-open-overlay').style.display = 'flex'; }
}
on('login-save', 'click', doLogin);
on('login-pin', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } });
on('login-user', 'keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('login-pin').focus(); } });
on('login-forgot', 'click', () => { $('forgot-overlay').style.display = 'flex'; });
on('fg-cancel', 'click', () => { $('forgot-overlay').style.display = 'none'; });
on('fg-save', 'click', async () => {
  const rec = LS.get('recovery', null), m = $('fg-msg');
  if (!rec) { m.textContent = '⚠️ Recovery kod yo\'q'; return; }
  if (($('fg-code').value || '').trim() !== rec.code) { m.textContent = '⚠️ Kod noto\'g\'ri'; return; }
  const r = await window.api.resetPin(rec.ownerId, $('fg-pass').value, 'owner');
  if (!r.ok) { m.textContent = '⚠️ ' + r.error; return; }
  m.textContent = '✅ Yangilandi'; $('forgot-overlay').style.display = 'none';
});
on('su-save', 'click', async () => {
  const res = await window.api.setupOwner({ first_name: $('su-first').value, last_name: $('su-last').value, phone: phoneVal($('su-phone')), branch_name: $('su-branch').value, username: $('su-username').value, pin: $('su-pin').value });
  const m = $('setup-msg');
  if (!res.ok) { m.textContent = '⚠️ ' + res.error; return; }
  if ($('su-branch').value.trim()) LS.set('store_name', $('su-branch').value.trim());
  const code = Math.random().toString(36).slice(2, 8).toUpperCase() + Math.random().toString(36).slice(2, 8).toUpperCase();
  LS.set('recovery', { code, ownerId: res.ownerId });
  $('setup-recovery-code').textContent = code; $('setup-recovery').style.display = 'block';
  applyBrand();
  const ac = ($('su-code').value || '').trim(); if (ac) await window.api.syncActivate(ac);
  setTimeout(() => { $('setup-overlay').style.display = 'none'; showLogin(); }, 2500);
});

async function checkEndOfDay() {
  if (!session || !session.shift) return;
  if (endOfDayShown) return;
  const h = new Date().getHours();
  if (h < 23) return;
  endOfDayShown = true;
  const ok = await confirmModal('🌙 Kun yakunlanyapti. Smenani yopishni xohlaysizmi?');
  if (ok) openCloseOverlay(false);
}

on('btn-shift-open', 'click', async () => {
  const r = await window.api.openShift(session.user.id, Number($('shift-opening').value) || 0);
  if (!r.ok) { $('shift-open-msg').textContent = '⚠️ ' + r.error; return; }
  session.shift = r.shift; session.mustCloseOld = false; endOfDayShown = false;
  $('shift-open-overlay').style.display = 'none'; enterApp();
});
async function openCloseOverlay(showOld) {
  if (!session || !session.shift) return;
  const st = await window.api.shiftStats(session.shift.id);
  const expected = Number(session.shift.opening_cash) + st.cashIn - st.retOut + st.cashIns;
  closeExpected = expected;
  $('shift-old-warning').style.display = showOld ? 'block' : 'none';
  $('shift-close-info').innerHTML = "Naqd: <b>" + fmt(st.cashIn) + '</b> | Karta: <b>' + fmt(st.cardIn) + '</b> | Qaytarish: <b>' + fmt(st.retOut) + '</b> | Nasiya to\'lovi: <b>' + fmt(st.cashIns) + "</b><br>KUTILGAN: <b>" + fmt(expected) + "</b> so'm";
  $('shift-actual').value = '';
  $('shift-diff').textContent = '';
  $('shift-note').value = '';
  $('shift-close-msg').textContent = '';
  $('shift-close-overlay').style.display = 'flex';
}
on('btn-close-shift', 'click', () => openCloseOverlay(false));
on('shift-actual', 'input', () => {
  const d = (Number($('shift-actual').value) || 0) - closeExpected;
  const el = $('shift-diff');
  el.textContent = 'Farq: ' + (d > 0 ? '+' : '') + fmt(d) + (d === 0 ? " ✅ TO'G'RI" : d < 0 ? ' ⚠️ KAM' : ' ➕ ORTIQCHA');
  el.className = d === 0 ? 'ok' : 'err';
});
on('btn-shift-cancel', 'click', () => {
  $('shift-close-overlay').style.display = 'none';
  if (session && session.mustCloseOld) { session = null; $('login-overlay').style.display = 'flex'; loadLoginUsers(); }
});
on('btn-shift-close', 'click', async () => {
  const r = await window.api.closeShift(session.shift.id, $('shift-actual').value, $('shift-note').value);
  if (!r.ok) { $('shift-close-msg').textContent = '⚠️ ' + r.error; return; }
  const mustReopen = session.mustCloseOld;
  alert('✅ Smena yopildi. Kutilgan: ' + fmt(r.expected) + ' | Farq: ' + (r.diff >= 0 ? '+' : '') + fmt(r.diff));
  $('shift-close-overlay').style.display = 'none';
  session.shift = null; session.mustCloseOld = false;
  if (mustReopen) { $('shift-open-user').textContent = session.user.full_name; $('shift-open-overlay').style.display = 'flex'; }
  else { session = null; $('login-overlay').style.display = 'flex'; loadLoginUsers(); }
});
function enterApp() {
  $('shift-open-overlay').style.display = 'none';
  $('sb-branch').textContent = session.user.branch_name || 'Filial-1';
  const av = $('top-avatar'); const img = LS.get('avatar_' + session.user.id, null);
  av.innerHTML = img ? '<img src="' + img + '">' : (session.user.full_name || 'U').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
  updateTopbar(); applyRole(); applyPayButtons(); applyKassa(); reloadAll(); switchPage((ROLE_PAGES[session.user.role] || ['home'])[0]);
}
function updateTopbar() { $('tb-shift').textContent = session.shift ? '🔄 Smena #' + session.shift.id : '⚠️ Smena yo\'q'; }
on('btn-logout', 'click', () => { session = null; endOfDayShown = false; $('login-overlay').style.display = 'flex'; loadLoginUsers(); });
on('btn-lock', 'click', () => { session = null; endOfDayShown = false; $('login-overlay').style.display = 'flex'; loadLoginUsers(); });
on('top-avatar', 'click', () => switchPage('profile'));

function applyPayButtons() {
  const en = LS.get('pay_enabled', { naqd: true, karta: true, nasiya: true });
  $('btn-pay-cash').style.display = en.naqd ? '' : 'none';
  $('btn-pay-card').style.display = en.karta ? '' : 'none';
  $('btn-pay-nasiya').style.display = en.nasiya ? '' : 'none';
  const cnt = [en.naqd, en.karta, en.nasiya].filter(Boolean).length;
  $('btn-pay-mixed').style.display = cnt >= 2 ? '' : 'none';
}
function applyKassa() {
  const k = LS.get('kassa', { grid: true, scan: true, autoclear: true, defaultpay: 'naqd' });
  $('pos-grid-card').style.display = k.grid ? '' : 'none';
}

function cartTotal() { return cart.reduce((s, i) => s + i.quantity * i.unit_price, 0); }
function renderCart() {
  $('cart-body').innerHTML = cart.map((it, i) => `<tr><td>${i + 1}</td><td>${it.name}</td><td>${fmt(it.unit_price)}</td><td><button class="btn ghost sm" data-act="dec" data-id="${it.product_id}">−</button> ${it.quantity} <button class="btn ghost sm" data-act="inc" data-id="${it.product_id}">+</button></td><td>${fmt(it.quantity * it.unit_price)}</td><td><button class="btn red sm" data-act="rm" data-id="${it.product_id}">🗑</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Savat bo\'sh</td></tr>';
  $('cart-total').textContent = fmt(cartTotal());
  $('cart-count').textContent = cart.reduce((s, i) => s + i.quantity, 0);
  $('cash-received').value = cartTotal() || '';
  updateChange();
}
function updateChange() {
  const c = (Number($('cash-received').value) || 0) - cartTotal();
  const el = $('cash-change');
  el.textContent = c >= 0 ? 'Qaytim: ' + fmt(c) : 'Yetmaydi: ' + fmt(-c);
  el.className = c >= 0 ? 'ok' : 'err';
}
on('cash-received', 'input', updateChange);
function addToCart(id) {
  const p = productsCache.find(x => x.id === id); if (!p) return;
  const it = cart.find(x => x.product_id === id);
  if (it) it.quantity++; else cart.push({ product_id: p.id, name: p.name, unit_price: Number(p.sale_price), quantity: 1, stock: Number(p.stock) });
  renderCart();
}
on('cart-body', 'click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const it = cart.find(x => x.product_id === Number(b.dataset.id));
  if (b.dataset.act === 'inc' && it) it.quantity++;
  if (b.dataset.act === 'dec' && it) { it.quantity--; if (it.quantity <= 0) cart = cart.filter(x => x !== it); }
  if (b.dataset.act === 'rm' && it) cart = cart.filter(x => x !== it);
  renderCart();
});
function renderProdGrid() {
  $('prod-grid').innerHTML = productsCache.map(p => { const im = prodImg(p); return `<div class="p-tile" data-id="${p.id}">${im ? `<img src="${im}">` : '<img src="" style="opacity:.12">'}<div class="pn">${p.name}</div><div class="pp">${fmt(p.sale_price)}</div></div>`; }).join('');
}
on('prod-grid', 'click', e => { const t = e.target.closest('.p-tile'); if (t) addToCart(Number(t.dataset.id)); });
on('pos-search', 'keydown', e => {
  if (e.key !== 'Enter') return; e.preventDefault();
  const q = $('pos-search').value.trim().toLowerCase(); if (!q) return;
  const p = productsCache.find(p => (p.barcode || '').toLowerCase() === q) || productsCache.find(p => p.name.toLowerCase().includes(q));
  if (p) { addToCart(p.id); $('pos-search').value = ''; }
});
async function doSale(type) {
  const pm = $('pos-msg');
  if (!session || !session.shift) { pm.textContent = '⚠️ Smena oching'; return; }
  if (!cart.length) { pm.textContent = "⚠️ Savat bo'sh"; return; }
  const total = cartTotal(), rec = Number($('cash-received').value) || 0;
  if (type === 'naqd' && rec < total) { pm.textContent = '⚠️ Pul yetarli emas'; return; }
  const r = await window.api.createSale({ items: cart.map(i => ({ product_id: i.product_id, quantity: i.quantity })), type, received: rec, cashier_id: session.user.id, cashier_name: session.user.full_name, shift_id: session.shift.id });
  if (!r.ok) { pm.textContent = '⚠️ ' + r.error; return; }
  pm.textContent = '✅ Chek №' + r.sale_number;
  cart = []; renderCart(); await reloadAll();
}
on('btn-pay-cash', 'click', () => doSale('naqd'));
on('btn-pay-card', 'click', () => doSale('karta'));
on('btn-clear-cart', 'click', async () => {
  if (!cart.length) { $('pos-msg').textContent = "Savat bo'sh"; return; }
  const ok = await confirmModal('Sotuv bekor qilinsinmi? Savat tozalanadi.');
  if (!ok) return;
  cart = []; renderCart(); $('pos-msg').textContent = '❌ Sotuv bekor qilindi';
});

function mixCash() { return Number($('mix-cash').value) || 0; }
function mixCard() { return Number($('mix-card').value) || 0; }
function mixDebt() { return Number($('mix-debt').value) || 0; }
function mixPaid() { return mixCash() + mixCard() + mixDebt(); }
function updateMixedBox() {
  const total = cartTotal(), paid = mixPaid(), left = total - paid;
  $('mix-total').textContent = fmt(total);
  $('mix-paid').textContent = fmt(paid) + " so'm";
  const el = $('mix-left');
  if (left > 0) { el.textContent = fmt(left) + " so'm qoldi"; el.className = 'err'; }
  else if (left < 0) { el.textContent = fmt(Math.abs(left)) + " so'm ortiqcha"; el.className = 'err'; }
  else { el.textContent = "To'liq"; el.className = 'ok'; }
  $('mix-customer-box').style.display = mixDebt() > 0 ? 'block' : 'none';
}
function clearMixed() {
  mixedCustomerId = null;
  $('mix-cash').value = 0; $('mix-card').value = 0; $('mix-debt').value = 0;
  ['mix-cust-search','mix-first','mix-last','mix-phone'].forEach(id => $(id).value = '');
  $('mix-cust-suggest').style.display = 'none'; $('mix-cust-selected').style.display = 'none'; $('mix-msg').textContent = '';
  updateMixedBox();
}
on('btn-pay-mixed', 'click', () => {
  const pm = $('pos-msg');
  if (!session || !session.shift) { pm.textContent = '⚠️ Smena oching'; return; }
  if (!cart.length) { pm.textContent = "⚠️ Savat bo'sh"; return; }
  clearMixed(); $('mix-cash').value = cartTotal(); updateMixedBox();
  $('mixed-overlay').style.display = 'flex'; setTimeout(() => $('mix-cash').focus(), 50);
});
['mix-cash','mix-card','mix-debt'].forEach(id => on(id, 'input', updateMixedBox));
on('btn-mix-cancel', 'click', () => { $('mixed-overlay').style.display = 'none'; });
on('mix-cust-search', 'input', async () => {
  const q = $('mix-cust-search').value.trim().toLowerCase(); const sug = $('mix-cust-suggest');
  if (!q) { sug.style.display = 'none'; return; }
  const cs = await window.api.getCustomers();
  const qd = q.replace(/\D/g, '');
  const list = cs.filter(c => String(c.name || '').toLowerCase().includes(q) || (qd && String(c.phone || '').replace(/\D/g, '').includes(qd)));
  sug.innerHTML = list.slice(0, 8).map(c => `<div class="nav-item" data-mix-cid="${c.id}" style="color:inherit">${c.name} ${c.phone ? '— ' + c.phone : ''}</div>`).join('');
  sug.style.display = list.length ? 'block' : 'none';
});
on('mix-cust-suggest', 'click', async e => {
  const row = e.target.closest('[data-mix-cid]'); if (!row) return;
  const cs = await window.api.getCustomers(); const c = cs.find(x => x.id === Number(row.dataset.mixCid)); if (!c) return;
  mixedCustomerId = c.id;
  const parts = String(c.name || '').split(' ');
  $('mix-first').value = parts[0] || ''; $('mix-last').value = parts.slice(1).join(' ') || ''; $('mix-phone').value = c.phone || '';
  $('mix-cust-selected').style.display = 'block'; $('mix-cust-selected').textContent = '✅ ' + c.name;
  $('mix-cust-suggest').style.display = 'none'; $('mix-cust-search').value = '';
});
async function ensureMixedCustomer() {
  if (mixDebt() <= 0) return null;
  if (mixedCustomerId) return mixedCustomerId;
  const first = $('mix-first').value.trim(), last = $('mix-last').value.trim(), phone = phoneVal($('mix-phone'));
  const full = (first + ' ' + last).trim();
  if (full.length < 2) return { error: 'Nasiya uchun mijoz ismi kerak' };
  const cs = await window.api.getCustomers();
  const pd = phone.replace(/\D/g, '');
  const ex = cs.find(c => String(c.name || '').toLowerCase() === full.toLowerCase() || (pd && String(c.phone || '').replace(/\D/g, '') === pd));
  if (ex) { mixedCustomerId = ex.id; return ex.id; }
  const r = await window.api.addCustomer({ name: full, phone });
  if (!r.ok) return { error: r.error };
  mixedCustomerId = r.id; return r.id;
}
on('btn-mix-confirm', 'click', async () => {
  const m = $('mix-msg');
  if (!session || !session.shift) { m.textContent = '⚠️ Smena oching'; return; }
  if (!cart.length) { m.textContent = "⚠️ Savat bo'sh"; return; }
  const total = cartTotal(), paid = mixPaid();
  if (paid !== total) { m.textContent = '⚠️ To\'lovlar jami ' + fmt(paid) + ', chek ' + fmt(total) + '. Teng bo\'lsin'; return; }
  const payments = [];
  if (mixCash() > 0) payments.push({ payment_type: 'naqd', amount: mixCash() });
  if (mixCard() > 0) payments.push({ payment_type: 'karta', amount: mixCard() });
  if (mixDebt() > 0) payments.push({ payment_type: 'nasiya', amount: mixDebt() });
  const cust = await ensureMixedCustomer();
  if (cust && cust.error) { m.textContent = '⚠️ ' + cust.error; return; }
  const res = await window.api.createSale({ items: cart.map(i => ({ product_id: i.product_id, quantity: i.quantity })), payments, customer_id: mixDebt() > 0 ? cust : null, cashier_id: session.user.id, cashier_name: session.user.full_name, shift_id: session.shift.id });
  if (!res.ok) { m.textContent = '⚠️ ' + res.error; return; }
  $('mixed-overlay').style.display = 'none';
  $('pos-msg').textContent = '✅ Aralash — Chek №' + res.sale_number;
  cart = []; renderCart(); await reloadAll();
});

on('btn-pay-nasiya', 'click', async () => {
  const pm = $('pos-msg');
  if (!session || !session.shift) { pm.textContent = '⚠️ Smena oching'; return; }
  if (!cart.length) { pm.textContent = "⚠️ Savat bo'sh"; return; }
  selectedCustomerId = null; $('no-total').textContent = fmt(cartTotal());
  ['no-search','no-first','no-last','no-phone'].forEach(id => $(id).value = '');
  $('no-suggest').style.display = 'none'; $('no-selected').style.display = 'none'; $('no-msg').textContent = '';
  $('nasiya-overlay').style.display = 'flex'; setTimeout(() => $('no-search').focus(), 50);
});
function fillCustomer(c) {
  selectedCustomerId = c.id;
  const [f, ...r] = String(c.name || '').split(' ');
  $('no-first').value = f || ''; $('no-last').value = r.join(' ') || ''; $('no-phone').value = c.phone || '';
  $('no-selected').style.display = 'block'; $('no-selected').textContent = '✅ ' + c.name;
  $('no-suggest').style.display = 'none'; $('no-search').value = '';
}
on('no-search', 'input', async () => {
  const q = $('no-search').value.trim().toLowerCase(); const s = $('no-suggest');
  if (!q) { s.style.display = 'none'; return; }
  const cs = await window.api.getCustomers();
  const l = cs.filter(c => String(c.name || '').toLowerCase().includes(q));
  s.innerHTML = l.slice(0, 8).map(c => `<div class="nav-item" data-cid="${c.id}" style="color:inherit">${c.name}</div>`).join('');
  s.style.display = l.length ? 'block' : 'none';
});
on('no-suggest', 'click', async e => {
  const d = e.target.closest('[data-cid]'); if (!d) return;
  const cs = await window.api.getCustomers(); const c = cs.find(x => x.id === Number(d.dataset.cid)); if (c) fillCustomer(c);
});
on('btn-nasiya-cancel', 'click', () => { $('nasiya-overlay').style.display = 'none'; });
on('btn-nasiya-confirm', 'click', async () => {
  if (nasiyaBusy) return; nasiyaBusy = true;
  try {
    const m = $('no-msg');
    const f = $('no-first').value.trim(), l = $('no-last').value.trim(), ph = phoneVal($('no-phone'));
    const q = $('no-search').value.trim();
    let full = (f + ' ' + l).trim(); if (!full && q) full = q;
    if (full.length < 2) { m.textContent = '⚠️ Ism kiriting'; return; }
    let cid = selectedCustomerId;
    if (!cid) {
      const cs = await window.api.getCustomers(); const pd = ph.replace(/\D/g, '');
      const mt = cs.find(c => String(c.name || '').toLowerCase() === full.toLowerCase() || (pd && String(c.phone || '').replace(/\D/g, '') === pd));
      if (mt) cid = mt.id;
    }
    if (!cid) { const r = await window.api.addCustomer({ name: full, phone: ph }); if (!r.ok) { m.textContent = '⚠️ ' + r.error; return; } cid = r.id; }
    const res = await window.api.createSale({ items: cart.map(i => ({ product_id: i.product_id, quantity: i.quantity })), type: 'nasiya', customer_id: cid, cashier_id: session.user.id, cashier_name: session.user.full_name, shift_id: session.shift.id });
    if (!res.ok) { m.textContent = '⚠️ ' + res.error; return; }
    $('nasiya-overlay').style.display = 'none';
    $('pos-msg').textContent = '📒 Nasiya — Chek №' + res.sale_number;
    cart = []; renderCart(); await reloadAll();
  } finally { nasiyaBusy = false; }
});
async function loadNasiya() {
  const d = await window.api.getOpenDebts();
  $('nas-total').textContent = fmt(d.reduce((s, x) => s + Number(x.amount), 0));
  $('nas-count').textContent = d.length;
  $('nas-body').innerHTML = d.map(x => `<tr><td>${x.customer_name}</td><td class="err">${fmt(x.amount)}</td><td>${String(x.created_at).slice(0, 16).replace('T', ' ')}</td><td class="err">🔴</td><td><button class="btn ghost sm" data-eye="${x.sale_id}">👁</button> <button class="btn green sm" data-settle="${x.id}">✅</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Yo\'q</td></tr>';
}
on('nas-body', 'click', async e => {
  const eye = e.target.closest('[data-eye]');
  if (eye) { showSaleReceipt(Number(eye.dataset.eye), true); return; }
  const s = e.target.closest('[data-settle]');
  if (s) {
    const ok = await confirmModal("To'landi deb belgilansinmi?"); if (!ok) return;
    const r = await window.api.settleDebt(Number(s.dataset.settle), session && session.shift ? session.shift.id : null, session ? session.user.full_name : null);
    if (!r.ok) alert('⚠️ ' + r.error); else reloadAll();
  }
});

function buildReceipt(sale, items, isNasiya, payments) {
  const rc = LS.get('receipt', { head: storeName(), foot: 'Rahmat!', width: '58', store: true, branch: true, phone: true, email: false, hours: false, logo: false, qr: false, footer: true });
  const labels = { naqd: 'Naqd', karta: 'Karta', nasiya: 'Nasiya' };
  let t = '';
  if (rc.logo) t += '[LOGO]\n';
  if (rc.store) t += (rc.head || storeName()) + '\n';
  if (rc.branch) t += 'Filial: ' + (session ? (session.user.branch_name || '') : '') + '\n';
  if (rc.phone) t += 'Tel: ' + (LS.get('store_phone', '') || '') + '\n';
  if (rc.email) t += 'Email: ' + (LS.get('store_email', '') || '') + '\n';
  if (rc.hours) t += 'Ish vaqti: ' + (LS.get('store_hours', '') || '') + '\n';
  t += 'Chek №' + sale.sale_number + '  ' + sale.created_at + '\nKassir: ' + (sale.cashier_name || '') + '\n-----------------------------\n';
  if (items && items.length) {
    items.forEach(i => {
      const name = i.product_name || 'Mahsulot';
      const qty = Number(i.quantity) || 0;
      t += name + '\n';
      if (i.unit_price != null && i.total_price != null) t += '  ' + qty + ' x ' + fmt(i.unit_price) + ' = ' + fmt(i.total_price) + '\n';
      else t += '  Miqdor: ' + qty + ' dona\n';
    });
  } else t += '(Mahsulot ma\'lumoti topilmadi)\n';
  t += '-----------------------------\n';
  if (items && items.length) t += 'Mahsulotlar: ' + items.reduce((s, i) => s + (Number(i.quantity) || 0), 0) + ' dona\n';
  t += 'JAMI: ' + fmt(sale.total) + " so'm\n";
  if (payments && payments.length) t += "To'lov: " + payments.map(p => (labels[p.payment_type] || p.payment_type) + ': ' + fmt(p.amount)).join(' + ') + '\n';
  if (isNasiya) t += 'HOLAT: 🔴 TO\'LANMAGAN (NASIYA)\n';
  if (sale.customer_name) t += 'Mijoz: ' + sale.customer_name + '\n';
  if (rc.footer) t += (rc.foot || '') + '\n';
  if (rc.qr) t += '[QR]\n';
  return t;
}
async function showSaleReceipt(saleId, isNasiya) {
  const d = await window.api.getSale(saleId); if (!d) return;
  let t = buildReceipt(d.sale, d.items, isNasiya, d.payments);
  if (isNasiya) {
    const cs = await window.api.getCustomers();
    const c = cs.find(x => x.id === d.sale.customer_id);
    if (c) t = '📒 NASIYA\nMijoz: ' + c.name + (c.phone ? ' (' + c.phone + ')' : '') + '\n' + t;
  }
  $('receipt-pre').textContent = t;
  $('receipt-overlay').style.display = 'flex';
}
on('btn-receipt-close', 'click', () => { $('receipt-overlay').style.display = 'none'; });

async function loadHome() {
  const today = await window.api.getReport({ period: 'today' });
  const week = await window.api.getReport({ period: '7d' });
  const yest = await window.api.getReport({ period: 'yesterday' });
  $('k-today').textContent = fmt(today.revenue);
  $('k-checks').textContent = today.checks;
  $('k-profit').textContent = fmt(today.profit);
  $('k-avg').textContent = fmt(today.checks ? Math.round(today.revenue / today.checks) : 0);
  const a = Number(today.revenue) || 0, b = Number(yest.revenue) || 0;
  const p = b ? Math.round((a - b) / b * 100) : (a ? 100 : 0);
  const t = $('k-today-t');
  t.textContent = (p >= 0 ? '↑ +' : '↓ ') + p + '% (kechaga nisbatan)';
  t.className = 'trend ' + (p >= 0 ? 'up' : 'dn');
  drawLine($('home-chart'), week.series || [], $('home-tip'));
  const payPeriod = $('home-pay-period')?.value || '7d';
  const payReport = await window.api.getReport({ period: payPeriod });
  drawDonut($('home-donut'), payReport.payments || []);
  $('home-top').innerHTML = (week.top || []).slice(0, 5).map((x, i) => `<div class="row" style="justify-content:space-between;padding:3px 0"><span>${i + 1}. ${x.product_name}</span><b>${x.qty} dona</b></div>`).join('') || '<span class="muted">Yo\'q</span>';
  const st = await window.api.getStock(); const low = st.filter(s => s.is_low);
  const la = LS.get('stock', { defaultmin: 5, lowalert: true, negstock: false }).lowalert;
  $('nav-low').style.display = (la && low.length) ? '' : 'none'; $('nav-low').textContent = low.length;
  $('home-low').innerHTML = low.slice(0, 6).map(s => `<div class="row" style="justify-content:space-between;padding:3px 0"><span>${s.name}</span><span class="err">${s.stock}/${s.min_stock}</span></div>`).join('') || '<span class="muted">Hammasi yetarli</span>';
}
on('home-pay-period', 'change', async () => {
  const period = $('home-pay-period').value;
  const r = await window.api.getReport({ period });
  drawDonut($('home-donut'), r.payments || []);
});

async function periodRange() { return await window.api.getReport({ period: repPeriod, from: $('rep-from').value, to: $('rep-to').value }); }
async function loadReport() {
  const r = await periodRange();
  $('r-rev').textContent = fmt(r.revenue); $('r-prof').textContent = fmt(r.profit); $('r-checks').textContent = r.checks; $('r-ret').textContent = r.returns.count;
  drawLine($('rep-chart'), r.series || [], $('rep-tip'));
  renderRepTab(r);
}
async function renderRepTab(r) {
  r = r || await periodRange();
  const area = $('rep-table-area');
  const sales = await window.api.getSales();
  const inSales = sales.filter(s => String(s.created_at).slice(0, 10) >= r.from && String(s.created_at).slice(0, 10) <= r.to);
  const agg = {}; const soldIds = new Set();
  for (const s of inSales) {
    const d = await window.api.getSale(s.id);
    (d.items || []).forEach(i => {
      soldIds.add(i.product_id);
      const a = agg[i.product_id] = agg[i.product_id] || { name: i.product_name, qty: 0, sum: 0, profit: 0 };
      a.qty += i.quantity; a.sum += i.total_price; a.profit += i.total_price - (i.cost_snapshot || 0) * i.quantity;
    });
  }
  if (repTab === 'sold') area.innerHTML = '<table><thead><tr><th>Mahsulot</th><th>Soni</th><th>Mablag\'</th><th>Foyda</th></tr></thead><tbody>' + Object.values(agg).sort((a, b) => b.sum - a.sum).map(a => `<tr><td>${a.name}</td><td>${a.qty}</td><td>${fmt(a.sum)}</td><td class="ok">${fmt(a.profit)}</td></tr>`).join('') + '</tbody></table>';
  else if (repTab === 'unsold') { const uns = productsCache.filter(p => Number(p.stock) > 0 && !soldIds.has(p.id)); area.innerHTML = '<table><thead><tr><th>Mahsulot</th><th>Qoldiq</th><th>Tannarx jami</th><th>Sotilsa foyda</th></tr></thead><tbody>' + uns.map(p => `<tr><td>${p.name}</td><td>${p.stock}</td><td>${fmt(p.stock * p.cost_price)}</td><td class="ok">${fmt(p.stock * (p.sale_price - p.cost_price))}</td></tr>`).join('') + '</tbody></table>'; }
  else if (repTab === 'low') { const low = stockCache.filter(s => s.is_low); area.innerHTML = '<table><thead><tr><th>Mahsulot</th><th>Qoldiq</th><th>Minimal</th><th>Yetishmaydi</th></tr></thead><tbody>' + low.map(s => `<tr><td>${s.name}</td><td>${s.stock}</td><td>${s.min_stock}</td><td class="err">${Math.max(0, s.min_stock - s.stock)}</td></tr>`).join('') + '</tbody></table>'; }
  else if (repTab === 'pay') area.innerHTML = '<table><thead><tr><th>Tur</th><th>Summa</th></tr></thead><tbody>' + (r.payments || []).map(p => `<tr><td>${p.payment_type}</td><td>${fmt(p.sum)}</td></tr>`).join('') + '</tbody></table>';
  else if (repTab === 'cash') area.innerHTML = '<table><thead><tr><th>Kassir</th><th>Cheklar</th><th>Summa</th></tr></thead><tbody>' + (r.cashiers || []).map(c => `<tr><td>${c.cashier_name || '—'}</td><td>${c.checks}</td><td>${fmt(c.sum)}</td></tr>`).join('') + '</tbody></table>';
  else if (repTab === 'shift') { const sh = await window.api.getShifts(); area.innerHTML = '<table><thead><tr><th>№</th><th>Kassir</th><th>Ochilgan</th><th>Yopilgan</th><th>Kutilgan</th><th>Real</th><th>Farq</th></tr></thead><tbody>' + sh.map(s => `<tr><td>${s.id}</td><td>${s.user_name || ''}</td><td>${s.opened_at}</td><td>${s.closed_at || '🟢'}</td><td>${s.expected_cash != null ? fmt(s.expected_cash) : '—'}</td><td>${s.actual_cash != null ? fmt(s.actual_cash) : '—'}</td><td class="${s.cash_diff == 0 ? 'ok' : 'err'}">${s.cash_diff == null ? '—' : s.cash_diff}</td></tr>`).join('') + '</tbody></table>'; }
  else if (repTab === 'audit') { const a = await window.api.auditList(); area.innerHTML = '<table><thead><tr><th>Vaqt</th><th>Kim</th><th>Amal</th><th>Tafsilot</th></tr></thead><tbody>' + a.map(x => `<tr><td>${x.created_at}</td><td>${x.username}</td><td>${x.action}</td><td>${x.detail}</td></tr>`).join('') + '</tbody></table>'; }
}
document.querySelectorAll('.rep-btn').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.rep-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); repPeriod = b.dataset.period; loadReport(); }));
document.querySelectorAll('.rt-btn').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.rt-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); repTab = b.dataset.rt; renderRepTab(); }));
on('btn-rep-custom', 'click', () => { repPeriod = 'custom'; loadReport(); });
on('btn-print', 'click', async () => {
  const r = await periodRange();
  const w = window.open('', '_blank');
  w.document.write('<html><head><title>Hisobot</title><style>body{font-family:Segoe UI,Arial;padding:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px;font-size:12px;text-align:left}h1{font-size:18px}</style></head><body><h1>' + storeName() + ' — Hisobot (' + r.from + ' → ' + r.to + ')</h1><p>Savdo: ' + fmt(r.revenue) + ' | Foyda: ' + fmt(r.profit) + ' | Cheklar: ' + r.checks + '</p>' + $('rep-table-area').innerHTML + '</body></html>');
  w.document.close(); w.focus(); w.print();
});

async function loadSales() {
  const sales = await window.api.getSales();
  const paymentLabels = { naqd: '💵 Naqd', karta: '💳 Karta', nasiya: '📒 Nasiya' };
  $('sales-body').innerHTML = sales.map(x => {
    const count = Number(x.items_count) || 0;
    let payment = '💵 Naqd';
    if (x.payment_types) {
      const types = x.payment_types.split(',').map(v => v.trim()).filter(Boolean);
      if (types.length > 1) payment = '🧩 Aralash';
      else payment = paymentLabels[types[0]] || types[0];
    }
    return `<tr>
      <td>№${x.sale_number}</td>
      <td>${String(x.created_at).slice(0, 19).replace('T', ' ')}</td>
      <td>${x.cashier_name || '—'}</td>
      <td><b>${count}</b> ta</td>
      <td>${fmt(x.total)} so'm</td>
      <td>${payment}</td>
      <td>
        <button class="btn ghost sm" title="Nima olganini ko'rish" data-sale="${x.id}">👁</button>
        <button class="btn amber sm" title="Qaytarish" data-ret="${x.id}">↩️</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">Sotuvlar mavjud emas</td></tr>';
}
on('sales-body', 'click', async e => {
  const v = e.target.closest('[data-sale]');
  if (v) { showSaleReceipt(Number(v.dataset.sale), false); return; }
  const rb = e.target.closest('[data-ret]'); if (rb) openReturn(Number(rb.dataset.ret));
});
async function openReturn(id) {
  const d = await window.api.getReturnable(id); if (!d) return;
  if (!d.items.some(i => i.max > 0)) { alert('Qaytarish qolmagan'); return; }
  returnState = d; $('ret-sale-number').textContent = d.sale.sale_number; $('ret-reason').value = '';
  $('ret-items-body').innerHTML = d.items.map(i => `<tr><td>${i.product_name}</td><td>${i.sold}</td><td>${i.returned}</td><td><input type="number" class="ret-qty" data-id="${i.product_id}" data-price="${i.unit_price}" min="0" max="${i.max}" value="0" ${i.max === 0 ? 'disabled' : ''} style="width:80px"></td></tr>`).join('');
  updateRet(); $('return-panel').style.display = 'block';
}
function updateRet() { let t = 0; document.querySelectorAll('.ret-qty').forEach(i => t += Math.max(0, Number(i.value) || 0) * Number(i.dataset.price)); $('ret-total').textContent = 'JAMI: ' + fmt(t); }
on('ret-items-body', 'input', updateRet);
on('btn-ret-close', 'click', () => { returnState = null; $('return-panel').style.display = 'none'; });
on('btn-ret-confirm', 'click', async () => {
  if (!returnState) return;
  const items = []; document.querySelectorAll('.ret-qty').forEach(i => { const q = Number(i.value) || 0; if (q > 0) items.push({ product_id: Number(i.dataset.id), quantity: q }); });
  const r = await window.api.createReturn({ sale_id: returnState.sale.id, items, reason: $('ret-reason').value });
  if (!r.ok) { $('ret-msg').textContent = '⚠️ ' + r.error; return; }
  returnState = null; $('return-panel').style.display = 'none'; reloadAll();
});
async function loadReturns() {
  const r = await window.api.getReturns();
  $('returns-body').innerHTML = r.map(x => `<tr><td>№${x.return_number}</td><td>${x.created_at}</td><td>№${x.sale_number}</td><td>${fmt(x.total)}</td><td>${x.reason || ''}</td><td><button class="btn ghost sm" data-retview="${x.id}">👁</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Yo\'q</td></tr>';
}
on('returns-body', 'click', async e => {
  const b = e.target.closest('[data-retview]'); if (!b) return;
  const d = await window.api.getReturn(Number(b.dataset.retview)); if (!d) return;
  let t = 'QAYTARISH №' + d.ret.return_number + '\n--------------\n';
  d.items.forEach(i => { t += i.product_name + ' ' + i.quantity + 'x' + fmt(i.unit_price) + '\n'; });
  t += '--------------\nJAMI: ' + fmt(d.ret.total) + '\n';
  $('receipt-pre').textContent = t; $('receipt-overlay').style.display = 'flex';
});

// ---------- KATEGORIYALAR ----------
function ensureCatsCard() {
  if ($('cats-card')) return;
  const card = document.createElement('div');
  card.className = 'card'; card.id = 'cats-card';
  card.innerHTML = `<h3>🏷️ Kategoriyalar (nomini bosing — mahsulotlari ko'rinadi)</h3>
    <div class="row"><input id="cat-new" placeholder="Yangi kategoriya nomi" style="max-width:260px"><button class="btn primary" id="cat-add">➕ Qo'shish</button></div>
    <table style="margin-top:10px"><thead><tr><th>Kategoriya</th><th>Mahsulotlar soni</th></tr></thead><tbody id="cats-body"></tbody></table>`;
  const pp = $('product-panel');
  if (pp && pp.parentNode) pp.parentNode.insertBefore(card, pp.nextSibling);
  on('cat-add', 'click', async () => {
    const n = $('cat-new').value.trim(); if (!n) return;
    const r = await window.api.addCategory(n);
    if (!r.ok) { alert('⚠️ ' + r.error); return; }
    $('cat-new').value = '';
    await loadCategories(); await loadCategoriesTable();
  });
  on('cats-body', 'click', e => {
    const a = e.target.closest('[data-cat]'); if (!a) return;
    showCatProducts(Number(a.dataset.cat), a.textContent);
  });
}
async function loadCategoriesTable() {
  ensureCatsCard();
  const c = await window.api.getCategories();
  $('cats-body').innerHTML = c.map(x => `<tr><td><a style="color:var(--accent);cursor:pointer;font-weight:600" data-cat="${x.id}">${x.name}</a></td><td>${x.product_count}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Yo\'q</td></tr>';
}
function showCatProducts(catId, catName) {
  const list = productsCache.filter(p => p.category_id === catId);
  let t = '🏷️ KATEGORIYA: ' + catName + '\nMahsulotlar soni: ' + list.length + '\n-----------------------------\n';
  if (list.length) list.forEach((p, i) => { t += (i + 1) + '. ' + p.name + '\n   Sotish: ' + fmt(p.sale_price) + " so'm | Qoldiq: " + p.stock + ' dona\n'; });
  else t += "(Bu kategoriyada mahsulot yo'q)\n";
  $('receipt-pre').textContent = t;
  $('receipt-overlay').style.display = 'flex';
}
on('f-img-pick', 'click', () => $('f-img-file').click());
on('f-img-file', 'change', e => { const f = e.target.files[0]; if (!f) return; readImage(f, d => { pendingImage = d; $('f-img-prev').src = d; $('f-img-url').value = ''; }); });
async function loadProducts() {
  productsCache = await window.api.getProducts();
  $('products-body').innerHTML = productsCache.map(p => { const im = prodImg(p); return `<tr><td>${im ? `<img class="thumb" src="${im}">` : ''}</td><td>${p.name}</td><td>${p.barcode || '—'}</td><td>${fmt(p.sale_price)}</td><td>${p.stock}</td><td><button class="btn ghost sm" data-id="${p.id}">✏️</button></td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">Mahsulot yo\'q</td></tr>';
  $('pi-product').innerHTML = productsCache.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  renderProdGrid();
  await loadCategoriesTable();
}
on('products-body', 'click', e => {
  const b = e.target.closest('[data-id]'); if (!b) return;
  const p = productsCache.find(x => x.id === Number(b.dataset.id)); if (!p) return;
  editingId = p.id; pendingImage = prodImg(p);
  $('f-name').value = p.name; $('f-barcode').value = p.barcode || ''; $('f-cost').value = p.cost_price; $('f-sale').value = p.sale_price; $('f-stock').value = p.stock; $('f-min').value = p.min_stock;
  $('f-img-url').value = p.image_url || ''; if (pendingImage) $('f-img-prev').src = pendingImage;
  $('form-cancel').style.display = ''; $('form-title').textContent = '✏️ ' + p.name;
});
on('form-cancel', 'click', () => { editingId = null; pendingImage = null; ['f-name','f-barcode','f-cost','f-sale','f-stock','f-min','f-img-url'].forEach(id => $(id).value = ''); $('form-cancel').style.display = 'none'; $('form-title').textContent = '➕ Yangi mahsulot'; });
on('form-submit', 'click', async () => {
  const defMin = LS.get('stock', { defaultmin: 5 }).defaultmin;
  const data = { name: $('f-name').value, barcode: $('f-barcode').value, category_id: Number($('f-category').value) || null, cost_price: Number($('f-cost').value) || 0, sale_price: Number($('f-sale').value) || 0, stock: Number($('f-stock').value) || 0, min_stock: ($('f-min').value === '' ? defMin : Number($('f-min').value)) };
  const was = editingId !== null;
  const res = was ? await window.api.updateProduct(editingId, data, session.user) : await window.api.addProduct(data);
  const m = $('msg');
  if (!res.ok) { m.textContent = '⚠️ ' + res.error; return; }
  const pid = was ? editingId : res.id;
  const url = $('f-img-url').value.trim();
  if (url) { await window.api.setProductImage(pid, url); LS.del('img_' + pid); }
  else if (pendingImage) { LS.set('img_' + pid, pendingImage); await window.api.setProductImage(pid, null); }
  m.textContent = '✅ Saqlandi';
  editingId = null; pendingImage = null;
  ['f-name','f-barcode','f-cost','f-sale','f-stock','f-min','f-img-url'].forEach(id => $(id).value = '');
  $('form-cancel').style.display = 'none'; $('form-title').textContent = '➕ Yangi mahsulot';
  reloadAll();
});
on('btn-export', 'click', () => {
  const rows = productsCache.map(p => ({ Nomi: p.name, Barcode: p.barcode || '', Kategoriya: p.category_name || '', Kelish: p.cost_price, Sotish: p.sale_price, Qoldiq: p.stock, Min: p.min_stock, Rasm: p.image_url || '' }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Mahsulotlar');
  XLSX.writeFile(wb, 'mahsulotlar.xlsx');
});
async function loadCategories() { const c = await window.api.getCategories(); $('f-category').innerHTML = c.map(x => `<option value="${x.id}">${x.name}</option>`).join(''); }

async function loadStock() {
  const s = await window.api.getInventorySummary(); stockCache = await window.api.getStock();
  $('sum-value').textContent = fmt(s.stock_value); $('sum-units').textContent = fmt(s.total_units); $('sum-low').textContent = fmt(s.low_count);
  renderStock();
  const m = await window.api.getMovements();
  $('mov-body').innerHTML = m.map(x => `<tr><td>${x.created_at}</td><td>${x.product_name}</td><td>${TYPE_LABELS[x.movement_type] || x.movement_type}</td><td class="${x.quantity >= 0 ? 'ok' : 'err'}">${x.quantity}</td><td>${x.note || ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Yo\'q</td></tr>';
}
function renderStock() {
  const rows = $('only-low').checked ? stockCache.filter(r => r.is_low) : stockCache;
  $('stock-body').innerHTML = rows.map(r => `<tr><td>${r.name}</td><td>${r.stock}</td><td>${r.min_stock}</td><td class="${r.is_low ? 'err' : 'ok'}">${r.is_low ? 'Kam' : 'OK'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Yo\'q</td></tr>';
}
on('only-low', 'change', renderStock);

on('pi-add', 'click', () => {
  const p = productsCache.find(x => x.id === Number($('pi-product').value));
  const q = Number($('pi-qty').value), c = Number($('pi-cost').value) || 0;
  if (!p || q <= 0) { $('pur-msg').textContent = '⚠️ Miqdor'; return; }
  purItems.push({ product_id: p.id, name: p.name, quantity: q, cost_price: c });
  $('pi-qty').value = ''; renderPur();
});
on('pur-items-body', 'click', e => { const b = e.target.closest('[data-idx]'); if (!b) return; purItems.splice(Number(b.dataset.idx), 1); renderPur(); });
function renderPur() {
  $('pur-items-body').innerHTML = purItems.map((it, i) => `<tr><td>${it.name}</td><td>${it.quantity}</td><td>${fmt(it.cost_price)}</td><td>${fmt(it.quantity * it.cost_price)}</td><td><button class="btn red sm" data-idx="${i}">🗑</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Yo\'q</td></tr>';
  $('pur-total').textContent = fmt(purItems.reduce((s, i) => s + i.quantity * i.cost_price, 0));
}
async function submitPur(st) {
  if (!purItems.length) { $('pur-msg').textContent = "⚠️ Qo'shing"; return; }
  const r = await window.api.createPurchase({ supplier_id: Number($('p-supplier').value) || null, doc_number: $('p-doc').value, items: purItems, status: st });
  if (!r.ok) { $('pur-msg').textContent = '⚠️ ' + r.error; return; }
  purItems = []; renderPur(); reloadAll();
}
on('btn-pur-draft', 'click', () => submitPur('draft'));
on('btn-pur-confirm', 'click', () => submitPur('confirmed'));
on('btn-add-supplier', 'click', async () => {
  const f = await showModal('🚚 Yetkazib beruvchi', [{ id:'name', label:'Nomi *' }, { id:'phone', label:'Telefon' }]);
  if (!f || !f.name.trim()) return;
  await window.api.addSupplier(f.name.trim(), (f.phone || '').trim());
  loadSuppliers();
});
async function loadSuppliers() { const s = await window.api.getSuppliers(); $('p-supplier').innerHTML = '<option value="">—</option>' + s.map(x => `<option value="${x.id}">${x.name}</option>`).join(''); }
async function loadPurchases() {
  const p = await window.api.getPurchases();
  $('pur-list-body').innerHTML = p.map(x => `<tr><td>${x.id}</td><td>${x.created_at}</td><td>${x.supplier_name || ''}</td><td>${fmt(x.total_amount)}</td><td>${x.status === 'confirmed' ? '✅' : '📝'}</td><td>${x.status === 'draft' ? `<button class="btn green sm" data-id="${x.id}">✅</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Yo\'q</td></tr>';
}
on('pur-list-body', 'click', async e => { const b = e.target.closest('[data-id]'); if (!b) return; await window.api.confirmPurchase(Number(b.dataset.id)); reloadAll(); });

function applyStaffRoles() {
  const all = ['kassir','menejer','omborchi','admin','owner'];
  const mine = (session.user.role === 'owner' || session.user.role === 'admin') ? all : ['kassir','omborchi'];
  $('st-role').innerHTML = mine.map(r => `<option value="${r}">${r}</option>`).join('');
}
on('st-save', 'click', async () => {
  const r = await window.api.addUser({ first_name: $('st-first').value, last_name: $('st-last').value, phone: phoneVal($('st-phone')), username: $('st-username').value, pin: $('st-pin').value, role: $('st-role').value }, session.user.role);
  const m = $('staff-msg');
  if (r.ok) { m.textContent = "✅ Qo'shildi"; ['st-first','st-last','st-phone','st-username','st-pin'].forEach(id => $(id).value = ''); loadStaff(); }
  else { m.textContent = '⚠️ ' + r.error; }
});
async function loadStaff() {
  const u = await window.api.getUsers();
  const can = session && (session.user.role === 'owner' || session.user.role === 'admin');
  $('staff-body').innerHTML = u.map(x => `<tr><td>${x.full_name}</td><td>${x.username}</td><td>${x.role}</td><td>${x.branch_name || ''}</td><td class="${x.active ? 'ok' : 'err'}">${x.active ? 'Faol' : 'Nofaol'}</td><td>${can ? `<button class="btn ghost sm" data-edit="${x.id}">✏️</button> <button class="btn ghost sm" data-key="${x.id}">🔑</button>` : ''}</td></tr>`).join('');
}
on('staff-body', 'click', async e => {
  const ed = e.target.closest('[data-edit]');
  if (ed) {
    const u = (await window.api.getUsers()).find(x => x.id === Number(ed.dataset.edit)); if (!u) return;
    const f = await showModal('✏️ Xodim: ' + u.full_name, [
      { id:'full_name', label:'Ism-familiya', value: u.full_name },
      { id:'phone', label:'Telefon', value: u.phone || '' },
      { id:'role', label:'Rol', type:'select', options:['kassir','menejer','omborchi','admin','owner'], value: u.role },
      { id:'active', label:'Holat', type:'select', options:['Faol','Nofaol'], value: u.active ? 'Faol' : 'Nofaol' }
    ]);
    if (!f) return;
    await window.api.staffUpdate(u.id, { full_name: f.full_name, phone: f.phone, role: f.role, active: f.active === 'Faol' }, session.user);
    loadStaff(); return;
  }
  const key = e.target.closest('[data-key]');
  if (key) {
    const f = await showModal('🔑 Parolni tiklash', [{ id:'pin', label:'Yangi parol (harf+raqam 8+)', type:'password' }]);
    if (!f || !f.pin) return;
    const r = await window.api.resetPin(Number(key.dataset.key), f.pin, session.user.role);
    alert(r.ok ? '✅' : '⚠️ ' + r.error);
  }
});

function loadProfile() {
  if (!session) return;
  $('prof-name').value = session.user.full_name || '';
  $('prof-phone').value = session.user.phone || '';
  $('prof-user').value = session.user.username || '';
  $('prof-role').value = (session.user.role || '') + ' / ' + (session.user.branch_name || '—');
  const av = $('prof-avatar'); const img = LS.get('avatar_' + session.user.id, null);
  av.innerHTML = img ? '<img src="' + img + '" style="width:100%;height:100%;object-fit:cover">' : (session.user.full_name || 'U').split(' ').map(s => s[0]).join('').slice(0, 2).toUpperCase();
}
on('prof-img-pick', 'click', () => $('prof-img-file').click());
on('prof-img-file', 'change', e => {
  const f = e.target.files[0]; if (!f || !session) return;
  readImage(f, d => { LS.set('avatar_' + session.user.id, d); loadProfile(); $('top-avatar').innerHTML = '<img src="' + d + '">'; });
});
on('prof-save', 'click', async () => {
  const r = await window.api.profileUpdate(session.user.id, { full_name: $('prof-name').value, phone: phoneVal($('prof-phone')) }, session.user);
  const m = $('prof-msg');
  if (!r.ok) { m.textContent = '⚠️ ' + r.error; return; }
  session.user.full_name = $('prof-name').value; session.user.phone = phoneVal($('prof-phone'));
  m.textContent = '✅ Saqlandi'; loadProfile();
});
on('prof-pass-save', 'click', async () => {
  const m = $('prof-pass-msg');
  if ($('prof-pass').value !== $('prof-pass2').value) { m.textContent = '⚠️ Mos emas'; return; }
  const role = (session.user.role === 'owner' || session.user.role === 'admin') ? session.user.role : 'owner';
  const r = await window.api.resetPin(session.user.id, $('prof-pass').value, role);
  if (!r.ok) { m.textContent = '⚠️ ' + r.error; return; }
  $('prof-pass').value = ''; $('prof-pass2').value = ''; m.textContent = '✅ Parol yangilandi';
});

document.querySelectorAll('#set-menu .nav-item').forEach(i => i.addEventListener('click', () => {
  document.querySelectorAll('#set-menu .nav-item').forEach(x => x.classList.toggle('active', x === i));
  document.querySelectorAll('.set-sec').forEach(s => s.classList.toggle('active', s.id === 'sec-' + i.dataset.sec));
}));
function loadSettings() {
  $('set-store').value = storeName();
  $('set-branch').value = session ? (session.user.branch_name || '') : '';
  $('set-phone').value = LS.get('store_phone', '');
  $('set-email').value = LS.get('store_email', '');
  $('set-hours').value = LS.get('store_hours', '');
  const logo = LS.get('store_logo', null); if (logo) $('set-logo-prev').src = logo;
  const rc = LS.get('receipt', { head: storeName(), foot: 'Rahmat!', width: '58', store: true, branch: true, phone: true, email: false, hours: false, logo: false, qr: false, footer: true });
  $('rc-head').value = rc.head; $('rc-foot').value = rc.foot; $('rc-width').value = rc.width;
  $('rc-store').checked = rc.store; $('rc-branch').checked = rc.branch; $('rc-phone').checked = rc.phone; $('rc-email').checked = rc.email; $('rc-hours').checked = rc.hours; $('rc-logo').checked = rc.logo; $('rc-qr').checked = rc.qr; $('rc-footer').checked = rc.footer;
  const en = LS.get('pay_enabled', { naqd: true, karta: true, nasiya: true });
  $('pay-naqd').checked = en.naqd; $('pay-karta').checked = en.karta; $('pay-nasiya').checked = en.nasiya;
  const st = LS.get('stock', { defaultmin: 5, lowalert: true, negstock: false });
  $('s-defaultmin').value = st.defaultmin; $('s-lowalert').checked = st.lowalert; $('s-negstock').checked = st.negstock;
  const k = LS.get('kassa', { grid: true, scan: true, autoclear: true, defaultpay: 'naqd' });
  $('k-grid').checked = k.grid; $('k-scan').checked = k.scan; $('k-autoclear').checked = k.autoclear; $('k-defaultpay').value = k.defaultpay;
  const sec = LS.get('security', { timeout: 30, autolock: 5 });
  $('sec-timeout').value = sec.timeout; $('sec-autolock').value = sec.autolock;
  const inf = LS.get('interface', { lang: 'uz', theme: 'light' });
  $('i-lang').value = inf.lang; $('i-theme').value = inf.theme;
  window.api.getDbInfo().then(d => { $('adv-dbpath').textContent = d.path + ' (' + (d.salesVersion || 'OLD') + ')'; });
  loadBackups(); loadAudit(); pollSync();
}
on('set-store-save', 'click', () => {
  LS.set('store_name', $('set-store').value.trim() || 'Mini Market');
  LS.set('store_phone', phoneVal($('set-phone')));
  LS.set('store_email', $('set-email').value.trim());
  LS.set('store_hours', $('set-hours').value.trim());
  applyBrand(); alert('✅ Saqlandi');
});
on('set-logo-pick', 'click', () => $('set-logo-file').click());
on('set-logo-file', 'change', e => { const f = e.target.files[0]; if (!f) return; readImage(f, d => { LS.set('store_logo', d); $('set-logo-prev').src = d; $('sb-logo').innerHTML = '<img src="' + d + '">'; }); });
on('set-receipt-save', 'click', () => {
  LS.set('receipt', { head: $('rc-head').value, foot: $('rc-foot').value, width: $('rc-width').value, store: $('rc-store').checked, branch: $('rc-branch').checked, phone: $('rc-phone').checked, email: $('rc-email').checked, hours: $('rc-hours').checked, logo: $('rc-logo').checked, qr: $('rc-qr').checked, footer: $('rc-footer').checked });
  alert('✅ Chek shabloni saqlandi');
});
['pay-naqd','pay-karta','pay-nasiya'].forEach(id => on(id, 'change', () => { LS.set('pay_enabled', { naqd: $('pay-naqd').checked, karta: $('pay-karta').checked, nasiya: $('pay-nasiya').checked }); applyPayButtons(); }));
on('set-stock-save', 'click', () => { LS.set('stock', { defaultmin: Number($('s-defaultmin').value) || 5, lowalert: $('s-lowalert').checked, negstock: $('s-negstock').checked }); alert('✅'); });
on('set-kassa-save', 'click', () => { LS.set('kassa', { grid: $('k-grid').checked, scan: $('k-scan').checked, autoclear: $('k-autoclear').checked, defaultpay: $('k-defaultpay').value }); applyKassa(); alert('✅'); });
on('set-security-save', 'click', () => { LS.set('security', { timeout: Number($('sec-timeout').value) || 30, autolock: Number($('sec-autolock').value) || 5 }); alert('✅'); });
on('sec-clear-remember', 'click', () => { LS.del('remember'); alert('✅ Eslab qolish tozalandi'); });
on('set-interface-save', 'click', () => { LS.set('interface', { lang: $('i-lang').value, theme: $('i-theme').value }); alert('✅'); });
async function loadBackups() {
  const l = await window.api.getBackups();
  $('backup-body').innerHTML = l.map(b => `<tr><td>${b.file}</td><td>${String(b.mtime).slice(0, 16).replace('T', ' ')}</td><td><button class="btn ghost sm" data-file="${b.file}">♻️</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">Yo\'q</td></tr>';
}
on('btn-backup-now', 'click', async () => { const r = await window.api.createBackup(); $('backup-msg').textContent = r.ok ? '✅ ' + r.name : '⚠️ ' + r.error; loadBackups(); });
on('backup-body', 'click', async e => {
  const b = e.target.closest('[data-file]'); if (!b) return;
  const ok = await confirmModal('Tiklansinmi? Dastur qayta ishga tushadi.'); if (!ok) return;
  const r = await window.api.restoreBackup(b.dataset.file);
  if (!r.ok) alert('⚠️ ' + r.error); else { alert('✅'); await window.api.relaunch(); }
});
async function loadAudit() {
  const can = session && (session.user.role === 'owner' || session.user.role === 'admin');
  if (!can) { $('audit-body').innerHTML = '<tr><td colspan="4" class="muted">Faqat owner/admin</td></tr>'; return; }
  const a = await window.api.auditList();
  $('audit-body').innerHTML = a.slice(0, 40).map(x => `<tr><td>${x.created_at}</td><td>${x.username}</td><td>${x.action}</td><td>${x.detail}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Yo\'q</td></tr>';
}

async function reloadAll() {
  await loadCategories();
  await loadProducts();
  await loadStock();
  await loadSuppliers();
  await loadPurchases();
  await loadSales();
  await loadReturns();
  await loadStaff();
  await loadNasiya();
  await loadHome();
  if (currentPage === 'reports') await loadReport();
}

renderCart();
renderPur();
boot();
// ---------- QADAM 17: AVTO-YANGILANISH ----------
(function () {
  const sec = $('sec-advanced');
  if (sec && !$('btn-update-check')) {
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '10px';
    row.innerHTML = '<button class="btn primary" id="btn-update-check">🔄 Yangilanishni tekshirish</button><span class="muted" id="update-ver"></span>';
    sec.appendChild(row);
    on('btn-update-check', 'click', async () => {
      const r = await window.api.updateCheck();
      $('update-ver').textContent = 'Joriy versiya: ' + (r && r.version ? r.version : '');
    });
  }
  window.api.onUpdate(d => {
    const ok = confirm('🆕 Yangi versiya mavjud: ' + d.version + '\nYuklab olish va o\'rnatishni xohlaysizmi?');
    if (ok) window.api.updateOpen(d.url);
  });
  window.api.getDbInfo().then(d => {
    const el = $('update-ver');
    if (el) el.textContent = 'Joriy versiya: ' + (d.appVersion || '');
  });
})();