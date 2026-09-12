const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { save } = require('./db');

function backupDir() { const d = path.join(app.getPath('userData'), 'backups'); fs.mkdirSync(d, { recursive: true }); return d; }
function dbFile() { return path.join(app.getPath('userData'), 'data', 'pos.db'); }

function listBackups() {
  return fs.readdirSync(backupDir()).filter(f => f.endsWith('.db')).map(f => {
    const st = fs.statSync(path.join(backupDir(), f));
    return { file: f, mtime: st.mtime.toISOString(), size: st.size };
  }).sort((a, b) => b.mtime.localeCompare(a.mtime));
}
function createBackup() {
  try {
    save();
    const name = 'backup_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.db';
    fs.copyFileSync(dbFile(), path.join(backupDir(), name));
    const list = listBackups();
    list.slice(7).forEach(o => fs.unlinkSync(path.join(backupDir(), o.file)));
    return { ok: true, name };
  } catch (e) { return { ok: false, error: e.message }; }
}
function restoreBackup(file) {
  try {
    const src = path.join(backupDir(), file);
    if (!fs.existsSync(src)) return { ok: false, error: 'Fayl topilmadi' };
    save();
    fs.copyFileSync(src, dbFile());
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
function autoDaily() {
  const today = new Date().toISOString().slice(0, 10);
  const has = listBackups().some(b => b.file.includes(today));
  if (!has) createBackup();
}
module.exports = { listBackups, createBackup, restoreBackup, autoDaily };