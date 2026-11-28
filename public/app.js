'use strict';

/* WIMP — Where Is My Parcel? · app.js
   Design, layout and the three languages are kept from the original build;
   everything that used to be fixed sample data is now driven by /api/track. */

const $ = (s) => document.querySelector(s);
const API = 'api/track';
const MAX_LENGTH = 60;

/* ------------------------------------------------------------------ *
 * Tracking-number input
 * Carriers print numbers with hyphens and people paste them from a
 * message; keep only A-Z a-z 0-9 while typing or pasting.
 * ------------------------------------------------------------------ */

function sanitizeNumber(value) {
  return String(value == null ? '' : value).replace(/[^A-Za-z0-9]/g, '').slice(0, MAX_LENGTH);
}

function countKept(text, upto) {
  let kept = 0;
  for (let i = 0; i < upto && i < text.length; i += 1) {
    if (/[A-Za-z0-9]/.test(text[i])) kept += 1;
  }
  return kept;
}

function sanitizeField(el) {
  if (!el) return '';
  const before = el.value;
  const clean = sanitizeNumber(before);
  if (clean === before) return clean;
  const caret = el.selectionStart == null ? before.length : el.selectionStart;
  el.value = clean;
  const pos = Math.min(countKept(before, caret), clean.length);
  try { el.setSelectionRange(pos, pos); } catch (err) { /* not focusable */ }
  return clean;
}

/* ------------------------------------------------------------------ *
 * Language
 * ------------------------------------------------------------------ */

const I18N = window.WIMP_I18N || {
  base: 'en', default: 'en', aliases: {},
  languages: [{ code: 'en', native: 'English', english: 'English', locale: 'en-US' }],
  strings: { en: {} }
};
const LANGS = I18N.languages;
const LANG_CODES = LANGS.map((lang) => lang.code);
const CJK = ['ko', 'ja', 'zh-CN', 'zh-TW'];

/* Every dictionary is merged over the English base when the bundle is built,
   so a thin translation degrades to English instead of showing a raw key. */
function dictFor(code) {
  return I18N.strings[code] || I18N.strings[I18N.base] || {};
}

function langInfo(code) {
  return LANGS.find((lang) => lang.code === (code || state.lang)) || LANGS[0];
}

/* "de-AT" -> "de", "zh-Hant-HK" -> "zh-TW", "pt-BR" -> "pt" */
function matchLanguage(tag) {
  const raw = String(tag || '').trim().toLowerCase();
  if (!raw) return '';
  const exact = LANG_CODES.find((code) => code.toLowerCase() === raw);
  if (exact) return exact;
  const parts = raw.split('-');
  for (let i = parts.length; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join('-');
    if (I18N.aliases && I18N.aliases[prefix]) return I18N.aliases[prefix];
    const hit = LANG_CODES.find((code) => code.toLowerCase() === prefix);
    if (hit) return hit;
  }
  return '';
}

function languageFromUrl() {
  try {
    return matchLanguage(new URLSearchParams(window.location.search).get('lang'));
  } catch (err) {
    return '';
  }
}

/* ?lang= first, then the browser's own preference list, then the default. */
function detectLanguage() {
  const fromUrl = languageFromUrl();
  if (fromUrl) return fromUrl;
  const tags = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language];
  for (const tag of tags) {
    const hit = matchLanguage(tag);
    if (hit) return hit;
  }
  return I18N.default || 'en';
}

/* The choice rides in the URL, so a shared or refreshed link keeps it.
   Nothing is remembered in the browser itself — see privacy.html. */
function syncLanguageUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('lang', state.lang);
    window.history.replaceState(null, '', url);
  } catch (err) { /* nothing to remember outside a real URL */ }
}

/* Guide pages read the same ?lang=, so their links carry the choice along.
   Korean is the default, so its links stay clean for search engines. */
function updateGuideLinks() {
  document.querySelectorAll('a[href^="guide.html"]').forEach((link) => {
    if (!link.dataset.baseHref) link.dataset.baseHref = link.getAttribute('href');
    const parts = link.dataset.baseHref.split('#');
    const hash = parts[1] ? '#' + parts[1] : '';
    const query = state.lang === 'ko' ? '' : '?lang=' + encodeURIComponent(state.lang);
    link.setAttribute('href', parts[0] + query + hash);
  });
}


/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  lang: detectLanguage(),
  number: '',
  carrier: 'auto',
  /* 'globe' or 'flat' — two projections of the same view model. */
  mapMode: 'globe',
  view: null,
  loading: false,
  error: null,
  notice: null,
  refreshing: false,
  selected: -1,
  autoRefresh: 0,
  timer: null
};

const t = () => dictFor(state.lang);
const isKo = () => state.lang === 'ko';
/* Korean, Japanese and Chinese write a count without a space: 3건, 3件. */
const joinsCount = () => !CJK.includes(state.lang);

function carrierLabel(code, fallback) {
  const key = code ? 'carrier' + String(code).toUpperCase() : '';
  const label = key ? t()[key] : '';
  return typeof label === 'string' ? label : (fallback || code || '');
}

function localizeNames() {
  /* An error keeps its code, so its wording follows a later language switch too. */
  if (state.error && state.error.code) {
    const s = t();
    /* The API's own wording is Korean, so it is only a fallback inside Korean. */
    state.error.title = s.errors[state.error.code] || (isKo() ? state.error.apiMessage : '') || s.errors.UPSTREAM;
    state.error.hint = s.hints[state.error.code] || (isKo() ? state.error.apiHint : '') || '';
  }
  if (state.notice && state.notice.code) {
    const s = t();
    state.notice.title = s.errors[state.notice.code] || (isKo() ? state.notice.apiMessage : '') || s.errors.UPSTREAM;
    state.notice.hint = s.hints[state.notice.code] || (isKo() ? state.notice.apiHint : '') || '';
  }
  const view = state.view;
  if (!view) return;
  view.carrierName = carrierLabel(view.carrierCode, view.carrierNameRaw || view.carrierName);
}

/* ------------------------------------------------------------------ *
 * Time formatting
 * ------------------------------------------------------------------ */

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const locale = state.lang === 'en' ? 'en-GB' : (langInfo().locale || 'en-GB');
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: 'Asia/Seoul',
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  } catch {
    return date.toISOString().slice(5, 16).replace('T', ' ');
  }
}

/* Estimated delivery day: "2026-12-01" -> "12월 1일" / "Dec 1" / "12月1日" */
function formatDay(dateText) {
  if (!dateText) return '';
  const date = new Date(`${String(dateText).slice(0, 10)}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return '';
  const locale = state.lang === 'en' ? 'en-US' : (langInfo().locale || 'en-US');
  const month = state.lang === 'en' ? 'short' : 'long';
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Seoul', month, day: 'numeric' }).format(date);
  } catch {
    return String(dateText).slice(5).replace('-', '/');
  }
}

function clockNow() {
  try {
    return new Intl.DateTimeFormat(state.lang === 'en' ? 'en-GB' : (langInfo().locale || 'en-GB'), {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date());
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * View model
 * ------------------------------------------------------------------ */

function statusLabel(code) {
  return t().status[code] || t().status.UNKNOWN;
}

/* The newest event that carries a time — shown in the status strip before the globe. */
function latestEvent(view) {
  if (!view || !view.events || !view.events.length) return null;
  let best = null;
  for (const ev of view.events) {
    if (!ev.time || Number.isNaN(Date.parse(ev.time))) continue;
    if (!best || Date.parse(ev.time) > Date.parse(best.time)) best = ev;
  }
  return best || view.events[view.events.length - 1] || null;
}

/* ------------------------------------------------------------------ *
 * Physical movement vs paperwork
 *   A customs file opened at the destination before the parcel gets there
 *   (“Customs clearance status updated – INCHEON”), a pre-advice or a label
 *   creation is not a stop. Drawing those makes the parcel look as if it
 *   flew Sofia → Incheon → Sofia → Leipzig. Only movement scans may become
 *   route nodes, markers and country chips.
 * ------------------------------------------------------------------ */

const DOCUMENT_SCAN = [
  /customs clearance status/i,
  /clearance status updated/i,
  /customs status updated/i,
  /customs (?:clearance )?(?:information|notification|pre-?notification)/i,
  /shipment information (?:received|sent)/i,
  /shipment data (?:received|sent)/i,
  /information received/i,
  /electronic (?:notification|data|advance|pre-?advice)/i,
  /pre-?advice/i,
  /pre-?alert/i,
  /label (?:created|printed|issued)/i,
  /waybill (?:created|issued)/i,
  /사전\s*통관/,
  /통관\s*(?:정보|서류|신고\s*접수)/,
  /전자\s*(?:통관|정보|사전\s*신고)/,
  /수입\s*신고\s*접수/,
  /(?:書類|電子)\s*(?:受信|通知)/,
  /通関\s*(?:情報|書類)/,
  /事前\s*通関/,
];

const CUSTOMS_SCAN = /customs|clearance|통관|通関|zoll|douane|aduana/i;

function isDocumentScan(text) {
  const body = String(text || '').trim();
  if (!body) return false;
  return DOCUMENT_SCAN.some((re) => re.test(body));
}

function isCustomsScan(ev) {
  return CUSTOMS_SCAN.test(`${(ev && ev.note) || ''} ${(ev && ev.title) || ''}`);
}

/* The API already says which scans are notices; older cached payloads do not. */
function eventIsPhysical(ev) {
  if (!ev) return false;
  if (ev.physical === false) return false;
  if (ev.physical === true) return true;
  return !isDocumentScan(`${ev.scan || ''} ${ev.description || ''}`);
}

/* One marker per city/terminal, however many scans land there. */
function locationKey(loc) {
  if (!loc) return '';
  const city = String(loc.city || loc.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\uac00-\ud7a3]/g, '');
  const cc = String(loc.countryCode || '').toUpperCase();
  if (city) return `${cc}|${city}`;
  return `${Number(loc.lat).toFixed(2)},${Number(loc.lng).toFixed(2)}`;
}

/* A customs scan the parcel never reached: the same country lies before and after it. */
function dropSandwichedCustoms(list) {
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const ev = list[i];
    if (!isCustomsScan(ev)) {
      out.push(ev);
      continue;
    }
    const prev = out[out.length - 1];
    const next = list.slice(i + 1).find((other) => !isCustomsScan(other));
    const cc = ev.location.countryCode;
    if (prev && next && cc && prev.location.countryCode === next.location.countryCode && cc !== prev.location.countryCode) {
      continue;
    }
    out.push(ev);
  }
  return out;
}

function buildDataset(api, demo) {
  const events = (api.events || []).map((ev) => ({
    time: ev.time,
    title: ev.description || ev.scan || statusLabel(ev.status && ev.status.code),
    note: ev.scan || '',
    statusCode: (ev.status && ev.status.code) || 'UNKNOWN',
    location: ev.location || null,
    physical: eventIsPhysical(ev)
  }));

  const located = events.filter((ev) => ev.location && Number.isFinite(ev.location.lat) && Number.isFinite(ev.location.lng));
  const moving = located.filter((ev) => ev.physical);
  // With no movement scan at all (label only), show where the record says it is.
  const usable = new Set(moving.length ? dropSandwichedCustoms(moving) : located);

  const points = [];
  const byKey = new Map();
  const visits = [];
  for (const ev of events) {
    if (!usable.has(ev)) {
      // A notice is not a place; a scan without coordinates still belongs to the last one.
      ev.point = ev.physical && points.length ? points.length - 1 : -1;
      continue;
    }
    const loc = ev.location;
    const key = locationKey(loc);
    let index = byKey.get(key);
    if (index === undefined) {
      index = points.findIndex((p) => Math.abs(p.lat - loc.lat) < 0.01 && Math.abs(p.lng - loc.lng) < 0.01);
      if (index < 0) {
        points.push({
          lat: loc.lat, lng: loc.lng,
          name: loc.city || loc.name,
          detail: loc.name,
          code: loc.code || '',
          country: loc.country || '',
          countryEn: loc.countryEn || '',
          countryCode: loc.countryCode || '',
          count: 0,
          firstEvent: ev,
          lastEvent: ev,
          active: false
        });
        index = points.length - 1;
      }
      byKey.set(key, index);
    }
    const point = points[index];
    point.count += 1;
    point.lastEvent = ev;
    ev.point = index;
    if (visits[visits.length - 1] !== index) visits.push(index);
  }

  const lastIndex = visits.length ? visits[visits.length - 1] : -1;
  points.forEach((p, i) => { p.active = i === lastIndex; });
  const latestPoint = points[lastIndex] || null;

  // Labels: first stop, last stop, and every country change. Points crowded together become dots.
  const seenCountry = new Set();
  points.forEach((p, i) => {
    const isFirst = i === 0;
    const isLast = p === latestPoint;
    const newCountry = !seenCountry.has(p.countryCode);
    seenCountry.add(p.countryCode);
    const crowded = points.some((q, j) => j !== i && Math.abs(q.lat - p.lat) < 0.35 && Math.abs(q.lng - p.lng) < 0.35);
    p.hideLabel = !isFirst && !isLast && (!newCountry || crowded);
  });

  // Arcs follow the visits, so a genuine A → B → A keeps both legs while the marker stays one.
  const arcs = [];
  for (let i = 1; i < visits.length; i += 1) {
    const from = points[visits[i - 1]];
    const to = points[visits[i]];
    if (from === to) continue;
    arcs.push({
      startLat: from.lat, startLng: from.lng,
      endLat: to.lat, endLng: to.lng,
      planned: Boolean(demo && i === visits.length - 1)
    });
  }

  const ordered = events.filter((e) => e.time).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const latestEvent = ordered[ordered.length - 1] || events[events.length - 1] || null;

  const countries = [];
  for (const index of visits) {
    const p = points[index];
    if (!countries.length || countries[countries.length - 1].code !== p.countryCode) {
      countries.push({
        code: p.countryCode, flag: flagOf(p.countryCode), city: p.name,
        planned: Boolean(demo && p === latestPoint && countries.length > 0)
      });
    }
  }

  const statusCode = api.status ? api.status.code : (latestEvent ? latestEvent.statusCode : 'UNKNOWN');
  const stage = api.status ? api.status.stage : 0;

  // The last country chip shows where the parcel is now, not where it entered the country.
  if (latestPoint && countries.length) countries[countries.length - 1].city = latestPoint.name;


  return {
    kind: 'parcel',
    demo,
    carrierCode: api.carrier ? api.carrier.code : state.carrier,
    carrierName: api.carrier ? api.carrier.name : state.carrier,
    carrierNameRaw: api.carrier ? api.carrier.name : state.carrier,
    carrierSite: api.carrier ? api.carrier.site : '',
    number: api.number || state.number,
    statusCode,
    statusLabel: statusLabel(statusCode),
    stage: Number.isFinite(stage) ? stage : 0,
    delivered: Boolean(api.status && api.status.delivered),
    estimatedDelivery: api.estimatedDelivery || null,
    events,
    points,
    arcs,
    countries,
    international: countries.some((c) => c.code && c.code !== 'KR'),
    latestLocation: latestPoint ? pair(latestPoint) : '',
    latestCode: latestPoint ? latestPoint.code || latestPoint.countryCode : '',
    latestDetail: latestPoint ? latestPoint.detail : '',
    latestIndex: lastIndex,
    latestPoint,
    fetchedAt: (api.meta && api.meta.fetchedAt) || new Date().toISOString(),
    cached: Boolean(api.meta && api.meta.cached)
  };
}

function pair(point) {
  if (!point) return '';
  const country = isKo() ? (point.country || point.countryEn) : (point.countryEn || point.country);
  if (point.name && country && point.name !== country) return `${point.name}, ${country}`;
  return point.name || country || '';
}

/* A merged city marker says how many scans it stands for: “Leipzig · 3건”. */
function pointCount(point) {
  if (!point || !(point.count > 1)) return '';
  return `${point.count}${joinsCount() ? ' ' : ''}${t().events}`;
}

/* Where the parcel is now: the last place it was actually seen. */
function currentPoint(view) {
  if (!view || !view.points || !view.points.length) return null;
  if (view.latestPoint) return view.latestPoint;
  if (Number.isFinite(view.latestIndex) && view.points[view.latestIndex]) return view.points[view.latestIndex];
  return view.points[view.points.length - 1] || null;
}

function pointSummary(point) {
  if (!point) return '';
  const event = point.lastEvent || point.firstEvent;
  return [pair(point), pointCount(point), event ? (event.note || event.title) : ''].filter(Boolean).join(' · ');
}

function flagOf(code) {
  if (!code || code.length !== 2) return '◉';
  return String.fromCodePoint(...code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/* ------------------------------------------------------------------ *
 * Globe
 * ------------------------------------------------------------------ */

let globe = null;
let globeBroken = false;

/* ------------------------------------------------------------------ *
 * Route arcs
 *   three-globe draws a leg as a cubic Bézier: both ends sit on the surface
 *   and the control points ride at 1.5× the requested altitude over the 25 %
 *   and 75 % marks of the great circle. Two traps follow from that shape —
 *   ends left on the surface cut the tube into the globe, so the line fades
 *   out exactly where it starts and lands, and the Bézier is a chord in
 *   space, so a long leg sags below the surface even at a generous altitude.
 *   So the ends are lifted, the arc grows with the distance it covers, and it
 *   is raised until a sample of the real curve clears the globe. A leg that
 *   would need an absurd height is split into shorter hops instead.
 * ------------------------------------------------------------------ */

const ARC_END_ALT = 0.02; // both ends sit this far above the surface
const ARC_STROKE = 1.35; // tube width, in globe units (the globe radius is 100)
const ARC_BASE_ALT = 0.075; // height of the hop for a leg of no length
const ARC_SPAN_ALT = 0.3; // extra height per radian of great-circle distance
const ARC_MAX_ALT = 0.45; // beyond this, split the leg rather than balloon it
const ARC_CLEAR = 1 + ARC_STROKE / 200 + 0.006; // tube radius + depth room, in radii
const DEG = Math.PI / 180;

function latLngUnit(lat, lng) {
  const p = lat * DEG;
  const l = lng * DEG;
  return [Math.cos(p) * Math.cos(l), Math.sin(p), Math.cos(p) * Math.sin(l)];
}

function angularDistance(a, b) {
  const cos =
    Math.sin(a.lat * DEG) * Math.sin(b.lat * DEG) +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((b.lng - a.lng) * DEG);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
}

/* Unit vector at fraction t of the great circle between two places. */
function greatCircleUnit(a, b, t) {
  const va = latLngUnit(a.lat, a.lng);
  const vb = latLngUnit(b.lat, b.lng);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  const sin = Math.sin(omega);
  if (sin < 1e-9) return va;
  const s0 = Math.sin((1 - t) * omega) / sin;
  const s1 = Math.sin(t * omega) / sin;
  return [va[0] * s0 + vb[0] * s1, va[1] * s0 + vb[1] * s1, va[2] * s0 + vb[2] * s1];
}

function greatCirclePlace(a, b, t) {
  const u = greatCircleUnit(a, b, t);
  return { lat: Math.asin(Math.max(-1, Math.min(1, u[1]))) / DEG, lng: Math.atan2(u[2], u[0]) / DEG };
}

/* Smallest distance from the globe centre that three-globe's curve reaches. */
function arcMinRadius(a, b, alt) {
  const endAlt = ARC_END_ALT;
  const ctrlAlt = alt + (alt - endAlt) * 0.5;
  const ua = latLngUnit(a.lat, a.lng);
  const ub = latLngUnit(b.lat, b.lng);
  const p1 = greatCircleUnit(a, b, 0.25);
  const p2 = greatCircleUnit(a, b, 0.75);
  let min = Infinity;
  for (let i = 0; i <= 24; i += 1) {
    const t = i / 24;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    const x = w0 * (ua[0] * (1 + endAlt)) + w1 * (p1[0] * (1 + ctrlAlt)) + w2 * (p2[0] * (1 + ctrlAlt)) + w3 * (ub[0] * (1 + endAlt));
    const y = w0 * (ua[1] * (1 + endAlt)) + w1 * (p1[1] * (1 + ctrlAlt)) + w2 * (p2[1] * (1 + ctrlAlt)) + w3 * (ub[1] * (1 + endAlt));
    const z = w0 * (ua[2] * (1 + endAlt)) + w1 * (p1[2] * (1 + ctrlAlt)) + w2 * (p2[2] * (1 + ctrlAlt)) + w3 * (ub[2] * (1 + endAlt));
    const r = Math.hypot(x, y, z);
    if (r < min) min = r;
  }
  return min;
}

/* Altitude for one leg, or null when no sane height keeps it above the globe. */
function arcAltitudeFor(a, b) {
  const span = angularDistance(a, b) * DEG;
  const base = ARC_BASE_ALT + ARC_SPAN_ALT * (span / Math.PI);
  if (arcMinRadius(a, b, base) >= ARC_CLEAR) return base;
  if (arcMinRadius(a, b, ARC_MAX_ALT) < ARC_CLEAR) return null;
  let lo = base;
  let hi = ARC_MAX_ALT;
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (arcMinRadius(a, b, mid) >= ARC_CLEAR) hi = mid;
    else lo = mid;
  }
  return hi;
}

/* One leg in, the arcs that get drawn out: a too-long hop becomes a chain. */
function arcLegs(arc) {
  const a = { lat: arc.startLat, lng: arc.startLng };
  const b = { lat: arc.endLat, lng: arc.endLng };
  const altitude = arcAltitudeFor(a, b);
  if (altitude != null) return [{ ...arc, altitude }];
  const span = angularDistance(a, b);
  const parts = Math.min(4, Math.max(2, Math.ceil(span / 80)));
  const legs = [];
  for (let i = 0; i < parts; i += 1) {
    const from = i === 0 ? a : greatCirclePlace(a, b, i / parts);
    const to = i === parts - 1 ? b : greatCirclePlace(a, b, (i + 1) / parts);
    const legAlt = arcAltitudeFor(from, to);
    legs.push({
      ...arc,
      startLat: from.lat,
      startLng: from.lng,
      endLat: to.lat,
      endLng: to.lng,
      altitude: legAlt == null ? ARC_BASE_ALT : legAlt
    });
  }
  return legs;
}

function routeArcs(arcs) {
  const out = [];
  for (const arc of arcs || []) {
    if (![arc.startLat, arc.startLng, arc.endLat, arc.endLng].every(Number.isFinite)) continue;
    out.push(...arcLegs(arc));
  }
  return out;
}

/* Middle of every stop, as seen from outside the globe. */
function sphericalCenter(points) {
  const sum = [0, 0, 0];
  for (const p of points) {
    const u = latLngUnit(p.lat, p.lng);
    sum[0] += u[0];
    sum[1] += u[1];
    sum[2] += u[2];
  }
  const len = Math.hypot(sum[0], sum[1], sum[2]);
  if (!len) return { lat: points[0].lat, lng: points[0].lng };
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, sum[1] / len))) / DEG,
    lng: Math.atan2(sum[2], sum[0]) / DEG
  };
}

/* Pull the camera back until every stop — and the label beside it — fits the box. */
function routeViewAltitude(points, center) {
  const box = $('#globe');
  const fov = (globe && globe.camera && globe.camera().fov) || 50;
  const w = (box && box.clientWidth) || 360;
  const h = (box && box.clientHeight) || 400;
  // Room for the marker label that hangs beside a stop ("• Los Angeles" is wide).
  const longest = points.reduce((max, p) => Math.max(max, String(p.name || '').length), 4);
  const pad = Math.min(w / 2 - 12, 24 + 3.3 * longest);
  const tanV = Math.tan((fov / 2) * DEG);
  const tanH = tanV * (w / h);
  const fits = (alt) => {
    const d = 1 + alt;
    return points.every((p) => {
      const psi = angularDistance(center, p) * DEG;
      const denom = d - Math.cos(psi);
      if (denom < 0.01) return false;
      const reach = Math.sin(psi) / denom;
      return (reach / tanH) * (w / 2) <= w / 2 - pad && (reach / tanV) * (h / 2) <= h / 2 - pad;
    });
  };
  // A domestic route keeps its country-level zoom; a wide one only needs the room.
  let lo = 0.8;
  let hi = 3.4;
  if (fits(lo)) return lo;
  for (let i = 0; i < 22; i += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/* Frame the whole journey, not one stop: on a long route the far end would
   otherwise sit behind the globe and the confirmed line looks cut off. */
function frameRoute() {
  const view = state.view;
  if (!view) return;
  const usable = view.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const last = currentPoint(view);
  if (!last || !Number.isFinite(last.lat)) return;
  const info = $('#marker-info');
  if (info) {
    info.hidden = false;
    info.textContent = pointSummary(last) || pair(last);
  }
  if (!globe) return;
  if (usable.length < 2) {
    globe.pointOfView({ lat: last.lat, lng: last.lng, altitude: 1.1 }, 800);
    return;
  }
  // The same place can appear on several scans; weigh each stop once.
  const stops = [];
  for (const p of usable) {
    if (!stops.some((q) => Math.abs(q.lat - p.lat) < 0.01 && Math.abs(q.lng - p.lng) < 0.01)) stops.push(p);
  }
  const center = sphericalCenter(stops);
  globe.pointOfView({ lat: center.lat, lng: center.lng, altitude: routeViewAltitude(stops, center) }, 900);
}

function initGlobe() {
  const container = $('#globe');
  if (!container) return;
  try {
    if (typeof Globe !== 'function') throw new Error('globe.gl missing');
    globe = Globe()(container)
      .width(container.clientWidth)
      .height(container.clientHeight)
      .backgroundColor('#080f19')
      .globeImageUrl('earth.jpg')
      .showAtmosphere(true)
      .atmosphereColor('#537eaa')
      .atmosphereAltitude(0.14)
      .arcsData([])
      .arcColor((d) => (d.planned ? '#b9cbe1' : '#b0f95e'))
      .arcStroke((d) => (d.planned ? ARC_STROKE * 0.72 : ARC_STROKE))
      .arcStartAltitude(ARC_END_ALT)
      .arcEndAltitude(ARC_END_ALT)
      .arcDashLength((d) => (d.planned ? 0.035 : 1))
      .arcDashGap((d) => (d.planned ? 0.022 : 0))
      // Height per leg comes from routeArcs(): distance-based, and raised until
      // the drawn curve is provably clear of the globe surface.
      .arcAltitude((d) => (Number.isFinite(d.altitude) ? d.altitude : 0.18))
      .htmlElementsData([])
      .htmlLat('lat')
      .htmlLng('lng')
      .htmlAltitude(0.015)
      .htmlElement((d) => {
        const el = document.createElement('button');
        el.className = 'globe-label' + (d.active ? ' active' : '') + (d.pending ? ' pending' : '') + (d.hideLabel ? ' dot' : '');
        const count = d.count > 1 ? ` · ${d.count}` : '';
        el.textContent = d.hideLabel ? '' : `• ${d.name}${count}${d.pending ? ' ○' : ''}`;
        el.title = pointSummary(d);
        el.onclick = () => focusPoint(d.index);
        return el;
      });

    globe.pointOfView({ lat: 37, lng: 67, altitude: 1.85 });
    if (globe.controls()) {
      globe.controls().enablePan = false;
      globe.controls().minDistance = 130;
      globe.controls().maxDistance = 650;
      globe.controls().autoRotate = true;
      globe.controls().autoRotateSpeed = 0.35;
    }
    new ResizeObserver(() => {
      if (!globe) return;
      globe.width(container.clientWidth).height(container.clientHeight);
    }).observe(container);
  } catch (err) {
    globeBroken = true;
    globe = softwareGlobe(container);
  }
}

function renderGlobe(view) {
  if (!globe) return;
  if (globe.controls()) globe.controls().autoRotate = !view;
  if (!view) {
    globe.htmlElementsData([]);
    globe.arcsData([]);
    return;
  }
  // One label per stop: several scans at the same place would otherwise stack a
  // dot on top of the name and smear the text. buildDataset already merges a
  // city's scans into one point; this keeps a second guard for near coordinates.
  const labels = [];
  const seen = new Map();
  view.points.forEach((p, i) => {
    // A point without both coordinates would put the camera at NaN; skip it instead.
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
    const pending = Boolean(view.demo && p.active && view.points.length > 1);
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    const earlier = seen.get(key);
    if (earlier) {
      earlier.index = i; // the newest scan at this stop answers a tap
      earlier.active = Boolean(p.active) || earlier.active;
      earlier.pending = pending;
      earlier.count = (earlier.count || 1) + (p.count || 1);
      earlier.lastEvent = p.lastEvent || earlier.lastEvent;
      return;
    }
    const label = { ...p, index: i, pending };
    seen.set(key, label);
    labels.push(label);
  });
  // Name the first and last stop and every country change; the rest stay dots.
  labels.forEach((p, i) => {
    const sameCountryAsPrev = i > 0 && labels[i - 1].countryCode === p.countryCode;
    const crowded = labels.some((q, j) => j > i && Math.abs(q.lat - p.lat) < 0.35 && Math.abs(q.lng - p.lng) < 0.35);
    // A merged stop can sit first in the list yet be where the parcel is now.
    p.hideLabel = !(i === 0 || p.active) && (sameCountryAsPrev || crowded);
  });
  globe.htmlElementsData(labels);
  globe.arcsData(routeArcs(view.arcs));
}

function focusPoint(index) {
  const view = state.view;
  if (!view || !view.points[index]) return;
  if (!Number.isFinite(view.points[index].lat) || !Number.isFinite(view.points[index].lng)) return;
  state.selected = index;
  const point = view.points[index];
  if (state.mapMode === 'flat') {
    /* 2D: centre the stop, keep the current zoom unless it is wider than a
       region — the same intent as the globe's altitude step. */
    flat.selected = index;
    const target = Math.max(flat.scale, Math.min(flat.maxScale, flat.minScale * 11, Math.min(flat.w, flat.h) / 16));
    flat.scale = target;
    flat.lon = point.lng;
    flat.lat = point.lat;
    wrapFlatLon();
    clampFlatLat();
    drawFlat();
    showFlatTip(index);
    const flatInfo = $('#marker-info');
    if (flatInfo) flatInfo.hidden = true;
    return;
  }
  flat.selected = -1;
  if (globe && globe.pointOfView) {
    // Zoom by how much of the world the route covers: a domestic parcel gets a country-level view.
    let spread = 0;
    for (const p of view.points) {
      spread = Math.max(spread, Math.abs(p.lat - point.lat), Math.abs(p.lng - point.lng));
    }
    const altitude = spread < 6 ? 0.75 : spread < 25 ? 1.1 : 1.35;
    globe.pointOfView({ lat: point.lat, lng: point.lng, altitude }, 900);
  }
  const info = $('#marker-info');
  const event = point.lastEvent || point.firstEvent;
  if (info) {
    info.hidden = false;
    info.textContent = pointSummary(point) || (event ? (event.note || event.title) : '');
  }
}

/* After a lookup the whole journey should be in frame, not one stop. */
function focusRoute() {
  const view = state.view;
  if (!view || !view.points.length) return;
  const latest = Number.isFinite(view.latestIndex) && view.latestIndex >= 0 ? view.latestIndex : view.points.length - 1;
  if (state.mapMode === 'flat') {
    fitFlat();
    showFlatTip(latest);
    flat.hover = -1;
  } else {
    frameRoute();
  }
}

/* Canvas fallback — same drawing as the original, driven by dynamic data. */
function softwareGlobe(host) {
  host.replaceChildren();
  const canvas = document.createElement('canvas');
  host.append(canvas);
  const ctx = canvas.getContext('2d');
  const tex = document.createElement('canvas');
  const tx = tex.getContext('2d');
  const rad = Math.PI / 180;
  const tw = 1024;
  const th = 512;
  let pixels;
  let lat = 37;
  let lon = 67;
  let alt = 1.85;
  let w;
  let h;
  let drag = null;
  let moved = false;
  let points = [];
  let arcs = [];
  let resize = null;

  function project(la, lo, r) {
    const a = la * rad;
    const b = (lo - lon) * rad;
    const c = lat * rad;
    const x = Math.cos(a) * Math.sin(b);
    const y = Math.sin(a) * Math.cos(c) - Math.cos(a) * Math.cos(b) * Math.sin(c);
    const z = Math.sin(a) * Math.sin(c) + Math.cos(a) * Math.cos(b) * Math.cos(c);
    return [w / 2 + r * x, h / 2 - r * y, z];
  }

  function vec(a, b) {
    return [Math.cos(a * rad) * Math.cos(b * rad), Math.sin(a * rad), Math.cos(a * rad) * Math.sin(b * rad)];
  }

  function draw() {
    w = host.clientWidth;
    h = host.clientHeight;
    canvas.width = w;
    canvas.height = h;
    ctx.fillStyle = '#080f19';
    ctx.fillRect(0, 0, w, h);
    const r = (Math.min(w, h) * 0.68) / Math.sqrt(alt);
    const halo = ctx.createRadialGradient(w / 2, h / 2, r * 0.98, w / 2, h / 2, r * 1.13);
    halo.addColorStop(0, '#4e8ba676');
    halo.addColorStop(1, '#080f1900');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, r * 1.13, 0, 7);
    ctx.fill();

    if (pixels) {
      const size = Math.ceil(r * 2);
      const im = ctx.createImageData(size, size);
      const cr = Math.cos(lat * rad);
      const sr = Math.sin(lat * rad);
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const xx = (x - r) / r;
          const yy = -(y - r) / r;
          const q = xx * xx + yy * yy;
          if (q > 1) continue;
          const z = Math.sqrt(1 - q);
          const la = Math.asin(yy * cr + z * sr);
          const lo = Math.atan2(xx, z * cr - yy * sr) + lon * rad;
          const u = (((lo / (2 * Math.PI)) + 0.5) % 1 + 1) % 1;
          const v = 0.5 - la / Math.PI;
          const src = (Math.min(th - 1, Math.floor(v * th)) * tw + Math.min(tw - 1, Math.floor(u * tw))) * 4;
          const k = (y * size + x) * 4;
          const shade = 0.48 + 0.48 * z;
          im.data[k] = pixels[src] * shade;
          im.data[k + 1] = pixels[src + 1] * shade;
          im.data[k + 2] = pixels[src + 2] * shade;
          im.data[k + 3] = 255;
        }
      }
      ctx.putImageData(im, Math.round(w / 2 - r), Math.round(h / 2 - r));
    }

    arcs.forEach((a) => {
      const start = vec(a.startLat, a.startLng);
      const end = vec(a.endLat, a.endLng);
      const omega = Math.acos(Math.max(-1, Math.min(1, start.reduce((n, v, i) => n + v * end[i], 0))));
      if (!Number.isFinite(omega) || omega === 0) return;
      ctx.beginPath();
      ctx.strokeStyle = a.planned ? '#c1d6ef' : '#b7f373';
      ctx.lineWidth = 1.8;
      ctx.setLineDash(a.planned ? [5, 6] : []);
      let pen = false;
      for (let i = 0; i <= 100; i += 1) {
        const tt = i / 100;
        const v = start.map((val, j) => (Math.sin((1 - tt) * omega) * val + Math.sin(tt * omega) * end[j]) / Math.sin(omega));
        const la = Math.asin(v[1]) / rad;
        const lo = Math.atan2(v[2], v[0]) / rad;
        const p = project(la, lo, r * (1 + Math.sin(tt * Math.PI) * (a.planned ? 0.13 : 0.03)));
        if (p[2] < 0) { pen = false; continue; }
        if (pen) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
        pen = true;
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);

    points.forEach((c, i) => {
      const p = project(c.lat, c.lng, r);
      if (p[2] < 0) return;
      const active = c.active;
      ctx.fillStyle = active ? '#b7f373' : '#e8f0ff';
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 4, 0, 7);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (c.hideLabel) return;
      ctx.font = '12px sans-serif';
      const label = c.name + (c.pending ? ' ○' : '');
      const px = p[0] + 10;
      const py = p[1] + (i === 0 ? 23 : -12);
      ctx.fillStyle = '#101b2ce8';
      ctx.fillRect(px - 5, py - 14, ctx.measureText(label).width + 10, 22);
      ctx.fillStyle = active ? '#b7f373' : '#e8f0ff';
      ctx.fillText(label, px, py);
    });

  }

  const img = new Image();
  img.onload = () => {
    tex.width = tw;
    tex.height = th;
    tx.drawImage(img, 0, 0, tw, th);
    pixels = tx.getImageData(0, 0, tw, th).data;
    draw();
  };
  img.src = 'earth.jpg';

  canvas.style.cssText = 'width:100%;height:100%;touch-action:none;cursor:grab';
  canvas.onpointerdown = (e) => {
    drag = [e.clientX, e.clientY, lat, lon];
    moved = false;
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag[0];
    const dy = e.clientY - drag[1];
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    lon = drag[3] - dx * 0.3;
    lat = Math.max(-85, Math.min(85, drag[2] + dy * 0.3));
    draw();
  };
  canvas.onpointerup = (e) => {
    if (!moved) {
      const box = canvas.getBoundingClientRect();
      const r = (Math.min(w, h) * 0.68) / Math.sqrt(alt);
      points.forEach((c, i) => {
        const p = project(c.lat, c.lng, r);
        if (p[2] > 0 && Math.hypot(e.clientX - box.left - p[0], e.clientY - box.top - p[1]) < 35) focusPoint(i);
      });
    }
    drag = null;
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    alt = Math.max(0.4, Math.min(5, alt * (e.deltaY > 0 ? 1.12 : 0.88)));
    draw();
  };
  resize = new ResizeObserver(draw);
  resize.observe(host);

  return {
    pointOfView(p) {
      if (!p) return { lat, lng: lon, altitude: alt };
      lat = p.lat;
      lon = p.lng;
      alt = p.altitude;
      draw();
      return this;
    },
    htmlElementsData(a) {
      points = (Array.isArray(a) ? a : []).filter(Boolean);
      draw();
      return this;
    },
    arcsData(a) {
      arcs = Array.isArray(a) ? a : [];
      draw();
      return this;
    },
    controls() {
      return null;
    }
  };
}

/* ------------------------------------------------------------------ *
 * 2D flat map — an equirectangular panorama drawn from vector coastlines.
 *   One local TopoJSON is decoded once into rings; every pan, zoom and
 *   relabel is a canvas repaint, so there is no tile server, no per-pan
 *   image request and nothing to blur at high zoom. Points, arcs and the
 *   last confirmed stop come from the same view model as the globe, so
 *   switching is only a change of projection.
 * ------------------------------------------------------------------ */

const WORLD_URL = 'world-110m.json';

const flat = {
  root: null, canvas: null, ctx: null, tip: null, tipTitle: null, tipBody: null, pulse: null,
  dpr: 1, w: 0, h: 0,
  lon: 0, lat: 12, scale: 0, minScale: 1, maxScale: 40,
  shapes: null, loading: false, failed: false,
  hits: [], hover: -1, selected: -1, tipIndex: -1,
  drag: null, pinch: null, pointers: new Map()
};

/* TopoJSON → one array of rings per polygon, each ring a list of [lng, lat].
   Quantized arcs are delta-encoded, so they are summed and scaled first; a
   negative arc index means the same arc walked backwards. */
/* The stop the parcel is at now — the last place it was actually seen, which
   is not always the last point on a route that returns somewhere. */
function lastStopIndex(view) {
  if (!view || !view.points || !view.points.length) return -1;
  if (Number.isFinite(view.latestIndex) && view.latestIndex >= 0) return view.latestIndex;
  return view.points.length - 1;
}

function decodeWorld(topo) {
  const objects = (topo && topo.objects) || {};
  const collection = objects.countries || objects.land;
  if (!collection) return [];
  const transform = topo.transform;
  const arcs = (topo.arcs || []).map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map((point) => {
      if (!transform) return [point[0], point[1]];
      x += point[0];
      y += point[1];
      return [x * transform.scale[0] + transform.translate[0], y * transform.scale[1] + transform.translate[1]];
    });
  });
  const join = (list) => {
    const ring = [];
    for (const index of list) {
      const source = index < 0 ? (arcs[~index] || []).slice().reverse() : (arcs[index] || []);
      for (let i = ring.length ? 1 : 0; i < source.length; i += 1) ring.push(source[i]);
    }
    return ring;
  };
  const shapes = [];
  /* A ring that crosses the antimeridian (Russia, Fiji) is stored with both
     179° and -179°; unwrapping it keeps one continuous outline instead of a
     line drawn straight across the whole map. */
  const addShape = (rings) => {
    const out = [];
    let minLng = Infinity;
    let maxLng = -Infinity;
    let anchor = 0;
    rings.forEach((ring, ringIndex) => {
      const unwrapped = [];
      let prev = null;
      for (const [lng, lat] of ring) {
        let value = lng;
        if (prev != null) {
          while (value - prev > 180) value -= 360;
          while (value - prev < -180) value += 360;
        }
        unwrapped.push([value, lat]);
        prev = value;
      }
      /* Holes follow the outer ring's sheet of the world. */
      if (ringIndex === 0) {
        if (unwrapped.length) anchor = unwrapped.reduce((sum, p) => sum + p[0], 0) / unwrapped.length;
      } else if (unwrapped.length) {
        const mean = unwrapped.reduce((sum, p) => sum + p[0], 0) / unwrapped.length;
        const shift = Math.round((anchor - mean) / 360) * 360;
        if (shift) for (const p of unwrapped) p[0] += shift;
      }
      for (const p of unwrapped) {
        if (p[0] < minLng) minLng = p[0];
        if (p[0] > maxLng) maxLng = p[0];
      }
      out.push(unwrapped);
    });
    if (!out.length || !out[0].length) return;
    /* Keep a polygon that landed entirely past the pole back on the map. */
    if (maxLng - minLng < 360 && (minLng > 180 || maxLng < -180)) {
      const shift = minLng > 180 ? -360 : 360;
      for (const ring of out) for (const p of ring) p[0] += shift;
      minLng += shift;
      maxLng += shift;
    }
    if (out[0].length > 2) shapes.push({ rings: out, minLng, maxLng });
  };
  const walk = (geometry) => {
    if (!geometry) return;
    if (geometry.type === 'Polygon') addShape((geometry.arcs || []).map(join));
    else if (geometry.type === 'MultiPolygon') (geometry.arcs || []).forEach((polygon) => addShape(polygon.map(join)));
    else if (geometry.type === 'GeometryCollection') (geometry.geometries || []).forEach(walk);
  };
  (collection.geometries || [collection]).forEach(walk);
  return shapes;
}

function loadWorld() {
  if (flat.shapes || flat.loading) return;
  flat.failed = false;
  /* Tests (and an inline build) can hand the topology in directly. */
  if (window.WIMP_WORLD) {
    flat.shapes = decodeWorld(window.WIMP_WORLD);
    if (state.mapMode === 'flat') drawFlat();
    return;
  }
  if (typeof fetch !== 'function') return;
  flat.loading = true;
  fetch(WORLD_URL, { headers: { accept: 'application/json' } })
    .then((res) => (res && res.ok ? res.json() : Promise.reject(new Error('world map ' + (res && res.status)))))
    .then((topo) => { flat.shapes = decodeWorld(topo); })
    .catch(() => { flat.failed = true; })
    .then(() => {
      flat.loading = false;
      if (state.mapMode === 'flat') drawFlat();
    });
}

function sizeFlat() {
  if (!flat.root || !flat.canvas) return;
  const w = Math.max(1, Math.round(flat.root.clientWidth || 0));
  const h = Math.max(1, Math.round(flat.root.clientHeight || 0));
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const first = !flat.w;
  flat.w = w;
  flat.h = h;
  flat.dpr = dpr;
  flat.canvas.width = Math.round(w * dpr);
  flat.canvas.height = Math.round(h * dpr);
  flat.minScale = w / 360;
  flat.maxScale = Math.max(flat.minScale * 20, 12);
  if (first || !flat.scale) {
    flat.scale = flat.minScale;
    flat.lon = 0;
    flat.lat = 12;
  }
  flat.scale = Math.max(flat.minScale, Math.min(flat.maxScale, flat.scale));
  clampFlatLat();
  drawFlat();
}

function wrapFlatLon() {
  flat.lon = ((((flat.lon + 180) % 360) + 360) % 360) - 180;
}

/* Keep the visible band inside the poles whenever the map is taller than the
   panel; when the whole world fits, the map is simply centred on the equator. */
function clampFlatLat() {
  const half = flat.h / 2 / (flat.scale || 1);
  if (half >= 90) flat.lat = 0;
  else flat.lat = Math.max(-90 + half, Math.min(90 - half, flat.lat));
}

function drawFlat() {
  const ctx = flat.ctx;
  if (!ctx || !flat.w || !flat.scale) return;
  const w = flat.w;
  const h = flat.h;
  const scale = flat.scale;
  ctx.setTransform(flat.dpr, 0, 0, flat.dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const sea = ctx.createLinearGradient(0, 0, 0, h);
  sea.addColorStop(0, '#0a131e');
  sea.addColorStop(0.55, '#080f19');
  sea.addColorStop(1, '#060c13');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, w, h);

  /* When the whole world fits with room to spare (a tall phone), the map is a
     band across the middle; clip the chart to it so the band reads as the map
     rather than as a grid that stops nowhere. */
  const bandTop = h / 2 - 90 * scale;
  const bandBottom = h / 2 + 90 * scale;
  const framed = bandTop > 0.5 || bandBottom < h - 0.5;
  ctx.save();
  if (framed) {
    ctx.beginPath();
    ctx.rect(0, Math.max(0, bandTop), w, Math.min(h, bandBottom) - Math.max(0, bandTop));
    ctx.clip();
  }
  drawGraticule(ctx);
  if (flat.shapes) drawLand(ctx);
  ctx.restore();
  if (framed) {
    ctx.strokeStyle = 'rgba(58,88,113,.45)';
    ctx.lineWidth = 1;
    for (const y of [bandTop, bandBottom]) {
      if (y > 0.5 && y < h - 0.5) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
        ctx.stroke();
      }
    }
  }

  drawArcs(ctx);
  drawPoints(ctx);
  placePulse();
  if (flat.tipIndex >= 0) placeTip();
}

function drawGraticule(ctx) {
  const w = flat.w;
  const h = flat.h;
  const step = 360 * flat.scale;
  /* The grid tightens as the map zooms in, so a close view is not an empty sea. */
  const grid = flat.scale > flat.minScale * 12 ? 5 : flat.scale > flat.minScale * 4 ? 10 : 30;
  ctx.save();
  ctx.lineWidth = 1;
  for (let lng = -180; lng <= 180; lng += grid) {
    let x = w / 2 + (lng - flat.lon) * flat.scale;
    while (x < -1) x += step;
    for (; x < w + 1; x += step) {
      ctx.strokeStyle = lng === 0 ? '#1c2d3e' : '#131f2b';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
      ctx.stroke();
    }
  }
  for (let lat = -60; lat <= 60; lat += grid) {
    const y = h / 2 - (lat - flat.lat) * flat.scale;
    if (y < -1 || y > h + 1) continue;
    ctx.strokeStyle = lat === 0 ? '#1c2d3e' : '#131f2b';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLand(ctx) {
  const w = flat.w;
  const h = flat.h;
  const scale = flat.scale;
  const land = ctx.createLinearGradient(0, 0, 0, h);
  land.addColorStop(0, '#1a2f42');
  land.addColorStop(0.6, '#152536');
  land.addColorStop(1, '#101d29');
  const reach = w / 2 / scale + 6;
  const left = flat.lon - reach;
  const right = flat.lon + reach;
  ctx.save();
  ctx.lineJoin = 'round';
  /* A slightly heavier hairline as the map zooms keeps the 1:110m coastlines
     reading as a drawn chart instead of pixel steps. */
  ctx.lineWidth = Math.max(0.7, Math.min(1.6, scale / 60));
  ctx.strokeStyle = 'rgba(96,144,178,.55)';
  for (const shape of flat.shapes) {
    /* Shapes are unwrapped, so they repeat every 360° instead of at ±180°. */
    const from = Math.max(-1, Math.ceil((left - shape.maxLng) / 360));
    const to = Math.min(1, Math.floor((right - shape.minLng) / 360));
    for (let k = from; k <= to; k += 1) {
      const dx = k * 360;
      ctx.beginPath();
      for (const ring of shape.rings) {
        for (let i = 0; i < ring.length; i += 1) {
          const x = w / 2 + (ring[i][0] + dx - flat.lon) * scale;
          const y = h / 2 - (ring[i][1] - flat.lat) * scale;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = land;
      ctx.fill('evenodd');
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* Great-circle path of an arc, in screen pixels. Longitudes are unwrapped so
   the line never jumps at the antimeridian, then shifted as one piece to the
   copy of the world nearest the camera. */
function arcScreenPoints(arc) {
  const lat1 = arc.startLat * DEG;
  const lat2 = arc.endLat * DEG;
  const lng1 = arc.startLng * DEG;
  const lng2 = arc.endLng * DEG;
  const v1 = [Math.cos(lat1) * Math.cos(lng1), Math.cos(lat1) * Math.sin(lng1), Math.sin(lat1)];
  const v2 = [Math.cos(lat2) * Math.cos(lng2), Math.cos(lat2) * Math.sin(lng2), Math.sin(lat2)];
  const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
  const omega = Math.acos(dot);
  const steps = 72;
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    let v = v1;
    if (omega > 1e-6) {
      const a = Math.sin((1 - t) * omega) / Math.sin(omega);
      const b = Math.sin(t * omega) / Math.sin(omega);
      v = [v1[0] * a + v2[0] * b, v1[1] * a + v2[1] * b, v1[2] * a + v2[2] * b];
    }
    const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG;
    const lng = Math.atan2(v[1], v[0]) / DEG;
    pts.push([lng, lat]);
  }
  for (let i = 1; i < pts.length; i += 1) {
    let lng = pts[i][0];
    const prev = pts[i - 1][0];
    while (lng - prev > 180) lng -= 360;
    while (lng - prev < -180) lng += 360;
    pts[i][0] = lng;
  }
  const mid = pts[Math.floor(pts.length / 2)][0];
  const shift = Math.round((flat.lon - mid) / 360) * 360;
  return pts.map(([lng, lat]) => [
    flat.w / 2 + (lng + shift - flat.lon) * flat.scale,
    flat.h / 2 - (lat - flat.lat) * flat.scale
  ]);
}

function drawArcs(ctx) {
  const view = state.view;
  if (!view || !view.arcs.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const arc of view.arcs) {
    if (!Number.isFinite(arc.startLat) || !Number.isFinite(arc.startLng)) continue;
    if (!Number.isFinite(arc.endLat) || !Number.isFinite(arc.endLng)) continue;
    const pts = arcScreenPoints(arc);
    if (pts.length < 2) continue;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (arc.planned) {
      ctx.setLineDash([5, 6]);
      ctx.strokeStyle = 'rgba(196,216,238,.72)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.strokeStyle = 'rgba(183,243,115,.15)';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = '#b7f373';
      ctx.lineWidth = 1.7;
      ctx.stroke();
    }
  }
  ctx.restore();
}

function chipPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawPoints(ctx) {
  flat.hits = [];
  const view = state.view;
  if (!view) return;
  const w = flat.w;
  const h = flat.h;
  ctx.save();
  ctx.font = '11px "DM Sans","Noto Sans KR",system-ui,sans-serif';
  ctx.textBaseline = 'middle';
  view.points.forEach((point, index) => {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
    let lng = point.lng;
    while (lng - flat.lon > 180) lng -= 360;
    while (lng - flat.lon < -180) lng += 360;
    const x = w / 2 + (lng - flat.lon) * flat.scale;
    const y = h / 2 - (point.lat - flat.lat) * flat.scale;
    if (x < -50 || x > w + 50 || y < -34 || y > h + 34) return;
    flat.hits.push({ index, x, y });
    const active = Boolean(point.active);
    const pending = Boolean(view.demo && index === lastStopIndex(view) && view.points.length > 1);
    const selected = flat.selected === index;

    if (active || selected) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 24);
      glow.addColorStop(0, active ? 'rgba(183,243,115,.34)' : 'rgba(183,243,115,.18)');
      glow.addColorStop(1, 'rgba(183,243,115,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, 24, 0, 7);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, active ? 4.6 : 3.4, 0, 7);
    ctx.fillStyle = active ? '#b7f373' : '#e8f0ff';
    ctx.fill();
    if (pending) {
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, 7);
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = 'rgba(201,217,238,.9)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (point.hideLabel && !active) return;

    const text = point.name + (pending ? ' ○' : '');
    const width = ctx.measureText(text).width || 40;
    const padX = 6;
    const boxH = 19;
    let boxX = x + 9;
    if (boxX + width + padX * 2 > w - 6) boxX = x - 9 - width - padX * 2;
    if (boxX < 6) boxX = 6;
    const boxY = y - boxH - 8;
    chipPath(ctx, boxX, boxY, width + padX * 2, boxH, 4);
    ctx.fillStyle = active ? 'rgba(24,42,26,.9)' : 'rgba(11,21,37,.86)';
    ctx.fill();
    ctx.strokeStyle = active ? 'rgba(183,243,115,.6)' : 'rgba(69,97,116,.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = active ? '#b7f373' : '#e8f0ff';
    ctx.fillText(text, boxX + padX, boxY + boxH / 2 + 0.5);
  });
  ctx.restore();
}

/* The last confirmed stop gets a CSS-driven ping so the canvas never has to
   repaint for an animation. */
function placePulse() {
  const el = flat.pulse;
  if (!el) return;
  const view = state.view;
  const last = lastStopIndex(view);
  const hit = last >= 0 ? flat.hits.find((entry) => entry.index === last) : null;
  if (!hit || state.mapMode !== 'flat') {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.style.transform = 'translate(' + Math.round(hit.x) + 'px,' + Math.round(hit.y) + 'px)';
}

function placeTip() {
  if (!flat.tip || flat.tipIndex < 0) return;
  const hit = flat.hits.find((entry) => entry.index === flat.tipIndex);
  if (!hit) {
    hideFlatTip();
    return;
  }
  flat.tip.hidden = false;
  const tw = flat.tip.offsetWidth || 180;
  const th = flat.tip.offsetHeight || 46;
  let x = hit.x + 16;
  let y = hit.y - th - 10;
  if (x + tw > flat.w - 8) x = hit.x - tw - 16;
  if (x < 8) x = 8;
  if (y < 8) y = hit.y + 16;
  if (y + th > flat.h - 8) y = flat.h - th - 8;
  flat.tip.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
}

function showFlatTip(index) {
  const view = state.view;
  if (!view || !view.points[index]) return;
  const point = view.points[index];
  const event = point.lastEvent || point.firstEvent;
  flat.tipIndex = index;
  if (flat.tipTitle) flat.tipTitle.textContent = pair(point);
  if (flat.tipBody) {
    const when = event ? (event.timeLabel || formatTime(event.time)) : '';
    const what = event ? (event.note || event.title) : '';
    flat.tipBody.textContent = [when, what].filter(Boolean).join(' · ');
  }
  placeTip();
}

function hideFlatTip() {
  flat.tipIndex = -1;
  if (flat.tip) flat.tip.hidden = true;
}

function flatHitAt(x, y, radius) {
  let best = -1;
  let bestD = radius * radius;
  for (const hit of flat.hits) {
    const d = (hit.x - x) * (hit.x - x) + (hit.y - y) * (hit.y - y);
    if (d <= bestD) {
      bestD = d;
      best = hit.index;
    }
  }
  return best;
}

function zoomFlat(factor, anchorX, anchorY) {
  if (!flat.scale) return;
  const ax = Number.isFinite(anchorX) ? anchorX : flat.w / 2;
  const ay = Number.isFinite(anchorY) ? anchorY : flat.h / 2;
  const lng = flat.lon + (ax - flat.w / 2) / flat.scale;
  const lat = flat.lat + (flat.h / 2 - ay) / flat.scale;
  flat.scale = Math.max(flat.minScale, Math.min(flat.maxScale, flat.scale * factor));
  flat.lon = lng - (ax - flat.w / 2) / flat.scale;
  flat.lat = lat - (flat.h / 2 - ay) / flat.scale;
  wrapFlatLon();
  clampFlatLat();
  drawFlat();
}

/* Frame every stop of the current lookup; a single city keeps a region-level
   zoom instead of filling the panel with one dot. */
function fitFlat() {
  if (!flat.w || !flat.scale) return;
  const view = state.view;
  const pts = (view ? view.points : []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (!pts.length) {
    flat.scale = flat.minScale;
    flat.lon = 0;
    flat.lat = 12;
    clampFlatLat();
    drawFlat();
    return;
  }
  const lngs = pts.map((p) => p.lng).sort((a, b) => a - b);
  let gap = lngs[0] + 360 - lngs[lngs.length - 1];
  let gapAt = lngs.length - 1;
  for (let i = 1; i < lngs.length; i += 1) {
    const span = lngs[i] - lngs[i - 1];
    if (span > gap) {
      gap = span;
      gapAt = i - 1;
    }
  }
  const spanLng = lngs.length > 1 ? 360 - gap : 0;
  let centerLng = lngs[(gapAt + 1) % lngs.length] + spanLng / 2;
  if (centerLng > 180) centerLng -= 360;
  const lats = pts.map((p) => p.lat);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const spanLat = maxLat - minLat;
  const sx = (flat.w * 0.8) / Math.max(14, spanLng);
  const sy = (flat.h * 0.8) / Math.max(9, spanLat);
  /* Stop at a regional view: the coastline set is 1:110m, and a domestic route
     zoomed to city level would only show a chunky silhouette. */
  flat.scale = Math.max(flat.minScale, Math.min(flat.maxScale, flat.minScale * 9, Math.min(sx, sy)));
  flat.lon = centerLng;
  flat.lat = (minLat + maxLat) / 2;
  wrapFlatLon();
  clampFlatLat();
  if (state.view) flat.selected = lastStopIndex(state.view);
  drawFlat();
}

function bindFlat() {
  const canvas = flat.canvas;
  if (!canvas) return;
  const local = (event) => {
    const box = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0 && event.pointerType !== 'touch') return;
    const p = local(event);
    flat.pointers.set(event.pointerId == null ? 1 : event.pointerId, p);
    try { canvas.setPointerCapture(event.pointerId); } catch (err) { /* no capture */ }
    if (flat.pointers.size === 1) {
      flat.drag = { x: p.x, y: p.y, lon: flat.lon, lat: flat.lat, moved: false };
      flat.pinch = null;
    } else if (flat.pointers.size === 2) {
      const [a, b] = [...flat.pointers.values()];
      flat.pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale: flat.scale,
        lon: flat.lon,
        lat: flat.lat,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      };
      flat.drag = null;
    }
  });

  canvas.addEventListener('pointermove', (event) => {
    const p = local(event);
    if (flat.pointers.has(event.pointerId)) flat.pointers.set(event.pointerId, p);

    if (flat.pinch && flat.pointers.size >= 2) {
      const [a, b] = [...flat.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (flat.pinch.dist > 0 && dist > 0) {
        const scale = Math.max(flat.minScale, Math.min(flat.maxScale, flat.pinch.scale * (dist / flat.pinch.dist)));
        const anchorLng = flat.pinch.lon + (flat.pinch.mid.x - flat.w / 2) / flat.pinch.scale;
        const anchorLat = flat.pinch.lat + (flat.h / 2 - flat.pinch.mid.y) / flat.pinch.scale;
        flat.scale = scale;
        flat.lon = anchorLng - (mid.x - flat.w / 2) / scale;
        flat.lat = anchorLat - (flat.h / 2 - mid.y) / scale;
        wrapFlatLon();
        clampFlatLat();
        hideFlatTip();
        drawFlat();
      }
      return;
    }

    if (flat.drag) {
      const dx = p.x - flat.drag.x;
      const dy = p.y - flat.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) flat.drag.moved = true;
      flat.lon = flat.drag.lon - dx / flat.scale;
      flat.lat = flat.drag.lat + dy / flat.scale;
      wrapFlatLon();
      clampFlatLat();
      if (flat.hover >= 0) {
        flat.hover = -1;
        hideFlatTip();
      }
      drawFlat();
      return;
    }

    const index = flatHitAt(p.x, p.y, 22);
    if (index !== flat.hover) {
      flat.hover = index;
      if (index >= 0) showFlatTip(index);
      else if (flat.selected < 0) hideFlatTip();
    }
    if (index >= 0) placeTip();
  });

  const finish = (event, allowClick) => {
    const box = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    const p = { x: event.clientX - box.left, y: event.clientY - box.top };
    if (flat.pointers.has(event.pointerId)) flat.pointers.delete(event.pointerId);
    try { canvas.releasePointerCapture(event.pointerId); } catch (err) { /* no capture */ }
    if (flat.pinch) {
      if (flat.pointers.size < 2) flat.pinch = null;
      flat.drag = null;
      return;
    }
    const drag = flat.drag;
    flat.drag = null;
    if (!drag) return;
    if (!drag.moved && allowClick) {
      const index = flatHitAt(p.x, p.y, 26);
      if (index >= 0) focusPoint(index);
    }
  };
  canvas.addEventListener('pointerup', (event) => finish(event, true));
  canvas.addEventListener('pointercancel', (event) => finish(event, false));

  canvas.addEventListener('pointerleave', () => {
    if (flat.drag || flat.pinch) return;
    flat.hover = -1;
    if (flat.selected < 0) hideFlatTip();
    else placeTip();
    drawFlat();
  });

  canvas.addEventListener('wheel', (event) => {
    if (event.preventDefault) event.preventDefault();
    if (!flat.scale) return;
    const p = local(event);
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomFlat(Math.exp(-Math.max(-120, Math.min(120, delta)) * 0.0018), p.x, p.y);
  }, { passive: false });

  canvas.addEventListener('dblclick', (event) => {
    const p = local(event);
    zoomFlat(1.8, p.x, p.y);
  });
}

function initFlatMap() {
  const root = $('#flat-map');
  const canvas = $('#flat-canvas');
  if (!root || !canvas) return;
  flat.root = root;
  flat.canvas = canvas;
  flat.tip = $('#flat-tip');
  flat.tipTitle = $('#flat-tip-title');
  flat.tipBody = $('#flat-tip-body');
  flat.pulse = $('#flat-pulse');
  flat.ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!flat.ctx) return;
  const panel = $('#map-panel');
  if (panel) panel.dataset.map = state.mapMode;
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => sizeFlat()).observe(root);
  bindFlat();
  sizeFlat();
  /* Warm the coastline file while the globe is on screen, so the first
     switch to 2D is already painted. */
  if ('requestIdleCallback' in window) window.requestIdleCallback(() => loadWorld(), { timeout: 3000 });
  else setTimeout(loadWorld, 1200);
}

function setMapMode(mode) {
  const next = mode === 'flat' ? 'flat' : 'globe';
  if (state.mapMode === next) return;
  state.mapMode = next;
  const panel = $('#map-panel');
  if (panel) panel.dataset.map = next;
  const globeRoot = $('#globe');
  if (globeRoot) globeRoot.setAttribute('aria-hidden', next === 'flat' ? 'true' : 'false');
  const flatRoot = $('#flat-map');
  if (flatRoot) flatRoot.setAttribute('aria-hidden', next === 'flat' ? 'false' : 'true');
  [['#view-globe', 'globe'], ['#view-flat', 'flat']].forEach(([selector, key]) => {
    const button = $(selector);
    if (!button) return;
    button.setAttribute('aria-pressed', next === key ? 'true' : 'false');
  });
  const hint = $('#map-hint');
  if (hint) {
    hint.dataset.i = next === 'flat' ? 'dragFlat' : 'drag';
    hint.textContent = t()[hint.dataset.i] || '';
  }
  const credit = $('#map-credit');
  if (credit) credit.textContent = next === 'flat' ? 'Map data · Natural Earth' : 'Earth imagery · NASA';
  hideFlatTip();
  const info = $('#marker-info');
  if (info) info.hidden = true;

  if (next === 'flat') {
    loadWorld();
    sizeFlat();
    if (state.view) fitFlat();
    else drawFlat();
  } else {
    if (globe && globe.width && globeRoot) globe.width(globeRoot.clientWidth).height(globeRoot.clientHeight);
    const controls = globe && globe.controls ? globe.controls() : null;
    if (controls) controls.autoRotate = !state.view;
    renderGlobe(state.view);
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render() {
  const s = t();
  const lang = langInfo();
  localizeNames();
  document.documentElement.lang = state.lang;
  document.documentElement.dir = lang.dir || 'ltr';
  updateLanguageControl(lang);
  updateGuideLinks();
  document.querySelectorAll('[data-i]').forEach((el) => {
    const value = s[el.dataset.i];
    if (typeof value === 'string') el.textContent = value;
  });
  /* Screen-reader labels follow the same dictionary. */
  document.querySelectorAll('[data-i-aria]').forEach((el) => {
    const value = s[el.dataset.iAria];
    if (typeof value === 'string') el.setAttribute('aria-label', value);
  });
  $('#number').placeholder = s.placeholder;
  if ($('#carrier').options[0]) $('#carrier').options[0].text = s.detect;
  const badge = $('#mode-badge');
  badge.hidden = !state.view;
  badge.textContent = state.view && !state.view.demo ? s.live : s.demo;
  badge.classList.toggle('live', Boolean(state.view && !state.view.demo));

  renderParcels();
  renderNotice();
  renderEvents();
  renderSteps();
  renderCountries();
  renderMapStatus();
  renderMap();
}

/* Both views read the same view model; only the visible one is repainted. */
function renderMap() {
  renderGlobe(state.view);
  if (state.mapMode === 'flat') drawFlat();
  else {
    placePulse();
    if (state.view) placeTip();
  }
}

function renderParcels() {
  const s = t();
  const box = $('#parcels');
  box.replaceChildren();

  if (!state.view && !state.error) {
    box.style.display = 'none';
    $('#count').textContent = countText(0);
    return;
  }
  box.style.display = '';

  const row = document.createElement('div');
  row.className = 'parcel selected';

  const icon = document.createElement('span');
  icon.className = 'carrier-logo';
  const code = state.view ? state.view.carrierCode : state.carrier;
  const mark = {
    CJ: 'CJ', EPOST: '郵', HANJIN: 'H', LOTTE: 'L', LOGEN: '로', ILYANG: '일',
    DHL: 'DHL', FEDEX: 'FX', UPS: 'UPS', USPS: 'US', CAINIAO: 'CA', EMS: 'EMS', YUNEXPRESS: 'YX'
  };
  icon.textContent = mark[code] || String(code || '?').slice(0, 3);
  icon.dataset.carrier = code;

  const body = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = state.number;
  const small = document.createElement('small');
  if (state.error) {
    small.textContent = state.error.title;
  } else if (state.view) {
    const count = countText(state.view.events.length);
    small.textContent = state.view.demo
      ? (isKo() ? 'Sofia · Leipzig · Incheon' : state.view.points.map((p) => p.name).join(' · '))
      : `${state.view.latestDetail || state.view.latestLocation} · ${count}`;
  } else {
    small.textContent = s.waiting;
  }
  body.append(strong, small);

  const status = document.createElement('span');
  status.className = 'state';
  status.textContent = state.error ? '—' : state.view ? statusLabel(state.view.statusCode) : s.idleBadge;

  row.append(icon, body, status);
  box.append(row);
  const events = state.view ? state.view.events.length : 0;
  $('#count').textContent = countText(events);
}

/* “배송 이력 9건” / “9 tracking events” — the header count carries its unit. */
function countText(n) {
  return `${n}${joinsCount() ? ' ' : ''}${t().events}`;
}

/* A refresh that failed while a good result is already on screen: keep the
   result and say so, instead of clearing the globe over a moment's outage. */
function renderNotice() {
  const el = $('#stale-note');
  if (!el) return;
  if (!state.notice) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = [t().staleNote, state.notice.title].filter(Boolean).join(' ');
}

function renderEvents() {
  const s = t();
  const box = $('#events');
  box.replaceChildren();

  if (state.loading) {
    // A same-number refresh keeps the timeline it already has on screen.
    if (!(state.refreshing && state.view)) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = s.loading;
      box.append(note);
      return;
    }
  }

  if (state.error) {
    const wrap = document.createElement('div');
    wrap.className = 'error-box';
    const title = document.createElement('h3');
    title.textContent = state.error.title;
    const hint = document.createElement('p');
    hint.textContent = state.error.hint || '';
    wrap.append(title);
    if (state.error.hint) wrap.append(hint);
    if (state.error.site) {
      const link = document.createElement('a');
      link.href = state.error.site;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'ghost-link';
      link.textContent = s.openSite + ' ↗';
      wrap.append(link);
    }
    box.append(wrap);
    return;
  }

  if (!state.view || !state.view.events.length) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = s.empty;
    box.append(note);
    return;
  }

  const list = [...state.view.events].reverse();
  list.forEach((ev, i) => {
    const item = document.createElement('div');
    item.className = 'event';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');

    const meta = document.createElement('small');
    const when = ev.timeLabel || formatTime(ev.time);
    const where = ev.location ? (ev.location.name || '') : '';
    meta.textContent = [when, where, ev.physical === false ? s.infoOnly : ''].filter(Boolean).join(' · ')
      || (state.view.demo ? '' : s.liveNote);

    const title = document.createElement('h3');
    title.textContent = ev.title || statusLabel(ev.statusCode);

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = ev.note && state.view.demo ? ev.note : statusLabel(ev.statusCode);

    item.append(meta, title, tag);
    if (typeof ev.point === 'number' && ev.point >= 0) {
      item.onclick = () => focusPoint(ev.point);
      item.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusPoint(ev.point); } };
    }
    box.append(item);
    if (i === 0) item.dataset.latest = '1';
  });
}

function renderSteps() {
  const s = t();
  const view = state.view;
  const labels = view && view.international ? s.stages : s.stagesDomestic;
  const stage = view ? view.stage : -1;
  $('#steps').innerHTML = labels
    .map((label, i) => {
      const done = stage > i;
      const current = stage === i;
      const mark = done ? '✓' : current ? '◉' : '·';
      return `<div class="step ${done ? 'done' : ''} ${current ? 'current' : ''}"><span>${mark}</span>${label}</div>`;
    })
    .join('');

  const badge = $('.history-summary .badge');
  badge.textContent = state.error ? '—' : view ? statusLabel(view.statusCode) : s.idleBadge;
  badge.classList.toggle('done', Boolean(view && view.delivered));
  badge.classList.toggle('warn', Boolean(state.error || (view && (view.statusCode === 'EXCEPTION' || view.statusCode === 'RETURNED'))));

  const edd = $('#edd');
  if (edd) {
    const show = Boolean(view && view.estimatedDelivery && !view.delivered);
    edd.hidden = !show;
    edd.textContent = show ? `${s.edd} · ${formatDay(view.estimatedDelivery)}` : '';
  }

  const summary = $('.history-summary p');
  if (state.error) summary.textContent = state.error.title;
  else if (view && view.demo) summary.textContent = s.historyNote;
  else if (view) summary.textContent = `${view.carrierName} · ${s.liveNote}`;
  else summary.textContent = '';
  summary.style.display = view || state.error ? '' : 'none';

  const accent = $('.panel-title .accent');
  /* “Not connected” is for a missing key; a carrier outage says what it is. */
  const disconnected = state.error && ['NEEDS_KEY', 'UNSUPPORTED'].includes(state.error.code);
  accent.textContent = view
    ? view.international ? s.international : s.domestic
    : state.error
      ? disconnected ? s.notconnected : state.error.title
      : s.idleBadge;
  accent.classList.toggle('done', Boolean(view && view.delivered));

  $('#notice-box').style.display = view && view.demo ? 'flex' : 'none';
}

function renderCountries() {
  const s = t();
  const title = document.querySelector('.route-panel h2');
  const eyebrow = document.querySelector('#route-eyebrow');
  const domestic = Boolean(state.view && !state.view.international);
  if (title) title.textContent = domestic ? s.routeDomestic : s.route;
  if (eyebrow) eyebrow.textContent = domestic ? 'DOMESTIC ROUTE' : 'ACROSS BORDERS';
  const wrap = $('#countries');
  wrap.replaceChildren();
  const view = state.view;
  if (!view || !view.countries.length) {
    wrap.style.visibility = 'hidden';
    return;
  }
  wrap.style.visibility = 'visible';

  view.countries.forEach((country, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.textContent = country.planned ? '┄┄' : '━━';
      if (country.planned) sep.className = 'muted';
      wrap.append(sep);
    }
    const node = document.createElement('div');
    if (country.planned) node.className = 'muted';
    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.textContent = country.flag;
    const code = document.createElement('b');
    code.textContent = country.code || '—';
    const city = document.createElement('small');
    city.textContent = country.city + (country.planned ? ` (${s.plannedTag})` : '');
    node.append(flag, code, city);
    wrap.append(node);
  });
}

function renderMapStatus() {
  const s = t();
  const view = state.view;
  const statusBox = $('.map-status');
  // The status strip stays in place so the three facts keep their order
  // (status → last location → last scan) whether or not a parcel is loaded.
  statusBox.classList.toggle('is-idle', !view && !state.error);
  const idleNote = $('#idle-note');
  if (idleNote) idleNote.hidden = Boolean(view || state.error || state.loading);
  if (state.error) {
    $('#location').textContent = '—';
    $('.map-status .code').textContent = '—';
  } else if (view) {
    $('#location').textContent = view.demo ? 'Leipzig, Germany' : pair(currentPoint(view));
    $('.map-status .code').textContent = view.latestCode || '—';
  } else {
    $('#location').textContent = '—';
    $('.map-status .code').textContent = '—';
  }
  $('.map-status').classList.toggle('is-error', Boolean(state.error));

  const lastTime = $('#last-time');
  if (lastTime) {
    const latest = view ? latestEvent(view) : null;
    const when = latest ? latest.timeLabel || formatTime(latest.time) : '';
    lastTime.textContent = when || (view ? s.noTime : '—');
  }

  const updated = $('#updated');
  if (state.error) {
    updated.textContent = '—';
  } else if (view) {
    /* The moment the data actually arrived. A language switch only re-formats it;
       the clock must not move just because the page was redrawn. */
    const when = formatTime(view.fetchedAt);
    updated.textContent = `${s.updated} ${when || clockNow()}${view.cached ? ` · ${s.cachedLabel}` : ''}`;
  } else {
    updated.textContent = s.notYet;
  }

  const plannedLegend = $('#legend-planned');
  plannedLegend.style.display = view && view.arcs.some((a) => a.planned) ? 'flex' : 'none';
  const legend = $('.legend');
  if (legend) legend.style.display = view ? 'flex' : 'none';
  $('#map-panel').setAttribute('aria-busy', state.loading ? 'true' : 'false');
  $('#loading').hidden = !state.loading;
  $('#search').classList.toggle('is-loading', state.loading);
  $('#search .primary').disabled = state.loading;
  $('#search .primary').textContent = state.loading ? s.loading : s.track;
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function errorFor(payload) {
  const s = t();
  const code = (payload && payload.code) || 'UPSTREAM';
  return {
    code,
    title: s.errors[code] || (isKo() ? (payload && payload.message) : '') || s.errors.UPSTREAM,
    hint: s.hints[code] || (isKo() ? (payload && payload.hint) : '') || '',
    site: payload && payload.carrier ? payload.carrier.site : '',
    /* Kept untranslated as a last resort and to re-word the box after a switch. */
    apiMessage: (payload && payload.message) || '',
    apiHint: (payload && payload.hint) || '',
    /* "Our API answered" differs from "the lookup pipeline is down". */
    apiOk: !['UPSTREAM', 'TIMEOUT', 'NETWORK', 'RATE_LIMITED'].includes(code)
  };
}

/* The API marks an error retryable when the carrier, not the number, failed. */
const TRANSIENT_CODES = ['UPSTREAM', 'TIMEOUT', 'NETWORK', 'RATE_LIMITED'];
function isTransientError(err) {
  if (!err) return false;
  if (typeof err.retryable === 'boolean') return err.retryable;
  return TRANSIENT_CODES.includes(String(err.code || ''));
}

async function lookup(number, carrier) {
  if (state.loading) return;

  // Asking again for the number already on screen: a failure must not throw that away.
  const sameNumber = Boolean(state.view && state.number && state.number === number);

  state.loading = true;
  state.refreshing = sameNumber;
  state.error = null;
  $('#marker-info').hidden = true;
  renderMapStatus();
  renderEvents();

  try {
    const res = await fetch(`${API}?number=${encodeURIComponent(number)}&carrier=${encodeURIComponent(carrier)}`, {
      headers: { accept: 'application/json' }
    });
    const payload = await res.json();

    if (!payload || payload.ok !== true) {
      const error = errorFor(payload && payload.error);
      if (sameNumber && isTransientError(payload && payload.error)) {
        // The carrier is down, not the shipment. Keep the last good result and say what happened.
        state.notice = error;
        toast(error.title);
        return;
      }
      state.error = error;
      state.notice = null;
      state.view = null;
      state.number = number;
      state.carrier = carrier === 'auto' ? 'auto' : carrier;
      toast(error.title);
      return;
    }

    state.number = payload.number || number;
    state.carrier = payload.carrier ? payload.carrier.code : carrier;
    state.view = buildDataset(payload, Boolean(payload.meta && payload.meta.demo));
    state.error = null;
    state.notice = null;
    render();
    focusRoute();
  } catch (err) {
    if (sameNumber) {
      state.notice = errorFor({ code: 'NETWORK' });
      toast(t().errors.NETWORK);
      return;
    }
    state.error = errorFor({ code: 'NETWORK' });
    state.notice = null;
    state.view = null;
    toast(t().errors.NETWORK);
  } finally {
    state.loading = false;
    state.refreshing = false;
    if (state.view) {
      $('#search .primary').disabled = false;
    }
    render();
  }
}

function submitSearch(event) {
  if (event) event.preventDefault();
  const raw = sanitizeField($('#number'));
  if (raw.length < 5) {
    toast(t().badNumber);
    return;
  }
  const number = raw.replace(/-/g, '').toUpperCase();
  const carrier = $('#carrier').value;
  lookup(number, carrier, { force: true });
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Language dropdown
 *   Nineteen native names do not fit a native <select>, so the list is a
 *   listbox panel anchored to the header button: it scrolls on its own and
 *   never leaves the viewport, on desktop or at 390px.
 * ------------------------------------------------------------------ */

const langRoot = $('#lang');
const langButton = $('#lang-button');
const langMenu = $('#lang-menu');
const langList = $('#lang-list');
let langOpen = false;
let langFocus = 0;

function buildLanguageList() {
  if (!langList) return;
  langList.replaceChildren();
  LANGS.forEach((lang) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'lang-option';
    option.dataset.lang = lang.code;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.setAttribute('lang', lang.code);
    option.dir = lang.dir || 'ltr';

    const native = document.createElement('span');
    native.className = 'lang-native';
    native.textContent = lang.native;

    const english = document.createElement('span');
    english.className = 'lang-english';
    english.textContent = lang.english;

    option.append(native, english);
    option.onclick = () => chooseLanguage(lang.code, true);
    langList.append(option);
  });
}

function updateLanguageControl(info) {
  if (langButton) {
    const current = $('#lang-current');
    if (current) {
      current.textContent = info.native;
      current.lang = info.code;
    }
    langButton.setAttribute('aria-label', `${t().langButton}: ${info.native}`);
    langButton.setAttribute('aria-expanded', langOpen ? 'true' : 'false');
  }
  if (!langList) return;
  [...langList.children].forEach((option) => {
    const on = option.dataset.lang === info.code;
    option.classList.toggle('active', on);
    option.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function openLanguages() {
  if (!langMenu || langOpen) return;
  langOpen = true;
  langMenu.hidden = false;
  if (langRoot) langRoot.classList.add('open');
  if (langButton) langButton.setAttribute('aria-expanded', 'true');
  const options = [...langList.children];
  langFocus = Math.max(0, options.findIndex((option) => option.dataset.lang === state.lang));
  const active = options[langFocus];
  if (active) {
    if (active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
    active.focus({ preventScroll: true });
  }
}

function closeLanguages(restoreFocus) {
  if (!langMenu || !langOpen) return;
  langOpen = false;
  langMenu.hidden = true;
  if (langRoot) langRoot.classList.remove('open');
  if (langButton) {
    langButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) langButton.focus();
  }
}

function moveLanguageFocus(step) {
  const options = [...langList.children];
  if (!options.length) return;
  langFocus = (langFocus + step + options.length) % options.length;
  options[langFocus].focus();
}

function chooseLanguage(code, restoreFocus) {
  closeLanguages(false);
  if (!LANG_CODES.includes(code)) return;
  const changed = code !== state.lang;
  state.lang = code;
  syncLanguageUrl();
  if (changed) render();
  else updateLanguageControl(langInfo());
  if (state.view && state.mapMode === 'flat') {
    if (flat.tipIndex >= 0) showFlatTip(flat.tipIndex);
  } else if (state.view) {
    focusPoint(Number.isFinite(state.view.latestIndex) && state.view.latestIndex >= 0 ? state.view.latestIndex : state.view.points.length - 1);
  }
  if (restoreFocus && langButton) langButton.focus();
}

if (langButton) {
  langButton.onclick = () => (langOpen ? closeLanguages(true) : openLanguages());
  langButton.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openLanguages();
    }
  };
}
if (langMenu) {
  langMenu.onclick = (e) => { if (e.target === langMenu) closeLanguages(true); };
  langMenu.onkeydown = (e) => {
    const options = [...langList.children];
    if (e.key === 'Escape') { e.preventDefault(); closeLanguages(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveLanguageFocus(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveLanguageFocus(-1); }
    else if (e.key === 'Home' && options[0]) { e.preventDefault(); options[0].focus(); }
    else if (e.key === 'End' && options.length) { e.preventDefault(); options[options.length - 1].focus(); }
  };
}
document.addEventListener('click', (e) => {
  if (langOpen && langRoot && !langRoot.contains(e.target)) closeLanguages(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && langOpen) closeLanguages(true);
});

$('#search').onsubmit = submitSearch;

/* Keep the field to A-Z a-z 0-9 while typing, pasting, or finishing an IME composition. */
const numberField = $('#number');
if (numberField) {
  numberField.addEventListener('input', (e) => {
    if (e.isComposing) return;
    sanitizeField(numberField);
  });
  numberField.addEventListener('compositionend', () => sanitizeField(numberField));
  numberField.addEventListener('paste', (e) => {
    const clip = e.clipboardData || window.clipboardData;
    const text = clip && clip.getData ? clip.getData('text') : '';
    if (!text) return;
    e.preventDefault();
    const before = numberField.value;
    const start = numberField.selectionStart == null ? before.length : numberField.selectionStart;
    const end = numberField.selectionEnd == null ? start : numberField.selectionEnd;
    const inserted = sanitizeNumber(text);
    const next = sanitizeNumber(before.slice(0, start) + inserted + before.slice(end));
    numberField.value = next;
    const pos = Math.min(start + inserted.length, next.length);
    try { numberField.setSelectionRange(pos, pos); } catch (err) { /* ignore */ }
  });
}

$('#settings').onclick = () => $('#modal').showModal();
/* “이용 안내” and “조회 안내” are links to /guide.html — they must not open the settings dialog. */
$('#refresh').onclick = () => {
  if (!state.number) { toast(t().empty); return; }
  lookup(state.number, state.carrier);
};

$('#interval').onchange = (e) => {
  state.autoRefresh = Number(e.target.value) * 1000;
  clearInterval(state.timer);
  if (state.autoRefresh > 0) {
    state.timer = setInterval(() => {
      if (!state.loading && state.number) lookup(state.number, state.carrier, { force: true });
    }, state.autoRefresh);
  }
};

$('#plus').onclick = () => {
  if (state.mapMode === 'flat') {
    zoomFlat(0.72);
    return;
  }
  if (!globe) return;
  const p = globe.pointOfView();
  globe.pointOfView({ ...p, altitude: Math.max(0.35, p.altitude * 0.75) }, 350);
};
$('#minus').onclick = () => {
  if (state.mapMode === 'flat') {
    zoomFlat(1.38);
    return;
  }
  if (!globe) return;
  const p = globe.pointOfView();
  globe.pointOfView({ ...p, altitude: Math.min(5, p.altitude * 1.3) }, 350);
};
$('#reset').onclick = () => {
  $('#marker-info').hidden = true;
  if (state.mapMode === 'flat') {
    flat.selected = -1;
    hideFlatTip();
    fitFlat();
    return;
  }
  if (!globe) return;
  globe.pointOfView({ lat: 37, lng: 67, altitude: 1.85 }, 900);
};

/* 3D ↔ 2D: both views already hold the same lookup, so this only repaints. */
const mapSwitch = $('#map-switch');
if (mapSwitch) {
  mapSwitch.onclick = (event) => {
    const target = event.target;
    const button = target && target.closest ? target.closest('[data-view]') : null;
    if (button) setMapMode(button.dataset.view);
  };
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

buildLanguageList();
initGlobe();
initFlatMap();
state.view = null;
state.number = '';
state.carrier = 'auto';
render();
if (globe) globe.pointOfView({ lat: 30, lng: 60, altitude: 1.95 }, 0);

/* Small read-only hook for the 2D view's state — used by the UI tests and by
   support when a report says “the flat map shows nothing”. */
window.WIMP_MAP = {
  get mode() { return state.mapMode; },
  get points() { return state.view ? state.view.points.length : 0; },
  get arcs() { return state.view ? state.view.arcs.length : 0; },
  get world() { return flat.shapes ? flat.shapes.length : 0; },
  get camera() { return { lon: flat.lon, lat: flat.lat, scale: flat.scale }; }
};
