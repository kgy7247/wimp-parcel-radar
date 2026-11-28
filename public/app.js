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
  view: null,
  loading: false,
  error: null,
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

function buildDataset(api, demo) {
  const events = (api.events || []).map((ev) => ({
    time: ev.time,
    title: ev.description || ev.scan || statusLabel(ev.status && ev.status.code),
    note: ev.scan || '',
    statusCode: (ev.status && ev.status.code) || 'UNKNOWN',
    location: ev.location || null
  }));

  const points = [];
  for (const ev of events) {
    const loc = ev.location;
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) {
      ev.point = points.length ? points.length - 1 : -1;
      continue;
    }
    const last = points[points.length - 1];
    if (last && Math.abs(last.lat - loc.lat) < 0.01 && Math.abs(last.lng - loc.lng) < 0.01) {
      last.lastEvent = ev;
      ev.point = points.length - 1;
      continue;
    }
    points.push({
      lat: loc.lat, lng: loc.lng,
      name: loc.city || loc.name,
      detail: loc.name,
      code: loc.code || '',
      country: loc.country || '',
      countryEn: loc.countryEn || '',
      countryCode: loc.countryCode || '',
      firstEvent: ev,
      lastEvent: ev
    });
    ev.point = points.length - 1;
  }

  points.forEach((p, i) => { p.active = i === points.length - 1; });
  // Labels: first stop, last stop, and every country change. Points crowded together become dots.
  points.forEach((p, i) => {
    const isFirst = i === 0;
    const isLast = i === points.length - 1;
    const sameCountryAsPrev = i > 0 && points[i - 1].countryCode === p.countryCode;
    const crowded = points.some((q, j) => j > i && Math.abs(q.lat - p.lat) < 0.35 && Math.abs(q.lng - p.lng) < 0.35);
    p.hideLabel = !isFirst && !isLast && (sameCountryAsPrev || crowded);
  });

  const arcs = [];
  for (let i = 1; i < points.length; i += 1) {
    arcs.push({
      startLat: points[i - 1].lat, startLng: points[i - 1].lng,
      endLat: points[i].lat, endLng: points[i].lng,
      planned: Boolean(demo && i === points.length - 1)
    });
  }

  const ordered = events.filter((e) => e.time).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const latestEvent = ordered[ordered.length - 1] || events[events.length - 1] || null;
  const latestPoint = points[points.length - 1] || null;

  const countries = [];
  for (const p of points) {
    const last = countries[countries.length - 1];
    if (!last || last.code !== p.countryCode) {
      countries.push({
        code: p.countryCode, flag: flagOf(p.countryCode), city: p.name,
        planned: Boolean(demo && p === latestPoint && countries.length > 0)
      });
    }
  }

  const statusCode = api.status ? api.status.code : (latestEvent ? latestEvent.statusCode : 'UNKNOWN');
  const stage = api.status ? api.status.stage : 0;

  // The last country chip shows where the parcel is now, not where it entered the country.
  if (points.length && countries.length) countries[countries.length - 1].city = points[points.length - 1].name;

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
  const last = usable[usable.length - 1];
  if (!last) return;
  const info = $('#marker-info');
  if (info) {
    const event = last.lastEvent || last.firstEvent;
    info.hidden = false;
    info.textContent = event ? `${pair(last)} · ${event.note || event.title}` : pair(last);
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
        el.textContent = d.hideLabel ? '' : '• ' + d.name + (d.pending ? ' ○' : '');
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
  // dot on top of the name and smear the text.
  const labels = [];
  const seen = new Map();
  view.points.forEach((p, i) => {
    // A point without both coordinates would put the camera at NaN; skip it instead.
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
    const pending = Boolean(view.demo && i === view.points.length - 1 && view.points.length > 1);
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    const earlier = seen.get(key);
    if (earlier) {
      earlier.index = i; // the newest scan at this stop answers a tap
      earlier.active = Boolean(p.active) || earlier.active;
      earlier.pending = pending;
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
    p.hideLabel = !(i === 0 || i === labels.length - 1) && (sameCountryAsPrev || crowded);
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
  info.hidden = false;
  info.textContent = `${pair(point)} · ${event ? (event.note || event.title) : ''}`;
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
  renderEvents();
  renderSteps();
  renderCountries();
  renderMapStatus();
  renderGlobe(state.view);
}

function renderParcels() {
  const s = t();
  const box = $('#parcels');
  box.replaceChildren();

  if (!state.view && !state.error) {
    box.style.display = 'none';
    $('#count').textContent = '0';
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
    const count = `${state.view.events.length}${joinsCount() ? ' ' : ''}${s.events}`;
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
  $('#count').textContent = String(events);
}

function renderEvents() {
  const s = t();
  const box = $('#events');
  box.replaceChildren();

  if (state.loading) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.textContent = s.loading;
    box.append(note);
    return;
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
    meta.textContent = [when, where].filter(Boolean).join(' · ') || (state.view.demo ? '' : s.liveNote);

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
  accent.textContent = view
    ? view.international ? s.international : s.domestic
    : state.error
      ? state.error.apiOk ? state.error.title : s.notconnected
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
    $('#location').textContent = view.demo ? 'Leipzig, Germany' : pair(view.points[view.points.length - 1]);
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
    updated.textContent = `${s.updated} ${clockNow()}${view.cached ? ` · ${s.cachedLabel}` : ''}`;
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

async function lookup(number, carrier) {
  if (state.loading) return;

  state.loading = true;
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
      state.error = error;
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
    render();
    frameRoute();
  } catch (err) {
    state.error = errorFor({ code: 'NETWORK' });
    state.view = null;
    toast(t().errors.NETWORK);
  } finally {
    state.loading = false;
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
  if (state.view) focusPoint(state.view.points.length - 1);
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
  if (!globe) return;
  const p = globe.pointOfView();
  globe.pointOfView({ ...p, altitude: Math.max(0.35, p.altitude * 0.75) }, 350);
};
$('#minus').onclick = () => {
  if (!globe) return;
  const p = globe.pointOfView();
  globe.pointOfView({ ...p, altitude: Math.min(5, p.altitude * 1.3) }, 350);
};
$('#reset').onclick = () => {
  if (!globe) return;
  globe.pointOfView({ lat: 37, lng: 67, altitude: 1.85 }, 900);
  $('#marker-info').hidden = true;
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

buildLanguageList();
initGlobe();
state.view = null;
state.number = '';
state.carrier = 'auto';
render();
if (globe) globe.pointOfView({ lat: 30, lng: 60, altitude: 1.95 }, 0);
