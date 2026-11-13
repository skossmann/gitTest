import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matches, extractRam, extractTb, extractBays, parsePrice } from '../src/extract.js';
import { classify, thresholds, score } from '../src/score.js';
import { parseSearch, interpretAd, searchUrl } from '../src/sources/kleinanzeigen.js';
import { parseFeed } from '../src/sources/rss.js';
import { DEFAULT_PROFILES } from '../src/defaults.js';
import { openDb } from '../src/db.js';
import { createRunner } from '../src/runner.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const prof = (id) => DEFAULT_PROFILES.find((p) => p.id === id);

test('Stichwort-Matching mit weichen Wortgrenzen', () => {
  assert.ok(matches('a6000', 'PNY RTX A 6000 48GB'));
  assert.ok(matches('5090', 'Zotac RTX5090 Solid'));
  assert.ok(!matches('a40', 'Nvidia RTX A4000 16GB'));
  assert.ok(!matches('ultra', 'WD Ultrastar 16TB'));
  assert.ok(matches('ds1817+', 'Synology DS1817+ 8 Bay'));
  assert.ok(!matches('pc', 'RTX 5090 PCIe 5.0'));
  assert.ok(matches('*hülle', 'Schutzhülle iPad') && !matches('hülle', 'Schutzhülle iPad'));
});

test('Preis-Parsing', () => {
  assert.deepEqual(parsePrice('3.250 € VB'), { price: 3250, vb: true });
  assert.deepEqual(parsePrice('68,56€'), { price: 68.56, vb: false });
  assert.equal(parsePrice('VB').price, null);
});

test('RAM vs. SSD (512-GB-Verwechslung)', () => {
  assert.equal(extractRam('Mac Studio M2 Ultra 64GB 1TB'), 64);
  assert.equal(extractRam('MacBook Pro 16 M3 Max 512GB'), null);
  assert.equal(extractRam('Mac Studio M3 Ultra 512GB RAM 4TB SSD'), 512);
  assert.equal(extractRam('MacBook Pro M1 Max 64 GB 512 GB SSD'), 64);
  assert.equal(extractRam('Mac Studio M4 Max 128/2TB'), 128);
});

test('Kapazität und Einschübe', () => {
  assert.deepEqual(extractTb('4x Seagate Exos 16TB'), { tb: 64, count: 4, each: 16 });
  assert.equal(extractTb('WD Red Plus 8 TB').tb, 8);
  assert.equal(extractBays('Synology DS1821+'), 8);
  assert.equal(extractBays('Synology DS923+ NAS'), 4);
  assert.equal(extractBays('Synology DS220+'), 2);
  assert.equal(extractBays('QNAP TS-873A'), 8);
  assert.equal(extractBays('NAS 4-Bay Leergehäuse'), 4);
});

test('Kleinanzeigen-Suchseite (echte Seite, gekürzt)', () => {
  const items = parseSearch(fx('ka-search.html'));
  assert.equal(items.length, 27);
  const z = items.find((i) => i.id === 'ka:3569752802');
  assert.equal(z.title, 'ZOTAC Gaming GeForce RTX 5090 Solid OC 32GB Grafikkarte');
  assert.equal(z.price, 3250);
  assert.equal(z.location, '90431 Kleinreuth b Schweinau');
  assert.ok(z.url.startsWith('https://www.kleinanzeigen.de/s-anzeige/zotac'));
  assert.ok(z.image.startsWith('https://img.kleinanzeigen.de/'));
  assert.ok(z.shipping && z.posted);
  assert.ok(items.every((i) => i.title && i.url));
});

test('Gesuche, Tausch, Laptops und Zubehör fallen raus', () => {
  const gpu = prof('gpu');
  const items = parseSearch(fx('ka-search.html'));
  const kept = items.filter((i) => !classify(gpu, i).reject).map((i) => i.title);
  assert.ok(kept.includes('ZOTAC Gaming GeForce RTX 5090 Solid OC 32GB Grafikkarte'));
  assert.ok(!kept.some((t) => /^(kaufe|tausche)/i.test(t)));
  assert.ok(!kept.some((t) => /laptop|gaming pc/i.test(t)));
  assert.equal(classify(gpu, { title: 'Suche RTX 5090', price: 2000 }).reject, 'gesuch');
  assert.equal(classify(gpu, { title: 'RTX 4080 Super 16GB', price: 700 }).reject, 'keine-stufe');
});

test('Mac-Stufen, NAS-Warnung, HDD €/TB', () => {
  const m = classify(prof('mac'), { title: 'Mac Studio M2 Ultra 192GB 2TB', price: 4700 });
  assert.equal(m.tier, '192 GB');
  assert.equal(m.badges[0].emoji, '⚡');
  assert.equal(classify(prof('mac'), { title: 'MacBook Pro M3 Max 36GB 512GB', price: 1700 }).reject, 'keine-stufe');
  const n = classify(prof('nas'), { title: 'Synology DS1817+ 8-Bay Leergehäuse', price: 280 });
  assert.equal(n.tier, '8-Bay');
  assert.match(n.warnings[0].text, /C2000/);
  assert.equal(classify(prof('nas'), { title: 'Synology DS220+', price: 150 }).reject, 'keine-stufe');
  const h = classify(prof('hdd'), { title: '4x Seagate Exos 16TB', price: 640 });
  assert.equal(h.unitPrice, 10);
});

test('Schwellen und Score', () => {
  const th = thresholds({}, { target: 1800, top: 1500 }, null, 0);
  assert.equal(score({ unitPrice: 1400, ...th }).level, 'top');
  assert.equal(score({ unitPrice: 1700, ...th }).level, 'deal');
  assert.equal(score({ unitPrice: 2400, ...th }).level, 'none');
  assert.equal(thresholds({}, {}, 1000, 3).basis, 'lernphase');
  assert.deepEqual(thresholds({}, {}, 1000, 10), { target: 750, top: 600, basis: 'median' });
  assert.ok(score({ unitPrice: 500, ...th }).suspicious);
});

test('Anzeigen-Status', () => {
  const html = fx('ka-ad.html');
  assert.deepEqual(interpretAd('3569752802', { status: 200, url: 'https://www.kleinanzeigen.de/s-anzeige/x/3569752802-225-6828', html }), { status: 'active', price: 3250 });
  assert.equal(interpretAd('3569752802', { status: 200, url: 'https://www.kleinanzeigen.de/s-pc-zubehoer/c225', html: '<html></html>' }).status, 'gone');
  const reserved = html.replace(/(<h1[^>]*>)/, '$1<span class="pvap-reserved-title">Reserviert • </span><span class="pvap-reserved-title is-hidden">Gelöscht • </span>');
  assert.equal(interpretAd('3569752802', { status: 200, url: 'https://www.kleinanzeigen.de/s-anzeige/x/3569752802-225-6828', html: reserved }).status, 'reserved');
});

test('Such-URL', () => {
  assert.equal(searchUrl('RTX 5090', { minPrice: 50, maxPrice: 6000 }), 'https://www.kleinanzeigen.de/s-anzeige:angebote/preis:50:6000/rtx-5090/k0');
  assert.throws(() => searchUrl('https://evil.example/s'));
});

test('mydealz-Feed', () => {
  const items = parseFeed(fx('mydealz.xml'));
  assert.equal(items.length, 6);
  assert.equal(items[0].temp, 108);
  assert.equal(items[0].price, 68.56);
  assert.equal(items[0].location, 'Amazon');
  assert.ok(!/^\d+°/.test(items[0].title));
});

test('Kompletter Lauf: Budget, Bewertung, Alarm, Sperre', async () => {
  const db = openDb(':memory:');
  db.saveSettings({ kaBudget: 4, checkBudget: 1, delayMinMs: 0, delayMaxMs: 0, webhookUrl: 'https://hook.test/x' });
  const calls = [];
  const sent = [];
  const page = fx('ka-search.html').replace('3.250 €', '2.100 €');
  const fetchFn = async (url, opts = {}) => {
    calls.push(url);
    if (url.startsWith('https://hook.test')) { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; }
    if (url.includes('mydealz')) return { ok: true, status: 200, text: async () => fx('mydealz.xml') };
    return { ok: true, status: 200, url, text: async () => page };
  };
  const runner = createRunner(db, { fetchFn, sleep: async () => {} });
  const sum = await runner.run();
  assert.equal(sum.error, undefined);
  assert.equal(calls.filter((u) => u.includes('kleinanzeigen.de/s-anzeige:angebote')).length, 3);
  const z = db.listing('ka:3569752802');
  assert.equal(z.level, 'top');
  assert.equal(z.tier, 'RTX 5090 (32 GB)');
  assert.equal(sent.length >= 1, true);
  assert.ok(sent.some((m) => m.url === z.url));
  assert.equal(db.listing('ka:3569752802').notified_price, 2100);
  // zweiter Lauf: keine erneute Meldung desselben Angebots
  const before = sent.length;
  await runner.run();
  assert.equal(sent.filter((m) => m.url === z.url).length, 1);
  assert.ok(sent.length >= before);
  // Sperre: 429 -> Pause, kein weiterer Abruf im nächsten Lauf
  const blocked = createRunner(db, { fetchFn: async (url) => (url.includes('mydealz') ? { ok: true, status: 200, text: async () => fx('mydealz.xml') } : { ok: false, status: 429, url, text: async () => 'Too many requests' }), sleep: async () => {} });
  const s2 = await blocked.run();
  assert.equal(s2.sources.ka.blocked, true);
  assert.equal(s2.sources.ka.requests, 1);
  const s3 = await blocked.run();
  assert.equal(s3.sources.ka.requests, 0);
});
