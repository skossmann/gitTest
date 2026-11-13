// SQLite-Speicher (node:sqlite, keine externen Abhängigkeiten).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_PROFILES, DEFAULT_SETTINGS } from './defaults.js';

const JSON_COLS = ['attrs', 'badges', 'warnings', 'history', 'extra'];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, started INTEGER, finished INTEGER, summary TEXT);
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY, source TEXT, profile_id TEXT, query TEXT, tier TEXT,
      title TEXT, descr TEXT, url TEXT, image TEXT,
      price REAL, price_text TEXT, vb INTEGER, unit_price REAL,
      location TEXT, posted INTEGER, pro INTEGER, shipping INTEGER,
      attrs TEXT, badges TEXT, warnings TEXT, history TEXT, extra TEXT,
      score INTEGER DEFAULT 0, level TEXT DEFAULT 'unknown', target REAL, top REAL, median REAL, basis TEXT, saving REAL,
      status TEXT DEFAULT 'active', gone_reason TEXT,
      first_seen INTEGER, last_seen INTEGER, last_checked INTEGER, gone_at INTEGER,
      notified_price REAL, fav INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_listings_profile ON listings(profile_id, status);
  `);

  const kvGet = db.prepare('SELECT value FROM kv WHERE key = ?');
  const kvSet = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

  const api = {
    raw: db,
    get(key, fallback = null) {
      const r = kvGet.get(key);
      return r ? JSON.parse(r.value) : fallback;
    },
    set(key, value) {
      kvSet.run(key, JSON.stringify(value));
    },
    settings() {
      return { ...DEFAULT_SETTINGS, ...api.get('settings', {}) };
    },
    saveSettings(patch) {
      const clean = {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!(k in patch)) continue;
        clean[k] = typeof DEFAULT_SETTINGS[k] === 'number' ? Number(patch[k]) || 0 : String(patch[k] ?? '').trim();
      }
      api.set('settings', { ...api.get('settings', {}), ...clean });
      return api.settings();
    },
    profiles() {
      return db.prepare('SELECT data FROM profiles ORDER BY pos').all().map((r) => JSON.parse(r.data));
    },
    profile(id) {
      const r = db.prepare('SELECT data FROM profiles WHERE id = ?').get(id);
      return r ? JSON.parse(r.data) : null;
    },
    saveProfile(p) {
      const pos = db.prepare('SELECT pos FROM profiles WHERE id = ?').get(p.id)?.pos ?? (db.prepare('SELECT MAX(pos) AS m FROM profiles').get().m ?? -1) + 1;
      db.prepare('INSERT INTO profiles (id, pos, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(p.id, pos, JSON.stringify(p));
      return p;
    },
    deleteProfile(id) {
      db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
      db.prepare('DELETE FROM listings WHERE profile_id = ? AND fav = 0').run(id);
    },
    listing(id) {
      return hydrate(db.prepare('SELECT * FROM listings WHERE id = ?').get(id));
    },
    listings(where = '1=1', ...params) {
      return db.prepare(`SELECT * FROM listings WHERE ${where}`).all(...params).map(hydrate);
    },
    insertListing(l) {
      const row = dehydrate(l);
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO listings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
    },
    updateListing(id, patch) {
      const row = dehydrate(patch);
      const cols = Object.keys(row);
      if (!cols.length) return;
      db.prepare(`UPDATE listings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => row[c]), id);
    },
    addRun(started, finished, summary) {
      db.prepare('INSERT INTO runs (started, finished, summary) VALUES (?, ?, ?)').run(started, finished, JSON.stringify(summary));
      db.prepare('DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT 60)').run();
    },
    runs(limit = 20) {
      return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ id: r.id, started: r.started, finished: r.finished, ...JSON.parse(r.summary) }));
    },
  };

  if (!db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n) DEFAULT_PROFILES.forEach((p) => api.saveProfile(p));
  return api;
}

function hydrate(row) {
  if (!row) return null;
  const o = { ...row };
  for (const c of JSON_COLS) o[c] = o[c] ? JSON.parse(o[c]) : c === 'attrs' || c === 'extra' ? {} : [];
  for (const c of ['vb', 'pro', 'shipping', 'fav', 'hidden']) o[c] = !!o[c];
  return o;
}

function dehydrate(obj) {
  const o = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (JSON_COLS.includes(k)) o[k] = JSON.stringify(v ?? null);
    else if (typeof v === 'boolean') o[k] = v ? 1 : 0;
    else o[k] = v;
  }
  return o;
}
