/*
 * homosapiens.ro: static site (./public) plus a small API for the /update admin page.
 *
 * Storage: one SQLite-backed Durable Object ("main") holds the editable content (JSON),
 * its version history, uploaded images, login sessions and failed-login counters.
 *
 * Accounts come from the ADMIN_USERS secret, set in the Cloudflare dashboard:
 *   user:password;user2:password2          (plain)
 *   user:pbkdf2$100000$<salt>$<hash>       (hashed, produced by /update/parola/)
 * Both forms can be mixed. Nothing about accounts is stored in this repository.
 */
import { DurableObject } from 'cloudflare:workers';

const COOKIE = 'hs_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_CONTENT = 900 * 1024;
const MAX_IMAGE = 1500 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_IP = 8;
const MAX_FAILS_USER = 12;
const HISTORY_KEEP = 40;
const ROLES = ['prog', 'eng', 'cad', 'pr', 'drive', 'hwcad', 'driveEng', 'peer', 'member'];
const LANGS = ['ro', 'en', 'fr', 'zh'];

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const randomId = (bytes = 16) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

export class HsStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, who TEXT NOT NULL, note TEXT, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS imgs (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, ts INTEGER NOT NULL, who TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user TEXT NOT NULL, exp INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS fails (k TEXT NOT NULL, ts INTEGER NOT NULL)');
  }

  rows(query, ...params) { return this.sql.exec(query, ...params).toArray(); }

  getContent() {
    const r = this.rows("SELECT v FROM kv WHERE k = 'content'");
    const m = this.rows("SELECT v FROM kv WHERE k = 'meta'");
    return r.length ? { content: r[0].v, meta: m.length ? m[0].v : null } : null;
  }

  saveContent(v, who, note) {
    const ts = Date.now();
    const meta = JSON.stringify({ ts, who });
    this.sql.exec("INSERT INTO kv (k, v) VALUES ('content', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", v);
    this.sql.exec("INSERT INTO kv (k, v) VALUES ('meta', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", meta);
    this.sql.exec('INSERT INTO history (ts, who, note, v) VALUES (?, ?, ?, ?)', ts, who, note || '', v);
    this.sql.exec(`DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ${HISTORY_KEEP})`);
    return { ts, who };
  }

  listHistory() {
    return this.rows('SELECT id, ts, who, note, length(v) AS size FROM history ORDER BY id DESC');
  }

  getHistory(id) {
    const r = this.rows('SELECT v FROM history WHERE id = ?', id);
    return r.length ? r[0].v : null;
  }

  putImage(type, data, who) {
    const id = randomId(16);
    this.sql.exec('INSERT INTO imgs (id, type, data, ts, who) VALUES (?, ?, ?, ?, ?)', id, type, data, Date.now(), who);
    return id;
  }

  getImage(id) {
    const r = this.rows('SELECT type, data FROM imgs WHERE id = ?', id);
    return r.length ? { type: r[0].type, data: r[0].data } : null;
  }

  // Images uploaded more than 3 days ago that no saved version (current or history) uses any more.
  pruneImages() {
    const used = new Set();
    const texts = this.rows('SELECT v FROM history').map((x) => x.v);
    const cur = this.getContent();
    if (cur) texts.push(cur.content);
    for (const t of texts) for (const m of t.matchAll(/\/api\/img\/([a-f0-9]{32})/g)) used.add(m[1]);
    const old = this.rows('SELECT id FROM imgs WHERE ts < ?', Date.now() - 3 * 24 * 3600 * 1000);
    let n = 0;
    for (const { id } of old) if (!used.has(id)) { this.sql.exec('DELETE FROM imgs WHERE id = ?', id); n++; }
    return n;
  }

  createSession(user) {
    const token = randomId(32);
    const now = Date.now();
    this.sql.exec('DELETE FROM sessions WHERE exp < ?', now);
    this.sql.exec('INSERT INTO sessions (token, user, exp) VALUES (?, ?, ?)', token, user, now + SESSION_MS);
    return token;
  }

  getSession(token) {
    if (!token) return null;
    const r = this.rows('SELECT user, exp FROM sessions WHERE token = ?', token);
    if (!r.length) return null;
    if (r[0].exp < Date.now()) { this.sql.exec('DELETE FROM sessions WHERE token = ?', token); return null; }
    return r[0].user;
  }

  endSession(token) {
    if (token) this.sql.exec('DELETE FROM sessions WHERE token = ?', token);
    return true;
  }

  failCount(key) {
    this.sql.exec('DELETE FROM fails WHERE ts < ?', Date.now() - FAIL_WINDOW_MS);
    return this.rows('SELECT COUNT(*) AS n FROM fails WHERE k = ?', key)[0].n;
  }

  noteFail(key) { this.sql.exec('INSERT INTO fails (k, ts) VALUES (?, ?)', key, Date.now()); return true; }

  clearFails(key) { this.sql.exec('DELETE FROM fails WHERE k = ?', key); return true; }
}

/* ---------- helpers ---------- */

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
});

const err = (status, code, message) => json({ error: code, message }, status);

function getCookie(request, name) {
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).host === url.host; } catch { return false; }
}

const te = new TextEncoder();

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)));
}

function equalBytes(a, b) {
  if (crypto.subtle && typeof crypto.subtle.timingSafeEqual === 'function' && a.byteLength === b.byteLength) {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function b64decode(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(pass, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function parseUsers(raw) {
  const out = [];
  for (const entry of String(raw || '').split(/[;\n]/)) {
    const e = entry.trim();
    const i = e.indexOf(':');
    if (i < 1) continue;
    out.push({ user: e.slice(0, i).trim(), secret: e.slice(i + 1) });
  }
  return out;
}

async function checkPassword(env, user, pass) {
  const users = parseUsers(env.ADMIN_USERS);
  const found = users.find((u) => u.user.toLowerCase() === user.toLowerCase());
  if (!found) {
    await pbkdf2(pass, te.encode('timing-equalizer'), 100000);
    return null;
  }
  const s = found.secret;
  if (s.startsWith('pbkdf2$')) {
    const [, it, salt, hash] = s.split('$');
    const iterations = Math.min(parseInt(it, 10) || 100000, 100000);
    const got = await pbkdf2(pass, b64decode(salt), iterations);
    return equalBytes(got, b64decode(hash)) ? found.user : null;
  }
  return equalBytes(await sha256(pass), await sha256(s)) ? found.user : null;
}

/* ---------- content validation ---------- */

function cleanContent(c) {
  if (!c || typeof c !== 'object') throw new Error('bad content');
  const str = (x, n) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');
  const bool = (x) => x === true;
  const arr = (x, n) => (Array.isArray(x) ? x.slice(0, n) : []);
  const idOf = (x) => (typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x) ? x : randomId(6));
  const ml = (x, n) => {
    if (typeof x === 'string') return x.trim() ? { ro: str(x, n) } : {};
    const o = {};
    for (const k of LANGS) { const v = str(x && x[k], n); if (v) o[k] = v; }
    return o;
  };
  const img = (x) => (typeof x === 'string' && (/^\/assets\/[A-Za-z0-9/_.-]{1,120}$/.test(x) || /^\/api\/img\/[a-f0-9]{32}$/.test(x)) ? x : '');
  const num = (x, lo, hi) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };

  const seasons = arr(c.seasons, 40).map((s) => ({
    id: idOf(s && s.id),
    active: bool(s && s.active),
    season: str(s && s.season, 24),
    game: str(s && s.game, 60),
    awards: arr(s && s.awards, 80).map((a) => ({
      id: idOf(a && a.id),
      active: bool(a && a.active),
      kind: a && a.kind === 'result' ? 'result' : 'award',
      name: ml(a && a.name, 120),
      place: [0, 1, 2, 3].includes(a && a.place) ? a.place : 0,
      event: ml(a && a.event, 160),
      country: str(a && a.country, 40),
      note: ml(a && a.note, 200)
    }))
  }));
  const team = arr(c.team, 150).map((m) => ({
    id: idOf(m && m.id),
    active: bool(m && m.active),
    name: str(m && m.name, 80),
    role: ROLES.includes(m && m.role) ? m.role : 'member',
    roleText: str(m && m.roleText, 80),
    alumni: bool(m && m.alumni),
    grad: str(m && m.grad, 12),
    photo: img(m && m.photo)
  }));
  const sponsors = arr(c.sponsors, 250).map((s) => ({
    id: idOf(s && s.id),
    active: bool(s && s.active),
    name: str(s && s.name, 100),
    logo: img(s && s.logo),
    ar: num(s && s.ar, 0, 40),
    size: ['x', 'w', 'm', 's'].includes(s && s.size) ? s.size : '',
    mono: !(s && s.mono === false)
  }));
  return { v: 1, seasons, team, sponsors };
}

/* ---------- API ---------- */

async function api(request, env, url) {
  const store = env.STORE.get(env.STORE.idFromName('main'));
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/version' && method === 'GET') {
    const v = env.CF_VERSION_METADATA || {};
    return json({ version: v.id || null, tag: v.tag || null, configured: !!env.ADMIN_USERS });
  }

  if (path === '/api/content' && method === 'GET') {
    const cur = await store.getContent();
    if (!cur) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    return new Response(cur.content, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' } });
  }

  const img = path.match(/^\/api\/img\/([a-f0-9]{32})$/);
  if (img && method === 'GET') {
    const found = await store.getImage(img[1]);
    if (!found) return new Response('Not found', { status: 404 });
    return new Response(found.data, { headers: { 'content-type': found.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
  }

  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request, url)) return err(403, 'origin', 'Cerere respinsă.');

  if (path === '/api/login' && method === 'POST') {
    if (!env.ADMIN_USERS) return err(503, 'not_configured', 'Conturile nu sunt configurate încă în Cloudflare (secretul ADMIN_USERS).');
    let body;
    try { body = await request.json(); } catch { return err(400, 'bad_request', 'Date invalide.'); }
    const user = String((body && body.user) || '').trim().slice(0, 60);
    const pass = String((body && body.pass) || '').slice(0, 200);
    if (!user || !pass) return err(400, 'missing', 'Scrie utilizatorul și parola.');
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const ipKey = 'ip:' + ip;
    const userKey = 'u:' + user.toLowerCase();
    if ((await store.failCount(ipKey)) >= MAX_FAILS_IP || (await store.failCount(userKey)) >= MAX_FAILS_USER) {
      return err(429, 'locked', 'Prea multe încercări. Mai încearcă peste 15 minute.');
    }
    const name = await checkPassword(env, user, pass);
    if (!name) {
      await store.noteFail(ipKey);
      await store.noteFail(userKey);
      return err(401, 'bad_login', 'Utilizator sau parolă greșită.');
    }
    await store.clearFails(ipKey);
    await store.clearFails(userKey);
    const token = await store.createSession(name);
    return json({ user: name }, 200, { 'set-cookie': sessionCookie(token, SESSION_MS / 1000) });
  }

  const token = getCookie(request, COOKIE);

  if (path === '/api/logout' && method === 'POST') {
    await store.endSession(token);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  const user = await store.getSession(token);

  if (path === '/api/me' && method === 'GET') {
    if (!user) return err(401, 'auth', 'Nu ești conectat.');
    const cur = await store.getContent();
    return json({ user, meta: cur && cur.meta ? JSON.parse(cur.meta) : null });
  }

  if (!path.startsWith('/api/admin/')) return err(404, 'not_found', 'Adresă necunoscută.');
  if (!user) return err(401, 'auth', 'Sesiunea a expirat. Conectează-te din nou.');

  if (path === '/api/admin/content' && method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_CONTENT) return err(413, 'too_big', 'Conținutul e prea mare.');
    let clean;
    try { clean = cleanContent(JSON.parse(text)); } catch { return err(400, 'bad_content', 'Conținut invalid.'); }
    const meta = await store.saveContent(JSON.stringify(clean), user, '');
    await store.pruneImages();
    return json({ ok: true, meta, content: clean });
  }

  if (path === '/api/admin/upload' && method === 'POST') {
    const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) return err(415, 'type', 'Folosește o imagine JPG, PNG sau WebP.');
    const data = await request.arrayBuffer();
    if (data.byteLength === 0) return err(400, 'empty', 'Fișier gol.');
    if (data.byteLength > MAX_IMAGE) return err(413, 'too_big', 'Imaginea e prea mare.');
    const id = await store.putImage(type, data, user);
    return json({ url: '/api/img/' + id });
  }

  if (path === '/api/admin/history' && method === 'GET') {
    return json({ items: await store.listHistory() });
  }

  const hist = path.match(/^\/api\/admin\/history\/(\d{1,10})$/);
  if (hist && method === 'GET') {
    const v = await store.getHistory(Number(hist[1]));
    if (!v) return err(404, 'not_found', 'Versiunea nu există.');
    return new Response(v, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }

  const rest = path.match(/^\/api\/admin\/restore\/(\d{1,10})$/);
  if (rest && method === 'POST') {
    const v = await store.getHistory(Number(rest[1]));
    if (!v) return err(404, 'not_found', 'Versiunea nu există.');
    const meta = await store.saveContent(v, user, 'restaurare #' + rest[1]);
    return json({ ok: true, meta, content: JSON.parse(v) });
  }

  return err(404, 'not_found', 'Adresă necunoscută.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (e) {
        return err(500, 'server', 'Eroare pe server. Încearcă din nou.');
      }
    }
    return env.ASSETS.fetch(request);
  }
};
