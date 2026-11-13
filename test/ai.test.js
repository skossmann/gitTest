import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suggestProfile, assessListing, AiError, PROFILE_SCHEMA, ASSESS_SCHEMA } from '../src/ai.js';
import { parseAd } from '../src/sources/kleinanzeigen.js';

class BadRequestError extends Error {}
const Anthropic = { BadRequestError };
const answer = { name: 'Sonos Arc', emoji: '🔊', queries: ['sonos arc'], minPrice: 100, maxPrice: null, require: ['sonos arc'], exclude: '*halterung|sub', excludeText: '', tiers: [{ label: 'Arc', match: '', attr: '', min: null, max: null, target: 400, top: null, unit: '' }], badges: [], warnings: [], note: 'Preis vom Nutzer.' };
const ok = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer) }] };

test('KI-Vorschlag: Anfrage und Antwort', async () => {
  const calls = [];
  const client = { beta: { messages: { create: async (req) => { calls.push(req); return ok; } } }, messages: { create: async () => assert.fail('nicht erwartet') } };
  const out = await suggestProfile({ description: 'Sonos Arc Soundbar', wishPrice: 400 }, { apiKey: 'k', clientFactory: async () => ({ Anthropic, client }) });
  assert.deepEqual(out, answer);
  const req = calls[0];
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.fallbacks, 'default');
  assert.match(req.messages[0].content, /Sonos Arc Soundbar/);
  assert.match(req.messages[0].content, /400 €/);
  assert.ok(!('temperature' in req) && !('thinking' in req));
});

test('KI-Vorschlag: ohne Ausweich-Option erneut, Ablehnung, fehlender Schlüssel', async () => {
  let plain = 0;
  const client = { beta: { messages: { create: async () => { throw new BadRequestError('beta unbekannt'); } } }, messages: { create: async (req) => { plain++; assert.equal(req.fallbacks, undefined); return ok; } } };
  await suggestProfile({ description: 'x y z' }, { apiKey: 'k', clientFactory: async () => ({ Anthropic, client }) });
  assert.equal(plain, 1);
  const refusing = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } };
  await assert.rejects(suggestProfile({ description: 'x y z' }, { apiKey: 'k', clientFactory: async () => ({ Anthropic, client: refusing }) }), AiError);
  await assert.rejects(suggestProfile({ description: 'x y z' }, { apiKey: '' }), /Schlüssel/);
});

test('Schema: alle Objekte geschlossen und vollständig required', () => {
  const walk = (n) => {
    if (n?.type === 'object') {
      assert.equal(n.additionalProperties, false);
      assert.deepEqual(n.required, Object.keys(n.properties));
      Object.values(n.properties).forEach(walk);
    }
    if (n?.items) walk(n.items);
  };
  walk(PROFILE_SCHEMA);
  walk(ASSESS_SCHEMA);
});

test('SDK ist installiert und bietet die genutzten Aufrufe', async () => {
  const { default: SDK } = await import('@anthropic-ai/sdk');
  const c = new SDK({ apiKey: 'test' });
  assert.equal(typeof c.messages.create, 'function');
  assert.equal(typeof c.beta.messages.create, 'function');
  for (const k of ['BadRequestError', 'AuthenticationError', 'RateLimitError', 'APIConnectionError', 'APIError']) assert.equal(typeof SDK[k], 'function', k);
});

test('Anzeigenseite: Beschreibung, Details, Verkäufer-Merkmale', () => {
  const ad = parseAd(readFileSync(new URL('./fixtures/ka-ad.html', import.meta.url), 'utf8'));
  assert.match(ad.description, /^ZOTAC Geforce RTX 5090, steht zum Verkauf/);
  assert.match(ad.description, /Garantie enthalten\.$/);
  assert.deepEqual(ad.details, { Art: 'Grafikkarten', Zustand: 'Sehr Gut' });
  assert.equal(ad.sellerSince, '25.10.2026');
  assert.ok(ad.sellerBadges.length >= 1);
  assert.match(ad.shipping, /Versand ab 7,69/);
});

test('Angebotsbewertung: Anfrage enthält Anzeige, App-Bewertung und Suchprofil', async () => {
  const verdict = { verdict: 'pruefen', headline: 'h', product: 'p', fit: 'f', price: 'pr', strengths: [], risks: ['r'], questions: ['q'], negotiation: '', limits: 'l' };
  let req;
  const client = { beta: { messages: { create: async (r) => { req = r; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(verdict) }] }; } } } };
  const listing = { source: 'ka', title: 'ZOTAC RTX 5090', price: 3250, vb: false, location: '90431 Nürnberg', shipping: true, descr: 'kurz…', score: 96, tier: 'RTX 5090 (32 GB)', target: 4950, top: 4400, median: 5500, unit_price: 3250, attrs: {}, badges: [], warnings: [], history: [{ t: 1, p: 3250 }], extra: { obs: 19 }, status: 'active' };
  const out = await assessListing({ listing, profile: { name: 'Grafikkarten', queries: ['rtx 5090'], tiers: [{ label: 'RTX 5090 (32 GB)' }] }, ad: { description: 'Volltext der Anzeige', details: { Zustand: 'Sehr Gut' }, sellerSince: '25.10.2026', sellerBadges: [], shipping: '+ Versand ab 7,69 €', status: 'active' } }, { apiKey: 'k', clientFactory: async () => ({ Anthropic, client }) });
  assert.deepEqual(out, verdict);
  const u = req.messages[0].content;
  for (const needle of ['Volltext der Anzeige', '3250 €', '5500 €', 'aus 19 Anzeigen', 'Sehr Gut', '25.10.2026', 'Grafikkarten', 'Privatanzeige']) assert.ok(u.includes(needle), needle);
  assert.ok(!u.includes('kurz…'));
  assert.equal(req.output_config.effort, 'high');
});
