// Text-Helfer: Normalisierung, Stichwort-Matching, Attribut-Extraktion (RAM, TB, Bays).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€' };

export function decodeEntities(s = '') {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

export function stripTags(s = '') {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function norm(s = '') {
  return s.toLowerCase().replace(/[“”„"']/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "3.250 € VB" -> { price: 3250, vb: true }; ohne Zahl -> price null */
export function parsePrice(text = '') {
  const t = text.replace(/\s+/g, ' ');
  const m = t.match(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*€/) || t.match(/€\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/);
  const vb = /\bVB\b/i.test(t);
  if (!m) return { price: null, vb };
  return { price: Number(m[1].replace(/\./g, '') + (m[2] ? '.' + m[2] : '')), vb };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termCache = new Map();

// Ein Begriff matcht mit "weichen" Wortgrenzen: Ziffern dürfen nicht an Ziffern,
// Buchstaben nicht an Buchstaben grenzen. So trifft "a40" nicht "a4000" und
// "ultra" nicht "ultrastar", aber "5090" trifft "rtx5090" und "a6000" trifft "a 6000".
function termRegex(term) {
  let re = termCache.get(term);
  if (re) return re;
  const key = term;
  const openL = term.startsWith('*');
  const openR = term.endsWith('*') && term.length > 1;
  term = term.replace(/^\*|\*$/g, '');
  if (!term) return /$^/;
  let body = '';
  for (let i = 0; i < term.length; i++) {
    const c = term[i];
    const p = term[i - 1];
    if (i > 0 && ((/\d/.test(c) && /[a-zäöüß]/.test(p)) || (/[a-zäöüß]/.test(c) && /\d/.test(p)))) body += '[\\s-]?';
    body += c === '-' ? '[\\s-]?' : esc(c);
  }
  const first = term[0];
  const last = term[term.length - 1];
  const lb = openL ? '' : /\d/.test(first) ? '(?<!\\d)' : /[a-zäöüß]/.test(first) ? '(?<![a-zäöüß])' : '';
  const rb = openR ? '' : /\d/.test(last) ? '(?!\\d)' : /[a-zäöüß]/.test(last) ? '(?![a-zäöüß])' : '';
  re = new RegExp(lb + body + rb, 'i');
  termCache.set(key, re);
  return re;
}

/**
 * Muster: Alternativen mit "|" getrennt; innerhalb einer Alternative müssen
 * alle durch Leerzeichen getrennten Begriffe vorkommen. Leeres Muster = false.
 * Ein "*" am Anfang/Ende eines Begriffs hebt die Wortgrenze auf ("*hülle" trifft "Schutzhülle").
 */
export function matches(pattern, text) {
  if (!pattern) return false;
  const t = norm(text);
  return norm(pattern)
    .split('|')
    .map((a) => a.trim())
    .filter(Boolean)
    .some((alt) => alt.split(' ').every((term) => termRegex(term).test(t)));
}

const RAM_SIZES = new Set([8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512]);

/**
 * Arbeitsspeicher eines Macs bestimmen. "512 GB" ist in Mac-Anzeigen fast immer die SSD –
 * deshalb zählen 256/512 nur dann als RAM, wenn es ausdrücklich dabeisteht oder
 * daneben eine klar größere Speicherangabe (TB) existiert.
 */
export function extractRam(text) {
  const t = norm(text);
  let m = t.match(/(\d{1,3})\s?gb[\s-]?(?:ram|arbeitsspeicher|unified|memory|ddr\d?)/) || t.match(/(?:ram|arbeitsspeicher|unified memory)\s?:?\s?(\d{1,3})\s?gb/);
  if (m) return Number(m[1]);
  const ssd = new Set();
  for (const s of t.matchAll(/(\d{2,4})\s?gb[\s-]?(?:ssd|hdd|festplatte|speicherplatz|flash)/g)) ssd.add(Number(s[1]));
  for (const s of t.matchAll(/(?:ssd|festplatte|speicherplatz)\s?:?\s?(\d{2,4})\s?gb/g)) ssd.add(Number(s[1]));
  const hasTb = /\d\s?tb\b/.test(t);
  const gbs = [...t.matchAll(/(?<![\d.,])(\d{1,3})\s?gb\b/g)].map((x) => Number(x[1])).filter((v) => RAM_SIZES.has(v));
  // "64/1TB"-Schreibweise
  m = t.match(/(?<![\d.,])(\d{2,3})\s?(?:gb)?\s?\/\s?\d+\s?tb/);
  if (m && RAM_SIZES.has(Number(m[1]))) return Number(m[1]);
  const cand = [...new Set(gbs)].filter((v) => !ssd.has(v)).sort((a, b) => a - b);
  if (!cand.length) return null;
  if (cand.length >= 2) return cand[0]; // kleinerer Wert = RAM, größerer = SSD
  const v = cand[0];
  if (v >= 256) return hasTb || ssd.size ? v : null; // einzelne 256/512 GB = vermutlich SSD
  return v;
}

/** Gesamtkapazität in TB und Stückzahl ("4x 16TB" -> { tb: 64, count: 4, each: 16 }) */
export function extractTb(text) {
  const t = norm(text);
  const sizes = [...t.matchAll(/(?<![\d.,])(\d{1,2}(?:[.,]\d)?)\s?tb\b/g)].map((x) => Number(x[1].replace(',', '.')));
  if (!sizes.length) return { tb: null, count: 1, each: null };
  const each = Math.max(...sizes);
  let count = 1;
  const c = t.match(/(?<![\d.,])(\d{1,2})\s?(?:x|×|stück|stk\.?)(?![a-z])/) || t.match(/\b(zwei|drei|vier|fünf|sechs|acht)\b/);
  if (c) {
    const words = { zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, acht: 8 };
    const n = words[c[1]] ?? Number(c[1]);
    if (n >= 2 && n <= 24) count = n;
  }
  return { tb: Math.round(each * count * 10) / 10, count, each };
}

// Synology: führende Ziffern = max. Laufwerke inkl. Erweiterung -> interne Einschübe
const SYNO = { 1: 1, 2: 2, 4: 4, 6: 6, 7: 2, 9: 4, 10: 5, 12: 12, 15: 5, 16: 6, 18: 8, 24: 12, 36: 12 };

export function extractBays(text) {
  const t = norm(text);
  let m = t.match(/(?<!\d)(\d{1,2})[\s-]?(?:bay|bays|schacht|schächte|einschübe|einschub|fach)\b/);
  if (m) return Number(m[1]);
  m = t.match(/\b(?:ds|rs)\s?-?(\d{1,2})(\d{2})(?:\+|j|play|xs|slim)?(?![\d])/);
  if (m && SYNO[Number(m[1])]) return SYNO[Number(m[1])];
  m = t.match(/\b(?:ts|tvs|tr)\s?-?h?(\d{1,2})(\d{2})/);
  if (m) return Number(m[1]);
  m = t.match(/\b(?:as|f|d)(\d)[\s-]?\d{3}\b/); // Asustor AS5404T, TerraMaster F4-423
  if (m && /asustor|terramaster/.test(t)) return Number(m[1]);
  return null;
}

/** "Heute, 07:19" / "Gestern, 21:27" / "10.11.2026" -> Zeitstempel (ms) oder null */
export function parsePosted(text, now = Date.now()) {
  if (!text) return null;
  const d = new Date(now);
  let m = text.match(/^(Heute|Gestern),?\s*(\d{1,2}):(\d{2})/i);
  if (m) {
    d.setHours(Number(m[2]), Number(m[3]), 0, 0);
    if (/gestern/i.test(m[1])) d.setDate(d.getDate() - 1);
    return d.getTime();
  }
  m = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12).getTime();
  return null;
}
