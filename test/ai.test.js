import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestProfile, AiError, PROFILE_SCHEMA } from '../src/ai.js';

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
});

test('SDK ist installiert und bietet die genutzten Aufrufe', async () => {
  const { default: SDK } = await import('@anthropic-ai/sdk');
  const c = new SDK({ apiKey: 'test' });
  assert.equal(typeof c.messages.create, 'function');
  assert.equal(typeof c.beta.messages.create, 'function');
  for (const k of ['BadRequestError', 'AuthenticationError', 'RateLimitError', 'APIConnectionError', 'APIError']) assert.equal(typeof SDK[k], 'function', k);
});
