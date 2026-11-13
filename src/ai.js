// KI-Vorschläge für Suchprofile über die Claude API.
// Der Vorschlag füllt nur das erweiterte Formular – gespeichert wird erst nach Bestätigung.

export const AI_MODEL = process.env.DEALRADAR_AI_MODEL || 'claude-opus-5-5';

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const PROFILE_SCHEMA = obj({
  name: { type: 'string', description: 'Kurzer Anzeigename der Suche' },
  emoji: { type: 'string', description: 'Ein einzelnes passendes Emoji' },
  queries: { type: 'array', items: { type: 'string' }, description: '1–6 Suchbegriffe für die Kleinanzeigen-Suche' },
  minPrice: { type: 'number' },
  maxPrice: nullable('number'),
  require: { type: 'array', items: { type: 'string' }, description: 'Pflichtbegriff-Gruppen; jede Gruppe muss in Titel oder Beschreibung vorkommen' },
  exclude: { type: 'string', description: 'Ausschluss-Muster für den Titel' },
  excludeText: { type: 'string', description: 'Ausschluss-Muster für Titel + Beschreibung, oft leer' },
  tiers: {
    type: 'array',
    items: obj({
      label: { type: 'string' },
      match: { type: 'string', description: 'Stichwort-Muster; leer = passt immer' },
      attr: { type: 'string', enum: ['', 'ram', 'bays', 'tb'] },
      min: nullable('number'),
      max: nullable('number'),
      target: nullable('number'),
      top: nullable('number'),
      unit: { type: 'string', enum: ['', 'tb'] },
    }),
  },
  badges: { type: 'array', items: obj({ any: { type: 'string' }, emoji: { type: 'string' }, text: { type: 'string' }, bonus: { type: 'number' } }) },
  warnings: { type: 'array', items: obj({ any: { type: 'string' }, text: { type: 'string' }, penalty: { type: 'number' } }) },
  note: { type: 'string', description: 'Kurzer Hinweis für den Nutzer: Annahmen und was er prüfen sollte' },
});

const SYSTEM = `Du konfigurierst Suchprofile für "Deal-Radar", eine App, die den deutschen Gebrauchtmarkt (kleinanzeigen.de) nach echten Preis-Ausreißern durchsucht. Der Nutzer beschreibt in eigenen Worten, was er sucht; du lieferst ein vollständig ausgefülltes Profil, das er anschließend im Formular prüft und anpasst.

So arbeitet die App mit dem Profil:
- queries: Jeder Eintrag ist ein eigener Abruf der Kleinanzeigen-Suche. Die App hat ein knappes Abruf-Budget, deshalb wenige, treffsichere Begriffe (meist 1–4), so wie man sie dort eintippen würde. Keine Varianten, die dieselben Anzeigen liefern.
- Gefundene Anzeigen werden gefiltert: require (jede Gruppe muss vorkommen), exclude (Titel), excludeText (Titel + Beschreibung), minPrice/maxPrice. Gesuche, Tausch- und Mietanzeigen filtert die App bereits selbst.
- tiers: Preisstufen. Die erste passende Stufe gilt; passt keine, wird die Anzeige verworfen. Eine Stufe passt über match (Stichwörter) und optional über ein erkanntes Merkmal (attr: "ram" = Arbeitsspeicher in GB, "bays" = NAS-Einschübe, "tb" = Gesamtkapazität in TB) mit min/max. unit "tb" bewertet den Preis pro TB statt pro Stück.
- target ist der Preis, ab dem ein Angebot als Deal gilt, top die Grenze für einen Top-Deal mit Benachrichtigung. Sind beide null, lernt die App den Marktmedian der Stufe aus den beobachteten Anzeigen und meldet deutlich darunter liegende Angebote.
- badges geben Pluspunkte (bonus, üblich 2–5) für wertsteigernde Hinweise im Text, warnings ziehen Punkte ab (penalty, üblich 15–40) für Risiken.

Muster-Syntax für require, exclude, excludeText, match und any:
- Alternativen mit | trennen. Innerhalb einer Alternative müssen alle durch Leerzeichen getrennten Begriffe vorkommen, Reihenfolge egal.
- Begriffe matchen an Wortgrenzen und ohne Rücksicht auf Groß-/Kleinschreibung: "pro" trifft nicht "Produkt". Ein * am Anfang oder Ende hebt die Grenze auf: "*hülle" trifft auch "Schutzhülle". Das ist bei deutschen Komposita für Zubehör wichtig.
- Zwischen Buchstaben und Ziffern sind Leerzeichen und Bindestriche egal: "a6000" trifft "A 6000".

Worauf es ankommt:
- Der Nutzer will nur außergewöhnliche Angebote sehen, keine Flut. Schließe typisches Zubehör, Ersatzteile und verwandte, aber ungewollte Produkte (andere Modellvarianten, Vorgänger, Bundles) über exclude aus, soweit sie bei dieser Suche realistisch auftauchen.
- Trenne Varianten mit deutlich unterschiedlichem Marktwert in eigene Stufen (z. B. Speichergrößen, Generationen), sonst verfälscht die teure Variante den Median der günstigen. Bei einem einheitlichen Produkt reicht eine Stufe.
- Setze target und top nur, wenn der Nutzer einen Preis nennt oder du den aktuellen deutschen Gebrauchtpreis wirklich sicher kennst. Preise ändern sich und dein Wissen kann veraltet sein; im Zweifel null lassen, dann lernt die App den Median selbst. Nennt der Nutzer einen Wunschpreis, verwende ihn als target.
- minPrice soll Zubehör und Lockangebote abschneiden, aber echte Schnäppchen durchlassen.
- warnings für bekannte Schwachstellen und Betrugsmuster genau dieses Produkts, wenn du welche kennst. Erfinde keine.
- note: zwei bis drei Sätze auf Deutsch – welche Annahmen du getroffen hast, ob Preise geschätzt sind und was der Nutzer vor dem Speichern prüfen sollte.

Alle Texte auf Deutsch. Liegt ein bestehendes Profil bei, überarbeite es nach dem Wunsch des Nutzers und behalte, was er nicht ändern will.`;

export class AiError extends Error {}

async function defaultClient(apiKey) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new AiError('KI-Paket fehlt auf dem Server – im App-Verzeichnis „npm install --omit=dev“ ausführen (oder deploy/install.sh erneut starten).');
  }
  return { Anthropic, client: new Anthropic({ apiKey }) };
}

/**
 * Liefert ein vorgeschlagenes Suchprofil (ungeprüft, ungespeichert).
 * @param {{description: string, wishPrice?: number, current?: object}} input
 */
export async function suggestProfile(input, { apiKey, clientFactory = defaultClient } = {}) {
  if (!apiKey) throw new AiError('Kein Claude-API-Schlüssel hinterlegt (Einstellungen → KI-Assistent).');
  const { Anthropic, client } = await clientFactory(apiKey);

  const parts = [`Das sucht der Nutzer:\n${input.description}`];
  if (input.wishPrice) parts.push(`Sein Wunschpreis: höchstens ${input.wishPrice} €.`);
  if (input.current) parts.push(`Bestehendes Profil, das überarbeitet werden soll:\n${JSON.stringify(input.current, null, 1)}`);

  const request = {
    model: AI_MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: PROFILE_SCHEMA } },
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  };

  let response;
  try {
    try {
      // Lehnt das Modell ab, übernimmt serverseitig ein Ausweichmodell.
      response = await client.beta.messages.create({ ...request, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (e) {
      if (!(Anthropic?.BadRequestError && e instanceof Anthropic.BadRequestError)) throw e;
      response = await client.messages.create(request); // ohne Ausweich-Option erneut
    }
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (Anthropic?.AuthenticationError && e instanceof Anthropic.AuthenticationError) throw new AiError('Claude-API-Schlüssel ungültig.');
    if (Anthropic?.RateLimitError && e instanceof Anthropic.RateLimitError) throw new AiError('Claude-API: Limit erreicht – später erneut versuchen.');
    if (Anthropic?.APIConnectionError && e instanceof Anthropic.APIConnectionError) throw new AiError('Claude-API nicht erreichbar (Netzwerk).');
    if (Anthropic?.APIError && e instanceof Anthropic.APIError) throw new AiError(`Claude-API-Fehler ${e.status}: ${e.message}`);
    throw e;
  }

  if (response.stop_reason === 'refusal') throw new AiError('Die KI hat diese Anfrage abgelehnt.');
  if (response.stop_reason === 'max_tokens') throw new AiError('KI-Antwort wurde abgeschnitten – Beschreibung kürzen und erneut versuchen.');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new AiError('Leere KI-Antwort.');
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('KI-Antwort war kein gültiges JSON.');
  }
}
