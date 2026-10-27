'use strict';
/** 50-file shared room. No external Node dependencies required. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const COUNT = 50;
const MAX_USERS = 10;
const MAX_FILE_MB = Math.max(1, Math.min(100, Number(process.env.MAX_FILE_MB) || 20));
const MAX_FILE = MAX_FILE_MB * 1024 * 1024;
const ROOM_PASSCODE = String(process.env.ROOM_PASSCODE || '');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(DATA_DIR, 'slots.json');
const COOKIE_NAME = 'fifty_room_session';
const GRACE_MS = 30000;
fs.mkdirSync(UPLOADS_DIR, {recursive: true});

const slots = Array.from({length: COUNT}, (_, index) => ({id: index + 1, label: '', file: null}));
try {
  const content = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  if (Array.isArray(content.slots)) {
    for (const record of content.slots) {
      if (!Number.isInteger(record?.id) || record.id < 1 || record.id > COUNT) continue;
      const current = slots[record.id - 1];
      current.label = typeof record.label === 'string' ? record.label.slice(0, 60) : '';
      const f = record.file;
      if (f && typeof f.diskId === 'string' && /^[a-f0-9-]{36}$/.test(f.diskId) &&
          fs.existsSync(path.join(UPLOADS_DIR, f.diskId))) {
        current.file = {
          diskId: f.diskId,
          name: typeof f.name === 'string' ? f.name.slice(0, 180) : 'file',
          size: Number.isFinite(f.size) ? f.size : 0,
          by: typeof f.by === 'string' ? f.by.slice(0, 24) : 'Unknown',
          at: Number.isFinite(f.at) ? f.at : Date.now()
        };
      }
    }
  }
} catch (err) {
  if (err.code !== 'ENOENT') console.warn('Could not read existing slot data:', err.message);
}

const sessions = new Map();
const busySlots = new Set();
const text = (v, max) => typeof v === 'string'
  ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : '';
const safeName = (v) => text(v, 180).replace(/[\\/]/g, '_').replace(/^\.+$/, '') || 'file';
const json = (res, status, data, headers={}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
};
function saveSlots() {
  const temporary = INDEX_FILE + '.tmp-' + crypto.randomUUID();
  fs.writeFileSync(temporary, JSON.stringify({version: 1, slots}, null, 2));
  fs.renameSync(temporary, INDEX_FILE);
}
function cookieValue(req) {
  const cookieLine = req.headers.cookie || '';
  const pair = cookieLine.split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE_NAME + '='));
  return pair ? pair.slice(COOKIE_NAME.length + 1) : '';
}
function participant(req) {
  const session = sessions.get(cookieValue(req));
  if (session) session.lastSeen = Date.now();
  return session || null;
}
function cleanSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, s] of sessions) {
    if (!s.streams.size && now - s.lastSeen > GRACE_MS) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) broadcast();
}
function occupiedCount() { return sessions.size; }
function onlineCount() { return [...sessions.values()].filter(s => s.streams.size > 0).length; }
function publicState() {
  return {
    slots: slots.map(s => ({ id: s.id, label: s.label, file: s.file ? {
      name: s.file.name, size: s.file.size, by: s.file.by, at: s.file.at
    } : null })),
    used: slots.filter(s => s.file !== null).length,
    online: onlineCount(),
    maxUsers: MAX_USERS,
    maxFileMB: MAX_FILE_MB,
    users: [...sessions.values()].filter(s => s.streams.size).map(s => s.name)
  };
}
function emit(res, event, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
function broadcast() {
  const state = publicState();
  for (const s of sessions.values()) for (const stream of s.streams) {
    try { emit(stream, 'state', state); } catch (_) { s.streams.delete(stream); }
  }
}
function eventMessage(name, message) {
  for (const s of sessions.values()) for (const stream of s.streams) {
    try { emit(stream, 'activity', {name, message}); } catch (_) { s.streams.delete(stream); }
  }
}
async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString('utf8');
    if (Buffer.byteLength(raw) > 8192) throw Object.assign(new Error('Request too large'), {status: 413});
  }
  try { return JSON.parse(raw || '{}'); } catch (_) { throw Object.assign(new Error('Invalid JSON'), {status: 400}); }
}
function parseSlot(pathname) {
  const match = /^\/api\/slots\/([1-9]\d*)\/(name|file-name|file)$/.exec(pathname);
  if (!match) return null;
  const number = Number(match[1]);
  return number >= 1 && number <= COUNT ? {slot: slots[number - 1], action: match[2]} : null;
}
function secureOrigin(req) {
  // JSON and binary mutations must originate from the same website.
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
}
function serveStatic(res, file, mime) {
  fs.readFile(path.join(PUBLIC_DIR, file), (err, body) => {
    if (err) return json(res, 404, {error: 'Not found'});
    res.writeHead(200, {
      'Content-Type': mime, 'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(body);
  });
}
function fileDownload(res, file) {
  const diskPath = path.join(UPLOADS_DIR, file.diskId);
  let stat;
  try { stat = fs.statSync(diskPath); }
  catch (_) { return json(res, 404, {error: 'Stored file is unavailable'}); }
  // Always force download, never render an uploaded HTML or script in the browser.
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(safeName(file.name))}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(diskPath).on('error', () => res.destroy()).pipe(res);
}
async function upload(req, res, slot, session) {
  if (busySlots.has(slot.id)) return json(res, 409, {error: 'This slot is being updated. Try again.'});
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > MAX_FILE) return json(res, 413, {error: `Files must be ${MAX_FILE_MB} MB or less`});
  if (!['application/octet-stream', 'application/octet-stream; charset=binary'].includes((req.headers['content-type'] || '').toLowerCase())) {
    return json(res, 415, {error: 'Unsupported upload request'});
  }
  let filename = 'file';
  try { filename = safeName(decodeURIComponent(req.headers['x-file-name'] || 'file')); }
  catch (_) { return json(res, 400, {error: 'Invalid file name'}); }
  if (!filename || filename.length > 180) return json(res, 400, {error: 'Invalid file name'});
  busySlots.add(slot.id);
  const diskId = crypto.randomUUID();
  const tempPath = path.join(UPLOADS_DIR, diskId);
  let saved = 0;
  let exceeded = false;
  try {
    // Writes stream incrementally; never buffers whole files in memory.
    const out = fs.createWriteStream(tempPath, {flags: 'wx'});
    try {
      for await (const chunk of req) {
        saved += chunk.length;
        if (saved > MAX_FILE) {
          exceeded = true;
          break;
        }
        if (!out.write(chunk)) await new Promise((resolve, reject) => {
          out.once('drain', resolve); out.once('error', reject);
        });
      }
      out.end();
      await new Promise((resolve, reject) => {
        out.once('finish', resolve); out.once('error', reject);
      });
    } catch (e) { out.destroy(); throw e; }
    if (exceeded || saved === 0) {
      fs.rmSync(tempPath, {force: true});
      return json(res, exceeded ? 413 : 400, {error: exceeded ? `Files must be ${MAX_FILE_MB} MB or less` : 'Cannot upload an empty file'});
    }
    const old = slot.file;
    slot.file = {diskId, name: filename, size: saved, by: session.name, at: Date.now()};
    try { saveSlots(); }
    catch (e) { slot.file = old; throw e; }
    if (old) fs.rmSync(path.join(UPLOADS_DIR, old.diskId), {force: true});
    json(res, 200, {ok: true});
    broadcast();
    eventMessage(session.name, `${old ? 'replaced' : 'uploaded'} a file in slot ${String(slot.id).padStart(2, '0')}`);
  } catch (e) {
    fs.rmSync(tempPath, {force: true});
    if (!res.headersSent) json(res, 500, {error: 'Upload failed'});
    console.error('Upload error:', e.message);
  } finally { busySlots.delete(slot.id); }
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch (_) { return json(res, 400, {error: 'Bad URL'}); }
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html'))
    return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && pathname === '/app.css')
    return serveStatic(res, 'app.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && pathname === '/app.js')
    return serveStatic(res, 'app.js', 'text/javascript; charset=utf-8');
  if (req.method === 'GET' && pathname === '/favicon.svg')
    return serveStatic(res, 'favicon.svg', 'image/svg+xml');
  if (req.method === 'GET' && pathname === '/health')
    return json(res, 200, {ok: true, name: '50 File Room'});
  if (!pathname.startsWith('/api/')) return json(res, 404, {error: 'Not found'});
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return json(res, 405, {error: 'Method not allowed'});
  if (req.method !== 'GET' && !secureOrigin(req)) return json(res, 403, {error: 'Invalid request origin'});

  try {
    if (pathname === '/api/config' && req.method === 'GET')
      return json(res, 200, {hasPasscode: ROOM_PASSCODE.length > 0, maxUsers: MAX_USERS, maxFileMB: MAX_FILE_MB});
    if (pathname === '/api/join' && req.method === 'POST') {
      const input = await readJson(req);
      const existing = participant(req);
      if (existing) return json(res, 200, {ok: true, name: existing.name});
      cleanSessions();
      if (occupiedCount() >= MAX_USERS) return json(res, 409, {error: 'Room full — all 10 places are taken. Try again after someone leaves.'});
      const name = text(input?.name, 24);
      if (name.length < 2) return json(res, 400, {error: 'Enter a name with at least 2 characters'});
      if (ROOM_PASSCODE && input?.passcode !== ROOM_PASSCODE) return json(res, 403, {error: 'Incorrect room passcode'});
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, {name, lastSeen: Date.now(), streams: new Set()});
      const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
      json(res, 200, {ok: true, name}, {
        'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`
      });
      broadcast();
      return;
    }
    const session = participant(req);
    if (!session) return json(res, 401, {error: 'Join the room first'});
    if (pathname === '/api/leave' && req.method === 'POST') {
      sessions.delete(cookieValue(req));
      for (const s of session.streams) s.end();
      json(res, 200, {ok: true}, {'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`});
      broadcast();
      return;
    }
    if (pathname === '/api/state' && req.method === 'GET')
      return json(res, 200, { ...publicState(), me: session.name });
    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      session.streams.add(res);
      session.lastSeen = Date.now();
      emit(res, 'state', publicState());
      broadcast();
      const ping = setInterval(() => {
        if (!res.destroyed) res.write(': keepalive\n\n');
        session.lastSeen = Date.now();
      }, 15000);
      res.on('close', () => {
        clearInterval(ping);
        session.streams.delete(res);
        session.lastSeen = Date.now();
        broadcast();
      });
      return;
    }
    const selected = parseSlot(pathname);
    if (!selected) return json(res, 404, {error: 'Not found'});
    const {slot, action} = selected;
    if (busySlots.has(slot.id)) return json(res, 409, {error: 'Slot is being updated. Try again.'});
    if (action === 'name' && req.method === 'POST') {
      const data = await readJson(req);
      slot.label = text(data?.name, 60);
      saveSlots();
      json(res, 200, {ok: true});
      broadcast();
      return;
    }
    if (action === 'file-name' && req.method === 'POST') {
      if (!slot.file) return json(res, 404, {error: 'No file in this slot'});
      const data = await readJson(req);
      const name = safeName(data?.name);
      if (!text(data?.name, 180)) return json(res, 400, {error: 'Enter a file name'});
      slot.file.name = name;
      saveSlots();
      json(res, 200, {ok: true});
      broadcast();
      return;
    }
    if (action === 'file' && req.method === 'PUT') return upload(req, res, slot, session);
    if (action === 'file' && req.method === 'GET') {
      if (!slot.file) return json(res, 404, {error: 'No file in this slot'});
      return fileDownload(res, slot.file);
    }
    if (action === 'file' && req.method === 'DELETE') {
      if (!slot.file) return json(res, 404, {error: 'No file in this slot'});
      const old = slot.file;
      slot.file = null;
      saveSlots();
      fs.rmSync(path.join(UPLOADS_DIR, old.diskId), {force: true});
      json(res, 200, {ok: true});
      broadcast();
      eventMessage(session.name, `removed the file from slot ${String(slot.id).padStart(2, '0')}`);
      return;
    }
    return json(res, 405, {error: 'Method not allowed'});
  } catch (e) {
    console.error('Request error:', e.message);
    if (!res.headersSent) json(res, e.status || 500, {error: e.status ? e.message : 'Server error'});
  }
});
setInterval(cleanSessions, 5000).unref();
server.listen(PORT, HOST, () => {
  console.log(`50 File Room listening on http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR} | max users: ${MAX_USERS} | max file: ${MAX_FILE_MB} MB`);
});
