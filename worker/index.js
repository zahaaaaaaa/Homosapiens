/*
 * homosapiens.ro: static site (./public) plus a small API for the /update admin page
 * and for the contact form.
 *
 * Storage: one SQLite-backed Durable Object ("main") holds the editable content (JSON),
 * its version history, uploaded images, login sessions, failed-login counters and the
 * messages sent through the contact form.
 *
 * Accounts come only from the ADMIN_USERS secret in the Cloudflare dashboard (Worker
 * "homosapienss" -> Settings -> Variables and Secrets, type Secret), in either form:
 *   user:password;user2:password2          (plain)
 *   user:pbkdf2$100000$<salt>$<hash>       (PBKDF2-SHA256, salt and hash in base64)
 * Both forms can be mixed. Nothing about accounts is stored in this repository.
 *
 * Recruitment: while "recruiting" is on in the saved settings, POST /api/recruit stores an
 * application (table apps) and returns a code (HS-XXXX-XXXX); POST /api/recruit/status tells the
 * applicant their status by that code. The team decides on /update ("Recrutări" tab).
 *
 * Link page: GET /redirect (no file in ./public, so it reaches the worker) renders the team's
 * links saved on /update ("Linkuri și QR" tab), in Romanian or English. The QR codes in
 * /assets/img/qr-homosapiens* point to it.
 *
 * Contact form email: the MAILER binding (send_email in wrangler.jsonc) sends each message
 * to the team inbox. It works once Email Routing is on for homosapiens.ro and the inbox is a
 * verified destination address. Until then messages are still saved and shown on /update.
 */
import { DurableObject } from 'cloudflare:workers';
import LINK_PAGE from './redirect-page.mjs';
import { formular230, incomeYear } from './f230.mjs';

const COOKIE = 'hs_admin';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_CONTENT = 900 * 1024;
const MAX_IMAGE = 1500 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Documents for sponsors (the sponsorship contract and the like), uploaded on /update.
const DOC_TYPES = {
  'application/pdf': 'pdf', 'application/msword': 'doc', 'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx'
};
const MAX_DOC = 1900 * 1024;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_IP = 8;
const MAX_FAILS_USER = 12;
const HISTORY_KEEP = 40;
const ROLES = ['software', 'hardware', 'pr', 'peer', 'member', 'prog', 'eng', 'cad', 'prLead', 'drive', 'hwcad', 'driveEng'];
const CURRENCIES = ['RON', 'EUR', 'USD', 'GBP'];
const SITE_EMAIL = 'team@homosapiens.ro';
const LANGS = ['ro', 'en', 'fr', 'zh'];
const LINK_KINDS = ['site', 'instagram', 'tiktok', 'youtube', 'facebook', 'linkedin', 'email', 'sponsor', 'join', 'tax', 'link'];
const MSG_KEEP = 1000;
const HIT_WINDOW_MS = 24 * 3600 * 1000;
const MAIL_TO = 'thehomosapiens123@gmail.com';
const APP_KEEP = 3000;
const APP_STATUS = ['new', 'interview', 'accepted', 'rejected'];
const DEPTS = { prog: 'Programare', eng: 'Inginerie', cad: 'CAD', pr: 'PR' };
const GRADES = { 9: 'a IX-a', 10: 'a X-a', 11: 'a XI-a', 12: 'a XII-a' };
const HOURS = { h1: 'Sub 3 ore', h2: '3-6 ore', h3: '6-10 ore', h4: 'Peste 10 ore' };
const SOURCES = { s1: 'De la prieteni sau colegi', s2: 'Instagram, Facebook sau TikTok', s3: 'La școală', s4: 'La un eveniment', s5: 'Altfel' };
const CODE_ABC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAIL_FROM = 'site@homosapiens.ro';

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const randomId = (bytes = 16) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
// 8 characters from a 32-letter alphabet without look-alikes (0/O, 1/I): about 10^12 codes.
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => CODE_ABC[b % 32]).join('');
const showCode = (c) => 'HS-' + c.slice(0, 4) + '-' + c.slice(4);
const normCode = (x) => {
  let v = String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v.length === 10 && v.startsWith('HS')) v = v.slice(2);
  return v;
};

export class HsStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, who TEXT NOT NULL, note TEXT, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS imgs (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, ts INTEGER NOT NULL, who TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user TEXT NOT NULL, exp INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS fails (k TEXT NOT NULL, ts INTEGER NOT NULL)');
    this.sql.exec("CREATE TABLE IF NOT EXISTS msgs (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', mail TEXT)");
    this.sql.exec('CREATE TABLE IF NOT EXISTS hits (k TEXT NOT NULL, ts INTEGER NOT NULL)');
    this.sql.exec("CREATE TABLE IF NOT EXISTS apps (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', note TEXT NOT NULL DEFAULT '', updated INTEGER, mail TEXT)");
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

  // Images and documents uploaded more than 3 days ago that no saved version (current or history) uses any more.
  pruneImages() {
    const used = new Set();
    const texts = this.rows('SELECT v FROM history').map((x) => x.v);
    const cur = this.getContent();
    if (cur) texts.push(cur.content);
    for (const t of texts) for (const m of t.matchAll(/\/api\/(?:img|file)\/([a-f0-9]{32})/g)) used.add(m[1]);
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

  /* contact form */
  hitCount(key, windowMs) {
    this.sql.exec('DELETE FROM hits WHERE ts < ?', Date.now() - HIT_WINDOW_MS);
    return this.rows('SELECT COUNT(*) AS n FROM hits WHERE k = ? AND ts >= ?', key, Date.now() - windowMs)[0].n;
  }

  noteHit(key) { this.sql.exec('INSERT INTO hits (k, ts) VALUES (?, ?)', key, Date.now()); return true; }

  addMessage(data) {
    const id = randomId(8);
    const ts = Date.now();
    this.sql.exec("INSERT INTO msgs (id, ts, data, status) VALUES (?, ?, ?, 'new')", id, ts, data);
    this.sql.exec(`DELETE FROM msgs WHERE id NOT IN (SELECT id FROM msgs ORDER BY ts DESC LIMIT ${MSG_KEEP})`);
    return { id, ts };
  }

  setMessageMail(id, mail) {
    this.sql.exec('UPDATE msgs SET mail = ? WHERE id = ?', mail, id);
    this.sql.exec("INSERT INTO kv (k, v) VALUES ('mail', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", mail);
    return true;
  }

  noteMail(mail) {
    this.sql.exec("INSERT INTO kv (k, v) VALUES ('mail', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", mail);
    return true;
  }

  lastMail() {
    const r = this.rows("SELECT v FROM kv WHERE k = 'mail'");
    return r.length ? r[0].v : null;
  }

  listMessages(limit) {
    return this.rows('SELECT id, ts, data, status, mail FROM msgs ORDER BY ts DESC LIMIT ?', limit);
  }

  setMessageStatus(id, status) {
    this.sql.exec('UPDATE msgs SET status = ? WHERE id = ?', status, id);
    return this.rows('SELECT COUNT(*) AS n FROM msgs WHERE id = ?', id)[0].n > 0;
  }

  deleteMessage(id) {
    const n = this.rows('SELECT COUNT(*) AS n FROM msgs WHERE id = ?', id)[0].n;
    this.sql.exec('DELETE FROM msgs WHERE id = ?', id);
    return n > 0;
  }

  /* recruitment */
  addApp(data) {
    const id = randomId(8);
    const ts = Date.now();
    let code = newCode();
    for (let i = 0; i < 8 && this.rows('SELECT 1 FROM apps WHERE code = ?', code).length; i++) code = newCode();
    this.sql.exec("INSERT INTO apps (id, code, ts, data, status, note) VALUES (?, ?, ?, ?, 'new', '')", id, code, ts, data);
    return { id, code, ts };
  }

  countApps() { return this.rows('SELECT COUNT(*) AS n FROM apps')[0].n; }

  getAppByCode(code) {
    const r = this.rows('SELECT data, status, note FROM apps WHERE code = ?', code);
    return r.length ? r[0] : null;
  }

  setAppMail(id, mail) {
    this.sql.exec('UPDATE apps SET mail = ? WHERE id = ?', mail, id);
    this.sql.exec("INSERT INTO kv (k, v) VALUES ('mail', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", mail);
    return true;
  }

  listApps() {
    return this.rows('SELECT id, code, ts, data, status, note, updated, mail FROM apps ORDER BY ts DESC');
  }

  updateApp(id, status, note) {
    const n = this.rows('SELECT COUNT(*) AS n FROM apps WHERE id = ?', id)[0].n;
    this.sql.exec('UPDATE apps SET status = ?, note = ?, updated = ? WHERE id = ?', status, note, Date.now(), id);
    return n > 0;
  }

  deleteApp(id) {
    const n = this.rows('SELECT COUNT(*) AS n FROM apps WHERE id = ?', id)[0].n;
    this.sql.exec('DELETE FROM apps WHERE id = ?', id);
    return n > 0;
  }

  clearApps() {
    const n = this.countApps();
    this.sql.exec('DELETE FROM apps');
    return n;
  }
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
  const set = c.settings && typeof c.settings === 'object' ? c.settings : {};
  const mail = str(set.email, 120);
  const settings = {
    recruiting: bool(set.recruiting),
    recruitResults: bool(set.recruitResults),
    recruitNote: ml(set.recruitNote, 400),
    showRobots: set.showRobots !== false,
    email: EMAIL_RE.test(mail) ? mail : SITE_EMAIL,
    linksBadge: set.linksBadge === undefined ? undefined : ml(set.linksBadge, 120),
    // where the names on the team photo are: About page, top of the Team page, or nowhere
    whoAt: ['about', 'team', 'off'].includes(set.whoAt) ? set.whoAt : 'about'
  };
  const contacts = arr(c.contacts, 12).map((p) => ({
    id: idOf(p && p.id),
    active: bool(p && p.active),
    name: str(p && p.name, 80),
    role: ml(p && p.role, 60),
    phone: str(p && p.phone, 32).replace(/[^\d+ ()-]/g, '').trim(),
    photo: img(p && p.photo)
  }));
  const bank = arr(c.bank, 12).map((b) => ({
    id: idOf(b && b.id),
    active: bool(b && b.active),
    cur: CURRENCIES.includes(b && b.cur) ? b.cur : 'RON',
    holder: str(b && b.holder, 100),
    iban: str(b && b.iban, 60).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 34),
    bank: str(b && b.bank, 60)
  }));
  // Content without a links list (saved before they existed) keeps none; migrate() adds the built-in ones.
  const links = !Array.isArray(c.links) ? undefined : arr(c.links, 24).map((l) => {
    const kind = LINK_KINDS.includes(l && l.kind) ? l.kind : 'link';
    return { id: idOf(l && l.id), active: bool(l && l.active), kind, label: str(l && l.label, 60), url: cleanLinkUrl(kind, str(l && l.url, 300)) };
  });
  const robots = arr(c.robots, 24).map((r) => ({
    id: idOf(r && r.id),
    active: bool(r && r.active),
    season: str(r && r.season, 40),
    name: ml(r && r.name, 80),
    text: ml(r && r.text, 320),
    photo: img(r && r.photo)
  }));
  // The photo at the top of the Team page and who is where in it (percent of the photo; m = member id).
  const tpIn = c.teamPhoto && typeof c.teamPhoto === 'object' ? c.teamPhoto : null;
  const teamPhoto = !tpIn ? undefined : {
    photo: img(tpIn.photo),
    w: Math.round(num(tpIn.w, 0, 20000)),
    h: Math.round(num(tpIn.h, 0, 20000)),
    py: num(tpIn.py, 0, 100),
    tags: arr(tpIn.tags, 80).map((g) => ({
      id: idOf(g && g.id),
      m: typeof (g && g.m) === 'string' && /^[A-Za-z0-9_-]{0,40}$/.test(g.m) ? g.m : '',
      x: num(g && g.x, 0, 100),
      y: num(g && g.y, 0, 100),
      r: num(g && g.r, 0.3, 20)
    }))
  };
  // The Support page: 3.5% of income tax (Formular 230, filled in with the NGO below) and sponsorship.
  const spIn = c.support && typeof c.support === 'object' ? c.support : {};
  const ngIn = spIn.ngo && typeof spIn.ngo === 'object' ? spIn.ngo : {};
  const support = {
    on: bool(spIn.on),
    ngo: {
      name: str(ngIn.name, 120),
      cif: str(ngIn.cif, 24).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14),
      iban: str(ngIn.iban, 60).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 34),
      bank: str(ngIn.bank, 60),
      addr: str(ngIn.addr, 200),
      rub: bool(ngIn.rub)
    },
    where: ml(spIn.where, 400),
    docs: arr(spIn.docs, 12).map((x) => ({
      id: idOf(x && x.id),
      title: ml(x && x.title, 100),
      url: typeof (x && x.url) === 'string' && /^\/api\/file\/[a-f0-9]{32}\/[^\s/<>"'`\\]{1,240}$/.test(x.url) ? x.url : '',
      name: str(x && x.name, 120).replace(/[\\/<>"'`]/g, ''),
      size: Math.round(num(x && x.size, 0, MAX_DOC)),
      type: Object.values(DOC_TYPES).includes(x && x.type) ? x.type : 'pdf'
    })).filter((x) => x.url)
  };
  const mig = arr(c.mig, 20).filter((x) => typeof x === 'string' && /^[\w.-]{1,40}$/.test(x));
  return { v: 1, seasons, team, sponsors, settings, contacts, bank, robots, links, teamPhoto, support, mig };
}

/* A link on /redirect: https address (http is upgraded, a bare "instagram.com/x" gets https://),
 * a path on this site ("/#contact"), or for kind "email" an email address. Anything else is dropped. */
function cleanLinkUrl(kind, u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (kind === 'email') { s = s.replace(/^mailto:/i, ''); return EMAIL_RE.test(s) ? s : ''; }
  if (/^\/(?!\/)[^\s<>"'`\\]*$/.test(s)) return s;
  if (/^http:\/\//i.test(s)) s = 'https://' + s.slice(7);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(s)) s = 'https://' + s;
  try {
    const x = new URL(s);
    if (x.protocol !== 'https:' || !x.hostname.includes('.') || /[\s<>"'`\\]/.test(s)) return '';
    return x.href;
  } catch { return ''; }
}

/* ---------- one-time content update (September 2026 partnership proposal) ----------
 * Content saved on /update before this release keeps what the team edited; only values
 * that are still exactly the old built-in ones are refreshed, and new sponsors are added.
 * Applied when the content is read; it becomes permanent with the next save on /update. */

const MIG = '2026-09-propunere';
const NEW_SPONSORS = ['sp-brl', 'sp-lincoln', 'sp-firesting', 'sp-prevstin', 'sp-24sign', 'sp-razedent', 'sp-eurolia'];
const OLD_AWARD_TEXT = {
  'a2526-1': { event: 'Western Edge Premier Event, Long Beach' },
  'a2526-2': { event: 'Turneul regional, Piatra Neamț' },
  'a2526-4': { name: 'Finaliști', note: '577 de puncte fără penalizări' },
  'a2425-1': { event: 'Italy Championship', note: '' },
  'a2425-2': { event: 'Michiana Premier Event, South Bend' },
  'a2324-1': { event: 'Turneu regional, Iași' },
  'a2223-1': { event: 'Calificări, București' }
};
let defaultsCache = null;

async function builtInContent(env, url) {
  if (defaultsCache) return defaultsCache;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/content-default.json', url).toString()));
    if (!res.ok) return null;
    defaultsCache = await res.json();
    return defaultsCache;
  } catch { return null; }
}

async function migrateProposal(c, env, url) {
  if (!c || c.v !== 1) return false;
  const done = Array.isArray(c.mig) ? c.mig : [];
  if (done.includes(MIG)) return false;
  const def = await builtInContent(env, url);
  if (!def) return false;
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');
  c.sponsors = Array.isArray(c.sponsors) ? c.sponsors : [];
  const ids = new Set(c.sponsors.map((s) => s && s.id));
  const names = new Set(c.sponsors.map((s) => norm(s && s.name)));
  for (const s of def.sponsors || []) {
    if (NEW_SPONSORS.includes(s.id) && !ids.has(s.id) && !names.has(norm(s.name))) c.sponsors.push(s);
  }
  for (const m of c.team || []) {
    if (m && m.id === 'm-cimpeanu' && m.role === 'pr' && !m.roleText) m.role = 'prLead';
  }
  const defAwards = new Map();
  for (const se of def.seasons || []) for (const a of se.awards || []) defAwards.set(a.id, a);
  for (const se of c.seasons || []) {
    for (const a of (se && se.awards) || []) {
      const old = a && OLD_AWARD_TEXT[a.id];
      const fresh = a && defAwards.get(a.id);
      if (!old || !fresh) continue;
      for (const f of ['name', 'event', 'note']) {
        if (!(f in old)) continue;
        const now = (a[f] && a[f].ro) || '';
        if (now === old[f] && fresh[f]) a[f] = fresh[f];
      }
    }
  }
  c.mig = done.concat([MIG]);
  return true;
}

/* Version 3 (September 2026): Software / Hardware / PR roles, and the settings, contacts,
 * bank accounts and robots that /update edits now. Stored content gets the built-in ones once. */
const MIG3 = '2026-09-v3';
const OLD_ROLES = { prog: 'software', eng: 'hardware', cad: 'hardware', hwcad: 'hardware', drive: 'hardware', driveEng: 'hardware', prLead: 'pr' };

/* Links page (September 2026): the built-in links and the line under the team name. */
const MIG7 = '2026-09-links';
/* Version 8: the team photo and the faces found in it, for "who is who" (names are chosen on /update). */
const MIG8 = '2026-09-poza-echipei';

async function migrate(c, env, url) {
  if (!c || c.v !== 1) return false;
  let changed = await migrateProposal(c, env, url);
  let done = Array.isArray(c.mig) ? c.mig : [];
  if (!done.includes(MIG3)) {
    const def = await builtInContent(env, url);
    if (!def) return changed;
    for (const m of c.team || []) if (m && OLD_ROLES[m.role]) m.role = OLD_ROLES[m.role];
    for (const k of ['settings', 'contacts', 'bank', 'robots']) {
      if (c[k] === undefined && def[k] !== undefined) c[k] = def[k];
    }
    c.mig = done = done.concat([MIG3]);
    changed = true;
  }
  if (!Array.isArray(c.links)) {
    const def = await builtInContent(env, url);
    if (def && Array.isArray(def.links)) { c.links = def.links; changed = true; }
  }
  if (!done.includes(MIG7)) {
    const def = await builtInContent(env, url);
    if (!def) return changed;
    if (c.settings && typeof c.settings === 'object' && c.settings.linksBadge === undefined && def.settings) c.settings.linksBadge = def.settings.linksBadge || {};
    c.mig = done = done.concat([MIG7]);
    changed = true;
  }
  if (!done.includes(MIG8)) {
    const def = await builtInContent(env, url);
    if (!def) return changed;
    if (c.teamPhoto === undefined && def.teamPhoto) c.teamPhoto = def.teamPhoto;
    c.mig = done.concat([MIG8]);
    changed = true;
  }
  return changed;
}

/* ---------- contact form ---------- */

const TOPICS = { sponsor: 'Sponsorizare', collab: 'Colaborare', press: 'Presă', other: 'Altceva' };
const SUPPORT = { money: 'Financiar', goods: 'Produse sau materiale', services: 'Servicii', mentoring: 'Mentorat sau vizite' };
const AMOUNTS = { a1: 'Sub 1.000 lei', a2: '1.000-5.000 lei', a3: '5.000-10.000 lei', a4: 'Peste 10.000 lei' };
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

function cleanMessage(b) {
  if (!b || typeof b !== 'object') return null;
  const line = (x, n) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const para = (x, n) => (typeof x === 'string' ? x.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, n) : '');
  const m = {
    topic: Object.hasOwn(TOPICS, b.topic) ? b.topic : 'other',
    name: line(b.name, 120),
    email: line(b.email, 200),
    subject: line(b.subject, 200),
    msg: para(b.msg, 5000),
    company: line(b.company, 160),
    cui: line(b.cui, 40),
    role: line(b.role, 120),
    phone: line(b.phone, 40),
    support: Array.isArray(b.support) ? [...new Set(b.support.filter((x) => Object.hasOwn(SUPPORT, x)))] : [],
    amount: Object.hasOwn(AMOUNTS, b.amount) ? b.amount : '',
    lang: LANGS.includes(b.lang) ? b.lang : 'ro'
  };
  if (!m.name || !EMAIL_RE.test(m.email) || !m.msg) return null;
  if (m.topic === 'sponsor') { if (!m.company) return null; }
  else { m.company = ''; m.cui = ''; m.role = ''; m.phone = ''; m.support = []; m.amount = ''; }
  return m;
}

function mailText(m, ts) {
  const when = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'long', timeStyle: 'short' }).format(new Date(ts));
  const rows = [['Tip', TOPICS[m.topic]], ['Nume', m.name], ['Email', m.email]];
  if (m.topic === 'sponsor') {
    rows.push(['Firma', m.company]);
    if (m.cui) rows.push(['CUI', m.cui]);
    if (m.role) rows.push(['Funcție', m.role]);
    if (m.phone) rows.push(['Telefon', m.phone]);
    if (m.support.length) rows.push(['Sprijin', m.support.map((x) => SUPPORT[x]).join(', ')]);
    if (m.amount) rows.push(['Sumă estimativă', AMOUNTS[m.amount]]);
  }
  if (m.subject) rows.push(['Subiect', m.subject]);
  if (m.lang !== 'ro') rows.push(['Limba site-ului', m.lang.toUpperCase()]);
  const text = 'Mesaj nou de pe homosapiens.ro\n\n'
    + rows.map(([k, v]) => k + ': ' + v).join('\n')
    + '\n\nMesaj:\n' + m.msg
    + '\n\n--\nPrimit pe ' + when + ' (ora României).'
    + '\nApasă Reply ca să-i răspunzi direct lui ' + m.name + '.'
    + '\nToate mesajele sunt și pe https://homosapiens.ro/update/ (tabul Mesaje).\n';
  const about = m.subject || (m.topic === 'sponsor' ? m.company : '') || m.name;
  const subject = ('[Site] ' + TOPICS[m.topic] + ': ' + about).slice(0, 160);
  return { subject, text };
}

function b64utf8(s) {
  const bytes = te.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function rawMime(from, to, replyTo, subject, text) {
  const body = b64utf8(text).replace(/.{1,76}/g, '$&\r\n');
  return [
    'From: =?UTF-8?B?' + b64utf8(from.name) + '?= <' + from.email + '>',
    'To: <' + to + '>',
    'Reply-To: <' + replyTo + '>',
    'Subject: =?UTF-8?B?' + b64utf8(subject) + '?=',
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + randomId(12) + '@homosapiens.ro>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body
  ].join('\r\n');
}

async function sendMail(env, subject, text, replyTo) {
  const ts = Date.now();
  const binding = env.MAILER;
  if (!binding || typeof binding.send !== 'function') return { ok: false, code: 'not_configured', ts };
  const from = { email: env.MAIL_FROM || MAIL_FROM, name: 'Site Homosapiens' };
  const to = env.MAIL_TO || MAIL_TO;
  try {
    const msg = { to, from, subject, text };
    if (replyTo) msg.replyTo = { email: replyTo.email, name: replyTo.name };
    const r = await binding.send(msg);
    return { ok: true, id: r && r.messageId ? String(r.messageId).slice(0, 120) : '', ts };
  } catch (e) {
    if (e instanceof TypeError) {
      // Older runtimes only take a raw MIME EmailMessage.
      try {
        const { EmailMessage } = await import('cloudflare:email');
        await binding.send(new EmailMessage(from.email, to, rawMime(from, to, replyTo ? replyTo.email : from.email, subject, text)));
        return { ok: true, id: '', ts };
      } catch (e2) {
        return { ok: false, code: String((e2 && (e2.code || e2.message)) || 'send_failed').slice(0, 160), ts };
      }
    }
    return { ok: false, code: String((e && (e.code || e.message)) || 'send_failed').slice(0, 160), ts };
  }
}

/* ---------- recruitment ---------- */

function cleanApp(b) {
  if (!b || typeof b !== 'object') return null;
  const txt = (x, n) => (typeof x === 'string' ? x.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n) : '');
  const line = (x, n) => txt(x, n).replace(/\s+/g, ' ');
  const a = {
    last: line(b.last, 60),
    first: line(b.first, 60),
    phone: line(b.phone, 24).replace(/[^\d+ ()-]/g, '').trim(),
    email: line(b.email, 120),
    school: line(b.school, 120),
    grade: Object.prototype.hasOwnProperty.call(GRADES, String(b.grade)) ? String(b.grade) : '',
    dept: Array.isArray(b.dept) ? Object.keys(DEPTS).filter((d) => b.dept.includes(d)) : [],
    exp: txt(b.exp, 2000),
    why: txt(b.why, 2000),
    hours: Object.prototype.hasOwnProperty.call(HOURS, b.hours) ? b.hours : '',
    source: Object.prototype.hasOwnProperty.call(SOURCES, b.source) ? b.source : '',
    other: txt(b.other, 2000),
    lang: ['ro', 'en', 'fr', 'zh'].includes(b.lang) ? b.lang : 'ro'
  };
  if (!a.last || !a.first || a.phone.replace(/\D/g, '').length < 9 || !EMAIL_RE.test(a.email) || !a.school || !a.grade
    || !a.dept.length || !a.exp || !a.why || !a.hours || b.consent !== true) return null;
  return a;
}

function appMailText(a, code, ts) {
  const when = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'long', timeStyle: 'short' }).format(new Date(ts));
  const depts = a.dept.map((d) => DEPTS[d]).join(', ');
  const lines = [
    'Înscriere nouă la recrutări, de pe homosapiens.ro.',
    '',
    'Cod: ' + showCode(code),
    'Primită: ' + when,
    'Nume: ' + a.last,
    'Prenume: ' + a.first,
    'Telefon: ' + a.phone,
    'Email: ' + a.email,
    'Liceul: ' + a.school,
    'Clasa: ' + GRADES[a.grade],
    'Departament: ' + depts,
    'Timp pe săptămână: ' + HOURS[a.hours]
  ];
  if (a.source) lines.push('A aflat: ' + SOURCES[a.source]);
  if (a.lang !== 'ro') lines.push('Limba site-ului: ' + a.lang.toUpperCase());
  lines.push('', 'Ce a făcut până acum:', a.exp, '', 'De ce vrea să intre în echipă:', a.why);
  if (a.other) lines.push('', 'Altceva:', a.other);
  lines.push('', 'Decizia se dă din homosapiens.ro/update, tabul Recrutări. Candidatul își vede rezultatul pe site, cu codul de mai sus.');
  return { subject: '[Recrutări] ' + a.first + ' ' + a.last + ' · ' + depts, text: lines.join('\n') + '\n' };
}

async function siteSettings(store) {
  const cur = await store.getContent();
  let set = {};
  if (cur) {
    try { const c = JSON.parse(cur.content); if (c && c.settings && typeof c.settings === 'object') set = c.settings; } catch { /* closed */ }
  }
  return { recruiting: set.recruiting === true, results: set.recruitResults === true };
}

async function ipKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  return 'c:' + hex(await sha256('hs19053|' + ip)).slice(0, 24);
}

/* ---------- API ---------- */

async function api(request, env, url) {
  const store = env.STORE.get(env.STORE.idFromName('main'));
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/version' && method === 'GET') {
    const v = env.CF_VERSION_METADATA || {};
    return json({ version: v.id || null, tag: v.tag || null, configured: !!env.ADMIN_USERS, mail: !!env.MAILER });
  }

  if (path === '/api/content' && method === 'GET') {
    const cur = await store.getContent();
    if (!cur) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    let body = cur.content;
    try {
      const c = JSON.parse(body);
      if (await migrate(c, env, url)) body = JSON.stringify(c);
    } catch { /* serve what is stored */ }
    return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' } });
  }

  const img = path.match(/^\/api\/img\/([a-f0-9]{32})$/);
  if (img && method === 'GET') {
    const found = await store.getImage(img[1]);
    if (!found) return new Response('Not found', { status: 404 });
    return new Response(found.data, { headers: { 'content-type': found.type, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
  }

  const file = path.match(/^\/api\/file\/([a-f0-9]{32})\/([^/]{1,240})$/);
  if (file && (method === 'GET' || method === 'HEAD')) {
    const found = await store.getImage(file[1]);
    if (!found || !DOC_TYPES[found.type]) return new Response('Not found', { status: 404 });
    let name = file[2];
    try { name = decodeURIComponent(name); } catch { /* keep as is */ }
    name = name.replace(/[\u0000-\u001f\\/"]/g, '') || 'document';
    const ascii = name.normalize('NFD').replace(/[^\x20-\x7e]/g, '').replace(/[;%]/g, '') || 'document';
    const how = found.type === 'application/pdf' ? 'inline' : 'attachment';
    return new Response(method === 'HEAD' ? null : found.data, { headers: {
      'content-type': found.type, 'content-disposition': `${how}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff'
    } });
  }

  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request, url)) return err(403, 'origin', 'Cerere respinsă.');

  if (path === '/api/contact' && method === 'POST') {
    const text = await request.text();
    if (text.length > 20000) return err(413, 'too_big', 'Mesajul e prea lung.');
    let b;
    try { b = JSON.parse(text); } catch { return err(400, 'bad_request', 'Date invalide.'); }
    // Filled honeypot or a form sent faster than a person can type: accept quietly, keep nothing.
    if ((b && typeof b.hp === 'string' && b.hp.trim()) || !(Number(b && b.t) >= 2500)) return json({ ok: true });
    const m = cleanMessage(b);
    if (!m) return err(400, 'invalid', 'Completează numele, un email valid și mesajul.');
    const key = await ipKey(request);
    if ((await store.hitCount(key, 10 * 60 * 1000)) >= 5 || (await store.hitCount(key, HIT_WINDOW_MS)) >= 20 || (await store.hitCount('c:all', HIT_WINDOW_MS)) >= 300) {
      return err(429, 'rate', 'Prea multe mesaje într-un timp scurt. Încearcă din nou mai târziu.');
    }
    await store.noteHit(key);
    await store.noteHit('c:all');
    const saved = await store.addMessage(JSON.stringify(m));
    const { subject, text: body } = mailText(m, saved.ts);
    const mail = await sendMail(env, subject, body, { email: m.email, name: m.name });
    await store.setMessageMail(saved.id, JSON.stringify(mail));
    return json({ ok: true, id: saved.id, mailed: mail.ok });
  }

  if (path === '/api/recruit' && method === 'POST') {
    const text = await request.text();
    if (text.length > 20000) return err(413, 'too_big', 'Înscrierea e prea lungă.');
    let b;
    try { b = JSON.parse(text); } catch { return err(400, 'bad_request', 'Date invalide.'); }
    // Filled honeypot or a form sent faster than a person can fill it: a made-up code, nothing kept.
    if ((b && typeof b.hp === 'string' && b.hp.trim()) || !(Number(b && b.t) >= 3000)) return json({ ok: true, code: showCode(newCode()) });
    if (!(await siteSettings(store)).recruiting) return err(403, 'closed', 'Înscrierile sunt închise.');
    const a = cleanApp(b);
    if (!a) return err(400, 'invalid', 'Completează toate câmpurile obligatorii.');
    const key = 'r' + (await ipKey(request));
    if ((await store.hitCount(key, 10 * 60 * 1000)) >= 3 || (await store.hitCount(key, HIT_WINDOW_MS)) >= 8
      || (await store.hitCount('r:all', HIT_WINDOW_MS)) >= 500 || (await store.countApps()) >= APP_KEEP) {
      return err(429, 'rate', 'Prea multe înscrieri într-un timp scurt. Încearcă din nou mai târziu.');
    }
    await store.noteHit(key);
    await store.noteHit('r:all');
    const saved = await store.addApp(JSON.stringify(a));
    const m = appMailText(a, saved.code, saved.ts);
    const mail = await sendMail(env, m.subject, m.text, { email: a.email, name: a.first + ' ' + a.last });
    await store.setAppMail(saved.id, JSON.stringify(mail));
    return json({ ok: true, code: showCode(saved.code) });
  }

  if (path === '/api/recruit/status' && method === 'POST') {
    let b;
    try { b = await request.json(); } catch { return err(400, 'bad_request', 'Date invalide.'); }
    const set = await siteSettings(store);
    if (!set.recruiting && !set.results) return err(403, 'closed', 'Verificarea rezultatelor nu e deschisă acum.');
    const key = 's' + (await ipKey(request));
    if ((await store.hitCount(key, 10 * 60 * 1000)) >= 30) return err(429, 'rate', 'Prea multe încercări. Mai încearcă peste câteva minute.');
    await store.noteHit(key);
    const code = normCode(b && b.code);
    const app = /^[A-Z0-9]{8}$/.test(code) ? await store.getAppByCode(code) : null;
    if (!app) return err(404, 'not_found', 'Nu am găsit acest cod.');
    let first = '';
    try { first = JSON.parse(app.data).first || ''; } catch { /* no name */ }
    return json({ status: APP_STATUS.includes(app.status) ? app.status : 'new', first, message: app.note || '' });
  }

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
    if (DOC_TYPES[type]) {
      const data = await request.arrayBuffer();
      if (data.byteLength === 0) return err(400, 'empty', 'Fișier gol.');
      if (data.byteLength > MAX_DOC) return err(413, 'too_big', 'Fișierul e prea mare (cel mult 1,9 MB).');
      const name = (url.searchParams.get('name') || '').replace(/[\u0000-\u001f\\/<>"'`]/g, '').trim().slice(0, 120) || 'document.' + DOC_TYPES[type];
      const id = await store.putImage(type, data, user);
      return json({ url: '/api/file/' + id + '/' + encodeURIComponent(name), name, size: data.byteLength, type: DOC_TYPES[type] });
    }
    if (!IMAGE_TYPES.includes(type)) return err(415, 'type', 'Folosește o imagine JPG, PNG sau WebP, ori un document PDF, Word sau ODT.');
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

  if (path === '/api/admin/messages' && method === 'GET') {
    const rows = await store.listMessages(300);
    const items = rows.map((r) => {
      let data = {};
      let mail = null;
      try { data = JSON.parse(r.data); } catch { /* keep empty */ }
      try { mail = r.mail ? JSON.parse(r.mail) : null; } catch { /* keep null */ }
      return Object.assign({}, data, { id: r.id, ts: r.ts, status: r.status, mail });
    });
    const last = await store.lastMail();
    return json({ items, mail: { configured: !!env.MAILER, to: env.MAIL_TO || MAIL_TO, from: env.MAIL_FROM || MAIL_FROM, last: last ? JSON.parse(last) : null } });
  }

  const mst = path.match(/^\/api\/admin\/messages\/([a-f0-9]{16})\/status$/);
  if (mst && method === 'POST') {
    let b;
    try { b = await request.json(); } catch { return err(400, 'bad_request', 'Date invalide.'); }
    const status = b && b.status === 'done' ? 'done' : 'new';
    if (!(await store.setMessageStatus(mst[1], status))) return err(404, 'not_found', 'Mesajul nu există.');
    return json({ ok: true, status });
  }

  const mdel = path.match(/^\/api\/admin\/messages\/([a-f0-9]{16})$/);
  if (mdel && method === 'DELETE') {
    if (!(await store.deleteMessage(mdel[1]))) return err(404, 'not_found', 'Mesajul nu există.');
    return json({ ok: true });
  }

  if (path === '/api/admin/recruits' && method === 'GET') {
    const rows = await store.listApps();
    const items = rows.map((r) => {
      let data = {};
      let mail = null;
      try { data = JSON.parse(r.data); } catch { /* keep empty */ }
      try { mail = r.mail ? JSON.parse(r.mail) : null; } catch { /* keep null */ }
      return Object.assign({}, data, { id: r.id, code: showCode(r.code), ts: r.ts, status: r.status, note: r.note || '', updated: r.updated || null, mail });
    });
    return json({ items });
  }

  if (path === '/api/admin/recruits/clear' && method === 'POST') {
    let b;
    try { b = await request.json(); } catch { return err(400, 'bad_request', 'Date invalide.'); }
    if (!b || b.confirm !== 'STERGE') return err(400, 'confirm', 'Confirmarea lipsește.');
    return json({ ok: true, deleted: await store.clearApps() });
  }

  const rap = path.match(/^\/api\/admin\/recruits\/([a-f0-9]{16})$/);
  if (rap && method === 'POST') {
    let b;
    try { b = await request.json(); } catch { return err(400, 'bad_request', 'Date invalide.'); }
    const status = APP_STATUS.includes(b && b.status) ? b.status : null;
    if (!status) return err(400, 'bad_status', 'Stare necunoscută.');
    const note = typeof (b && b.note) === 'string' ? b.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 1000) : '';
    if (!(await store.updateApp(rap[1], status, note))) return err(404, 'not_found', 'Înscrierea nu există.');
    return json({ ok: true, status, note });
  }
  if (rap && method === 'DELETE') {
    if (!(await store.deleteApp(rap[1]))) return err(404, 'not_found', 'Înscrierea nu există.');
    return json({ ok: true });
  }

  if (path === '/api/admin/mail-test' && method === 'POST') {
    const when = new Intl.DateTimeFormat('ro-RO', { timeZone: 'Europe/Bucharest', dateStyle: 'long', timeStyle: 'short' }).format(new Date());
    const r = await sendMail(env, '[Site] Email de test', 'Acesta este un email de test trimis de ' + user + ' din homosapiens.ro/update, pe ' + when + '.\nDacă îl vezi, formularul de contact trimite mesajele automat pe acest email.\n', null);
    await store.noteMail(JSON.stringify(r));
    return json(r);
  }

  return err(404, 'not_found', 'Adresă necunoscută.');
}

/* ---------- Support page: Formular 230 filled in with the team's NGO ---------- */

// The page is on and the NGO has a name, a fiscal code and a Romanian IBAN: the form can be made.
function supportReady(c) {
  const sp = c && c.support && typeof c.support === 'object' ? c.support : null;
  const n = sp && sp.ngo && typeof sp.ngo === 'object' ? sp.ngo : null;
  return !!(sp && sp.on === true && n && typeof n.name === 'string' && n.name.trim()
    && /^(RO)?\d{2,10}$/i.test(String(n.cif || '')) && /^RO\d{2}[A-Z]{4}[A-Z0-9]{16}$/.test(String(n.iban || '')));
}

async function liveContent(env, url) {
  const store = env.STORE.get(env.STORE.idFromName('main'));
  let c = null;
  try {
    const cur = await store.getContent();
    if (cur) { c = JSON.parse(cur.content); await migrate(c, env, url); }
  } catch { c = null; }
  if (!c || typeof c !== 'object') c = (await builtInContent(env, url)) || {};
  return c;
}

const F230_NOT_READY = '<!doctype html><html lang="ro"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Formularul 230</title><body style="margin:0;display:grid;min-height:100vh;place-items:center;font:600 17px/1.5 system-ui,sans-serif;background:#F4F5F7;color:#111317">'
  + '<main style="max-width:30rem;padding:24px;text-align:center"><p>Formularul 230 al echipei apare aici în curând.</p>'
  + '<p><a href="/" style="color:#2D4E8A">homosapiens.ro</a></p></main></body></html>';

async function f230Response(request, env, url) {
  const c = await liveContent(env, url);
  if (!supportReady(c)) {
    return new Response(request.method === 'HEAD' ? null : F230_NOT_READY, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const n = c.support.ngo;
  const img = await env.ASSETS.fetch(new Request(new URL('/assets/f230/formular-230-2025.jpg', url).toString()));
  if (!img.ok) return new Response('Formularul nu e disponibil acum. Încearcă din nou mai târziu.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const year = incomeYear();
  const pdf = formular230({ year, cif: n.cif, name: n.name.trim(), iban: n.iban, pct: '3,5', title: 'Formular 230 · ' + n.name.trim() }, new Uint8Array(await img.arrayBuffer()));
  return new Response(request.method === 'HEAD' ? null : pdf, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="Formular-230-Homosapiens-${year}.pdf"`,
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff'
    }
  });
}

/* ---------- /redirect: every link of the team on one page (the QR codes point here) ---------- */

const LINK_TXT = {
  ro: {
    title: 'Homosapiens #19053 · Linkuri',
    desc: 'Toate linkurile echipei de robotică Homosapiens #19053, într-un singur loc.',
    tag: 'Echipa de robotică FIRST Tech Challenge a Colegiului Național „B. P. Hasdeu” din Buzău.',
    share: 'Distribuie', copied: 'Link copiat', other: 'English', otherLang: 'en',
    empty: 'Linkurile apar aici în curând.',
    label: { site: 'Site-ul echipei', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook', linkedin: 'LinkedIn', email: 'Scrie-ne un email', sponsor: 'Devino sponsor', join: 'Intră în echipă', tax: 'Redirecționează 3,5%', link: 'Link' },
    sub: { sponsor: 'Susține echipa în noul sezon', join: 'Recrutările sunt deschise', tax: 'Formularul 230, fără niciun cost' }
  },
  en: {
    title: 'Homosapiens #19053 · Links',
    desc: 'All the links of the Homosapiens #19053 robotics team, in one place.',
    tag: 'FIRST Tech Challenge robotics team of Colegiul Național „B. P. Hasdeu”, Buzău, Romania.',
    share: 'Share', copied: 'Link copied', other: 'Română', otherLang: 'ro',
    empty: 'Our links will be here soon.',
    label: { site: 'Team website', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook', linkedin: 'LinkedIn', email: 'Email us', sponsor: 'Become a sponsor', join: 'Join the team', tax: 'Give us 3.5% of your tax', link: 'Link' },
    sub: { sponsor: 'Support us this season', join: 'Recruitment is open', tax: 'Form 230, at no cost to you' }
  }
};
const SVG_ATTR = 'viewBox="0 0 24 24" aria-hidden="true"';
const STROKE = SVG_ATTR + ' fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';
const FILL = SVG_ATTR + ' fill="currentColor"';
const LINK_ICONS = {
  site: `<svg ${STROKE}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
  instagram: `<svg ${STROKE}><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none"/></svg>`,
  tiktok: `<svg ${FILL}><path d="M14.6 3h3.1c.2 1.9 1.6 3.4 3.5 3.6v3.1c-1.3 0-2.5-.4-3.5-1.1v6.2a5.6 5.6 0 1 1-5.6-5.6c.3 0 .6 0 .9.1v3.2a2.5 2.5 0 1 0 1.6 2.3z"/></svg>`,
  youtube: `<svg ${FILL}><path fill-rule="evenodd" d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5a2.7 2.7 0 0 0-1.9 1.9C2 8.9 2 12 2 12s0 3.1.4 4.8a2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9c.4-1.7.4-4.8.4-4.8s0-3.1-.4-4.8zM10 15.1V8.9l5.2 3.1z"/></svg>`,
  facebook: `<svg ${FILL}><path d="M12 2a10 10 0 0 0-1.6 19.9v-7h-2.5V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.4h-1.2c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.4v7A10 10 0 0 0 12 2z"/></svg>`,
  linkedin: `<svg ${FILL}><path fill-rule="evenodd" d="M4.5 3h15A1.5 1.5 0 0 1 21 4.5v15a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-15A1.5 1.5 0 0 1 4.5 3zM7 10v7.5h2.4V10zm1.2-3.9a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8zM11 10v7.5h2.4v-4c0-1.1.4-1.8 1.3-1.8s1.2.7 1.2 1.8v4h2.4v-4.6c0-2.2-1.2-3.1-2.8-3.1-1.2 0-1.8.6-2.1 1.1V10z"/></svg>`,
  email: `<svg ${STROKE}><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>`,
  sponsor: `<svg ${STROKE}><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>`,
  join: `<svg ${STROKE}><circle cx="10" cy="8" r="3.5"/><path d="M3.5 19.5c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5M18.5 8v6M15.5 11h6"/></svg>`,
  tax: `<svg ${STROKE}><path d="M18 6 6 18"/><circle cx="7.5" cy="7.5" r="2.5"/><circle cx="16.5" cy="16.5" r="2.5"/></svg>`,
  link: `<svg ${STROKE}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`
};
const GO_ICON = `<svg class="go" ${STROKE}><path d="M7 17 17 7M9 7h8v8"/></svg>`;
const TROPHY = `<svg ${STROKE}><path d="M8 4h8v4a4 4 0 0 1-8 0zM8 5.5H5v1a3 3 0 0 0 3 3M16 5.5h3v1a3 3 0 0 1-3 3M12 12v4M8.5 20h7M10 16h4v4h-4z"/></svg>`;
const escHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function linkLang(request, url) {
  const q = url.searchParams.get('lang');
  if (q === 'ro' || q === 'en') return q;
  const first = (request.headers.get('accept-language') || '').split(',')[0].trim().toLowerCase();
  return !first || first.startsWith('ro') || first.startsWith('mo') ? 'ro' : 'en';
}

function linkItem(l, lang, email) {
  const T = LINK_TXT[lang];
  const kind = LINK_KINDS.includes(l.kind) ? l.kind : 'link';
  const clean = cleanLinkUrl(kind, l.url);
  let href, sub;
  if (kind === 'email') {
    const a = clean || email;
    href = 'mailto:' + a; sub = a;
  } else if (!clean) {
    return '';
  } else if (clean.startsWith('/')) {
    href = clean;
    sub = 'homosapiens.ro' + (clean === '/' ? '' : clean.replace(/^\/#/, '/'));
  } else {
    href = clean;
    const u = new URL(clean);
    const seg = u.pathname.split('/').filter(Boolean);
    const host = u.hostname.replace(/^(www|m)\./, '');
    let path = u.pathname.replace(/\/$/, '');
    try { path = decodeURIComponent(path); } catch { /* keep encoded */ }
    sub = ['instagram', 'tiktok', 'youtube'].includes(kind) && seg[0] && !['channel', 'c', 'user', 'watch', 'playlist', 'p', 'reel', 'video'].includes(seg[0])
      ? '@' + seg[0].replace(/^@/, '') : host + path;
  }
  if (kind === 'sponsor' || kind === 'join' || kind === 'tax') sub = T.sub[kind];
  const label = l.label || T.label[kind];
  const live = kind === 'join' ? '<span class="live" aria-hidden="true"></span>' : '';
  return `    <li><a class="lk k-${kind}${kind === 'site' ? ' main' : ''}" href="${escHtml(href)}"><span class="ic">${LINK_ICONS[kind]}</span>`
    + `<span class="tx"><b>${escHtml(label)}${live}</b><small>${escHtml(sub.slice(0, 80))}</small></span>${GO_ICON}</a></li>`;
}

async function linkPage(request, env, url) {
  const store = env.STORE.get(env.STORE.idFromName('main'));
  let c = null;
  try {
    const cur = await store.getContent();
    if (cur) { c = JSON.parse(cur.content); await migrate(c, env, url); }
  } catch { c = null; }
  if (!c || typeof c !== 'object') c = (await builtInContent(env, url)) || {};
  const lang = linkLang(request, url);
  const T = LINK_TXT[lang];
  const set = c.settings && typeof c.settings === 'object' ? c.settings : {};
  const email = typeof set.email === 'string' && EMAIL_RE.test(set.email) ? set.email : SITE_EMAIL;
  const items = (Array.isArray(c.links) ? c.links : [])
    .filter((l) => l && typeof l === 'object' && l.active === true && (l.kind !== 'join' || set.recruiting === true) && (l.kind !== 'tax' || supportReady(c)))
    .map((l) => linkItem({ kind: l.kind, label: typeof l.label === 'string' ? l.label.trim() : '', url: typeof l.url === 'string' ? l.url : '' }, lang, email))
    .filter(Boolean);
  const b = set.linksBadge && typeof set.linksBadge === 'object' ? set.linksBadge : {};
  const badgeText = typeof b[lang] === 'string' && b[lang].trim() ? b[lang] : (typeof b.ro === 'string' ? b.ro : '');
  const map = {
    lang, title: escHtml(T.title), desc: escHtml(T.desc), tag: escHtml(T.tag), share: escHtml(T.share), copied: escHtml(T.copied),
    other: escHtml(T.other), otherLang: T.otherLang, otherHref: '/redirect?lang=' + T.otherLang,
    badge: badgeText.trim() ? `<p class="badge">${TROPHY}<span>${escHtml(badgeText.trim())}</span></p>` : '',
    links: items.length ? items.join('\n') : `    <li class="empty">${escHtml(T.empty)}</li>`
  };
  const html = LINK_PAGE.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(map, k) ? map[k] : m));
  return new Response(request.method === 'HEAD' ? null : html, {
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-language': lang, vary: 'Accept-Language',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    if ((p === '/redirect' || p === '/redirect/') && (request.method === 'GET' || request.method === 'HEAD')) {
      try { return await linkPage(request, env, url); } catch { return new Response('Eroare pe server. Încearcă din nou.', { status: 500 }); }
    }
    if (p === '/links' || p === '/linkuri' || p === '/links/' || p === '/linkuri/') {
      return Response.redirect(new URL('/redirect' + url.search, url).toString(), 301);
    }
    if ((p === '/formular-230.pdf' || p === '/230.pdf') && (request.method === 'GET' || request.method === 'HEAD')) {
      try { return await f230Response(request, env, url); } catch { return new Response('Eroare pe server. Încearcă din nou.', { status: 500 }); }
    }
    // short addresses for the Support page, to share or print: homosapiens.ro/sustine, /230, /3-5
    let dp = p;
    try { dp = decodeURIComponent(p); } catch { /* keep it encoded */ }
    if (/^\/(sustine|susține|susţine|230|3-5|35|redirectioneaza)\/?$/i.test(dp)) {
      return Response.redirect(new URL('/#sustine', url).toString(), 302);
    }
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
