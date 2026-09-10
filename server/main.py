import sqlite3, json, secrets, os
from datetime import datetime, timedelta
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(__file__))
DB = os.path.join(DATA_DIR, "cloud.db")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "")
VERSION_FILE = os.path.join(DATA_DIR, "version.json")

app = FastAPI(title="Mini Market OS Cloud")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

def conn():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c

def admin_guard(x_admin_key: Optional[str] = Header(None)):
    if ADMIN_KEY and x_admin_key != ADMIN_KEY:
        raise HTTPException(403, "Admin kalit noto'g'ri")

def init():
    os.makedirs(DATA_DIR, exist_ok=True)
    c = conn()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS stores(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS branches(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, activation_code TEXT UNIQUE, store_id INTEGER);
    CREATE TABLE IF NOT EXISTS devices(id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL, token TEXT UNIQUE, created_at TEXT DEFAULT (datetime('now')), last_seen TEXT, version TEXT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL, branch_id INTEGER NOT NULL, event_id TEXT UNIQUE, event_type TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS cloud_products(id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL, product_id INTEGER NOT NULL, name TEXT, category TEXT, price INTEGER, cost INTEGER, stock INTEGER, min INTEGER, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(branch_id, product_id));
    """)
    for sql in ["ALTER TABLE branches ADD COLUMN store_id INTEGER",
                "ALTER TABLE devices ADD COLUMN last_seen TEXT",
                "ALTER TABLE devices ADD COLUMN version TEXT"]:
        try: c.execute(sql)
        except Exception: pass
    if not c.execute("SELECT id FROM stores").fetchone():
        c.execute("INSERT INTO stores(name) VALUES(?)", ["Asosiy do'kon"])
    sid = c.execute("SELECT id FROM stores ORDER BY id LIMIT 1").fetchone()["id"]
    c.execute("UPDATE branches SET store_id=? WHERE store_id IS NULL", [sid])
    if not c.execute("SELECT id FROM branches WHERE name='Filial-1'").fetchone():
        c.execute("INSERT INTO branches(name,activation_code,store_id) VALUES('Filial-1','111111',?)", [sid])
    c.commit(); c.close()
init()

class ActivateReq(BaseModel): code: str
class EventItem(BaseModel): event_id: str; event_type: str; payload: dict
class PushReq(BaseModel): events: List[EventItem]
class NewBranchReq(BaseModel): name: str; store_id: Optional[int] = None
class RenameReq(BaseModel): name: str

def auth(token):
    if not token: raise HTTPException(401, "token yo'q")
    c = conn(); d = c.execute("SELECT branch_id FROM devices WHERE token=?", [token]).fetchone(); c.close()
    if not d: raise HTTPException(401, "token noto'g'ri")
    return d["branch_id"]

def dstr(d): return d.strftime("%Y-%m-%d")
def resolve_period(p):
    t = datetime.now()
    if p == "yesterday":
        d = t - timedelta(days=1); return dstr(d), dstr(d)
    if p == "7d": return dstr(t - timedelta(days=6)), dstr(t)
    if p == "month": return dstr(t.replace(day=1)), dstr(t)
    if p == "all": return "2000-01-01", "2099-12-31"
    return dstr(t), dstr(t)

def load_rows(branch_ids, f, t):
    if not branch_ids: return []
    c = conn()
    ph = ",".join("?" * len(branch_ids))
    rows = c.execute(f"SELECT event_type,payload,received_at,branch_id FROM events WHERE branch_id IN ({ph}) ORDER BY id", branch_ids).fetchall()
    c.close()
    return [r for r in rows if f <= (r["received_at"] or "")[:10] <= t]

def agg(rows):
    rev = prof = checks = 0; pay = {}; top = {}; series = {}; sales = []; rets = []; audit = []
    for r in rows:
        day = (r["received_at"] or "")[:10]
        try: pl = json.loads(r["payload"])
        except Exception: pl = {}
        et = r["event_type"]
        if et == "SALE_CREATED":
            s = pl.get("sale", {}); items = pl.get("items", [])
            tot = int(s.get("total") or 0); pr = 0
            for it in items:
                q = int(it.get("quantity") or 0); tp = int(it.get("total_price") || 0) if False else int(it.get("total_price") or 0); cs = int(it.get("cost_snapshot") or 0)
                pr += tp - cs * q
                nm = it.get("product_name") or "?"
                top[nm] = top.get(nm, 0) + q
            rev += tot; prof += pr; checks += 1
            for p in (pl.get("payments") or []):
                pt = p.get("payment_type") or "naqd"; pay[pt] = pay.get(pt, 0) + int(p.get("amount") or 0)
            d = series.setdefault(day, {"lbl": day, "revenue": 0, "profit": 0}); d["revenue"] += tot; d["profit"] += pr
            sales.append({"num": s.get("sale_number"), "at": r["received_at"], "cashier": s.get("cashier_name"), "total": tot, "profit": pr, "branch": r["branch_id"]})
        elif et == "RETURN_CREATED":
            rt = pl.get("ret", {}); rets.append({"num": rt.get("return_number"), "at": r["received_at"], "total": int(rt.get("total") or 0)})
        elif et == "AUDIT":
            audit.append({"at": pl.get("at") or r["received_at"], "user": pl.get("username"), "action": pl.get("action"), "detail": pl.get("detail")})
    return {"revenue": rev, "profit": prof, "checks": checks,
            "payments": [{"payment_type": k, "sum": v} for k, v in pay.items()],
            "top": [{"name": k, "qty": v} for k, v in sorted(top.items(), key=lambda x: -x[1])[:10]],
            "series": [series[k] for k in sorted(series)],
            "sales": sales[:40],
            "returns": {"count": len(rets), "sum": sum(x["total"] for x in rets), "list": rets[:20]},
            "audit": audit[:60]}

@app.get("/api/health")
def health(): return {"ok": True, "time": datetime.now().isoformat()}

@app.get("/api/app/version")
def app_version():
    try:
        with open(VERSION_FILE, "r", encoding="utf8") as f: return json.load(f)
    except Exception:
        return {"version": "1.0.0", "url": ""}

@app.post("/api/admin/branches")
def create_branch(req: NewBranchReq, guard: bool = Depends(admin_guard)):
    name = req.name.strip()
    if len(name) < 2: raise HTTPException(422, "Nom juda qisqa")
    code = "".join([str(secrets.randbelow(10)) for _ in range(6)])
    c = conn()
    sid = req.store_id or c.execute("SELECT id FROM stores ORDER BY id LIMIT 1").fetchone()["id"]
    try: c.execute("INSERT INTO branches(name,activation_code,store_id) VALUES(?,?,?)", [name, code, sid])
    except sqlite3.IntegrityError: c.close(); raise HTTPException(409, "Nom band")
    c.commit(); bid = c.execute("SELECT last_insert_rowid() AS i").fetchone()["i"]; c.close()
    return {"ok": True, "id": bid, "name": name, "activation_code": code}

@app.post("/api/admin/branches/{branch_id}/rename")
def rename_branch(branch_id: int, req: RenameReq, guard: bool = Depends(admin_guard)):
    c = conn()
    try: c.execute("UPDATE branches SET name=? WHERE id=?", [req.name.strip(), branch_id])
    except sqlite3.IntegrityError: c.close(); raise HTTPException(409, "Nom band")
    c.commit(); c.close(); return {"ok": True}

@app.delete("/api/admin/branches/{branch_id}")
def delete_branch(branch_id: int, guard: bool = Depends(admin_guard)):
    c = conn()
    c.execute("DELETE FROM devices WHERE branch_id=?", [branch_id])
    c.execute("DELETE FROM cloud_products WHERE branch_id=?", [branch_id])
    c.execute("DELETE FROM branches WHERE id=?", [branch_id])
    c.commit(); c.close()
    return {"ok": True}

@app.post("/api/activate")
def activate(req: ActivateReq):
    c = conn(); b = c.execute("SELECT * FROM branches WHERE activation_code=?", [req.code]).fetchone()
    if not b: c.close(); raise HTTPException(404, "Kod noto'g'ri")
    token = secrets.token_hex(24)
    c.execute("INSERT INTO devices(branch_id,token) VALUES(?,?)", [b["id"], token]); c.commit()
    out = {"ok": True, "token": token, "branch_id": b["id"], "branch_name": b["name"]}; c.close(); return out

@app.post("/api/sync/push")
def push(req: PushReq, authorization: Optional[str] = Header(None), x_app_version: Optional[str] = Header(None)):
    bid = auth(authorization)
    c = conn()
    c.execute("UPDATE devices SET last_seen=?, version=? WHERE token=?", [datetime.now().isoformat(), x_app_version or None, authorization])
    added = dup = 0
    for e in req.events:
        if e.event_type == "PRODUCT_UPSERT":
            p = e.payload
            c.execute("""INSERT INTO cloud_products(branch_id,product_id,name,category,price,cost,stock,min,updated_at)
                         VALUES(?,?,?,?,?,?,?,?,datetime('now'))
                         ON CONFLICT(branch_id,product_id) DO UPDATE SET name=excluded.name, category=excluded.category,
                         price=excluded.price, cost=excluded.cost, stock=excluded.stock, min=excluded.min, updated_at=excluded.updated_at""",
                      [bid, p.get("product_id"), p.get("name"), p.get("category"), p.get("price"), p.get("cost"), p.get("stock"), p.get("min")])
            added += 1
            continue
        try:
            c.execute("INSERT INTO events(device_id,branch_id,event_id,event_type,payload) VALUES((SELECT id FROM devices WHERE token=?),?,?,?,?)",
                      [authorization, bid, e.event_id, e.event_type, json.dumps(e.payload, ensure_ascii=False)])
            added += 1
        except sqlite3.IntegrityError: dup += 1
    c.commit(); c.close(); return {"ok": True, "added": added, "duplicates": dup}

@app.get("/api/owner/stores")
def stores(guard: bool = Depends(admin_guard)):
    c = conn()
    st = c.execute("SELECT s.*, (SELECT COUNT(*) FROM branches b WHERE b.store_id=s.id) bc FROM stores s ORDER BY s.id").fetchall()
    c.close(); return [dict(x) for x in st]

@app.get("/api/owner/dashboard")
def dashboard(store: Optional[int] = None, period: str = "7d", guard: bool = Depends(admin_guard)):
    f, t = resolve_period(period)
    c = conn()
    br = c.execute("SELECT id,name FROM branches WHERE store_id=?", [store]).fetchall() if store else c.execute("SELECT id,name FROM branches").fetchall()
    c.close()
    ids = [b["id"] for b in br]
    rows = load_rows(ids, f, t)
    total = agg(rows)
    per = []
    for b in br:
        a = agg([r for r in rows if r["branch_id"] == b["id"]])
        per.append({"id": b["id"], "name": b["name"], "revenue": a["revenue"], "profit": a["profit"], "checks": a["checks"]})
    return {"from": f, "to": t, "total": total, "branches": per}

@app.get("/api/owner/branch/{branch_id}")
def branch_detail(branch_id: int, period: str = "7d", guard: bool = Depends(admin_guard)):
    f, t = resolve_period(period)
    c = conn(); b = c.execute("SELECT id,name FROM branches WHERE id=?", [branch_id]).fetchone(); c.close()
    if not b: raise HTTPException(404, "Filial topilmadi")
    return {"branch": dict(b), "from": f, "to": t, "data": agg(load_rows([branch_id], f, t))}

@app.get("/api/owner/audit")
def audit_feed(store: Optional[int] = None, guard: bool = Depends(admin_guard)):
    c = conn()
    br = [x["id"] for x in (c.execute("SELECT id FROM branches WHERE store_id=?", [store]).fetchall() if store else c.execute("SELECT id FROM branches").fetchall())]
    c.close()
    return agg(load_rows(br, "2000-01-01", "2099-12-31"))["audit"]

@app.get("/api/owner/products")
def owner_products(store: Optional[int] = None, guard: bool = Depends(admin_guard)):
    c = conn()
    q = "SELECT cp.*, b.name AS branch FROM cloud_products cp JOIN branches b ON b.id=cp.branch_id"
    if store: q += " WHERE b.store_id=%d" % int(store)
    q += " ORDER BY cp.branch, cp.name LIMIT 2000"
    rows = c.execute(q).fetchall(); c.close()
    return [dict(x) for x in rows]

@app.get("/api/owner/devices")
def owner_devices(store: Optional[int] = None, guard: bool = Depends(admin_guard)):
    c = conn()
    q = "SELECT d.id, d.last_seen, d.version, d.created_at, b.name AS branch FROM devices d JOIN branches b ON b.id=d.branch_id"
    if store: q += " WHERE b.store_id=%d" % int(store)
    q += " ORDER BY d.id DESC LIMIT 500"
    rows = c.execute(q).fetchall(); c.close()
    return [dict(x) for x in rows]

DASHBOARD_HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mini Market OS — Owner</title>
<style>
:root{--bg:#f4f6fa;--side:#12283a;--card:#fff;--text:#1f2937;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--green:#16a34a;--red:#dc2626;--amber:#d97706}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;background:var(--bg);color:var(--text);display:flex;min-height:100vh}
#sb{width:220px;background:linear-gradient(180deg,var(--side),#0d1f2d);color:#e5e7eb;position:fixed;inset:0 auto 0 0;display:flex;flex-direction:column}
#sb .brand{padding:16px;border-bottom:1px solid rgba(255,255,255,.08);font-weight:700}
#sb .brand small{display:block;font-weight:400;color:#9fb3c8;font-size:11px}
#sb select{margin:10px;background:#0d1f2d;color:#e5e7eb;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:8px}
#sb .nav{flex:1;padding:8px}
#sb .nav div{padding:10px 12px;border-radius:8px;cursor:pointer;color:#cfd8e3;font-size:14px;margin-bottom:2px}
#sb .nav div.on{background:var(--accent);color:#fff;font-weight:600}
#mn{margin-left:220px;flex:1;padding:20px 24px}
.cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 18px;flex:1;min-width:150px}
.kpi .lbl{font-size:12px;color:var(--muted)}.kpi .num{font-size:22px;font-weight:800;margin-top:4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.card h3{font-size:14px;margin-bottom:12px}
.grid2{display:grid;grid-template-columns:1.4fr 1fr;gap:16px}
table{width:100%;border-collapse:collapse}
th,td{padding:9px 10px;text-align:left;border-bottom:1px solid var(--line);font-size:13px}
th{color:var(--muted);font-weight:600;font-size:12px}
.btn{border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer}
.btn.p{background:var(--accent);color:#fff}.btn.g{background:var(--green);color:#fff}.btn.gh{background:#eef2ff;color:var(--accent)}.btn.r{background:var(--red);color:#fff}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.muted{color:var(--muted);font-size:12px}.ok{color:var(--green)}.err{color:var(--red)}
canvas{width:100%;height:220px;display:block;cursor:crosshair}
.wrap{position:relative}
.tip{position:absolute;display:none;background:#111827;color:#fff;border-radius:8px;padding:6px 10px;font-size:11px;pointer-events:none;white-space:nowrap}
a.bl{color:var(--accent);cursor:pointer;font-weight:600}
.view{display:none}.view.on{display:block}
</style></head><body>
<aside id="sb">
  <div class="brand">🏪 Mini Market OS<small>Owner Dashboard</small></div>
  <select id="store-sel"></select>
  <div class="nav">
    <div class="on" data-v="home">🏠 Bosh sahifa</div>
    <div data-v="branch">🏬 Filiallar</div>
    <div data-v="products">📦 Mahsulotlar</div>
    <div data-v="devices">🖥 Qurilmalar</div>
    <div data-v="audit">📒 Audit</div>
  </div>
</aside>
<div id="mn">
  <div class="row">
    <button class="btn gh pb on" data-p="today">Bugun</button>
    <button class="btn gh pb" data-p="7d">7 kun</button>
    <button class="btn gh pb" data-p="month">Oy</button>
    <button class="btn gh pb" data-p="all">Hammasi</button>
    <button class="btn g" id="print" style="margin-left:auto">🖨 Chop etish</button>
  </div>

  <div class="view on" id="v-home">
    <div class="cards">
      <div class="kpi"><div class="lbl">Savdo</div><div class="num" id="k-rev">0</div></div>
      <div class="kpi"><div class="lbl">Sof foyda</div><div class="num ok" id="k-prof">0</div></div>
      <div class="kpi"><div class="lbl">Cheklar</div><div class="num" id="k-chk">0</div></div>
      <div class="kpi"><div class="lbl">Qaytarishlar</div><div class="num err" id="k-ret">0</div></div>
    </div>
    <div class="grid2">
      <div class="card"><h3>📈 Savdo dinamikasi</h3><div class="wrap"><canvas id="ch"></canvas><div class="tip" id="tip"></div></div></div>
      <div class="card"><h3>🏆 Top mahsulotlar</h3><div id="top"></div></div>
    </div>
    <div class="card"><h3>🧾 Oxirgi savdolar</h3><table><thead><tr><th>№</th><th>Vaqt</th><th>Kassir</th><th>Summa</th><th>Foyda</th></tr></thead><tbody id="sales"></tbody></table></div>
  </div>

  <div class="view" id="v-branch">
    <div class="card"><h3>🏬 Filiallar</h3>
      <div class="row"><input id="new-br" placeholder="Yangi filial nomi" style="max-width:240px"><button class="btn p" id="add-br">➕ Filial yaratish</button><span class="ok" id="br-code"></span></div>
      <table><thead><tr><th>Filial</th><th>Savdo</th><th>Foyda</th><th>Cheklar</th><th></th></tr></thead><tbody id="brs"></tbody></table></div>
    <div id="bd" style="display:none">
      <button class="btn gh" id="back">← Orqaga</button>
      <div class="cards">
        <div class="kpi"><div class="lbl">Savdo</div><div class="num" id="b-rev">0</div></div>
        <div class="kpi"><div class="lbl">Foyda</div><div class="num ok" id="b-prof">0</div></div>
        <div class="kpi"><div class="lbl">Cheklar</div><div class="num" id="b-chk">0</div></div>
      </div>
      <div class="grid2">
        <div class="card"><h3>📈 Filial dinamikasi</h3><div class="wrap"><canvas id="bch"></canvas><div class="tip" id="btip"></div></div></div>
        <div class="card"><h3>↩️ Qaytarishlar</h3><table><thead><tr><th>№</th><th>Vaqt</th><th>Summa</th></tr></thead><tbody id="brets"></tbody></table></div>
      </div>
      <div class="card"><h3>🧾 Filial savdolari</h3><table><thead><tr><th>№</th><th>Vaqt</th><th>Kassir</th><th>Summa</th><th>Foyda</th></tr></thead><tbody id="bsales"></tbody></table></div>
    </div>
  </div>

  <div class="view" id="v-products">
    <div class="card"><h3>📦 Mahsulotlar (filiallar kesimida, POS'dan sync)</h3>
      <table><thead><tr><th>Filial</th><th>Mahsulot</th><th>Kategoriya</th><th>Narx</th><th>Qoldiq</th><th>Yangilangan</th></tr></thead><tbody id="prods"></tbody></table></div>
  </div>

  <div class="view" id="v-devices">
    <div class="card"><h3>🖥 Qurilmalar (versiya va holat)</h3>
      <table><thead><tr><th>Filial</th><th>Versiya</th><th>Oxirgi sync</th><th>Holat</th></tr></thead><tbody id="devs"></tbody></table></div>
  </div>

  <div class="view" id="v-audit">
    <div class="card"><h3>📒 Xodimlar amallari (audit)</h3>
      <table><thead><tr><th>Vaqt</th><th>Kim</th><th>Amal</th><th>Tafsilot</th></tr></thead><tbody id="aud"></tbody></table></div>
  </div>
</div>
<script>
const fmt=n=>Number(n||0).toLocaleString();
let PERIOD='today', STORE=null, AK=localStorage.getItem('ak')||'';
if(!AK){AK=prompt('Admin kalit (ADMIN_KEY):')||'';localStorage.setItem('ak',AK);}
async function api(p){const r=await fetch(p,{headers:{'X-Admin-Key':AK}});if(r.status===403){AK=prompt('Kalit noto\\'g\\'ri, qayta kiriting:')||'';localStorage.setItem('ak',AK);return api(p);}return r.json();}
function line(cv,data,tip){const ctx=cv.getContext('2d');const W=cv.width=cv.clientWidth||600,H=cv.height=220;ctx.clearRect(0,0,W,H);
 if(!data||!data.length){ctx.fillStyle='#9ca3af';ctx.font='12px Segoe UI';ctx.fillText("Ma'lumot yo'q",20,H/2);cv.onmousemove=null;return;}
 const pad=44,max=Math.max(...data.map(d=>+d.revenue||0),1);const x=i=>pad+i*(W-pad-12)/Math.max(data.length-1,1);const y=v=>H-26-(+v||0)/max*(H-50);
 ctx.font='10px Segoe UI';for(let g=0;g<=4;g++){const val=max*(1-g/4),gy=y(val);ctx.strokeStyle='#e5e7eb';ctx.beginPath();ctx.moveTo(pad,gy);ctx.lineTo(W-12,gy);ctx.stroke();ctx.fillStyle='#9ca3af';ctx.fillText(fmt(Math.round(val)),4,gy+3);}
 const st=Math.max(1,Math.floor(data.length/6));ctx.fillStyle='#9ca3af';for(let i=0;i<data.length;i+=st)ctx.fillText(data[i].lbl,x(i)-12,H-8);
 const L=(k,c)=>{ctx.strokeStyle=c;ctx.lineWidth=2;ctx.beginPath();data.forEach((d,i)=>{const px=x(i),py=y(d[k]);i?ctx.lineTo(px,py):ctx.moveTo(px,py);});ctx.stroke();ctx.fillStyle=c;data.forEach((d,i)=>{ctx.beginPath();ctx.arc(x(i),y(d[k]),3,0,7);ctx.fill();});};
 L('revenue','#2563eb');L('profit','#16a34a');
 cv.onmousemove=e=>{const r=cv.getBoundingClientRect();let i=Math.round((e.clientX-r.left-pad)/((W-pad-12)/Math.max(data.length-1,1)));i=Math.max(0,Math.min(data.length-1,i));const d=data[i];tip.style.display='block';tip.style.left=Math.min(x(i)+10,W-170)+'px';tip.style.top=Math.max(y(d.revenue)-14,4)+'px';tip.innerHTML='<b>'+d.lbl+'</b><br>Savdo: '+fmt(d.revenue)+'<br>Foyda: '+fmt(d.profit);};
 cv.onmouseleave=()=>tip.style.display='none';}
async function loadStores(){const s=await api('/api/owner/stores');const sel=document.getElementById('store-sel');
 sel.innerHTML='<option value="">Barcha do\\'konlar</option>'+s.map(x=>'<option value="'+x.id+'">'+x.name+' ('+x.bc+')</option>').join('');
 sel.value=STORE||'';}
document.getElementById('store-sel').onchange=e=>{STORE=e.target.value||null;refresh();};
document.querySelectorAll('.pb').forEach(b=>b.onclick=()=>{document.querySelectorAll('.pb').forEach(x=>x.classList.remove('on'));b.classList.add('on');PERIOD=b.dataset.p;refresh();});
document.querySelectorAll('#sb .nav div').forEach(d=>d.onclick=()=>{document.querySelectorAll('#sb .nav div').forEach(x=>x.classList.remove('on'));d.classList.add('on');
 document.querySelectorAll('.view').forEach(v=>v.classList.remove('on'));document.getElementById('v-'+d.dataset.v).classList.add('on');refresh();});
document.getElementById('back').onclick=()=>{document.getElementById('bd').style.display='none';};
document.getElementById('print').onclick=()=>window.print();
function isOnline(ls){if(!ls)return false;const d=(new Date()-new Date(ls))/1000;return d<120;}
document.getElementById('add-br').onclick=async()=>{
  const n=document.getElementById('new-br').value.trim(); if(!n)return;
  const r=await fetch('/api/admin/branches',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':AK},body:JSON.stringify({name:n,store_id:STORE?Number(STORE):null})});
  const j=await r.json();
  if(j.ok){document.getElementById('br-code').textContent='✅ Kod: '+j.activation_code;document.getElementById('new-br').value='';refresh();}
  else alert('Xato: '+(j.detail||'noma\'lum'));
};
async function delB(id){
  if(!confirm('Filial va uning qurilmalari BUTUNLAY o\\'chirilsinmi?'))return;
  const r=await fetch('/api/admin/branches/'+id,{method:'DELETE',headers:{'X-Admin-Key':AK}});
  const j=await r.json();
  if(j.ok){document.getElementById('bd').style.display='none';refresh();}
}
async function refresh(){
 const q='/api/owner/dashboard?period='+PERIOD+(STORE?'&store='+STORE:'');
 const d=await api(q);
 document.getElementById('k-rev').textContent=fmt(d.total.revenue);
 document.getElementById('k-prof').textContent=fmt(d.total.profit);
 document.getElementById('k-chk').textContent=d.total.checks;
 document.getElementById('k-ret').textContent=d.total.returns.count;
 line(document.getElementById('ch'),d.total.series,document.getElementById('tip'));
 document.getElementById('top').innerHTML=(d.total.top||[]).slice(0,6).map((t,i)=>'<div class="row" style="justify-content:space-between;margin:0;padding:3px 0"><span>'+(i+1)+'. '+t.name+'</span><b>'+t.qty+' dona</b></div>').join('')||'<span class="muted">Yo\\'q</span>';
 document.getElementById('sales').innerHTML=(d.total.sales||[]).map(s=>'<tr><td>№'+s.num+'</td><td>'+String(s.at).slice(5,16)+'</td><td>'+(s.cashier||'')+'</td><td>'+fmt(s.total)+'</td><td class="ok">'+fmt(s.profit)+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">Yo\\'q</td></tr>';
 document.getElementById('brs').innerHTML=(d.branches||[]).map(b=>'<tr><td><a class="bl" onclick="openB('+b.id+')">'+b.name+'</a></td><td>'+fmt(b.revenue)+'</td><td class="ok">'+fmt(b.profit)+'</td><td>'+b.checks+'</td><td><button class="btn r" onclick="delB('+b.id+')">🗑</button></td></tr>').join('')||'<tr><td colspan="5" class="muted">Yo\\'q</td></tr>';
 const pr=await api('/api/owner/products?'+(STORE?'store='+STORE:''));
 document.getElementById('prods').innerHTML=(pr||[]).map(p=>'<tr><td>'+p.branch+'</td><td>'+p.name+'</td><td>'+(p.category||'—')+'</td><td>'+fmt(p.price)+'</td><td>'+p.stock+'</td><td class="muted">'+String(p.updated_at||'').slice(5,16)+'</td></tr>').join('')||'<tr><td colspan="6" class="muted">Hali sync yo\\'q</td></tr>';
 const dv=await api('/api/owner/devices?'+(STORE?'store='+STORE:''));
 document.getElementById('devs').innerHTML=(dv||[]).map(x=>'<tr><td>'+x.branch+'</td><td>'+(x.version||'?')+'</td><td>'+String(x.last_seen||'—').slice(5,16)+'</td><td class="'+(isOnline(x.last_seen)?'ok':'err')+'">'+(isOnline(x.last_seen)?'🟢 Online':'🔴 Offline')+'</td></tr>').join('')||'<tr><td colspan="4" class="muted">Yo\\'q</td></tr>';
 const a=await api('/api/owner/audit?'+(STORE?'store='+STORE:''));
 document.getElementById('aud').innerHTML=(a||[]).map(x=>'<tr><td>'+String(x.at).slice(5,16)+'</td><td>'+(x.user||'')+'</td><td>'+x.action+'</td><td>'+x.detail+'</td></tr>').join('')||'<tr><td colspan="4" class="muted">Yo\\'q</td></tr>';
}
async function openB(id){
 document.getElementById('bd').style.display='block';
 const d=await api('/api/owner/branch/'+id+'?period='+PERIOD);
 document.getElementById('b-rev').textContent=fmt(d.data.revenue);
 document.getElementById('b-prof').textContent=fmt(d.data.profit);
 document.getElementById('b-chk').textContent=d.data.checks;
 line(document.getElementById('bch'),d.data.series,document.getElementById('btip'));
 document.getElementById('brets').innerHTML=(d.data.returns.list||[]).map(r=>'<tr><td>№'+r.num+'</td><td>'+String(r.at).slice(5,16)+'</td><td class="err">'+fmt(r.total)+'</td></tr>').join('')||'<tr><td colspan="3" class="muted">Yo\\'q</td></tr>';
 document.getElementById('bsales').innerHTML=(d.data.sales||[]).map(s=>'<tr><td>№'+s.num+'</td><td>'+String(s.at).slice(5,16)+'</td><td>'+(s.cashier||'')+'</td><td>'+fmt(s.total)+'</td><td class="ok">'+fmt(s.profit)+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">Yo\\'q</td></tr>';
}
loadStores();refresh();setInterval(refresh,30000);
</script></body></html>"""

@app.get("/", response_class=HTMLResponse)
def dashboard_page(): return DASHBOARD_HTML