'use strict';

/* WIMP — live aircraft radar for overseas parcels and flight numbers.
 *
 *   GET /api/plane?cs=KE082,KAL249          → aircraft by flight number (IATA or ICAO callsign)
 *   GET /api/plane?carrier=DHL&lat=37.4&lon=126.4
 *                                            → cargo aircraft near a point, that carrier first
 *
 * Data: adsb.lol (ODbL 1.0, https://adsb.lol). A free key can be supplied as
 * ADSB_LOL_API_KEY and is sent as x-api-key; without it the anonymous quota
 * (500 requests/day/IP) applies. adsb.fi is used only when adsb.lol answers
 * 429/5xx, because its terms allow fallback/public-interest use but not
 * commercial primary use.
 *
 * The CDN cache header (s-maxage=45) is what keeps the daily quota safe:
 * every visitor shares one upstream request per 45 seconds per query.
 */

const LOL_BASE = 'https://api.adsb.lol/v2';
const FI_BASE = 'https://opendata.adsb.fi/api';
const UPSTREAM_TIMEOUT_MS = 5500;
const MAX_DIST_NM = 250;
const MIN_DIST_NM = 10;
const MAX_CALLSIGNS = 12;
const MAX_PLANES = 8;

const DEFAULT_CENTER = { lat: 37.4602, lon: 126.4407 };

const {
  IATA_TO_ICAO,
  CARRIER_OPERATORS,
  ATTRIBUTION,
  operatorOf,
  reverseIata,
  normalizeCallsign
} = require('../lib/air-cargo.js');

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const cors = (res) => {
  if (typeof res.setHeader === 'function') {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
  }
};

function respond(res, status, body, cacheSeconds) {
  const cache = status === 200 ? `public, s-maxage=${cacheSeconds || 45}, stale-while-revalidate=120` : 'no-store';
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', cache);
    res.setHeader('x-robots-tag', 'noindex');
    res.setHeader('referrer-policy', 'no-referrer');
  }
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function fail(res, status, code, message, hint) {
  respond(res, status, { ok: false, error: { code, message, hint } });
}

function readQuery(req) {
  if (req.query && Object.keys(req.query).length) return req.query;
  try {
    return Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams);
  } catch {
    return {};
  }
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function shapeAircraft(ac) {
  const callsign = String(ac.flight || '').trim().toUpperCase();
  const onGround = ac.alt_baro === 'ground';
  const altFt = typeof ac.alt_baro === 'number' ? ac.alt_baro : typeof ac.alt_geom === 'number' ? ac.alt_geom : null;
  const operator = operatorOf(callsign);
  return {
    hex: ac.hex || null,
    callsign: callsign || null,
    iata: callsign ? reverseIata(callsign) : null,
    aircraftType: ac.t || ac.type || null,
    registration: ac.r || null,
    lat: Number.isFinite(ac.lat) ? ac.lat : null,
    lon: Number.isFinite(ac.lon) ? ac.lon : null,
    altFt,
    speedKts: Number.isFinite(ac.gs) ? Math.round(ac.gs) : null,
    heading: Number.isFinite(ac.track) ? Math.round(ac.track) : null,
    verticalRateFpm: Number.isFinite(ac.baro_rate) ? ac.baro_rate : null,
    onGround: Boolean(onGround),
    seenSec: Number.isFinite(ac.seen_pos) ? Math.round(ac.seen_pos * 10) / 10 : null,
    operator: operator ? { code: operator.code, label: operator.label } : null
  };
}

/* ------------------------------------------------------------------ *
 * Upstream
 * ------------------------------------------------------------------ */

function upstreamHeaders() {
  const headers = { accept: 'application/json' };
  const key = process.env.ADSB_LOL_API_KEY;
  if (key) headers['x-api-key'] = key;
  return headers;
}

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), redirect: 'follow' });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    json,
    retryAfter: res.headers.get('retry-after'),
    rateLimit: {
      limit: Number(res.headers.get('x-ratelimit-limit')) || null,
      remaining: Number(res.headers.get('x-ratelimit-remaining')) || null,
      resetSec: Number(res.headers.get('x-ratelimit-reset')) || null
    }
  };
}

function lolUrl(kind, args) {
  if (kind === 'callsign') return `${LOL_BASE}/callsign/${encodeURIComponent(args)}`;
  if (kind === 'hex') return `${LOL_BASE}/hex/${encodeURIComponent(args)}`;
  return `${LOL_BASE}/lat/${args.lat}/lon/${args.lon}/dist/${args.dist}`;
}

function fiUrl(kind, args) {
  if (kind === 'callsign') return `${FI_BASE}/v2/callsign/${encodeURIComponent(args)}`;
  if (kind === 'hex') return `${FI_BASE}/v2/hex/${encodeURIComponent(args)}`;
  return `${FI_BASE}/v3/lat/${args.lat}/lon/${args.lon}/dist/${args.dist}`;
}

const listOf = (json) => (json && (Array.isArray(json.ac) ? json.ac : Array.isArray(json.aircraft) ? json.aircraft : null)) || [];

/* adsb.lol first; adsb.fi only when adsb.lol is rate-limited or broken. */
async function queryAircraft(kind, args) {
  const meta = { source: null, rateLimit: null, fallbackReason: null };
  let primary = null;
  try {
    primary = await fetchJson(lolUrl(kind, args), upstreamHeaders());
    meta.rateLimit = primary.rateLimit;
  } catch (err) {
    meta.fallbackReason = 'network';
  }

  if (primary && primary.ok && primary.json) {
    meta.source = 'adsb.lol';
    return { list: listOf(primary.json), meta };
  }

  if (primary) {
    meta.fallbackReason = primary.status === 429 ? 'rate-limited' : `http-${primary.status}`;
    // A real 404/400 from adsb.lol is not worth a second provider.
    if (primary.status !== 429 && primary.status < 500) {
      return { list: [], meta: { ...meta, source: 'adsb.lol', upstreamStatus: primary.status } };
    }
  }

  try {
    const fallback = await fetchJson(fiUrl(kind, args), { accept: 'application/json' });
    if (fallback.ok && fallback.json) {
      meta.source = 'adsb.fi';
      return { list: listOf(fallback.json), meta };
    }
    meta.upstreamStatus = fallback.status;
  } catch (err) {
    meta.upstreamStatus = 'network';
  }

  const error = new Error('aircraft upstream unavailable');
  error.meta = meta;
  throw error;
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

function scorePlane(plane, wantedOperators) {
  let score = 0;
  if (plane.operator && wantedOperators.includes(plane.operator.code)) score += 100;
  if (!plane.onGround) score += 20;
  if (plane.operator) score += 5;
  if (plane.altFt && plane.altFt > 10000) score += 2;
  return score;
}

function pickPlanes(list, wantedOperators, limit) {
  const planes = list
    .map(shapeAircraft)
    .filter((p) => p.callsign && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const wanted = wantedOperators || [];
  const matched = planes.filter((p) => p.operator && wanted.includes(p.operator.code));
  const rest = planes.filter((p) => !wanted.includes(p.operator ? p.operator.code : ''));
  const byScore = (a, b) => scorePlane(b, wanted) - scorePlane(a, wanted) || (b.seenSec || 0) - (a.seenSec || 0);
  matched.sort(byScore);
  rest.sort(byScore);
  const shown = matched
    .concat(rest)
    .slice(0, limit || MAX_PLANES)
    .map((plane) => ({
      ...plane,
      matched: Boolean(plane.operator && wanted.includes(plane.operator.code))
    }));
  return { planes: shown, matchedCount: matched.length, total: planes.length };
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end('');
    return;
  }
  if (req.method && req.method !== 'GET') {
    fail(res, 405, 'METHOD_NOT_ALLOWED', 'GET만 지원합니다.');
    return;
  }

  const q = readQuery(req);
  const startedAt = Date.now();
  const csRaw = q.cs || q.callsign || q.flight;
  const carrier = String(q.carrier || '').trim().toUpperCase();
  const hex = String(q.hex || '').trim().toLowerCase();

  let kind;
  let args;
  let callsigns = [];
  let center = null;
  let wantedOperators = [];

  if (hex) {
    if (!/^[0-9a-f]{6}$/.test(hex)) {
      fail(res, 400, 'BAD_REQUEST', 'ICAO24 주소는 16진수 6자리입니다.', '예) /api/plane?hex=71c285');
      return;
    }
    kind = 'hex';
    args = hex;
  } else if (csRaw) {
    callsigns = String(csRaw)
      .split(',')
      .map((piece) => normalizeCallsign(piece))
      .filter(Boolean)
      .slice(0, MAX_CALLSIGNS);
    if (!callsigns.length) {
      fail(res, 400, 'BAD_REQUEST', '편명을 이해하지 못했습니다.', '예) /api/plane?cs=KE082 또는 /api/plane?cs=KAL249');
      return;
    }
    const hexOnly = callsigns.filter((c) => c.hex);
    if (hexOnly.length === callsigns.length) {
      kind = 'hex';
      args = hexOnly.map((c) => c.hex).join(',');
    } else {
      kind = 'callsign';
      args = callsigns.filter((c) => c.icao).map((c) => c.icao).join(',');
      if (!args) {
        fail(res, 400, 'BAD_REQUEST', '편명을 이해하지 못했습니다.', '예) /api/plane?cs=KE082 또는 /api/plane?cs=KAL249');
        return;
      }
    }
  } else {
    kind = 'point';
    const lat = num(q.lat, DEFAULT_CENTER.lat);
    const lon = num(q.lon, DEFAULT_CENTER.lon);
    const dist = Math.round(num(q.dist, MAX_DIST_NM));
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      fail(res, 400, 'BAD_REQUEST', '좌표가 범위를 벗어났습니다.', 'lat은 -90~90, lon은 -180~180입니다.');
      return;
    }
    if (dist < MIN_DIST_NM || dist > MAX_DIST_NM) {
      fail(res, 400, 'BAD_REQUEST', '반경은 10~250NM 사이여야 합니다.', 'adsb.lol은 250NM까지만 제공합니다.');
      return;
    }
    args = { lat: lat.toFixed(4), lon: lon.toFixed(4), dist };
    center = { lat, lon, distNM: dist, label: q.iata ? String(q.iata).toUpperCase().slice(0, 3) : null };
    wantedOperators = carrier ? CARRIER_OPERATORS[carrier] || [] : [];
  }

  let result;
  try {
    result = await queryAircraft(kind, args);
  } catch (err) {
    fail(
      res,
      429,
      'RATE_LIMITED',
      '실시간 항공기 데이터 제공처가 잠시 응답하지 않습니다.',
      err.meta && err.meta.fallbackReason === 'rate-limited'
        ? 'adsb.lol 무료 조회 한도(500회/일)에 도달했습니다. 잠시 후 다시 시도해 주세요.'
        : '잠시 후 다시 시도해 주세요. 위치 데이터는 약 1분 단위로 갱신됩니다.'
    );
    return;
  }

  const picked = pickPlanes(result.list, wantedOperators, MAX_PLANES);
  const looked = callsigns.filter((c) => c.icao).map((c) => ({ input: c.input, icao: c.icao, iata: c.iata }));
  const found = new Set(picked.planes.map((p) => p.callsign));
  const missing = looked.filter((c) => !found.has(c.icao)).map((c) => c.input);

  const payload = {
    ok: true,
    kind: 'planes',
    query: {
      type: kind === 'point' ? 'point' : kind,
      carrier: carrier || null,
      callsigns: looked,
      center
    },
    planes: picked.planes,
    counts: {
      shown: picked.planes.length,
      matched: picked.matchedCount,
      total: picked.total
    },
    missing,
    message:
      kind !== 'point' && picked.planes.length === 0
        ? '지금 이 편명의 항공기가 관측되지 않습니다. 지상에 있거나 레이더 범위 밖일 수 있습니다.'
        : null,
    source: result.meta.source,
    attribution: ATTRIBUTION,
    meta: {
      fetchedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      rateLimit: result.meta.rateLimit,
      fallbackReason: result.meta.fallbackReason,
      cached: false
    }
  };

  respond(res, 200, payload, 45);
}

module.exports = handler;
module.exports.handler = handler;
module.exports._internal = {
  normalizeCallsign,
  shapeAircraft,
  pickPlanes,
  reverseIata,
  operatorOf,
  readQuery,
  CARRIER_OPERATORS,
  MAX_PLANES
};
