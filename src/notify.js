// Benachrichtigungen: ntfy (iPhone-App), Telegram, generischer Webhook.

const eur = (n) => (n == null ? '–' : `${Math.round(n).toLocaleString('de-DE')} €`);

export function formatAlert(l, profile) {
  const drop = l.extra?.dropFrom ? `📉 Preis gesenkt von ${eur(l.extra.dropFrom)} · ` : '';
  const flags = [l.level === 'top' ? '🔥' : '', ...(l.badges || []).map((b) => b.emoji), l.warnings?.length || l.extra?.suspicious ? '⚠️' : ''].filter(Boolean).join(' ');
  const lines = [
    `${drop}${eur(l.price)}${l.vb ? ' VB' : ''} · Score ${l.score}`,
    l.target ? `Ziel ≤ ${eur(l.target)}${l.median ? ` · Median ${eur(l.median)}` : ''}` : l.extra?.temp != null ? `${l.extra.temp}° · ${l.location}` : '',
    l.source === 'ka' ? [l.location, l.shipping ? 'Versand möglich' : 'nur Abholung'].filter(Boolean).join(' · ') : '',
    ...(l.warnings || []).map((w) => `⚠️ ${w.text}`),
    l.extra?.suspicious ? '⚠️ Verdächtig billig – Betrug/Fehler prüfen' : '',
  ].filter(Boolean);
  return {
    title: `${flags} ${profile?.emoji || ''} ${l.title}`.trim().slice(0, 180),
    body: lines.join('\n'),
    url: l.url,
    priority: l.score >= 95 ? 5 : 4,
  };
}

export function channels(s) {
  return [s.ntfyUrl && 'ntfy', s.telegramToken && s.telegramChat && 'telegram', s.webhookUrl && 'webhook'].filter(Boolean);
}

export async function send(settings, msg, fetchFn = fetch) {
  const results = [];
  const post = async (name, url, body) => {
    try {
      const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      results.push({ channel: name, ok: res.ok, status: res.status });
    } catch (e) {
      results.push({ channel: name, ok: false, error: e.message });
    }
  };
  if (settings.ntfyUrl) {
    // "https://ntfy.sh/mein-topic" -> JSON-Publish an den Server-Root (UTF-8-sicher)
    const u = new URL(settings.ntfyUrl);
    const topic = u.pathname.replace(/^\/+|\/+$/g, '');
    await post('ntfy', u.origin, { topic, title: msg.title, message: msg.body, click: msg.url, priority: msg.priority || 3, tags: ['moneybag'] });
  }
  if (settings.telegramToken && settings.telegramChat) {
    const h = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const text = `<b>${h(msg.title)}</b>\n${h(msg.body)}${msg.url ? `\n${h(msg.url)}` : ''}`;
    await post('telegram', `https://api.telegram.org/bot${settings.telegramToken}/sendMessage`, { chat_id: settings.telegramChat, text, parse_mode: 'HTML', disable_web_page_preview: false });
  }
  if (settings.webhookUrl) await post('webhook', settings.webhookUrl, msg);
  return results;
}
