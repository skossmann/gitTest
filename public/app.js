// Deal-Radar – Oberfläche (ohne Framework, ohne Build-Schritt)
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const eur = (n, d = 0) => (n == null ? '–' : `${Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d })} €`);

let S = null;
let editing = null; // Profil im Editor
const ui = { tab: localStorage.tab || 'radar', view: 'deals', profile: '', sort: 'score', q: '', sheet: null };

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((S.now - ts) / 60000);
  if (m < 1) return 'gerade eben';
  if (m < 60) return `vor ${m} min`;
  if (m < 60 * 36) return `vor ${Math.round(m / 60)} h`;
  return `vor ${Math.round(m / 1440)} Tagen`;
}
const until = (ts) => {
  const m = Math.round((ts - S.now) / 60000);
  return m <= 0 ? 'gleich' : m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
};
const clock = (ts) => new Date(ts).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const prof = (id) => S.profiles.find((p) => p.id === id);
const isDeal = (l) => l.level === 'top' || l.level === 'deal';
const live = (l) => l.status !== 'gone' && !l.hidden;
const fresh = (l) => l.posted || l.first_seen;

// ---------- Bausteine ----------
function saveText(l) {
  if (l.source === 'rss') return l.extra.temp != null ? `${l.extra.temp}°` : '';
  const u = l.unit_price;
  if (l.median && u < l.median) return `−${Math.round((1 - u / l.median) * 100)} % ggü. Median`;
  if (l.target && u <= l.target) return `${Math.round((1 - u / l.target) * 100)} % unter Ziel`;
  return '';
}

function tags(l) {
  const out = [];
  if (l.status === 'reserved') out.push('<span class="tag w">Reserviert</span>');
  if (l.status === 'gone') out.push('<span class="tag w">Weg</span>');
  if (l.hidden) out.push('<span class="tag">ausgeblendet</span>');
  if (l.extra.dropFrom) out.push(`<span class="tag g">📉 war ${eur(l.extra.dropFrom)}</span>`);
  if (l.extra.unit === 'tb' && l.attrs.tb) out.push(`<span class="tag">${eur(l.unit_price, 2)}/TB · ${l.attrs.tb} TB</span>`);
  for (const b of l.badges) out.push(`<span class="tag t">${h(b.emoji)} ${h(b.text.split(' (')[0])}</span>`);
  if (l.extra.suspicious) out.push('<span class="tag w">⚠️ verdächtig billig</span>');
  for (const w of l.warnings) out.push(`<span class="tag w">⚠️ ${h(w.text.split(' (')[0])}</span>`);
  if (l.level === 'unknown' && l.source === 'ka') out.push('<span class="tag">Lernphase</span>');
  return out.join('');
}

const ring = (l) => `<div class="ring ${l.level}" style="--v:${l.score}" aria-label="Score ${l.score}">${l.level === 'unknown' ? '…' : l.score}</div>`;
const thumb = (l, p) => (l.image ? `<img src="${h(l.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : h(p?.emoji || '🏷️'));

function card(l) {
  const p = prof(l.profile_id);
  const where = l.source === 'rss' ? l.location : [l.location, l.shipping ? 'Versand' : 'Abholung', l.pro ? 'gewerblich' : ''].filter(Boolean).join(' · ');
  return `<button class="card ${l.level === 'top' ? 'top' : ''} ${l.status === 'gone' ? 'gone' : ''}" data-act="detail" data-id="${h(l.id)}">
    <div class="thumb">${thumb(l, p)}</div>
    <div class="b">
      <div class="r1">${l.fav ? '⭐ ' : ''}${h(p?.emoji || '')} ${h(l.tier || p?.name || '')} · ${ago(fresh(l))}</div>
      <h3>${h(l.title)}</h3>
      <div class="price"><b>${l.price != null ? eur(l.price, l.price % 1 ? 2 : 0) : '–'}</b>${l.vb ? '<span class="muted small">VB</span>' : ''}${saveText(l) ? `<span class="save">${saveText(l)}</span>` : ''}</div>
      <div class="meta">${h(where)}</div>
      <div class="tags">${tags(l)}</div>
    </div>${ring(l)}
  </button>`;
}

// ---------- Radar ----------
function viewRadar() {
  const act = S.listings.filter(live);
  const deals = act.filter(isDeal).sort((a, b) => b.score - a.score || fresh(b) - fresh(a));
  const tops = deals.filter((l) => l.level === 'top');
  const day = S.now - 86400000;
  const isNew = deals.filter((l) => l.first_seen > day);
  const gone = S.listings.filter((l) => l.status === 'gone' && l.gone_at > S.now - 7 * 86400000);
  const drops = deals.filter((l) => l.extra.dropFrom);
  const last = S.runs[0];
  const best = deals.find((l) => !l.extra.suspicious) || deals[0]; // verdächtig billige Anzeigen nicht als Aufmacher
  const p = best && prof(best.profile_id);

  const lastFor = (id) => S.runs.find((r) => r.profiles?.[id]?.queries > 0);
  const cats = S.profiles
    .map((pr) => {
      const mine = act.filter((l) => l.profile_id === pr.id);
      const d = mine.filter(isDeal);
      const t = d.filter((l) => l.level === 'top').length;
      const run = lastFor(pr.id);
      let st;
      if (!pr.enabled) st = 'ausgeschaltet';
      else if (d.length) st = `${t ? `${t} 🔥 · ` : ''}${d.length} Deal${d.length > 1 ? 's' : ''}`;
      else if (!run) st = 'noch nicht geprüft';
      else if (mine.length && mine.every((l) => l.level === 'unknown')) st = `Lernphase · ${mine.length} Anzeigen`;
      else st = `kein extremer Treffer · ${ago(run.finished)}`;
      return `<button class="cat ${d.length ? 'hit' : ''} ${pr.enabled ? '' : 'off'}" data-act="cat" data-id="${h(pr.id)}"><span class="em">${h(pr.emoji)}</span><span class="nm">${h(pr.name)}</span><span class="st">${st}</span></button>`;
    })
    .join('');

  const ka = last?.sources?.ka;
  const blocked = S.kaBlockedUntil > S.now;
  const errs = [...(ka?.errors || []), ...(last?.sources?.rss?.errors || []), last?.error, last?.sources?.notify].filter(Boolean);

  return `
  <header class="head">
    <div class="radar ${S.running ? 'busy' : ''}"></div>
    <div class="grow"><h1>Deal-Radar</h1>
      <div class="sub">${S.running ? h(S.progress || 'Suche läuft …') : last ? `Letzter Lauf ${ago(last.finished)} · nächster ${S.nextRun ? until(S.nextRun) : '–'}` : 'Noch kein Lauf – gleich geht’s los'}</div></div>
    <button class="btn pri" data-act="run" ${S.running ? 'disabled' : ''}>${S.running ? 'läuft …' : 'Jetzt suchen'}</button>
  </header>
  ${blocked ? `<div class="banner">⚠️ <b>Kleinanzeigen schränkt den Zugriff ein.</b> Der Radar pausiert dort bis ${clock(S.kaBlockedUntil)} – Kleinanzeigen ist bis dahin <b>nicht vollständig geprüft</b>.<br><button class="btn" data-act="unblock">Pause vorzeitig beenden</button></div>` : ''}
  ${!S.channels.length ? '<div class="banner info">🔔 Noch kein Benachrichtigungskanal eingerichtet – Top-Deals erscheinen nur hier. <button class="btn" data-act="goto" data-id="settings">Einrichten</button></div>' : ''}
  ${best ? `<button class="card hero ${best.level === 'top' ? 'top' : ''}" data-act="detail" data-id="${h(best.id)}">
      <div class="img">${thumb({ ...best, image: best.image.replace('$_2.', '$_59.') }, p)}</div><span class="flag">${best.level === 'top' ? '🔥 Bester Deal gerade' : 'Bestes Angebot gerade'}</span>${ring(best)}
      <div class="b"><div class="r1">${h(p?.emoji || '')} ${h(best.tier || p?.name || '')} · ${ago(fresh(best))}</div><h3>${h(best.title)}</h3>
      <div class="price"><b>${eur(best.price)}</b>${best.vb ? '<span class="muted small">VB</span>' : ''}${saveText(best) ? `<span class="save">${saveText(best)}</span>` : ''}</div>
      <div class="meta">${h(best.location)}</div><div class="tags">${tags(best)}</div></div></button>` : `<p class="empty">Gerade kein Angebot über der Schwelle.<br>Das ist gewollt – gemeldet werden nur echte Ausreißer.</p>`}
  <div class="tiles">
    <div class="tile hot"><b>${tops.length}</b><span>🔥 Top-Deals</span></div>
    <div class="tile ok"><b>${deals.length}</b><span>Deals aktiv</span></div>
    <div class="tile"><b>${isNew.length}</b><span>neu (24 h)</span></div>
    <div class="tile"><b>${gone.length}</b><span>weg (7 Tage)</span></div>
  </div>
  ${deals.length > 1 ? `<h2 class="sec">Top 5 gerade <button data-act="goto" data-id="deals">alle ›</button></h2>${deals.filter((l) => l !== best).slice(0, 5).map(card).join('')}` : ''}
  ${drops.length ? `<h2 class="sec">Preis gesenkt</h2>${drops.slice(0, 3).map(card).join('')}` : ''}
  <h2 class="sec">Kategorien</h2><div class="cats">${cats}</div>
  <h2 class="sec">Letzter Lauf</h2>
  <div class="panel small">${last ? `${clock(last.started)} · ${Math.round((last.finished - last.started) / 1000)} s · Kleinanzeigen: ${ka?.blocked ? '<b class="err">eingeschränkt / pausiert</b>' : `${ka?.requests ?? 0} Abrufe`} · Feeds: ${last.sources?.rss?.feeds ?? 0} · ${last.checked} Verfügbarkeitsprüfungen (${last.gone} weg) · ${last.alerts} Meldungen
    ${errs.length ? `<div class="log err">${errs.map(h).join('<br>')}</div>` : ''}` : 'Noch kein Lauf.'}</div>`;
}

// ---------- Deals ----------
function filtered() {
  let ls = S.listings;
  if (ui.view === 'deals') ls = ls.filter((l) => live(l) && isDeal(l));
  else if (ui.view === 'all') ls = ls.filter(live);
  else if (ui.view === 'fav') ls = ls.filter((l) => l.fav);
  else ls = ls.filter((l) => l.status === 'gone' || l.hidden);
  if (ui.profile) ls = ls.filter((l) => l.profile_id === ui.profile);
  if (ui.q) {
    const q = ui.q.toLowerCase();
    ls = ls.filter((l) => `${l.title} ${l.location} ${l.tier}`.toLowerCase().includes(q));
  }
  const by = {
    score: (a, b) => b.score - a.score || fresh(b) - fresh(a),
    new: (a, b) => fresh(b) - fresh(a),
    price: (a, b) => (a.price ?? 1e12) - (b.price ?? 1e12),
    save: (a, b) => (b.saving || 0) - (a.saving || 0),
  };
  return [...ls].sort(by[ui.sort]);
}

function viewDeals() {
  const ls = filtered();
  const seg = [['deals', 'Deals'], ['all', 'Alle'], ['fav', '⭐ Gemerkt'], ['gone', 'Archiv']];
  return `
  <div class="bar">
    <div class="seg">${seg.map(([k, t]) => `<button class="${ui.view === k ? 'on' : ''}" data-act="view" data-id="${k}">${t}</button>`).join('')}</div>
    <div class="row" style="margin-bottom:8px"><input type="search" id="q" placeholder="Suchen …" value="${h(ui.q)}" autocomplete="off">
      <select id="sort" aria-label="Sortierung">${[['score', 'Beste zuerst'], ['new', 'Neueste'], ['price', 'Preis'], ['save', 'Ersparnis']].map(([k, t]) => `<option value="${k}" ${ui.sort === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="chips"><button class="chip ${ui.profile ? '' : 'on'}" data-act="pf" data-id="">Alle</button>${S.profiles.filter((p) => p.enabled || S.listings.some((l) => l.profile_id === p.id)).map((p) => `<button class="chip ${ui.profile === p.id ? 'on' : ''}" data-act="pf" data-id="${h(p.id)}">${h(p.emoji)} ${h(p.name)}</button>`).join('')}</div>
  </div>
  <div id="list">${listHtml(ls)}</div>`;
}

function listHtml(ls) {
  const hint = { deals: 'Kein Angebot über der Deal-Schwelle. Unter „Alle“ siehst du sämtliche beobachteten Anzeigen.', all: 'Noch keine Anzeigen erfasst.', fav: 'Noch nichts gemerkt – ⭐ in der Detailansicht.', gone: 'Archiv ist leer.' }[ui.view];
  return ls.length ? `<p class="muted small" style="margin:2px 2px 8px">${ls.length} Angebot${ls.length === 1 ? '' : 'e'}</p>${ls.slice(0, 300).map(card).join('')}` : `<p class="empty">${hint}</p>`;
}

// ---------- Detail ----------
function spark(hist) {
  if (hist.length < 2) return '';
  const ps = hist.map((x) => x.p);
  const min = Math.min(...ps);
  const max = Math.max(...ps);
  const pts = hist.map((x, i) => `${(i / (hist.length - 1)) * 300},${44 - ((x.p - min) / (max - min || 1)) * 38}`).join(' ');
  return `<svg class="spark" viewBox="0 0 300 50" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>
    <div class="small muted">${hist.map((x) => `${new Date(x.t).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}: ${eur(x.p)}`).join(' → ')}</div>`;
}

const VERDICT = { zugreifen: ['🟢', 'Zugreifen', 'g'], pruefen: ['🟡', 'Interessant – erst prüfen', 't'], abwarten: ['⚪', 'Kein besonderer Deal', ''], finger_weg: ['🔴', 'Finger weg', 'w'] };

function aiPanel(l) {
  const a = l.extra.ai;
  if (!a) return '';
  const r = a.result;
  const [icon, label, cls] = VERDICT[r.verdict] || ['', r.verdict, ''];
  const sec = (title, text) => (text ? `<h4>${title}</h4><p>${h(text)}</p>` : '');
  const lst = (title, items) => (items?.length ? `<h4>${title}</h4><ul>${items.map((x) => `<li>${h(x)}</li>`).join('')}</ul>` : '');
  const stale = a.price !== l.price ? ` · Preis war damals ${eur(a.price)}` : '';
  return `<div class="panel ai"><h3>✨ KI-Bewertung</h3>
    <div class="verdict ${cls}">${icon} ${h(label)}</div><p><b>${h(r.headline)}</b></p>
    ${sec('Produkt & Technik', r.product)}${sec('Passt es zur Suche?', r.fit)}${sec('Preis', r.price)}
    ${lst('Dafür spricht', r.strengths)}${lst('Risiken', r.risks)}${lst('Fragen & Prüfpunkte', r.questions)}
    ${sec('Verhandlung', r.negotiation)}${sec('Nicht beurteilbar', r.limits)}
    <p class="muted small" style="margin-top:10px">${ago(a.t)}${stale} · ${a.full ? 'auf Basis der vollständigen Anzeige' : h(a.note || 'nur anhand des Kurztexts')}. KI-Einschätzung – Angaben und Preise können falsch oder veraltet sein.</p></div>`;
}

function detail(l) {
  const p = prof(l.profile_id);
  const u = l.extra.unit === 'tb' ? '/TB' : '';
  const d = l.extra.unit === 'tb' ? 2 : 0;
  const basis = { fest: 'fester Zielpreis', median: `Marktmedian (${l.extra.obs} Anzeigen)`, lernphase: `Lernphase – erst ${l.extra.obs ?? 0} von 8 Vergleichsanzeigen`, temperatur: 'mydealz-Temperatur' }[l.basis] || '–';
  const status = l.status === 'gone' ? `Weg – ${h(l.gone_reason || '')}` : l.status === 'reserved' ? 'Reserviert' : 'Aktiv';
  return `
  <div class="sheet-top"><h2>${h(p?.emoji || '')} ${h(l.tier || p?.name || '')}</h2><button class="x" data-act="close-sheet" aria-label="Schließen">✕</button></div>
  ${l.image ? `<img class="dimg" src="${h(l.image.replace('$_2.', '$_59.'))}" alt="" referrerpolicy="no-referrer">` : ''}
  <h3 style="font-size:18px;line-height:1.25">${h(l.title)}</h3>
  <div class="price" style="margin:8px 0"><b style="font-size:26px">${l.price != null ? eur(l.price, l.price % 1 ? 2 : 0) : '–'}</b>${l.vb ? '<span class="muted">VB</span>' : ''}${saveText(l) ? `<span class="save">${saveText(l)}</span>` : ''}</div>
  <div class="tags" style="margin-bottom:12px">${tags(l)}</div>
  <div class="actions">
    <a class="btn pri wide" href="${h(l.url)}" target="_blank" rel="noopener noreferrer">Angebot öffnen ↗</a>
    ${S.ai ? `<button class="btn wide" data-act="ask-ai" data-id="${h(l.id)}">✨ ${l.extra.ai ? 'KI erneut fragen' : 'KI fragen'}</button>` : ''}
    <button class="btn" data-act="fav" data-id="${h(l.id)}">${l.fav ? '⭐ Gemerkt' : '☆ Merken'}</button>
    <button class="btn" data-act="hide" data-id="${h(l.id)}">${l.hidden ? '👁 Einblenden' : '🙈 Ausblenden'}</button>
  </div>
  ${aiPanel(l)}
  <div class="panel" style="margin-top:12px"><h3>Warum ${isDeal(l) ? 'ist das ein Deal' : 'dieser Score'}?</h3>
    <dl class="kv">
      <dt>Score</dt><dd><b>${l.level === 'unknown' ? '–' : l.score}</b> / 100 ${l.level === 'top' ? '🔥 Top-Deal' : l.level === 'deal' ? '✅ Deal' : ''}</dd>
      <dt>Bewertungsbasis</dt><dd>${basis}</dd>
      ${l.source === 'ka' ? `${u ? `<dt>Preis je TB</dt><dd>${eur(l.unit_price, 2)}</dd>` : ''}
      <dt>Zielpreis${u}</dt><dd>${l.target ? `≤ ${eur(l.target, d)}` : '–'}</dd>
      <dt>Top-Deal-Grenze${u}</dt><dd>${l.top ? `≤ ${eur(l.top, d)}` : '–'}</dd>
      <dt>Marktmedian${u}</dt><dd>${l.median ? eur(l.median, d) : `zu wenig Daten (${l.extra.obs ?? 0})`}</dd>` : `<dt>Temperatur</dt><dd>${l.extra.temp ?? '–'}°</dd><dt>Händler</dt><dd>${h(l.location)}</dd>`}
      <dt>Status</dt><dd>${status}</dd>
      <dt>Zuerst gesehen</dt><dd>${ago(l.first_seen)}</dd>
      <dt>Zuletzt in Suche</dt><dd>${ago(l.last_seen)}</dd>
      ${l.last_checked ? `<dt>Einzeln geprüft</dt><dd>${ago(l.last_checked)}</dd>` : ''}
    </dl>
    ${[...l.badges.map((b) => `${b.emoji} ${b.text}`), ...l.warnings.map((w) => `⚠️ ${w.text}`), l.extra.suspicious ? '⚠️ Preis liegt weit unter der Top-Deal-Grenze – Betrug oder Fehlangebot prüfen, nie per Vorkasse zahlen.' : ''].filter(Boolean).map((t) => `<p class="small" style="margin-top:8px">${h(t)}</p>`).join('')}
    ${spark(l.history)}
  </div>
  ${l.descr ? `<div class="panel"><h3>Beschreibung (Auszug)</h3><p class="small" style="white-space:pre-line">${h(l.descr)}</p></div>` : ''}`;
}

// ---------- Suchprofile ----------
function viewSearches() {
  return `<header class="head"><div class="grow"><h1>Suchen</h1><div class="sub">Was der Radar beobachtet – alles antippbar und änderbar</div></div></header>
  ${S.profiles.map((p) => `<div class="prow"><button class="row grow" data-act="edit" data-id="${h(p.id)}" style="text-align:left"><span class="em">${h(p.emoji)}</span><span class="grow"><span class="nm">${h(p.name)}</span><br><span class="muted small">${p.type === 'rss' ? `${p.feeds.length} Feed · ab ${p.minTemp}°` : `${p.queries.length} Suche${p.queries.length === 1 ? '' : 'n'} · ${p.tiers.length} Preisstufe${p.tiers.length === 1 ? '' : 'n'}`}</span></span></button>
    <button class="switch ${p.enabled ? 'on' : ''}" data-act="toggle" data-id="${h(p.id)}" role="switch" aria-checked="${p.enabled}" aria-label="${h(p.name)} aktiv"></button></div>`).join('')}
  <div class="row" style="margin-top:14px"><button class="btn pri grow" data-act="new-simple">+ Neue Suche</button><button class="btn" data-act="new" data-id="rss">+ Deal-Feed</button></div>
  <p class="muted small" style="margin-top:14px">Pro Lauf werden höchstens ${S.settings.kaBudget - S.settings.checkBudget} Suchen abgerufen (reihum). Bei ${S.profiles.filter((p) => p.enabled && p.type !== 'rss').reduce((n, p) => n + p.queries.length, 0)} aktiven Suchen ist jede etwa alle ${Math.ceil(S.profiles.filter((p) => p.enabled && p.type !== 'rss').reduce((n, p) => n + p.queries.length, 0) / Math.max(1, S.settings.kaBudget - S.settings.checkBudget)) * S.settings.intervalMin / 60} h dran.</p>`;
}

const F = (label, name, val, o = {}) => `<label class="f"><span>${label}</span>${o.area ? `<textarea data-k="${name}" ${o.ph ? `placeholder="${h(o.ph)}"` : ''}>${h(val ?? '')}</textarea>` : `<input type="${o.type || 'text'}" ${o.type === 'number' ? 'inputmode="decimal" step="any"' : ''} data-k="${name}" value="${h(val ?? '')}" ${o.ph ? `placeholder="${h(o.ph)}"` : ''} autocomplete="off" autocapitalize="off">`}${o.help ? `<small>${o.help}</small>` : ''}</label>`;

const tierRow = (t = {}) => `<div class="sub-item" data-row="tiers"><button class="del" data-act="del-row" aria-label="Stufe löschen">✕</button>
  ${F('Bezeichnung', 'label', t.label)}${F('Stichwörter (leer = alle)', 'match', t.match, { ph: 'a6000|rtx 6000 ada' })}
  <div class="grid3"><label class="f"><span>Merkmal</span><select data-k="attr" style="width:100%"><option value="">–</option>${[['ram', 'RAM (GB)'], ['bays', 'Einschübe'], ['tb', 'Kapazität (TB)']].map(([k, n]) => `<option value="${k}" ${t.attr === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>${F('von', 'min', t.min, { type: 'number' })}${F('bis', 'max', t.max, { type: 'number' })}</div>
  <div class="grid3">${F('Zielpreis €', 'target', t.target, { type: 'number', ph: 'auto' })}${F('Top-Deal €', 'top', t.top, { type: 'number', ph: 'auto' })}<label class="f"><span>Preis je</span><select data-k="unit" style="width:100%"><option value="">Stück</option><option value="tb" ${t.unit === 'tb' ? 'selected' : ''}>TB</option></select></label></div></div>`;
const badgeRow = (b = {}) => `<div class="sub-item" data-row="badges"><button class="del" data-act="del-row" aria-label="Löschen">✕</button>${F('Stichwörter', 'any', b.any)}<div class="grid3">${F('Emoji', 'emoji', b.emoji ?? '✨')}${F('Bonus-Punkte', 'bonus', b.bonus ?? 0, { type: 'number' })}<span></span></div>${F('Hinweistext', 'text', b.text)}</div>`;
const warnRow = (w = {}) => `<div class="sub-item" data-row="warnings"><button class="del" data-act="del-row" aria-label="Löschen">✕</button>${F('Stichwörter', 'any', w.any)}${F('Warntext', 'text', w.text)}${F('Punktabzug', 'penalty', w.penalty ?? 20, { type: 'number' })}</div>`;

// Einfache Suche: ein Feld genügt. Von hier geht es optional ins erweiterte Formular oder zur KI.
function simpleForm(v = {}) {
  return `<div class="sheet-top"><h2>Neue Suche</h2><button class="x" data-act="close-sheet" aria-label="Schließen">✕</button></div>
  <div class="panel">
    <label class="f"><span>Was suchst du?</span><textarea id="s-term" rows="2" style="min-height:64px;font-family:inherit;font-size:16px" placeholder="z. B. Sonos Arc">${h(v.term || '')}</textarea>
      <small>Ein Suchbegriff genügt. Für die KI darfst du auch ausführlich beschreiben, worauf es dir ankommt.</small></label>
    <div class="grid2"><label class="f"><span>Wunschpreis € (optional)</span><input type="number" inputmode="decimal" id="s-wish" value="${h(v.wish || '')}" placeholder="lernt Marktpreis"></label>
      <label class="f"><span>Nicht im Titel (optional)</span><input type="text" id="s-ex" value="${h(v.ex || '')}" placeholder="defekt, hülle" autocapitalize="off"></label></div>
    <p class="muted small">Ohne Wunschpreis beobachtet der Radar erst den Markt und meldet dann Angebote deutlich unter dem üblichen Preis.</p>
  </div>
  <div class="actions">
    <button class="btn pri wide" data-act="save-simple">Suche anlegen</button>
    <button class="btn" data-act="ai-new">✨ Mit KI ausfüllen</button>
    <button class="btn" data-act="to-advanced">Erweitert …</button>
  </div>
  <p class="muted small">${S.ai ? '„Mit KI ausfüllen“ erstellt aus deiner Beschreibung einen Vorschlag mit Suchbegriffen, Ausschlüssen, Preisstufen und Warnungen. Du prüfst ihn im erweiterten Formular, bevor etwas gespeichert wird.' : 'Für „Mit KI ausfüllen“ zuerst unter Einstellungen → KI-Assistent einen Claude-API-Schlüssel eintragen.'}</p>`;
}

function readSimple() {
  const term = $('#s-term').value.replace(/\s+/g, ' ').trim();
  const wish = Number($('#s-wish').value) || null;
  const ex = $('#s-ex').value.split(/[,;|]/).map((x) => x.trim()).filter(Boolean);
  return { term, wish, ex };
}

function simpleProfile({ term, wish, ex }) {
  if (!term) throw new Error('Bitte einen Suchbegriff eingeben.');
  if (term.length > 60) throw new Error('Für die einfache Suche bitte einen kurzen Suchbegriff – längere Beschreibungen kann die KI umsetzen.');
  return {
    type: 'ka', name: term, emoji: '🔎', enabled: true, queries: [term], require: [term], exclude: ex.join('|'), excludeText: '',
    minPrice: wish ? Math.max(10, Math.round(wish * 0.15)) : 20, maxPrice: wish ? wish * 2 : '',
    tiers: [{ label: term, target: wish || '' }], badges: [], warnings: [],
  };
}

async function askAi(btn, payload, keep = {}) {
  if (!S.ai) throw new Error('Erst unter Einstellungen → KI-Assistent einen Claude-API-Schlüssel eintragen.');
  const label = btn.textContent;
  const sheet = ui.sheet;
  btn.disabled = true;
  btn.textContent = '✨ KI arbeitet … (bis ca. 1 min)';
  try {
    const { profile } = await api('POST', '/api/ai/suggest', payload);
    if (ui.sheet !== sheet) return; // Formular wurde inzwischen geschlossen
    editing = { ...profile, ...keep, type: 'ka', aiFilled: true };
    openSheet(editor(editing), 'edit');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function editor(p) {
  const isNew = !p.id;
  const head = `<div class="sheet-top"><h2>${isNew ? 'Neue Suche' : h(p.name)}</h2><button class="x" data-act="close-sheet" aria-label="Schließen">✕</button></div>
    ${p.aiFilled ? '<div class="banner info">✨ <b>KI-Vorschlag – noch nicht gespeichert.</b> Bitte prüfen, vor allem Preise und Ausschlüsse.</div>' : ''}
    ${p.note ? `<div class="banner info">${h(p.note)}</div>` : ''}
    ${p.type !== 'rss' && S.ai ? `<div class="panel"><label class="f" style="margin-bottom:8px"><span>✨ KI-Assistent</span><input type="text" id="ai-hint" placeholder="${isNew ? 'Was soll anders sein?' : 'z. B. „auch Vorgängermodell aufnehmen“'}" autocomplete="off"></label><button class="btn block" data-act="ai-edit">Formular von der KI überarbeiten lassen</button></div>` : ''}
    <div class="panel"><div class="grid2" style="grid-template-columns:76px 1fr">${F('Emoji', 'emoji', p.emoji)}${F('Name', 'name', p.name)}</div>`;
  const foot = `<div class="actions"><button class="btn pri wide" data-act="save-profile">Speichern</button>${isNew ? '' : '<button class="btn danger wide" data-act="delete-profile">Suche löschen</button>'}</div>`;
  const syntax = 'Mehrere Alternativen mit | trennen. Begriffe mit Leerzeichen müssen alle vorkommen. *wort ignoriert Wortgrenzen.';
  if (p.type === 'rss') {
    return `${head}${F('Feed-URLs (eine pro Zeile)', 'feeds', p.feeds.join('\n'), { area: 1 })}
      <div class="grid3">${F('Aufnehmen ab °', 'minTemp', p.minTemp, { type: 'number' })}${F('Alarm ab °', 'alertTemp', p.alertTemp, { type: 'number' })}${F('Max. Alter (Tage)', 'maxAgeDays', p.maxAgeDays, { type: 'number' })}</div>
      ${F('Nur Titel mit …', 'include', p.include, { ph: 'leer = alles', help: syntax })}${F('Ausschließen', 'exclude', p.exclude)}</div>${foot}`;
  }
  return `${head}
    ${F('Suchen (eine pro Zeile)', 'queries', p.queries.join('\n'), { area: 1, help: 'Suchbegriff oder komplette kleinanzeigen.de-Such-URL (z. B. mit Ort + Umkreis).' })}
    <div class="grid2">${F('Mindestpreis €', 'minPrice', p.minPrice, { type: 'number' })}${F('Höchstpreis €', 'maxPrice', p.maxPrice, { type: 'number', ph: 'offen' })}</div>
    ${F('Pflichtbegriffe (eine Gruppe pro Zeile)', 'require', (p.require || []).join('\n'), { area: 1, help: syntax })}
    ${F('Ausschluss im Titel', 'exclude', p.exclude, { area: 1 })}${F('Ausschluss in Titel + Beschreibung', 'excludeText', p.excludeText)}</div>
    <div class="panel"><h3>Preisstufen</h3><p class="muted small" style="margin-bottom:10px">Die erste passende Stufe gilt. Ohne Zielpreis lernt der Radar den Marktmedian (ab 8 Anzeigen) und meldet ab ${Math.round((p.dealPct || 0.75) * 100)} % davon.</p>
      <div id="rows-tiers">${p.tiers.map(tierRow).join('')}</div><button class="btn block" data-act="add-row" data-id="tiers">+ Stufe</button>
      <div class="grid3" style="margin-top:12px">${F('Deal ab × Median', 'dealPct', p.dealPct, { type: 'number', ph: '0.75' })}${F('Top ab × Median', 'topPct', p.topPct, { type: 'number', ph: '0.6' })}${F('Mind. Ersparnis €', 'minSaving', p.minSaving, { type: 'number', ph: '0' })}</div></div>
    <div class="panel"><h3>Pluspunkte</h3><div id="rows-badges">${(p.badges || []).map(badgeRow).join('')}</div><button class="btn block" data-act="add-row" data-id="badges">+ Pluspunkt</button></div>
    <div class="panel"><h3>Warnungen</h3><div id="rows-warnings">${(p.warnings || []).map(warnRow).join('')}</div><button class="btn block" data-act="add-row" data-id="warnings">+ Warnung</button></div>${foot}`;
}

function collect(root) {
  const read = (el) => Object.fromEntries($$('[data-k]', el).filter((i) => i.closest('[data-row]') === (el.dataset.row ? el : null)).map((i) => [i.dataset.k, i.value.trim()]));
  const out = read(root);
  for (const k of ['tiers', 'badges', 'warnings']) out[k] = $$(`[data-row="${k}"]`, root).map(read);
  return out;
}

// ---------- Einstellungen ----------
function viewSettings() {
  const s = S.settings;
  return `<header class="head"><div class="grow"><h1>Einstellungen</h1></div></header>
  <form id="settings">
  <div class="panel"><h3>🔔 Benachrichtigungen</h3>
    ${F('ntfy-Topic-URL', 'ntfyUrl', s.ntfyUrl, { type: 'url', ph: 'https://ntfy.sh/mein-geheimes-topic', help: 'Einfachster Weg fürs iPhone: ntfy-App installieren, Topic abonnieren, URL hier eintragen.' })}
    <div class="grid2">${F('Telegram Bot-Token', 'telegramToken', s.telegramToken)}${F('Telegram Chat-ID', 'telegramChat', s.telegramChat)}</div>
    ${F('Webhook-URL (optional)', 'webhookUrl', s.webhookUrl, { type: 'url' })}
    <div class="grid3">${F('Alarm ab Score', 'alertScore', s.alertScore, { type: 'number' })}${F('Max. pro Lauf', 'maxAlerts', s.maxAlerts, { type: 'number' })}${F('Preisverfall %', 'priceDropPct', s.priceDropPct, { type: 'number' })}</div>
    <button type="button" class="btn block" data-act="test-notify">Testnachricht senden</button></div>
  <div class="panel"><h3>✨ KI-Assistent</h3>
    ${F('Claude-API-Schlüssel', 'anthropicKey', s.anthropicKey, { ph: 'sk-ant-…', help: `Für „Mit KI ausfüllen“ beim Anlegen von Suchen. ${S.ai ? 'Schlüssel ist hinterlegt.' : 'Noch kein Schlüssel hinterlegt.'} Jeder Vorschlag verbraucht API-Guthaben; die Suchläufe selbst nutzen keine KI.` })}</div>
  <div class="panel"><h3>⏱ Zeitplan & Schonung</h3>
    <div class="grid2">${F('Lauf alle … Minuten', 'intervalMin', s.intervalMin, { type: 'number' })}${F('Kleinanzeigen-Abrufe / Lauf', 'kaBudget', s.kaBudget, { type: 'number' })}
    ${F('davon Verfügbarkeitsprüfungen', 'checkBudget', s.checkBudget, { type: 'number' })}${F('Pause nach Sperre (h)', 'blockBackoffH', s.blockBackoffH, { type: 'number' })}
    ${F('Wartezeit min (ms)', 'delayMinMs', s.delayMinMs, { type: 'number' })}${F('Wartezeit max (ms)', 'delayMaxMs', s.delayMaxMs, { type: 'number' })}</div>
    <p class="muted small">Der Radar umgeht keine Sperren. Meldet Kleinanzeigen 403/429, pausiert er dort und zeigt das im Radar an.</p></div>
  <div class="panel"><h3>🧹 Liste</h3><div class="grid2">${F('Nicht-Deals „weg“ nach Tagen', 'staleDays', s.staleDays, { type: 'number' })}${F('Archiv löschen nach Tagen', 'purgeDays', s.purgeDays, { type: 'number' })}</div><p class="muted small">Score ab 60 = Deal, ab 85 = Top-Deal.</p></div>
  <button type="button" class="btn pri block" data-act="save-settings">Einstellungen speichern</button>
  </form>
  <h2 class="sec">Protokoll</h2><div class="panel">${S.runs.length ? S.runs.map((r) => {
    const hits = Object.values(r.profiles || {}).filter((p) => p.newTop || p.newDeals).map((p) => `${p.emoji} ${p.newTop ? `${p.newTop}🔥` : ''}${p.newDeals ? ` ${p.newDeals}✅` : ''}`).join(' · ');
    const errs = [...(r.sources?.ka?.errors || []), ...(r.sources?.rss?.errors || []), r.error].filter(Boolean);
    return `<div class="log"><b>${clock(r.started)}</b> · ${r.sources?.ka?.blocked ? 'Kleinanzeigen pausiert' : `${r.sources?.ka?.requests ?? 0} Abrufe`} · ${r.alerts} Meldungen<br>${hits || '<span class="muted">kein neuer Treffer</span>'}${errs.length ? `<div class="err">${errs.map(h).join('<br>')}</div>` : ''}</div>`;
  }).join('') : '<span class="muted small">Noch keine Läufe.</span>'}</div>
  <p class="muted small">iPhone: in Safari öffnen → Teilen → „Zum Home-Bildschirm“. Dann startet der Radar wie eine App.</p>`;
}

// ---------- Rendern ----------
function render() {
  if (!S) return;
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
  const n = S.listings.filter((l) => live(l) && l.level === 'top').length;
  $('#deal-count').textContent = n || '';
  $('#app').innerHTML = { radar: viewRadar, deals: viewDeals, searches: viewSearches, settings: viewSettings }[ui.tab]();
}

function openSheet(html, kind) {
  ui.sheet = kind;
  $('#sheet-body').innerHTML = html;
  $('#sheet-body').scrollTop = 0;
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  ui.sheet = null;
  editing = null;
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
}

async function load(force) {
  try {
    S = await api('GET', '/api/state');
  } catch (e) {
    if (!S) $('#app').innerHTML = `<p class="empty">Server nicht erreichbar: ${h(e.message)}</p>`;
    return;
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (force || (!ui.sheet && !typing && (ui.tab === 'radar' || ui.tab === 'deals'))) render();
}

const actions = {
  async run() { await api('POST', '/api/run'); toast('Suchlauf gestartet'); await load(true); },
  async unblock() { await api('POST', '/api/unblock'); await load(true); },
  goto(id) { setTab(id); },
  cat(id) { ui.profile = id; ui.view = 'all'; setTab('deals'); },
  view(id) { ui.view = id; render(); },
  pf(id) { ui.profile = id; render(); },
  detail(id) { const l = S.listings.find((x) => x.id === id); if (l) openSheet(detail(l), 'detail'); },
  'close-sheet'() { closeSheet(); render(); },
  async fav(id) { const l = S.listings.find((x) => x.id === id); Object.assign(l, await api('PATCH', `/api/listings/${encodeURIComponent(id)}`, { fav: !l.fav })); openSheet(detail(l), 'detail'); },
  async hide(id) { const l = S.listings.find((x) => x.id === id); await api('PATCH', `/api/listings/${encodeURIComponent(id)}`, { hidden: !l.hidden }); closeSheet(); toast(l.hidden ? 'Wieder eingeblendet' : 'Ausgeblendet – im Archiv zu finden'); await load(true); },
  async 'ask-ai'(id, el) {
    el.disabled = true;
    el.textContent = '✨ KI bewertet … (bis ca. 1 min)';
    try {
      const r = await api('POST', `/api/listings/${encodeURIComponent(id)}/assess`);
      const i = S.listings.findIndex((x) => x.id === id);
      if (i >= 0) S.listings[i] = r.listing;
      if (r.gone) toast('Die Anzeige ist nicht mehr online.');
      if (ui.sheet === 'detail') { openSheet(detail(r.listing), 'detail'); if (!r.gone) $('.panel.ai')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    } catch (e) {
      el.disabled = false;
      el.textContent = '✨ KI fragen';
      throw e;
    }
  },
  edit(id) { editing = structuredClone(prof(id)); openSheet(editor(editing), 'edit'); },
  new(id) { editing = id === 'rss' ? { type: 'rss', name: '', emoji: '🔥', feeds: [], minTemp: 200, alertTemp: 500, maxAgeDays: 4 } : { type: 'ka', name: '', emoji: '🔎', queries: [], minPrice: 50, tiers: [{ label: 'Alle' }], badges: [], warnings: [], require: [] }; openSheet(editor(editing), 'edit'); },
  'new-simple'() { editing = null; openSheet(simpleForm(), 'simple'); },
  async 'save-simple'() { await api('POST', '/api/profiles', simpleProfile(readSimple())); closeSheet(); toast('Suche angelegt – läuft beim nächsten Durchgang mit'); await load(true); },
  'to-advanced'() { const v = readSimple(); editing = v.term ? simpleProfile(v) : { type: 'ka', name: '', emoji: '🔎', queries: [], minPrice: 50, tiers: [{ label: 'Alle' }], badges: [], warnings: [], require: [] }; openSheet(editor(editing), 'edit'); },
  async 'ai-new'(_, el) { const v = readSimple(); if (!v.term) throw new Error('Bitte beschreiben, was du suchst.'); await askAi(el, { description: v.term + (v.ex.length ? `\nNicht gewünscht: ${v.ex.join(', ')}` : ''), wishPrice: v.wish }); },
  async 'ai-edit'(_, el) {
    const hint = $('#ai-hint').value.trim();
    const current = collect($('#sheet-body'));
    await askAi(el, { description: hint || `Überarbeite und vervollständige dieses Suchprofil: ${current.name}`, current }, { id: editing.id, enabled: editing.enabled });
  },
  async toggle(id) { const p = prof(id); await api('PUT', `/api/profiles/${id}`, { ...p, enabled: !p.enabled }); await load(true); },
  'add-row'(id) { $(`#rows-${id}`).insertAdjacentHTML('beforeend', { tiers: tierRow, badges: badgeRow, warnings: warnRow }[id]()); },
  'del-row'(_, el) { el.closest('[data-row]').remove(); },
  async 'save-profile'() {
    const data = { ...collect($('#sheet-body')), type: editing.type, enabled: editing.enabled ?? true, note: editing.note };
    await (editing.id ? api('PUT', `/api/profiles/${editing.id}`, data) : api('POST', '/api/profiles', data));
    closeSheet(); toast('Gespeichert'); await load(true);
  },
  async 'delete-profile'() { if (!confirm(`„${editing.name}“ samt Angeboten löschen?`)) return; await api('DELETE', `/api/profiles/${editing.id}`); closeSheet(); await load(true); },
  async 'save-settings'() { await api('PUT', '/api/settings', Object.fromEntries($$('#settings [data-k]').map((i) => [i.dataset.k, i.value.trim()]))); toast('Gespeichert'); await load(true); },
  async 'test-notify'() { await actions['save-settings'](); const r = await api('POST', '/api/notify/test'); toast(r.results.map((x) => `${x.channel}: ${x.ok ? 'ok' : x.error || x.status}`).join(' · ')); },
};

function setTab(t) {
  ui.tab = localStorage.tab = t;
  render();
  scrollTo(0, 0);
}

document.addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) return setTab(tab.dataset.tab);
  const el = e.target.closest('[data-act]');
  if (!el) return;
  try {
    await actions[el.dataset.act]?.(el.dataset.id, el);
  } catch (err) {
    toast(err.message);
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') { ui.q = e.target.value; $('#list').innerHTML = listHtml(filtered()); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'sort') { ui.sort = e.target.value; $('#list').innerHTML = listHtml(filtered()); }
});
document.addEventListener('visibilitychange', () => !document.hidden && load());

await load(true);
(function poll() {
  setTimeout(async () => { if (!document.hidden) await load(); poll(); }, S?.running ? 4000 : 20000);
})();
