// Deal-Radar: HTTP-Server (API + statische PWA) und Scheduler.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openDb } from './src/db.js';
import { createRunner } from './src/runner.js';
import { send, channels } from './src/notify.js';
import { searchUrl } from './src/sources/kleinanzeigen.js';
import { suggestProfile, AiError } from './src/ai.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.DEALRADAR_PASSWORD || '';
const db = openDb(process.env.DEALRADAR_DB || join(ROOT, 'data', 'dealradar.db'));
const runner = createRunner(db);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new Error('Anfrage zu groß');
  }
  return raw ? JSON.parse(raw) : {};
}

function authorized(req) {
  if (!PASSWORD) return true;
  const given = Buffer.from((req.headers.authorization || '').replace(/^Basic\s+/i, ''), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(given);
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

const list = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((x) => String(x).trim()).filter(Boolean);
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? undefined : Number(v));

function cleanProfile(input, existing) {
  const type = existing?.type || (input.type === 'rss' ? 'rss' : 'ka');
  const id = existing?.id || `${String(input.name || 'suche').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'suche'}-${Date.now().toString(36)}`;
  const p = { id, type, name: String(input.name || 'Neue Suche').slice(0, 80), emoji: String(input.emoji || '🔎').slice(0, 8), enabled: input.enabled !== false, note: String(input.note || '').slice(0, 500), exclude: String(input.exclude || '') };
  if (type === 'rss') {
    const feeds = list(input.feeds);
    feeds.forEach((f) => { if (new URL(f).protocol !== 'https:') throw new Error('Feeds müssen https-URLs sein'); });
    return { ...p, feeds, include: String(input.include || ''), minTemp: num(input.minTemp) ?? 200, alertTemp: num(input.alertTemp) ?? 500, maxAgeDays: num(input.maxAgeDays) ?? 4 };
  }
  const queries = list(input.queries);
  queries.forEach((q) => searchUrl(q)); // wirft bei fremden Hosts
  return {
    ...p, queries, minPrice: num(input.minPrice) ?? 50, maxPrice: num(input.maxPrice), minSaving: num(input.minSaving), dealPct: num(input.dealPct), topPct: num(input.topPct),
    excludeText: String(input.excludeText || ''), require: list(input.require),
    tiers: (input.tiers || []).map((t) => ({ label: String(t.label || '').slice(0, 60), match: String(t.match || '') || undefined, attr: ['ram', 'bays', 'tb'].includes(t.attr) ? t.attr : undefined, min: num(t.min), max: num(t.max), target: num(t.target), top: num(t.top), unit: t.unit === 'tb' ? 'tb' : undefined })).filter((t) => t.label),
    badges: (input.badges || []).filter((b) => b.any && b.text).map((b) => ({ any: String(b.any), emoji: String(b.emoji || '✨').slice(0, 8), text: String(b.text), bonus: num(b.bonus) ?? 0 })),
    warnings: (input.warnings || []).filter((w) => w.any && w.text).map((w) => ({ any: String(w.any), text: String(w.text), penalty: num(w.penalty) ?? 0 })),
  };
}

const mask = (v) => (v ? '••••' + v.slice(-4) : '');
const aiKey = (s) => s.anthropicKey || process.env.ANTHROPIC_API_KEY || '';

function snapshot() {
  const s = db.settings();
  const listings = db.listings('1=1').filter((l) => l.status !== 'gone' || l.level === 'top' || l.level === 'deal' || l.fav);
  return {
    now: Date.now(), running: runner.state.running, progress: runner.state.progress, nextRun: db.get('nextRun', null), kaBlockedUntil: db.get('ka.blockedUntil', 0),
    settings: { ...s, telegramToken: mask(s.telegramToken), anthropicKey: mask(s.anthropicKey) }, channels: channels(s), auth: !!PASSWORD, ai: !!aiKey(s),
    profiles: db.profiles(), runs: db.runs(15), listings,
  };
}

async function api(req, res, path) {
  const m = req.method;
  if (path === '/api/state' && m === 'GET') return json(res, 200, snapshot());
  if (path === '/api/run' && m === 'POST') {
    if (runner.state.running) return json(res, 409, { error: 'Lauf ist bereits aktiv' });
    runner.run().catch((e) => console.error(e));
    return json(res, 202, { ok: true });
  }
  if (path === '/api/unblock' && m === 'POST') { db.set('ka.blockedUntil', 0); return json(res, 200, { ok: true }); }
  if (path === '/api/settings' && m === 'PUT') {
    const b = await body(req);
    for (const k of ['telegramToken', 'anthropicKey']) if (/^••••/.test(b[k] || '')) delete b[k];
    for (const k of ['ntfyUrl', 'webhookUrl']) if (b[k] && !/^https?:\/\//.test(b[k])) throw new Error(`${k}: muss mit http(s):// beginnen`);
    const before = db.settings().intervalMin;
    const s = db.saveSettings(b);
    if (s.intervalMin !== before) db.set('nextRun', Math.min(db.get('nextRun', Infinity), Date.now() + s.intervalMin * 60000));
    return json(res, 200, { ok: true });
  }
  if (path === '/api/notify/test' && m === 'POST') {
    const s = db.settings();
    if (!channels(s).length) return json(res, 400, { error: 'Kein Benachrichtigungskanal eingerichtet' });
    return json(res, 200, { results: await send(s, { title: '🔥 Deal-Radar Test', body: 'Benachrichtigungen funktionieren.', url: s.publicUrl || undefined, priority: 3 }) });
  }
  if (path === '/api/ai/suggest' && m === 'POST') {
    const b = await body(req);
    const description = String(b.description || '').trim().slice(0, 2000);
    if (description.length < 3) return json(res, 400, { error: 'Bitte kurz beschreiben, was du suchst.' });
    try {
      const raw = await suggestProfile({ description, wishPrice: num(b.wishPrice), current: b.current }, { apiKey: aiKey(db.settings()) });
      // Vorschlag durch dieselbe Bereinigung wie eine Formular-Eingabe schicken; gespeichert wird hier nichts.
      const { id, ...profile } = cleanProfile({ ...raw, type: 'ka', maxPrice: raw.maxPrice ?? '' });
      return json(res, 200, { profile });
    } catch (e) {
      if (e instanceof AiError) return json(res, 502, { error: e.message });
      throw e;
    }
  }
  if (path === '/api/profiles' && m === 'POST') {
    const p = db.saveProfile(cleanProfile(await body(req)));
    return json(res, 201, p);
  }
  let mm = path.match(/^\/api\/profiles\/([\w-]+)$/);
  if (mm) {
    const existing = db.profile(mm[1]);
    if (!existing) return json(res, 404, { error: 'Profil nicht gefunden' });
    if (m === 'PUT') {
      const p = db.saveProfile(cleanProfile(await body(req), existing));
      runner.rescoreAll();
      return json(res, 200, p);
    }
    if (m === 'DELETE') { db.deleteProfile(mm[1]); return json(res, 200, { ok: true }); }
  }
  mm = path.match(/^\/api\/listings\/([^/]+)$/);
  if (mm && m === 'PATCH') {
    const id = decodeURIComponent(mm[1]);
    if (!db.listing(id)) return json(res, 404, { error: 'Angebot nicht gefunden' });
    const b = await body(req);
    const patch = {};
    if ('fav' in b) patch.fav = !!b.fav;
    if ('hidden' in b) patch.hidden = !!b.hidden;
    db.updateListing(id, patch);
    return json(res, 200, db.listing(id));
  }
  return json(res, 404, { error: 'Unbekannter Endpunkt' });
}

const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/healthz') return json(res, 200, { ok: true });
    if (!authorized(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Deal-Radar"' });
      return res.end('Anmeldung erforderlich');
    }
    if (path.startsWith('/api/')) return await api(req, res, path);
    const file = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
    const full = join(ROOT, 'public', file);
    if (!full.startsWith(join(ROOT, 'public'))) return json(res, 403, { error: 'verboten' });
    const data = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return json(res, 404, { error: 'nicht gefunden' });
    json(res, 400, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Deal-Radar läuft auf http://${HOST}:${PORT}`);
  if (process.env.DEALRADAR_NO_SCHEDULER !== '1') runner.start();
});
