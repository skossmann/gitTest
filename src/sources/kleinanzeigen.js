// Kleinanzeigen: Suchergebnisseiten auswerten (kein Browser, keine Umgehung von Sperren).
import { decodeEntities, stripTags, parsePrice, parsePosted } from '../extract.js';

const HOST = 'https://www.kleinanzeigen.de';
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

export class BlockedError extends Error {}

/** Such-URL bauen. Eine vollständige kleinanzeigen.de-URL (z. B. mit Region/Umkreis) wird unverändert genutzt. */
export function searchUrl(query, { minPrice, maxPrice } = {}) {
  if (/^https?:\/\//i.test(query)) {
    const u = new URL(query);
    if (u.hostname !== 'www.kleinanzeigen.de') throw new Error(`Nur www.kleinanzeigen.de-URLs erlaubt: ${u.hostname}`);
    return u.href;
  }
  const slug = query
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9äöüß+.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const price = minPrice || maxPrice ? `/preis:${minPrice || ''}:${maxPrice || ''}` : '';
  return `${HOST}/s-anzeige:angebote${price}/${encodeURIComponent(slug)}/k0`;
}

export function parseSearch(html, now = Date.now()) {
  const items = [];
  const parts = html.split(/<article\b/).slice(1);
  for (const raw of parts) {
    const a = raw.split('</article>')[0];
    const id = a.match(/data-adid="(\d+)"/)?.[1];
    const href = a.match(/data-href="([^"]+)"/)?.[1];
    if (!id || !href) continue;
    const body = a.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
    const title = stripTags(body.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/)?.[1] || '');
    if (!title) continue;
    const texts = body
      .split(/<[^>]+>/)
      .map((t) => decodeEntities(t).replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const priceText = texts.find((t) => /^(\d[\d.]*\s*€|VB$|Zu verschenken)/.test(t)) || '';
    const postedText = texts.find((t) => /^(Heute|Gestern),|^\d{1,2}\.\d{1,2}\.\d{4}$/.test(t)) || '';
    const location = texts.find((t) => /^\d{5}\s+\S/.test(t)) || '';
    const descr = stripTags(body.match(/<h[23][\s\S]*?<\/h[23]>\s*<p[^>]*>([\s\S]*?)<\/p>/)?.[1] || '');
    const image = decodeEntities(a.match(/<img[^>]+src="([^"]+)"/)?.[1] || '');
    const { price, vb } = parsePrice(priceText);
    items.push({
      id: `ka:${id}`,
      source: 'ka',
      url: HOST + decodeEntities(href),
      title,
      descr,
      image,
      price,
      priceText,
      vb,
      location,
      posted: parsePosted(postedText, now),
      pro: texts.includes('PRO'),
      shipping: texts.some((t) => /^Versand möglich/.test(t)),
    });
  }
  return items;
}

function looksBlocked(status, html) {
  if (status === 403 || status === 429) return true;
  return html.length < 20000 && /captcha|access denied|zugriff verweigert|ungewöhnliche aktivität/i.test(html);
}

async function get(url, fetchFn) {
  const res = await fetchFn(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'de-DE,de;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  const html = await res.text();
  if (looksBlocked(res.status, html)) throw new BlockedError(`Kleinanzeigen schränkt den Zugriff ein (HTTP ${res.status})`);
  return { status: res.status, url: res.url || url, html };
}

export async function fetchSearch(url, fetchFn = fetch) {
  const r = await get(url, fetchFn);
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  const items = parseSearch(r.html);
  // Leere Seite ohne Ergebnis-Zähler deutet auf geänderte Seitenstruktur hin.
  const structureOk = items.length > 0 || /srp-breadcrumb-summary|Ergebnisse|keine Anzeigen/i.test(r.html);
  return { items, structureOk };
}

/**
 * Einzelanzeige prüfen. Gelöschte Anzeigen leiten auf eine Kategorie-Seite um
 * (keine Anzeigen-ID mehr in der URL, kein Titel-Element).
 */
export async function checkAd(listing, fetchFn = fetch) {
  const r = await get(listing.url, fetchFn);
  return interpretAd(listing.id.replace(/^ka:/, ''), r);
}

export function interpretAd(adId, { status, url, html }) {
  if (status === 404 || status === 410) return { status: 'gone' };
  const h1 = html.match(/<h1[^>]*id="viewad-title"[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  if (!h1 || !url.includes(adId)) return { status: 'gone' };
  // Versteckte Status-Labels ("Reserviert • Gelöscht") stehen im Template jeder Seite – nur sichtbare zählen.
  const visible = stripTags(h1.replace(/<span[^>]*class="[^"]*is-hidden[^"]*"[^>]*>[\s\S]*?<\/span>/g, ''));
  const p = html.match(/itemprop="price"\s+content="([\d.]+)"/)?.[1];
  const price = p ? Number(p) : null;
  if (/^(Gelöscht|Verkauft)\b/i.test(visible)) return { status: 'gone', price };
  if (/^Reserviert\b/i.test(visible)) return { status: 'reserved', price };
  return { status: 'active', price };
}

/** Beschreibung, Detailangaben und Verkäufer-Merkmale einer Anzeigenseite (ohne Namen). */
export function parseAd(html) {
  const description = stripTags((html.match(/<p[^>]*id="viewad-description-text"[^>]*>([\s\S]*?)<\/p>/)?.[1] || '').replace(/<br\s*\/?>/gi, '\n'));
  const details = {};
  for (const m of html.matchAll(/<li class="addetailslist--detail">([\s\S]*?)<span class="addetailslist--detail--value"[^>]*>([\s\S]*?)<\/span>/g)) {
    const k = stripTags(m[1]);
    if (k) details[k] = stripTags(m[2]);
  }
  const sellerSince = html.match(/Aktiv seit (\d{1,2}\.\d{1,2}\.\d{4})/)?.[1] || null;
  const sellerBadges = [...html.matchAll(/<span class="userbadge[^"]*">([\s\S]*?)<\/span>/g)].map((m) => stripTags(m[1])).filter(Boolean).slice(0, 5);
  const shipping = stripTags(html.match(/<span class="boxedarticle--details--shipping">([\s\S]*?)<\/span>/)?.[1] || '');
  return { description, details, sellerSince, sellerBadges, shipping };
}

/** Lädt die Anzeigenseite einmal und liefert Status + Inhalte. */
export async function fetchAd(listing, fetchFn = fetch) {
  const r = await get(listing.url, fetchFn);
  return { ...interpretAd(listing.id.replace(/^ka:/, ''), r), ...parseAd(r.html) };
}
