# MINI MARKET OS — CLOUD API + OWNER DASHBOARD (VPS-ready)
import sqlite3, json, secrets, os
from datetime import datetime
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(__file__))
DB = os.path.join(DATA_DIR, "cloud.db")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "")

app = FastAPI(title="Mini Market OS Cloud")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

def conn():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c

def admin_guard(x_admin_key: Optional[str] = Header(None)):
    if ADMIN_KEY and x_admin_key != ADMIN_KEY:
        raise HTTPException(403, "Admin kalit noto'g'ri")

def init():
    os.makedirs(DATA_DIR, exist_ok=True)
    c = conn()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, activation_code TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER NOT NULL, token TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL, branch_id INTEGER NOT NULL,
      event_id TEXT UNIQUE, event_type TEXT NOT NULL, payload TEXT NOT NULL,
      received_at TEXT DEFAULT (datetime('now')));
    """)
    if not c.execute("SELECT id FROM branches WHERE name='Filial-1'").fetchone():
        c.execute("INSERT INTO branches (name, activation_code) VALUES ('Filial-1','111111')")
    c.commit(); c.close()

init()

class ActivateReq(BaseModel): code: str
class EventItem(BaseModel): event_id: str; event_type: str; payload: dict
class PushReq(BaseModel): events: List[EventItem]
class NewBranchReq(BaseModel): name: str
class RenameReq(BaseModel): name: str

def auth(token: Optional[str]) -> int:
    if not token: raise HTTPException(401, "token yo'q")
    c = conn(); d = c.execute("SELECT branch_id FROM devices WHERE token=?", [token]).fetchone(); c.close()
    if not d: raise HTTPException(401, "token noto'g'ri")
    return d["branch_id"]

@app.get("/api/health")
def health(): return {"ok": True, "time": datetime.now().isoformat()}

@app.post("/api/admin/branches")
def create_branch(req: NewBranchReq, guard: bool = Depends(admin_guard)):
    name = req.name.strip()
    if len(name) < 2: raise HTTPException(422, "Filial nomi juda qisqa")
    code = "".join([str(secrets.randbelow(10)) for _ in range(6)])
    c = conn()
    try: c.execute("INSERT INTO branches (name, activation_code) VALUES (?,?)", [name, code])
    except sqlite3.IntegrityError: c.close(); raise HTTPException(409, "Bu filial nomi band")
    c.commit(); bid = c.execute("SELECT last_insert_rowid() AS i").fetchone()["i"]; c.close()
    return {"ok": True, "id": bid, "name": name, "activation_code": code}

@app.post("/api/admin/branches/{branch_id}/rename")
def rename_branch(branch_id: int, req: RenameReq, guard: bool = Depends(admin_guard)):
    name = req.name.strip()
    if len(name) < 2: raise HTTPException(422, "Nom juda qisqa")
    c = conn()
    try: c.execute("UPDATE branches SET name=? WHERE id=?", [name, branch_id])
    except sqlite3.IntegrityError: c.close(); raise HTTPException(409, "Bu nom band")
    c.commit(); c.close()
    return {"ok": True}

@app.post("/api/activate")
def activate(req: ActivateReq):
    c = conn(); b = c.execute("SELECT * FROM branches WHERE activation_code=?", [req.code]).fetchone()
    if not b: c.close(); raise HTTPException(404, "Aktivatsiya kodi noto'g'ri")
    token = secrets.token_hex(24)
    c.execute("INSERT INTO devices (branch_id, token) VALUES (?,?)", [b["id"], token]); c.commit()
    out = {"ok": True, "token": token, "branch_id": b["id"], "branch_name": b["name"]}; c.close()
    return out

@app.post("/api/sync/push")
def push(req: PushReq, authorization: Optional[str] = Header(None)):
    branch_id = auth(authorization)
    c = conn(); added = 0; dup = 0
    for e in req.events:
        try:
            c.execute("""INSERT INTO events (device_id, branch_id, event_id, event_type, payload)
                         VALUES ((SELECT id FROM devices WHERE token=?),?,?,?,?)""",
                      [authorization, branch_id, e.event_id, e.event_type, json.dumps(e.payload, ensure_ascii=False)])
            added += 1
        except sqlite3.IntegrityError: dup += 1
    c.commit(); c.close()
    return {"ok": True, "added": added, "duplicates": dup}

@app.get("/api/owner/dashboard")
def dashboard_data():
    c = conn()
    branches = c.execute("""
        SELECT b.id, b.name,
          IFNULL(SUM(CASE WHEN e.event_type='SALE_CREATED' THEN 1 ELSE 0 END),0) AS checks,
          IFNULL(SUM(CASE WHEN e.event_type='SALE_CREATED'
            THEN IFNULL(CAST(json_extract(e.payload,'$.sale.total') AS INTEGER),0) ELSE 0 END),0) AS revenue,
          MAX(e.received_at) AS last_event
        FROM branches b LEFT JOIN events e ON e.branch_id=b.id GROUP BY b.id ORDER BY b.id""").fetchall()
    devices = c.execute("SELECT branch_id, COUNT(*) AS cnt FROM devices GROUP BY branch_id").fetchall()
    recent = c.execute("""
        SELECT e.event_type, e.received_at, b.name AS branch, json_extract(e.payload,'$.sale.total') AS sale_total
        FROM events e JOIN branches b ON b.id=e.branch_id ORDER BY e.id DESC LIMIT 20""").fetchall()
    totals = c.execute("""
        SELECT IFNULL(SUM(CASE WHEN event_type='SALE_CREATED' THEN 1 ELSE 0 END),0) AS checks,
               IFNULL(SUM(CASE WHEN event_type='SALE_CREATED'
                 THEN IFNULL(CAST(json_extract(payload,'$.sale.total') AS INTEGER),0) ELSE 0 END),0) AS revenue
        FROM events""").fetchone()
    c.close()
    dev_map = {d["branch_id"]: d["cnt"] for d in devices}
    return {"generated_at": datetime.now().isoformat(),
            "totals": {"checks": totals["checks"], "revenue": totals["revenue"]},
            "branches": [{**dict(b), "devices": dev_map.get(b["id"], 0)} for b in branches],
            "recent": [dict(r) for r in recent]}

@app.get("/api/owner/branch/{branch_id}")
def branch_detail(branch_id: int):
    c = conn(); b = c.execute("SELECT * FROM branches WHERE id=?", [branch_id]).fetchone()
    if not b: c.close(); raise HTTPException(404, "Filial topilmadi")
    sales = c.execute("""
        SELECT json_extract(payload,'$.sale.sale_number') AS num, json_extract(payload,'$.sale.total') AS total,
               json_extract(payload,'$.sale.cashier_name') AS cashier, received_at
        FROM events WHERE branch_id=? AND event_type='SALE_CREATED' ORDER BY id DESC LIMIT 30""", [branch_id]).fetchall()
    totals = c.execute("""
        SELECT IFNULL(SUM(CASE WHEN event_type='SALE_CREATED' THEN 1 ELSE 0 END),0) AS checks,
               IFNULL(SUM(CASE WHEN event_type='SALE_CREATED'
                 THEN IFNULL(CAST(json_extract(payload,'$.sale.total') AS INTEGER),0) ELSE 0 END),0) AS revenue
        FROM events WHERE branch_id=?""", [branch_id]).fetchone()
    c.close()
    return {"branch": dict(b), "totals": dict(totals), "sales": [dict(s) for s in sales]}

DASHBOARD_HTML = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Mini Market OS — Owner Dashboard</title>
<style>
body{background:#1e1e2e;color:#fff;font-family:'Segoe UI',Arial;margin:0;padding:24px}
h1{font-size:22px} h2{font-size:16px;margin:0 0 10px}
.dim{color:#80809a;font-size:13px} .ok{color:#4ade80;font-weight:bold}
a.bl{color:#4ade80;text-decoration:none;font-weight:bold} a.bl:hover{text-decoration:underline}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
.card{background:#2a2a3e;border-radius:12px;padding:16px 22px;flex:1;min-width:160px}
.num{font-size:26px;font-weight:bold}.lbl{color:#a0a0c0;font-size:13px;margin-top:4px}
table{width:100%;border-collapse:collapse;background:#2a2a3e;border-radius:12px;overflow:hidden}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #3a3a52;font-size:14px}
th{background:#34344c}
.grid{display:grid;grid-template-columns:1.2fr .8fr;gap:16px}
.nb{display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap}
.nb input{background:#1e1e2e;border:1px solid #3a3a52;color:#fff;padding:10px;border-radius:8px;min-width:260px}
.nb button{background:#4ade80;color:#1e1e2e;border:none;border-radius:8px;padding:10px 16px;font-weight:bold;cursor:pointer}
.eb{background:#8b5cf6;border:none;color:#fff;border-radius:6px;padding:4px 8px;cursor:pointer}
</style></head><body>
<h1>🏪 MINI MARKET OS — Owner Dashboard <span class="dim" id="gen"></span></h1>
<div class="cards" id="cards"></div>
<div class="card" style="margin-bottom:16px">
  <h2>➕ Yangi filial yaratish (aktivatsiya kodi olish)</h2>
  <div class="nb"><input id="nb" placeholder="Filial nomi"><button onclick="createBranch()">Yaratish</button><span id="nbc" class="ok"></span></div>
  <p class="dim">✏️ — filial nomini tahrirlash.</p>
</div>
<div class="grid">
  <div><h2>🏪 Filiallar kesimi</h2>
    <table><thead><tr><th>Filial</th><th>Qurilmalar</th><th>Cheklar</th><th>Savdo</th><th></th></tr></thead><tbody id="br"></tbody></table></div>
  <div><h2>🕒 Oxirgi hodisalar</h2>
    <table><thead><tr><th>Vaqt</th><th>Filial</th><th>Hodisa</th><th>Summa</th></tr></thead><tbody id="ev"></tbody></table></div>
</div>
<script>
const fmt=n=>Number(n||0).toLocaleString();
function ak(){ let k=localStorage.getItem('ak'); if(!k){k=prompt('Admin kalit (ADMIN_KEY):'); if(k)localStorage.setItem('ak',k);} return k||''; }
async function createBranch(){
  const name=document.getElementById('nb').value.trim();
  if(!name){document.getElementById('nbc').textContent='⚠️ Nom kiriting';return;}
  const r=await (await fetch('/api/admin/branches',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':ak()},body:JSON.stringify({name})})).json();
  document.getElementById('nbc').textContent=r.ok?('✅ Kod: '+r.activation_code):('⚠️ '+(r.detail||'xato'));
  if(r.ok) load();
}
async function renameBranch(id){
  const name=prompt('Filialning yangi nomi:'); if(!name) return;
  const r=await (await fetch('/api/admin/branches/'+id+'/rename',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Key':ak()},body:JSON.stringify({name})})).json();
  alert(r.ok?'✅ Nom o\\'zgartirildi':'⚠️ '+(r.detail||'xato')); load();
}
async function load(){
  const r=await (await fetch('/api/owner/dashboard')).json();
  document.getElementById('gen').textContent='· '+r.generated_at.slice(0,19).replace('T',' ');
  document.getElementById('cards').innerHTML=
    '<div class="card"><div class="num">'+fmt(r.totals.revenue)+'</div><div class="lbl">Jami savdo (so\\'m)</div></div>'+
    '<div class="card"><div class="num">'+r.totals.checks+'</div><div class="lbl">Cheklar</div></div>'+
    '<div class="card"><div class="num">'+r.branches.length+'</div><div class="lbl">Filiallar</div></div>';
  document.getElementById('br').innerHTML=r.branches.map(b=>
    '<tr><td>'+b.name+'</td><td>'+b.devices+'</td><td>'+b.checks+'</td><td>'+fmt(b.revenue)+'</td><td><button class="eb" onclick="renameBranch('+b.id+')">✏️</button></td></tr>'
  ).join('')||'<tr><td colspan="5" class="dim">Hali filial yo\\'q</td></tr>';
  document.getElementById('ev').innerHTML=r.recent.map(e=>
    '<tr><td class="dim">'+String(e.received_at).slice(11,16)+'</td><td>'+e.branch+'</td><td>'+e.event_type+'</td><td>'+(e.sale_total?fmt(e.sale_total):'—')+'</td></tr>'
  ).join('')||'<tr><td colspan="4" class="dim">Hali hodisa yo\\'q</td></tr>';
}
load(); setInterval(load,10000);
</script></body></html>"""

@app.get("/", response_class=HTMLResponse)
def dashboard(): return DASHBOARD_HTML