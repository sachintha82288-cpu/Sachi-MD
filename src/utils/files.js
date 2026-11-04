const fs = require('fs');
const path = require('path');
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function safeUnlink(file) { try { fs.unlinkSync(file); return true; } catch { return false; } }
function safeJsonRead(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function atomicJsonWrite(file, value) { ensureDir(path.dirname(file)); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
module.exports = { ensureDir, safeUnlink, safeJsonRead, atomicJsonWrite };
