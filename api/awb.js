'use strict';

/* WIMP — air waybill (AWB) lookup for Korean cargo airlines.
 *
 *   GET /api/awb?no=98812345675      (Asiana Cargo, prefix 988)
 *   GET /api/awb?no=180-12345675     (Korean Air Cargo, prefix 180)
 *
 * Both airlines publish a guest lookup; neither needs a key. Responses are
 * normalised to one shape. Shipper/consignee fields are never copied out of
 * the upstream payload — the output is built from an allowlist, so names,
 * addresses, phone numbers and account codes cannot leak through.
 *
 * Airline pages are cached for 5 minutes in memory and at the CDN edge; the
 * AWB serial is the only thing sent to the airline.
 */

const { airport, normalizeCallsign } = require('../lib/air-cargo.js');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const UPSTREAM_TIMEOUT_MS = 7000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map();

const AIRLINES = {
  '988': {
    prefix: '988',
    code: 'OZ',
    icao: 'AAR',
    name: '아시아나항공',
    nameEn: 'Asiana Airlines',
    cargo: '아시아나 카고',
    site: 'https://www.asianacargo.com/tracking/viewTraceAirWaybill.do'
  },
  '180': {
    prefix: '180',
    code: 'KE',
    icao: 'KAL',
    name: '대한항공',
    nameEn: 'Korean Air',
    cargo: '대한항공 카고',
    site: 'https://cargo.koreanair.com/en/tracking'
  }
};

/* IATA CIMP event codes used by Asiana / Korean Air cargo tracking. */
const EVENT_LABEL = {
  BKD: { label: '예약 접수', status: 'REGISTERED', stage: 0 },
  RCS: { label: '화물 접수', status: 'PICKED_UP', stage: 0 },
  MAN: { label: '항공기 적재', status: 'IN_TRANSIT', stage: 1 },
  DEP: { label: '출발', status: 'IN_TRANSIT', stage: 1 },
  TFD: { label: '환적', status: 'IN_TRANSIT', stage: 1 },
  SPL: { label: '분할', status: 'IN_TRANSIT', stage: 1 },
  RCF: { label: '항공편 도착', status: 'ARRIVED', stage: 2 },
  ARR: { label: '도착', status: 'ARRIVED', stage: 2 },
  NFD: { label: '도착 통지', status: 'CUSTOMS', stage: 3 },
  AWD: { label: '서류 도착', status: 'CUSTOMS', stage: 3 },
  DLV: { label: '배송 완료', status: 'DELIVERED', stage: 4 },
  DIS: { label: '보관 중', status: 'CUSTOMS', stage: 3 },
  FOH: { label: '보류', status: 'EXCEPTION', stage: -1 }
};

class AwbError extends Error {
  constructor(code, message, hint, status) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.status = status || 502;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function respond(res, status, body, cacheSeconds) {
  if (typeof res.setHeader === 'function') {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader(
      'cache-control',
      status === 200 ? `public, s-maxage=${cacheSeconds || 300}, stale-while-revalidate=600` : 'no-store'
    );
    res.setHeader('x-robots-tag', 'noindex');
    res.setHeader('referrer-policy', 'no-referrer');
  }
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

function fail(res, error) {
  respond(res, error.status || 502, {
    ok: false,
    error: { code: error.code, message: error.message, hint: error.hint }
  });
}

function readQuery(req) {
  if (req.query && Object.keys(req.query).length) return req.query;
  try {
    return Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams);
  } catch {
    return {};
  }
}

const cleanText = (value) =>
  String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();

/* AWB = 3-digit airline prefix + 8-digit serial, last of which is serial mod 7. */
function splitAwb(raw) {
  const input = String(raw || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!input) return null;
  if (!/^\d{11}$/.test(input)) return { input, digits: null };
  const prefix = input.slice(0, 3);
  const docNo = input.slice(3);
  const serial = Number(docNo.slice(0, 7));
  const checkDigit = Number(docNo.slice(7));
  return {
    input,
    digits: input,
    prefix,
    docNo,
    serial: docNo.slice(0, 7),
    checkDigitOk: Number.isFinite(serial) ? serial % 7 === checkDigit : false
  };
}

/* "2026-11-27 17:20" / "202611271720" / "27 Nov 2026 17:20" → display text + sort key.
 * Airline pages print station local time, so the label is shown as printed
 * rather than shifted into the viewer's timezone. */
const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

function parseDateText(value, opts) {
  const raw = cleanText(value);
  if (!raw) return { at: null, atLabel: '', sortKey: 0 };
  const utc = Boolean(opts && opts.utc);
  let y;
  let mo;
  let d;
  let h = '00';
  let mi = '00';

  let m = /^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?/.exec(raw);
  if (m) {
    [, y, mo, d, h, mi] = m;
  } else {
    m = /^(\d{2})[\s-]([A-Za-z]{3})[\s-](\d{4})[\sT]+(\d{1,2}):(\d{2})/.exec(raw);
    if (m) {
      d = m[1].padStart(2, '0');
      mo = MONTHS[m[2].toUpperCase()] || null;
      y = m[3];
      h = m[4].padStart(2, '0');
      mi = m[5];
      if (!mo) return { at: null, atLabel: raw, sortKey: 0 };
    }
  }
  if (!y || !mo || !d) return { at: null, atLabel: raw, sortKey: 0 };
  const iso = `${y}-${mo}-${d}T${h}:${mi}:00${utc ? 'Z' : ''}`;
  const sortKey = Date.parse(iso) || Number(`${y}${mo}${d}${h}${mi}`) || 0;
  return { at: iso, atLabel: `${y}-${mo}-${d} ${h}:${mi}`, sortKey };
}

function eventMeta(code) {
  const key = String(code || '').toUpperCase().slice(0, 3);
  return EVENT_LABEL[key] || { label: key || '상태 갱신', status: 'IN_TRANSIT', stage: 1 };
}

function place(iata, name) {
  const found = airport(iata);
  if (!found) return null;
  return {
    iata: found.iata,
    name: name ? cleanText(name) : found.city || found.iata,
    city: found.city,
    country: found.country,
    countryEn: found.countryEn,
    countryCode: found.countryCode,
    lat: found.lat,
    lng: found.lon
  };
}

/* Only ever copies fields this function names — never the whole record. */
function makeEvent({ code, message, iata, placeName, flight, pieces, weight, at, atLabel, sortKey, status, stage }) {
  const meta = eventMeta(code);
  return {
    code: String(code || '').toUpperCase().slice(0, 3),
    label: cleanText(message) || meta.label,
    detail: cleanText(message) === meta.label ? '' : cleanText(message),
    place: place(iata, placeName),
    flight: cleanText(flight) || null,
    pieces: Number.isFinite(Number(pieces)) ? Number(pieces) : null,
    weight: Number.isFinite(Number(weight)) ? Number(weight) : null,
    at: at || null,
    atLabel: atLabel || '',
    sortKey: sortKey || 0,
    status: status || meta.status,
    stage: Number.isFinite(stage) ? stage : meta.stage
  };
}

function pickStatus(events, fallback) {
  if (!events.length) return fallback;
  const delivered = events.find((e) => e.code === 'DLV');
  if (delivered) return { code: 'DELIVERED', label: '배송 완료', stage: 4, delivered: true };
  let best = null;
  for (const ev of events) {
    if (!best || ev.stage > best.stage || (ev.stage === best.stage && ev.sortKey > best.sortKey)) best = ev;
  }
  if (!best) return fallback;
  return {
    code: best.status,
    label: eventMeta(best.code).label,
    stage: best.stage >= 0 ? best.stage : 0,
    delivered: best.status === 'DELIVERED'
  };
}

const STATUS_TEXT = {
  REGISTERED: '예약 접수',
  PICKED_UP: '화물 접수',
  IN_TRANSIT: '운송 중',
  ARRIVED: '도착',
  CUSTOMS: '통관·수령 통지',
  DELIVERED: '배송 완료',
  EXCEPTION: '확인 필요',
  UNKNOWN: '확인 중'
};

/* ------------------------------------------------------------------ *
 * Asiana Cargo (988)
 * ------------------------------------------------------------------ */

async function fetchAsiana(awb) {
  const entry = 'https://www.asianacargo.com/tracking/viewTraceAirWaybill.do';
  let page;
  try {
    page = await fetch(entry, {
      headers: { 'user-agent': DESKTOP_UA, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: 'follow'
    });
  } catch {
    throw new AwbError('UPSTREAM', '아시아나 카고 조회 서버에 연결하지 못했습니다.', '잠시 후 다시 시도해 주세요.', 504);
  }
  if (!page.ok) throw new AwbError('UPSTREAM', '아시아나 카고 조회 서버가 응답하지 않습니다.', `잠시 후 다시 시도하거나 ${entry} 에서 직접 확인해 주세요.`, 502);

  const html = await page.text();
  const csrf = (/name="_csrf"\s+value="([^"]+)"/.exec(html) || [])[1] || '';
  const cookie = typeof page.headers.getSetCookie === 'function'
    ? page.headers.getSetCookie().map((c) => c.split(';')[0]).filter(Boolean).join('; ')
    : '';

  const body = new URLSearchParams({ prefix: '988', awbNumber: awb.docNo, _csrf: csrf });
  let res;
  try {
    res = await fetch('https://www.asianacargo.com/tracking/searchTraceAirWaybillResult.do', {
      method: 'POST',
      headers: {
        'user-agent': DESKTOP_UA,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json, text/javascript, */*; q=0.01',
        referer: entry,
        origin: 'https://www.asianacargo.com',
        ...(cookie ? { cookie } : {})
      },
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch {
    throw new AwbError('UPSTREAM', '아시아나 카고 조회에 시간이 걸리고 있습니다.', '잠시 후 다시 시도해 주세요.', 504);
  }
  if (res.status === 429) {
    throw new AwbError('RATE_LIMITED', '아시아나 카고가 조회를 잠시 제한했습니다.', '1분 뒤 다시 시도해 주세요.', 429);
  }
  if (!res.ok) throw new AwbError('UPSTREAM', '아시아나 카고 조회가 실패했습니다.', '잠시 후 다시 시도해 주세요.', 502);

  let json;
  try {
    json = await res.json();
  } catch {
    throw new AwbError('UPSTREAM', '아시아나 카고 응답을 읽지 못했습니다.', '잠시 후 다시 시도해 주세요.', 502);
  }
  if (!json || json.success !== true) {
    throw new AwbError('UPSTREAM', '아시아나 카고가 조회를 거절했습니다.', '잠시 후 다시 시도해 주세요.', 502);
  }
  const record = Array.isArray(json.data) ? json.data[0] : null;
  if (!record) return null;
  return normaliseAsiana(record, awb);
}

function normaliseAsiana(record, awb) {
  const s = record.shipmentSummaryVo || {};
  const events = [];

  for (const h of Array.isArray(record.trackingHistoryVoList) ? record.trackingHistoryVoList : []) {
    const code = cleanText(h.eventCode).toUpperCase();
    if (!code) continue;
    const when = parseDateText(h.eventDate) || {};
    events.push(
      makeEvent({
        code,
        message: h.eventMessage,
        iata: h.airportCode,
        flight: h.flightNumber,
        pieces: h.pieces,
        weight: h.weight,
        at: when.at,
        atLabel: when.atLabel,
        sortKey: when.sortKey
      })
    );
  }

  // Nodes carry the milestone list even when the history feed is empty.
  const nodes = Array.isArray(record.trackingNodeList) ? record.trackingNodeList : [];
  for (const node of nodes) {
    const code = cleanText(node.eventCode).toUpperCase();
    if (!code || code === 'AIRPORT') continue;
    const when = parseDateText(node.eventDate) || {};
    const time = parseDateText(node.eventTime) || {};
    events.push(
      makeEvent({
        code,
        iata: node.airportCode,
        message: node.eventDescription,
        flight: node.flightNumber,
        pieces: node.pieces,
        weight: node.weight,
        at: when.at || time.at,
        atLabel: when.atLabel || time.atLabel,
        sortKey: when.sortKey || time.sortKey
      })
    );
  }

  // The summary keeps hadled-plan/actual times for five milestones.
  const milestones = [
    ['RCS', s.rcsActualTime, s.rcsStatus],
    ['DEP', s.depActualTime, s.depStatus],
    ['ARR', s.arrActualTime, s.arrStatus],
    ['NFD', s.nfdActualTime, s.nfdStatus],
    ['DLV', s.dlvActualTime, s.dlvStatus]
  ];
  for (const [code, actual, status] of milestones) {
    const green = String(status || '').toUpperCase() === 'GREEN';
    if (!actual && !green) continue;
    if (events.some((e) => e.code === code)) continue;
    const when = parseDateText(actual) || {};
    events.push(
      makeEvent({
        code,
        iata: code === 'RCS' ? s.origin : code === 'DEP' ? s.origin : s.destination,
        at: when.at,
        atLabel: when.atLabel,
        sortKey: when.sortKey
      })
    );
  }

  events.sort((a, b) => a.sortKey - b.sortKey);

  const flights = [];
  const pushFlight = (no, from, to, dateText) => {
    const number = cleanText(no).toUpperCase().replace(/\s+/g, '');
    if (!number) return;
    if (flights.some((f) => f.no === number && f.from === from && f.to === to)) return;
    const when = parseDateText(dateText) || {};
    flights.push({
      no: number,
      from: cleanText(from).toUpperCase() || null,
      to: cleanText(to).toUpperCase() || null,
      date: when.atLabel || null,
      live: Boolean(normalizeCallsign(number))
    });
  };
  for (const f of Array.isArray(record.fetchFlightDetailsList) ? record.fetchFlightDetailsList : []) {
    pushFlight(f.flightNumber, f.segmentOrigin, f.segmentDestination, f.flightDate);
  }
  for (const b of Array.isArray(record.bookingsVoList) ? record.bookingsVoList : []) {
    pushFlight(b.flightNumber, b.segmentOrigin, b.segmentDestination, b.departureTime);
  }

  const routeCodes = Array.isArray(record.sortedAirportList) && record.sortedAirportList.length
    ? record.sortedAirportList
    : [s.origin, s.destination];
  const route = [];
  for (const code of routeCodes) {
    const stop = place(code);
    if (stop && !route.some((r) => r.iata === stop.iata)) route.push(stop);
  }
  for (const ev of events) {
    if (ev.place && ev.place.lat != null && !route.some((r) => r.iata === ev.place.iata)) route.push(ev.place);
  }

  const status = pickStatus(events, { code: 'REGISTERED', label: STATUS_TEXT.REGISTERED, stage: 0, delivered: false });

  return {
    number: cleanText(record.awbNumber) || awb.prefix + awb.docNo,
    prefix: awb.prefix,
    airline: AIRLINES[awb.prefix],
    origin: place(s.origin, s.originName),
    destination: place(s.destination, s.destinationName),
    pieces: Number.isFinite(Number(s.statedPieces)) ? Number(s.statedPieces) : null,
    weight: Number.isFinite(Number(s.statedWeight)) ? Number(s.statedWeight) : null,
    weightUnit: 'KG',
    commodity: null,
    status: { ...status, label: STATUS_TEXT[status.code] || status.label },
    events,
    flights,
    route,
    liveCallsigns: flights.filter((f) => f.live).map((f) => f.no).slice(0, 6),
    source: 'asiana'
  };
}

/* ------------------------------------------------------------------ *
 * Korean Air Cargo (180)
 * ------------------------------------------------------------------ */

let keSession = null; // { cookies, sid, region, expires }

async function koreanAirSession() {
  if (keSession && keSession.expires > Date.now()) return keSession;
  const entry = 'https://cargo.koreanair.com/en/tracking';
  const res = await fetch(entry, {
    headers: { 'user-agent': DESKTOP_UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    redirect: 'follow'
  });
  if (!res.ok) throw new AwbError('UPSTREAM', '대한항공 카고 조회 서버가 응답하지 않습니다.', '잠시 후 다시 시도해 주세요.', 502);
  const html = await res.text();
  const sid = (/"session_id":"([^"]+)"/.exec(html) || [])[1];
  const region = (/"region":"([^"]+)"/.exec(html) || [])[1] || 'America';
  if (!sid) throw new AwbError('AIRLINE_BLOCKED', '대한항공 카고 세션을 열지 못했습니다.', '대한항공은 자동 조회를 막는 경우가 있습니다. cargo.koreanair.com 에서 직접 조회해 주세요.', 502);
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie().map((c) => c.split(';')[0]).filter(Boolean).join('; ')
    : '';
  keSession = { cookies, sid, region, expires: Date.now() + 4 * 60 * 1000 };
  return keSession;
}

function keTime() {
  // Korean Air expects "28 Nov 2026 02:45" (KST, zero-padded like its own UI).
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    })
      .format(new Date())
      .replace(/,/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    const d = new Date();
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
  }
}

async function fetchKoreanAir(awb) {
  const session = await koreanAirSession();
  const body = (sessionId) =>
    JSON.stringify({
      payLoad: [{ awbPrefix: '180', awbDocNo: awb.docNo }],
      generalInfo: { sessionId, lang: 'EN', time: keTime(), txnId: Math.random().toString(36).slice(2, 11) + Date.now() },
      userInfo: { userId: '', agentCode: '', region: session.region, branch: '', userType: 'GUEST' }
    });

  const post = async (sessionId) => {
    const res = await fetch('https://cargo.koreanair.com/cargoportal/services/trackawb', {
      method: 'POST',
      headers: {
        'user-agent': DESKTOP_UA,
        'content-type': 'application/json; charset=utf-8',
        accept: 'application/json, text/plain, */*',
        referer: 'https://cargo.koreanair.com/en/tracking',
        origin: 'https://cargo.koreanair.com',
        ...(session.cookies ? { cookie: session.cookies } : {})
      },
      body: body(sessionId),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  let reply;
  try {
    reply = await post(session.sid);
    // The first call bootstraps the guest session; one retry with the returned id.
    const firstCode = reply.json && reply.json.messages && reply.json.messages[0] && reply.json.messages[0].code;
    if (firstCode === 'ESC401' && reply.json.generalInfo && reply.json.generalInfo.sessionId) {
      reply = await post(reply.json.generalInfo.sessionId);
    }
  } catch {
    keSession = null;
    throw new AwbError('UPSTREAM', '대한항공 카고 조회에 연결하지 못했습니다.', '잠시 후 다시 시도해 주세요.', 504);
  }

  if (!reply.json) {
    keSession = null;
    throw new AwbError('AIRLINE_BLOCKED', '대한항공 카고가 자동 조회를 차단했습니다.', '대한항공은 서버 자동 조회에 세션 확인을 요구합니다. cargo.koreanair.com 에서 AWB를 직접 조회하거나 아시아나(988)·편명 조회를 이용해 주세요.', 503);
  }

  const blockCode = reply.json.messages && reply.json.messages[0] && reply.json.messages[0].code;
  if (blockCode === 'ESC401' || blockCode === 'ESC403') {
    keSession = null;
    throw new AwbError('AIRLINE_BLOCKED', '대한항공 카고 세션이 열리지 않았습니다.', '대한항공은 자동 조회에 세션 확인을 요구합니다. cargo.koreanair.com 에서 AWB를 직접 조회하거나 아시아나(988)·편명 조회를 이용해 주세요.', 503);
  }
  if (blockCode) {
    throw new AwbError('UPSTREAM', cleanText(reply.json.messages[0].text) || '대한항공 카고 조회가 거절되었습니다.', '잠시 후 다시 시도해 주세요.', 502);
  }

  const item = reply.json.payLoad && reply.json.payLoad[0];
  if (!item) return null;
  const booking = Array.isArray(item.bookingMessages) ? item.bookingMessages : [];
  const noData = booking.find((m) => m && (m.code === 'EET600' || /no tracking data/i.test(String(m.text || ''))));
  if (noData) return null;
  return normaliseKoreanAir(item, awb);
}

function normaliseKoreanAir(item, awb) {
  const events = [];
  const list = Array.isArray(item.eventDetails) ? item.eventDetails : [];
  for (const e of list) {
    const code = cleanText(e.eventCode || e.event || e.status).toUpperCase();
    const when = parseDateText(e.eventDate || e.eventDateTime || e.eventTime) || {};
    events.push(
      makeEvent({
        code,
        message: e.eventDescription || e.eventName || e.description,
        iata: e.airportCode || e.station || e.airport,
        flight: e.flightNo || e.fltNo,
        pieces: e.pieces,
        weight: e.weight,
        at: when.at,
        atLabel: when.atLabel,
        sortKey: when.sortKey
      })
    );
  }
  events.sort((a, b) => a.sortKey - b.sortKey);

  const flights = [];
  for (const f of Array.isArray(item.fltDetails) ? item.fltDetails : []) {
    const no = cleanText(f.fltNo || f.flightNo).toUpperCase().replace(/\s+/g, '');
    if (!no) continue;
    flights.push({
      no,
      from: cleanText(f.departure || f.depStn || f.origin).toUpperCase() || null,
      to: cleanText(f.arrival || f.arrStn || f.destination).toUpperCase() || null,
      date: cleanText(f.departureDate || f.fltDate) || null,
      aircraft: cleanText(f.carType) || null,
      live: Boolean(normalizeCallsign(no))
    });
  }

  const routeCodes = Array.isArray(item.routes) ? item.routes.map((r) => cleanText(r).slice(0, 3)) : [];
  const route = [];
  for (const code of routeCodes) {
    const stop = place(code);
    if (stop && !route.some((r) => r.iata === stop.iata)) route.push(stop);
  }

  const status = pickStatus(events, { code: 'UNKNOWN', label: STATUS_TEXT.UNKNOWN, stage: 0, delivered: false });
  return {
    number: `${item.awbPrefix || '180'}${item.awbDocNo || awb.docNo}`,
    prefix: '180',
    airline: AIRLINES['180'],
    origin: route[0] || null,
    destination: route[route.length - 1] || null,
    pieces: null,
    weight: null,
    weightUnit: 'KG',
    commodity: null,
    status: { ...status, label: STATUS_TEXT[status.code] || status.label },
    events,
    flights,
    route,
    liveCallsigns: flights.filter((f) => f.live).map((f) => f.no).slice(0, 6),
    source: 'koreanair'
  };
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    if (typeof res.setHeader === 'function') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    }
    res.end('');
    return;
  }
  if (req.method && req.method !== 'GET') {
    fail(res, new AwbError('METHOD_NOT_ALLOWED', 'GET만 지원합니다.', null, 405));
    return;
  }

  const q = readQuery(req);
  const startedAt = Date.now();
  const raw = q.no || q.awb || q.number || q.n;
  const awb = splitAwb(raw);

  if (!awb || !awb.input) {
    fail(res, new AwbError('BAD_REQUEST', 'AWB 번호를 입력해 주세요.', '예) /api/awb?no=988-12345675', 400));
    return;
  }

  if (/^[A-Z]{2,3}\d{1,4}$/.test(awb.input)) {
    fail(
      res,
      new AwbError('IS_FLIGHT', '이 값은 AWB가 아니라 편명입니다.', `편명은 /api/plane?cs=${awb.input} 로 조회합니다. 화물 AWB는 988-12345675처럼 11자리입니다.`, 400)
    );
    return;
  }

  if (!awb.digits) {
    fail(
      res,
      new AwbError('BAD_REQUEST', 'AWB는 11자리 숫자입니다.', '예) 아시아나 988-12345675, 대한항공 180-12345675. 하이픈은 있어도 됩니다.', 400)
    );
    return;
  }

  const airline = AIRLINES[awb.prefix];
  if (!airline) {
    fail(
      res,
      new AwbError(
        'AWB_UNSUPPORTED',
        `${awb.prefix}로 시작하는 AWB는 아직 지원하지 않습니다.`,
        '지금은 아시아나(988)와 대한항공(180) 화물 AWB만 조회됩니다. 다른 항공사는 화주·포워더에게 문의해 주세요.',
        501
      )
    );
    return;
  }

  const cacheKey = `${awb.prefix}:${awb.docNo}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    respond(res, 200, { ...hit.payload, meta: { ...hit.payload.meta, cached: true, elapsedMs: Date.now() - startedAt } });
    return;
  }

  try {
    const found = awb.prefix === '988' ? await fetchAsiana(awb) : await fetchKoreanAir(awb);
    if (!found) {
      respond(res, 404, {
        ok: false,
        error: {
          code: 'AWB_NOT_FOUND',
          message: `${airline.name}에서 이 AWB의 운송 정보를 찾지 못했습니다.`,
          hint: awb.checkDigitOk
            ? 'AWB 번호를 다시 확인하거나, 화물이 아직 접수되지 않았을 수 있습니다. 화주·포워더에게 문의해 주세요.'
            : '마지막 자리는 체크디지트입니다. 앞 7자리 숫자를 7로 나눈 나머지와 일치해야 하니 번호를 다시 확인해 주세요.',
          airline: { code: airline.code, name: airline.name, site: airline.site }
        },
        meta: {
          source: found ? found.source : awb.prefix === '988' ? 'asiana' : 'koreanair',
          prefix: awb.prefix,
          checkDigitOk: awb.checkDigitOk,
          fetchedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt
        }
      });
      return;
    }

    const payload = {
      ok: true,
      kind: 'awb',
      awb: { ...found, airline },
      meta: {
        source: found.source,
        prefix: awb.prefix,
        cached: false,
        checkDigitOk: awb.checkDigitOk,
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        piiRemoved: true,
        timeZone: 'station-local'
      }
    };
    cache.set(cacheKey, { payload, expires: Date.now() + CACHE_TTL_MS });
    if (cache.size > CACHE_MAX) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    respond(res, 200, payload);
  } catch (err) {
    if (err instanceof AwbError) {
      fail(res, err);
      return;
    }
    fail(res, new AwbError('UPSTREAM', '화물 조회 중 문제가 생겼습니다.', '잠시 후 다시 시도해 주세요.', 502));
  }
}

module.exports = handler;
module.exports.handler = handler;
module.exports._internal = {
  splitAwb,
  parseDateText,
  normaliseAsiana,
  normaliseKoreanAir,
  eventMeta,
  AIRLINES,
  EVENT_LABEL,
  cache
};
