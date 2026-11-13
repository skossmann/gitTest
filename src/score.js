// Filtern, Preisstufe bestimmen, bewerten.
import { matches, norm, extractRam, extractTb, extractBays } from './extract.js';

// Gesuche tarnen sich gern als Angebote (Preis = Wunschpreis des Suchenden).
const WANTED = /^\W*(suche|suchen|kaufe|ankauf|gesuch|gesucht|tausche|tausch|wtb|s:)(?![a-zäöüß])/i;
const WANTED_ANY = /\b(ankauf|inzahlungnahme|zu vermieten|vermietung|mieten|verleih|leihen)\b/i;
const DEFECT = 'defekt|defekte|defekter|bastler|bastlerware|ersatzteile|ersatzteilspender|ausgeschlachtet|kaputt|wasserschaden|displayschaden|icloud gesperrt|icloud sperre';
const SCAM_TEXT = /\b(nur vorkasse|western union|paypal freunde|whatsapp|telegram|nur per mail|nur email)\b/i;

/**
 * Prüft ein Roh-Angebot gegen ein Suchprofil.
 * Rückgabe: { reject: 'grund' } oder { tier, attrs, unitPrice, badges, warnings }.
 */
export function classify(profile, item) {
  const title = item.title || '';
  const full = `${title} ${item.descr || ''}`;
  if (WANTED.test(title.trim()) || WANTED_ANY.test(title)) return { reject: 'gesuch' };
  if (item.price == null) return { reject: 'kein-preis' };
  if (item.price < (profile.minPrice ?? 50)) return { reject: 'zu-billig' };
  if (profile.maxPrice && item.price > profile.maxPrice) return { reject: 'zu-teuer' };
  if (profile.exclude && matches(profile.exclude, title)) return { reject: 'ausschluss' };
  if (profile.excludeText && matches(profile.excludeText, full)) return { reject: 'ausschluss' };
  for (const group of profile.require || []) if (group && !matches(group, full)) return { reject: 'pflichtbegriff' };

  const attrs = {};
  const tiers = profile.tiers || [];
  const need = new Set(tiers.map((t) => t.attr).filter(Boolean));
  if (need.has('ram')) attrs.ram = extractRam(full);
  if (need.has('bays')) attrs.bays = extractBays(full);
  if (need.has('tb') || tiers.some((t) => t.unit === 'tb')) Object.assign(attrs, extractTb(full));

  let tier = null;
  for (const t of tiers) {
    if (t.match && !matches(t.match, full)) continue;
    if (t.attr) {
      const v = attrs[t.attr];
      if (v == null) continue;
      if (t.min != null && t.min !== '' && v < Number(t.min)) continue;
      if (t.max != null && t.max !== '' && v > Number(t.max)) continue;
    }
    tier = t;
    break;
  }
  if (tiers.length && !tier) return { reject: 'keine-stufe' };

  let unitPrice = item.price;
  if (tier?.unit === 'tb') {
    if (!attrs.tb) return { reject: 'keine-kapazität' };
    unitPrice = Math.round((item.price / attrs.tb) * 100) / 100;
  }

  const badges = [];
  const warnings = [];
  for (const b of profile.badges || []) if (matches(b.any, full)) badges.push({ emoji: b.emoji || '✨', text: b.text, bonus: Number(b.bonus) || 0 });
  for (const w of profile.warnings || []) if (matches(w.any, full)) warnings.push({ text: w.text, penalty: Number(w.penalty) || 0 });
  if (matches(DEFECT, full)) warnings.push({ text: 'Defekt / Bastlerware erwähnt', penalty: 35 });
  if (SCAM_TEXT.test(full)) warnings.push({ text: 'Betrugsmuster im Text (Vorkasse / Messenger)', penalty: 20 });
  if (attrs.count >= 2 && tier?.unit === 'tb') badges.push({ emoji: '🧩', text: `${attrs.count}× identisch (RAID-Set)`, bonus: 3 });

  return { tier: tier?.label || '', attrs, unitPrice, badges, warnings };
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const MIN_OBS = 8;

/**
 * Zielpreise einer Stufe bestimmen. Feste Werte aus dem Profil haben Vorrang;
 * fehlen sie, werden sie aus dem beobachteten Marktmedian abgeleitet.
 */
export function thresholds(profile, tier, med, obsCount) {
  const dealPct = Number(profile.dealPct) || 0.75;
  const topPct = Number(profile.topPct) || 0.6;
  const haveMed = med != null && obsCount >= MIN_OBS;
  let target = Number(tier?.target) || null;
  let top = Number(tier?.top) || null;
  let basis = 'fest';
  if (!target) {
    if (!haveMed) return { target: null, top: null, basis: 'lernphase' };
    target = med * dealPct;
    basis = 'median';
  }
  // Feste Zielpreise sind Obergrenzen: Liegt der Markt bereits darunter, zählt nur,
  // was klar unter dem Median liegt (Deal ab −10 %, Top-Deal ab −20 %).
  if (basis === 'fest' && haveMed) {
    target = Math.min(target, med * 0.9);
    top = Math.min(top || Infinity, med * 0.8);
  }
  if (!top) top = basis === 'median' ? med * topPct : target * 0.8;
  if (top > target) top = target;
  return { target: Math.round(target * 100) / 100, top: Math.round(top * 100) / 100, basis };
}

/** Score 0–100; ab 85 = Top-Deal, ab 60 = Deal. */
export function score({ unitPrice, price, target, top, med, badges = [], warnings = [], minSaving = 0, perUnit = 1 }) {
  if (!target) return { score: 0, level: 'unknown' };
  let s;
  if (unitPrice <= top) s = 85 + 15 * Math.min(1, (top - unitPrice) / (0.35 * top));
  else if (unitPrice <= target) s = 60 + 25 * ((target - unitPrice) / Math.max(target - top, 0.01));
  else s = Math.max(0, 60 * (1 - (unitPrice - target) / (0.5 * target)));
  for (const b of badges) s += b.bonus || 0;
  for (const w of warnings) s -= w.penalty || 0;
  const ref = med ?? target;
  const saving = (ref - unitPrice) * perUnit;
  if (minSaving && saving < minSaving) s = Math.min(s, 59);
  s = Math.max(0, Math.min(100, Math.round(s)));
  const suspicious = unitPrice < 0.4 * top;
  return { score: s, level: s >= 85 ? 'top' : s >= 60 ? 'deal' : 'none', suspicious, saving: Math.round(saving), price };
}

export const titleKey = (t) => norm(t).replace(/[^a-z0-9äöüß]/g, '');
