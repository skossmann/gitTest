// Suchlauf: Quellen abfragen, bewerten, Verfügbarkeit prüfen, benachrichtigen.
import { classify, thresholds, score, median, titleKey, MIN_OBS } from './score.js';
import { matches } from './extract.js';
import { searchUrl, fetchSearch, checkAd, BlockedError } from './sources/kleinanzeigen.js';
import { fetchFeed, tempScore } from './sources/rss.js';
import { formatAlert, send, channels } from './notify.js';

const DAY = 86400000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRunner(db, { fetchFn = fetch, sleep = realSleep, log = console.log } = {}) {
  const state = { running: false, progress: '' };

  const pause = (s) => sleep(s.delayMinMs + Math.random() * Math.max(0, s.delayMaxMs - s.delayMinMs));

  function ingestKa(profile, query, items, now, stat) {
    stat.found += items.length;
    for (const item of items) {
      const c = classify(profile, item);
      if (c.reject) continue;
      stat.matched++;
      const existing = db.listing(item.id);
      const fields = {
        title: item.title, descr: item.descr, image: item.image, url: item.url,
        price: item.price, price_text: item.priceText, vb: item.vb, unit_price: c.unitPrice,
        location: item.location, pro: item.pro, shipping: item.shipping,
        tier: c.tier, attrs: c.attrs, badges: c.badges, warnings: c.warnings, last_seen: now,
      };
      if (!existing) {
        db.insertListing({ id: item.id, source: 'ka', profile_id: profile.id, query, ...fields, posted: item.posted, history: [{ t: now, p: item.price }], extra: {}, status: 'active', first_seen: now });
        continue;
      }
      if (existing.profile_id !== profile.id) {
        db.updateListing(item.id, { last_seen: now });
        continue;
      }
      const patch = { ...fields };
      if (item.posted) patch.posted = item.posted;
      if (existing.status === 'gone') Object.assign(patch, { status: 'active', gone_at: null, gone_reason: null });
      if (item.price !== existing.price) {
        patch.history = [...existing.history, { t: now, p: item.price }].slice(-30);
        patch.extra = { ...existing.extra, dropFrom: item.price < existing.price ? existing.price : undefined };
      }
      db.updateListing(item.id, patch);
    }
  }

  function rescore(profile, now) {
    const rows = db.listings("profile_id = ? AND source = 'ka'", profile.id);
    const byTier = new Map();
    for (const r of rows) {
      if (r.last_seen < now - 45 * DAY || r.warnings.some((w) => w.penalty >= 30)) continue;
      if (!byTier.has(r.tier)) byTier.set(r.tier, []);
      byTier.get(r.tier).push(r.unit_price);
    }
    for (const r of rows) {
      if (r.status === 'gone') continue;
      const tier = (profile.tiers || []).find((t) => (t.label || '') === r.tier);
      const obs = byTier.get(r.tier) || [];
      const med = obs.length >= MIN_OBS ? Math.round(median(obs) * 100) / 100 : null;
      const th = thresholds(profile, tier, med, obs.length);
      const unit = tier?.unit === 'tb' ? 'tb' : undefined;
      const sc = score({ unitPrice: r.unit_price, price: r.price, ...th, med, badges: r.badges, warnings: r.warnings, minSaving: Number(profile.minSaving) || 0, perUnit: unit ? r.attrs.tb || 1 : 1 });
      db.updateListing(r.id, {
        score: sc.score, level: sc.level, target: th.target, top: th.top, median: med, basis: th.basis, saving: sc.saving ?? null,
        extra: { ...r.extra, suspicious: sc.suspicious || undefined, unit, obs: obs.length },
      });
    }
  }

  function ingestRss(profile, items, kaProfiles, now, stat) {
    stat.found += items.length;
    for (const item of items) {
      if (profile.exclude && matches(profile.exclude, item.title)) continue;
      if (profile.include && !matches(profile.include, item.title)) continue;
      const hit = kaProfiles.find((p) => (p.queries || []).some((q) => !/^https?:/i.test(q) && matches(q, item.title)) && !(p.exclude && matches(p.exclude, item.title)));
      const minTemp = Number(profile.minTemp) || 0;
      if (item.temp == null ? !hit : item.temp < (hit ? minTemp / 2 : minTemp)) continue;
      stat.matched++;
      let s = item.temp == null ? 70 : tempScore(item.temp) + (hit ? 10 : 0);
      const isTop = item.temp != null && item.temp >= (Number(profile.alertTemp) || Infinity);
      s = isTop ? Math.max(85, Math.min(100, s)) : Math.min(84, s);
      const fields = {
        title: item.title, descr: item.descr, image: item.image, url: item.url, price: item.price, price_text: item.priceText,
        unit_price: item.price, location: item.location, score: s, level: isTop ? 'top' : s >= 60 ? 'deal' : 'none', basis: 'temperatur',
        badges: hit ? [{ emoji: '🎯', text: `passt zu „${hit.name}“`, bonus: 10 }] : [], last_seen: now,
      };
      const existing = db.listing(item.id);
      const extra = { ...(existing?.extra || {}), temp: item.temp, category: item.category };
      if (!existing) {
        db.insertListing({ id: item.id, source: 'rss', profile_id: profile.id, tier: item.category || '', ...fields, extra, vb: false, pro: true, shipping: true, attrs: {}, warnings: [], posted: item.posted, history: item.price != null ? [{ t: now, p: item.price }] : [], status: 'active', first_seen: now });
      } else {
        if (item.price != null && item.price !== existing.price) fields.history = [...existing.history, { t: now, p: item.price }].slice(-30);
        db.updateListing(item.id, { ...fields, extra, status: 'active', gone_at: null, gone_reason: null });
      }
    }
  }

  async function verify(s, budget, runStart, summary) {
    const cands = db
      .listings("source = 'ka' AND status IN ('active','reserved') AND last_seen < ? AND (level IN ('top','deal') OR fav = 1)", runStart)
      .sort((a, b) => (a.last_checked || 0) - (b.last_checked || 0))
      .slice(0, budget);
    for (const l of cands) {
      state.progress = `Prüfe Verfügbarkeit: ${l.title.slice(0, 40)}`;
      await pause(s);
      summary.sources.ka.requests++;
      let r;
      try {
        r = await checkAd(l, fetchFn);
      } catch (e) {
        if (e instanceof BlockedError) throw e;
        summary.sources.ka.errors.push(`Prüfung „${l.title.slice(0, 30)}“: ${e.message}`);
        continue;
      }
      const now = Date.now();
      const patch = { last_checked: now, status: r.status };
      if (r.status === 'gone') Object.assign(patch, { gone_at: now, gone_reason: 'Anzeige gelöscht oder verkauft (geprüft)' });
      if (r.status !== 'gone' && r.price != null && r.price !== l.price) {
        Object.assign(patch, { price: r.price, unit_price: l.extra.unit === 'tb' && l.attrs.tb ? Math.round((r.price / l.attrs.tb) * 100) / 100 : r.price, history: [...l.history, { t: now, p: r.price }].slice(-30), extra: { ...l.extra, dropFrom: r.price < l.price ? l.price : undefined } });
      }
      db.updateListing(l.id, patch);
      summary.checked++;
      if (r.status === 'gone') summary.gone++;
    }
  }

  async function alerts(s, profiles, summary) {
    if (!channels(s).length) return;
    const dropFactor = 1 - (s.priceDropPct || 10) / 100;
    const notified = db.listings('notified_price IS NOT NULL');
    const picks = [];
    for (const l of db.listings("status = 'active' AND hidden = 0 AND level = 'top' AND score >= ?", s.alertScore).sort((a, b) => b.score - a.score)) {
      if (l.notified_price != null && l.price > l.notified_price * dropFactor) continue;
      // Gleicher Titel, anderer Link, kein deutlicher Preisverfall = Doppelanzeige -> nicht erneut melden
      const dup = l.notified_price == null && notified.find((n) => n.id !== l.id && n.profile_id === l.profile_id && titleKey(n.title) === titleKey(l.title) && l.price > n.notified_price * dropFactor);
      if (dup) {
        db.updateListing(l.id, { notified_price: l.price, extra: { ...l.extra, duplicateOf: dup.id } });
        continue;
      }
      if (picks.length < s.maxAlerts) picks.push(l);
    }
    for (const l of picks) {
      const res = await send(s, formatAlert(l, profiles.find((p) => p.id === l.profile_id)), fetchFn);
      if (res.some((r) => r.ok)) {
        db.updateListing(l.id, { notified_price: l.price });
        summary.alerts++;
      } else summary.sources.notify = res.map((r) => `${r.channel}: ${r.error || r.status}`).join(', ');
    }
  }

  async function run() {
    if (state.running) return null;
    state.running = true;
    const runStart = Date.now();
    const s = db.settings();
    const profiles = db.profiles().filter((p) => p.enabled);
    const kaProfiles = profiles.filter((p) => p.type !== 'rss');
    const summary = { sources: { ka: { requests: 0, blocked: false, errors: [] }, rss: { feeds: 0, errors: [] } }, profiles: {}, alerts: 0, checked: 0, gone: 0 };
    const stat = (p) => (summary.profiles[p.id] ??= { name: p.name, emoji: p.emoji, queries: 0, of: (p.queries || p.feeds || []).length, found: 0, matched: 0, newDeals: 0, newTop: 0 });
    profiles.forEach(stat);

    try {
      // 1) Kleinanzeigen – strikt begrenzt, reihum über alle Suchen
      const blockedUntil = db.get('ka.blockedUntil', 0);
      const ka = summary.sources.ka;
      if (blockedUntil > runStart) {
        ka.blocked = true;
        ka.blockedUntil = blockedUntil;
      } else {
        const tasks = kaProfiles.flatMap((p) => (p.queries || []).filter(Boolean).map((q) => ({ p, q })));
        const n = Math.min(tasks.length, Math.max(1, s.kaBudget - s.checkBudget));
        const start = tasks.length ? db.get('ka.cursor', 0) % tasks.length : 0;
        try {
          for (let i = 0; i < n; i++) {
            const { p, q } = tasks[(start + i) % tasks.length];
            state.progress = `${p.emoji} ${p.name}: „${q.slice(0, 40)}“ (${i + 1}/${n})`;
            if (i) await pause(s);
            ka.requests++;
            try {
              const r = await fetchSearch(searchUrl(q, { minPrice: p.minPrice, maxPrice: p.maxPrice }), fetchFn);
              if (!r.structureOk) ka.errors.push(`„${q}“: Seitenstruktur nicht erkannt – Parser prüfen`);
              stat(p).queries++;
              ingestKa(p, q, r.items, runStart, stat(p));
            } catch (e) {
              if (e instanceof BlockedError) throw e;
              ka.errors.push(`„${q}“: ${e.message}`);
            }
            db.set('ka.cursor', (start + i + 1) % tasks.length);
          }
          kaProfiles.forEach((p) => rescore(p, runStart));
          await verify(s, Math.max(0, s.kaBudget - ka.requests), runStart, summary);
        } catch (e) {
          if (!(e instanceof BlockedError)) throw e;
          ka.blocked = true;
          ka.blockedUntil = Date.now() + s.blockBackoffH * 3600000;
          db.set('ka.blockedUntil', ka.blockedUntil);
          ka.errors.push(e.message);
        }
      }
      kaProfiles.forEach((p) => rescore(p, runStart));

      // 2) RSS-Feeds (Neuware)
      for (const p of profiles.filter((x) => x.type === 'rss')) {
        const seenBefore = Date.now();
        let ok = false;
        for (const feed of p.feeds || []) {
          state.progress = `${p.emoji} ${p.name}`;
          try {
            ingestRss(p, await fetchFeed(feed, fetchFn), kaProfiles, runStart, stat(p));
            summary.sources.rss.feeds++;
            stat(p).queries++;
            ok = true;
          } catch (e) {
            summary.sources.rss.errors.push(`${feed}: ${e.message}`);
          }
        }
        if (ok) {
          const maxAge = (Number(p.maxAgeDays) || 4) * DAY;
          for (const l of db.listings("profile_id = ? AND status = 'active' AND last_seen < ?", p.id, runStart)) {
            if ((l.posted || l.first_seen) < seenBefore - maxAge) db.updateListing(l.id, { status: 'gone', gone_at: seenBefore, gone_reason: 'nicht mehr im Feed (vermutlich abgelaufen)' });
          }
        }
      }

      // 3) Aufräumen
      const now = Date.now();
      for (const l of db.listings("source = 'ka' AND status = 'active' AND fav = 0 AND level NOT IN ('top','deal') AND last_seen < ?", now - s.staleDays * DAY)) {
        db.updateListing(l.id, { status: 'gone', gone_at: now, gone_reason: 'nicht mehr in den Suchergebnissen (ungeprüft)' });
      }
      db.raw.prepare("DELETE FROM listings WHERE status = 'gone' AND fav = 0 AND gone_at < ?").run(now - s.purgeDays * DAY);

      // 4) Ergebnis je Profil + Benachrichtigungen
      for (const l of db.listings("first_seen = ? AND level IN ('top','deal')", runStart)) {
        const st = summary.profiles[l.profile_id];
        if (st) l.level === 'top' ? st.newTop++ : st.newDeals++;
      }
      await alerts(s, profiles, summary);
    } catch (e) {
      summary.error = e.message;
      log('Lauf fehlgeschlagen:', e);
    } finally {
      const finished = Date.now();
      db.addRun(runStart, finished, summary);
      db.set('nextRun', finished + s.intervalMin * 60000 * (0.92 + Math.random() * 0.16));
      state.running = false;
      state.progress = '';
    }
    return summary;
  }

  function start() {
    if (!db.get('nextRun')) db.set('nextRun', Date.now() + 5000);
    const timer = setInterval(() => {
      if (!state.running && Date.now() >= db.get('nextRun', 0)) run().catch((e) => log(e));
    }, 15000);
    timer.unref?.();
    return timer;
  }

  /** Nach Profil-Änderungen neu bewerten (ohne Netzabruf). */
  function rescoreAll() {
    const now = Date.now();
    db.profiles().filter((p) => p.type !== 'rss').forEach((p) => rescore(p, now));
  }

  return { run, start, state, rescoreAll };
}
