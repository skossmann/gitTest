// RSS-Feeds für Neuware-Deals (z. B. mydealz "Hot").
import { decodeEntities, stripTags, parsePrice } from '../extract.js';
import { UA } from './kleinanzeigen.js';

const cdata = (s = '') => s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
const tag = (xml, name) => cdata(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]?.trim() || '');

export function parseFeed(xml) {
  const items = [];
  for (const raw of xml.split(/<item\b[^>]*>/).slice(1)) {
    const it = raw.split('</item>')[0];
    const link = decodeEntities(tag(it, 'link'));
    let title = decodeEntities(tag(it, 'title'));
    if (!link || !title) continue;
    let temp = null;
    const tm = title.match(/^(-?\d+)°\s*-\s*/); // mydealz: "108° - Titel"
    if (tm) {
      temp = Number(tm[1]);
      title = title.slice(tm[0].length);
    }
    const merchant = it.match(/<pepper:merchant[^>]*name="([^"]*)"/)?.[1] || '';
    const priceAttr = it.match(/<pepper:merchant[^>]*price="([^"]*)"/)?.[1] || '';
    const descr = stripTags(tag(it, 'description')).slice(0, 400);
    const { price } = parsePrice(decodeEntities(priceAttr) || descr.slice(0, 60));
    const image = decodeEntities(it.match(/<media:content[^>]*url="([^"]+)"/)?.[1] || '');
    const pub = Date.parse(tag(it, 'pubDate'));
    const key = link.match(/-(\d+)$/)?.[1] || link;
    items.push({
      id: `rss:${key}`,
      source: 'rss',
      url: link,
      title,
      descr,
      image,
      price,
      priceText: decodeEntities(priceAttr),
      vb: false,
      location: decodeEntities(merchant),
      posted: Number.isNaN(pub) ? null : pub,
      pro: true,
      shipping: true,
      temp,
      category: decodeEntities(tag(it, 'category')),
    });
  }
  return items;
}

export async function fetchFeed(url, fetchFn = fetch) {
  const res = await fetchFn(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseFeed(await res.text());
}

/** Temperatur -> Score: 200° = 70, 350° = 85, ab 500° = 100 */
export const tempScore = (temp) => Math.max(0, Math.min(100, Math.round(50 + temp / 10)));
