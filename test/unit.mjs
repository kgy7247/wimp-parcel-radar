/**
 * Unit test — no network. Every upstream response is replaced by a fixture.
 * Usage: node test/unit.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handler = require('../api/track.js');
const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const realFetch = globalThis.fetch;
let calls = [];
let routes = {};

function stub(list) {
  calls = [];
  routes = list;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: (init && init.method) || 'GET' });
    for (const [pattern, make] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        const body = typeof make === 'function' ? make(url, init) : make;
        if (body && body.__status) {
          return {
            ok: body.__status < 400,
            status: body.__status,
            headers: new Headers(),
            text: async () => body.body,
            json: async () => JSON.parse(body.body),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
          json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        };
      }
    }
    throw new Error('unstubbed fetch: ' + url);
  };
}

function call(number, carrier = 'auto') {
  const req = { method: 'GET', url: `/api/track?number=${number}&carrier=${carrier}`, query: { number, carrier } };
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(body) {
        resolve({ status: this.statusCode, body: JSON.parse(body), headers: this.headers });
      },
    };
    handler(req, res);
  });
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log('  PASS  ' + name);
  } catch (err) {
    results.push([false, name, err]);
    console.log('  FAIL  ' + name + '\n        ' + (err && err.message));
  }
}

const CJ_MAIN = '<html><form><input type="hidden" name="_csrf" value="0f0e0d0c-1111-2222-3333-444455556666"></form></html>';
const cjJson = fixture('cj-1234567890.json');

/* lastscanned response shape (documented at work/wimp911/lastscanned_api.md). */
function lastscannedJson(overrides = {}) {
  return {
    carrier: 'ups',
    trackingNumber: '1Z000Y770414233027',
    status: 'delivered',
    statusDescription: 'Delivered',
    service: 'UPS Express Saver®',
    deliveredAt: '2026-07-31T12:55:04Z',
    deliveredAtLocal: '2026-07-31T14:55:00',
    signedBy: 'EMSO',
    destination: { city: 'Ditzingen', state: '', country: 'DE' },
    estimatedDelivery: '2026-08-07',
    estimatedDeliveryAt: null,
    message: null,
    events: [
      { timestamp: '2026-07-31T12:55:04Z', localTime: '2026-07-31T14:55:00', status: 'delivered', description: 'DELIVERED', location: 'DITZINGEN, DE', code: 'KB' },
      { timestamp: '2026-07-31T08:10:00Z', localTime: '2026-07-31T10:10:00', status: 'out_for_delivery', description: 'OUT FOR DELIVERY', location: 'STUTTGART, DE', code: 'OT' },
      { timestamp: '2026-07-30T21:40:00Z', localTime: '2026-07-30T23:40:00', status: 'in_transit', description: 'ARRIVAL SCAN', location: 'KOELN, DE', code: 'AR' },
      { timestamp: '2026-07-29T09:00:00Z', localTime: '2026-07-29T11:00:00', status: 'label_created', description: 'LABEL CREATED', location: 'KOELN, DE', code: 'MP' },
    ],
    ...overrides,
  };
}

function withLastscannedKey(fn) {
  const previous = process.env.LASTSCANNED_API_KEY;
  process.env.LASTSCANNED_API_KEY = 'lsk_test_key';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.LASTSCANNED_API_KEY;
      else process.env.LASTSCANNED_API_KEY = previous;
    });
}

function dhlJson() {
  return {
    shipments: [
      {
        id: '1234567896',
        service: 'express',
        status: { timestamp: '2026-11-27T08:00:00+09:00', location: { address: { addressLocality: 'Leipzig', countryCode: 'DE' } }, statusCode: 'transit', status: 'Processed at LEIPZIG' },
        events: [
          {
            timestamp: '2026-11-25T22:10:00+09:00',
            location: { address: { addressLocality: 'Sofia', countryCode: 'BG' } },
            statusCode: 'pre-transit',
            status: 'Shipment information received',
          },
          {
            timestamp: '2026-11-26T18:40:00+09:00',
            location: { address: { addressLocality: 'Leipzig', countryCode: 'DE' } },
            statusCode: 'transit',
            status: 'Processed at LEIPZIG - HUB',
          },
          {
            timestamp: '2026-11-27T07:20:00+09:00',
            location: { address: { addressLocality: 'Leipzig', countryCode: 'DE' } },
            statusCode: 'delivery',
            status: 'Out for delivery',
          },
        ],
      },
    ],
  };
}

console.log('\nWIMP api/track.js — unit tests\n');

await test('CJ: csrf handshake then JSON history, phones masked, newest scan wins', async () => {
  stub({
    'cjlogistics.com/ko/tool/parcel/tracking-detail': cjJson,
    'cjlogistics.com/ko/tool/parcel/tracking': CJ_MAIN,
  });
  const out = await call('1234567890', 'CJ');
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.carrier.code, 'CJ');
  assert.equal(out.body.events.length, 6);
  // 2026-11-21 12:42 배송출발 is newer than the 10:25 배송완료 scan before it.
  assert.equal(out.body.status.code, 'OUT_FOR_DELIVERY');
  assert.equal(out.body.status.delivered, false);
  assert.equal(out.body.status.stage, 3);
  assert.equal(out.body.latest.scan, '배송출발');
  assert.ok(out.body.route.length >= 4, 'route points');
  assert.deepEqual(out.body.countries, ['KR']);
  const blob = JSON.stringify(out.body);
  assert.ok(!/010-1234-5678/.test(blob), 'driver phone number must be masked');
  assert.ok(blob.includes('010-****-****'), 'masked phone marker present');
  assert.equal(calls[0].method, 'GET');
  assert.ok(calls[1].url.includes('_csrf='), 'csrf forwarded to the detail call');
});

await test('CJ: 15-minute cache prevents a second upstream call', async () => {
  const before = calls.length;
  const out = await call('1234567890', 'CJ');
  assert.equal(out.status, 200);
  assert.equal(out.body.meta.cached, true);
  assert.equal(calls.length, before, 'no new upstream request');
});

await test('EPOST: HTML progress table parsed, hub geocoded from the built-in table', async () => {
  stub({
    'trace.RetrieveDomRigiTraceList.comm': fixture('epost-1234567890123.html'),
  });
  const out = await call('1234567890123', 'EPOST');
  assert.equal(out.status, 200);
  assert.equal(out.body.events.length, 7); // 9 rows, two duplicated scans collapsed
  const first = out.body.events[0];
  assert.equal(first.scan, '배달준비');
  assert.equal(first.location.name, '제주우편집중국');
  assert.equal(first.location.city, '제주');
  assert.ok(Math.abs(first.location.lat - 33.4996) < 0.01);
  assert.ok(!/TEL/.test(first.location.name), 'phone block stripped from location');
  assert.ok(out.body.status.code === 'DELIVERED' || out.body.status.code === 'IN_TRANSIT');
});

await test('EPOST: empty table yields a clean NOT_FOUND', async () => {
  stub({ 'trace.RetrieveDomRigiTraceList.comm': fixture('epost-empty.html') });
  const out = await call('9999999999999', 'EPOST');
  assert.equal(out.status, 404);
  assert.equal(out.body.error.code, 'NOT_FOUND');
  assert.ok(out.body.error.message.length > 0);
});

await test('LOTTE: live-style cancelled waybill is reported, not invented', async () => {
  stub({ 'lotteglogis.com/mobile/reservation/tracking/linkView': fixture('lotte-123456789013.html') });
  const out = await call('123456789013', 'LOTTE');
  assert.equal(out.status, 404);
  assert.equal(out.body.error.code, 'NOT_FOUND');
  assert.ok(out.body.error.message.includes('취소'));
});

await test('LOTTE: event rows parsed and mapped to stages', async () => {
  stub({ 'lotteglogis.com/mobile/reservation/tracking/linkView': fixture('lotte-synthetic.html') });
  const out = await call('123456789014', 'LOTTE');
  assert.equal(out.status, 200);
  assert.equal(out.body.events.length, 4);
  assert.equal(out.body.events[0].scan, '집하완료');
  assert.equal(out.body.events[0].status.code, 'PICKED_UP');
  assert.equal(out.body.status.code, 'DELIVERED');
  assert.ok(out.body.route.length >= 3);
});

await test('HANJIN: not-registered page yields NOT_FOUND', async () => {
  stub({ 'hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do': fixture('hanjin-notfound.html') });
  const out = await call('555555555554', 'HANJIN');
  assert.equal(out.status, 404);
  assert.equal(out.body.error.code, 'NOT_FOUND');
});

await test('HANJIN: two-table layout parsed (synthetic fixture)', async () => {
  stub({ 'hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do': fixture('hanjin-synthetic.html') });
  const out = await call('123456789013', 'HANJIN');
  assert.equal(out.status, 200);
  assert.equal(out.body.events.length, 4);
  assert.equal(out.body.events.at(-1).scan, '배송완료');
  assert.equal(out.body.status.code, 'DELIVERED');
});

await test('DHL: without DHL_API_KEY the key requirement is explained', async () => {
  stub({});
  delete process.env.DHL_API_KEY;
  const out = await call('1234567895', 'DHL');
  assert.equal(out.status, 501);
  assert.equal(out.body.error.code, 'NEEDS_KEY');
  assert.ok(out.body.error.message.includes('DHL_API_KEY'));
});

await test('DHL: API key path normalises events and stages', async () => {
  stub({ 'api-eu.dhl.com/track/shipments': dhlJson() });
  process.env.DHL_API_KEY = 'test-key-123';
  const out = await call('1234567896', 'DHL');
  delete process.env.DHL_API_KEY;
  assert.equal(out.status, 200);
  assert.equal(out.body.events.length, 3);
  assert.equal(out.body.status.code, 'OUT_FOR_DELIVERY');
  // "Shipment information received" at Sofia is a pre-advice, not a stop.
  assert.equal(out.body.events[0].physical, false);
  assert.deepEqual(out.body.countries, ['DE']);
  assert.ok(out.body.route.every((p) => p.countryCode === 'DE'), 'only Leipzig is a route node');
  assert.ok(calls[0].url.includes('trackingNumber=1234567896'));
});

/* The reported itinerary: DHL opens the customs file at Incheon before the
   parcel leaves Sofia, and the feed lands BG → KR → BG → DE → KR → DE. */
function dhlPreclearanceJson() {
  const place = (locality, countryCode) => ({ location: { address: { addressLocality: locality, countryCode } } });
  return {
    shipments: [
      {
        id: '2746217154',
        status: { timestamp: '2026-11-28T08:05:00+09:00', ...place('Leipzig', 'DE'), statusCode: 'transit', status: 'Departed from LEIPZIG - GERMANY' },
        events: [
          { timestamp: '2026-11-26T05:10:00+09:00', ...place('INCHEON OUTSKIRT OF SEOUL', 'KR'), statusCode: 'transit', status: 'Customs clearance status updated. Note - The Customs clearance process may start in the destination country' },
          { timestamp: '2026-11-26T22:57:00+09:00', ...place('Sofia', 'BG'), statusCode: 'transit', status: 'Shipment picked up' },
          { timestamp: '2026-11-27T03:26:00+09:00', ...place('INCHEON OUTSKIRT OF SEOUL', 'KR'), statusCode: 'transit', status: 'Customs clearance status updated. Note - The Customs clearance process may start in the destination country' },
          { timestamp: '2026-11-27T18:40:00+09:00', ...place('Leipzig', 'DE'), statusCode: 'transit', status: 'Processed at LEIPZIG - GERMANY' },
          { timestamp: '2026-11-28T00:10:00+09:00', ...place('Leipzig', 'DE'), statusCode: 'transit', status: 'Processed at LEIPZIG - GERMANY' },
          { timestamp: '2026-11-28T06:30:00+09:00', ...place('INCHEON OUTSKIRT OF SEOUL', 'KR'), statusCode: 'transit', status: 'Customs clearance status updated - INCHEON' },
          { timestamp: '2026-11-28T08:05:00+09:00', ...place('Leipzig', 'DE'), statusCode: 'transit', status: 'Departed from LEIPZIG - GERMANY' },
        ],
      },
    ],
  };
}

await test('DHL: a destination customs notice never becomes a stop (BG → DE, not BG → KR → …)', async () => {
  stub({ 'api-eu.dhl.com/track/shipments': dhlPreclearanceJson() });
  process.env.DHL_API_KEY = 'test-key-123';
  const out = await call('2746217154', 'DHL');
  delete process.env.DHL_API_KEY;
  assert.equal(out.status, 200);
  assert.equal(out.body.events.length, 7, 'every scan stays in the history');
  assert.deepEqual(out.body.events.map((e) => e.physical), [false, true, false, true, true, false, true]);
  assert.deepEqual(out.body.countries, ['BG', 'DE']);
  assert.deepEqual(out.body.route.map((p) => p.countryCode), ['BG', 'DE'], 'Sofia then Leipzig only');
  assert.equal(out.body.route.at(-1).name, 'Leipzig');
  assert.equal(out.body.route.at(-1).active, true);
});

await test('route: repeated scans at one city become one marker with a count', async () => {
  stub({ 'api-eu.dhl.com/track/shipments': dhlPreclearanceJson() });
  process.env.DHL_API_KEY = 'test-key-123';
  const out = await call('2746217155', 'DHL');
  delete process.env.DHL_API_KEY;
  const leipzig = out.body.route.find((p) => p.name === 'Leipzig');
  assert.equal(leipzig.count, 3, 'three Leipzig scans, one marker');
  assert.equal(out.body.route.filter((p) => p.name === 'Leipzig').length, 1);
  assert.match(leipzig.lastEvent.scan, /Departed from LEIPZIG/, 'the marker carries the newest scan there');
});

await test('route: a non-adjacent repeat keeps its arcs but stays one marker', async () => {
  const { routeModel, routeCountries } = handler._internal;
  const at = (city, cc, lat, lng) => ({ name: city, city, countryCode: cc, country: '', countryEn: '', lat, lng });
  const ev = (city, cc, lat, lng, scan, time) => ({ time, scan, description: scan, status: { code: 'IN_TRANSIT', label: '', stage: 2 }, location: at(city, cc, lat, lng) });
  const { points, visits } = routeModel([
    ev('Seoul', 'KR', 37.55, 126.99, 'Arrived at SEOUL', '2026-01-01T01:00:00+09:00'),
    ev('Busan', 'KR', 35.10, 129.04, 'Departed from BUSAN', '2026-01-01T02:00:00+09:00'),
    ev('Seoul', 'KR', 37.55, 126.99, 'Returned to SEOUL', '2026-01-01T03:00:00+09:00'),
  ]);
  assert.equal(points.length, 2, 'two markers');
  assert.deepEqual(visits, [0, 1, 0], 'three visits, so both legs stay');
  assert.equal(points[0].count, 2);
  assert.equal(points[0].active, true, 'the latest visit is Seoul');
  assert.deepEqual(routeCountries(points, visits), ['KR']);
});

await test('route: a customs scan sandwiched between one country is dropped even without known wording', async () => {
  const { routeModel } = handler._internal;
  const ev = (city, cc, lat, lng, scan, time) => ({ time, scan, description: scan, status: { code: 'IN_TRANSIT', label: '', stage: 2 }, location: { name: city, city, countryCode: cc, country: '', countryEn: '', lat, lng } });
  const { points } = routeModel([
    ev('Leipzig', 'DE', 51.34, 12.37, 'Processed at LEIPZIG', '2026-01-01T01:00:00+09:00'),
    ev('Incheon', 'KR', 37.45, 126.7, 'Import clearance started', '2026-01-01T02:00:00+09:00'),
    ev('Leipzig', 'DE', 51.34, 12.37, 'Departed from LEIPZIG', '2026-01-01T03:00:00+09:00'),
  ]);
  assert.deepEqual(points.map((p) => p.countryCode), ['DE'], 'Incheon never happened physically');
});

await test('scans: paperwork and notices are told apart from movement', async () => {
  const { isDocumentScan } = handler._internal;
  for (const scan of [
    'Customs clearance status updated - INCHEON',
    'Shipment information received',
    'Electronic notification received',
    'Pre-advice data received',
    'LABEL CREATED',
    '사전 통관 정보 접수',
    '通関情報を受信',
  ]) {
    assert.equal(isDocumentScan({ scan }), true, scan);
  }
  for (const scan of ['Arrived at INCHEON', 'Processed at LEIPZIG - GERMANY', 'Departed from LEIPZIG', 'Shipment picked up', 'DELIVERED', '배송출발', '집하']) {
    assert.equal(isDocumentScan({ scan }), false, scan);
  }
});

await test('errors: “no such shipment” and “the carrier is down” are labelled differently', async () => {
  const { errorMeta } = handler._internal;
  assert.deepEqual(errorMeta('NOT_FOUND'), { kind: 'NOT_FOUND', retryable: false });
  assert.deepEqual(errorMeta('UPSTREAM'), { kind: 'SERVICE', retryable: true });
  assert.deepEqual(errorMeta('RATE_LIMITED'), { kind: 'SERVICE', retryable: true });
  assert.deepEqual(errorMeta('BAD_REQUEST'), { kind: 'INPUT', retryable: false });

  stub({
    'cjlogistics.com/ko/tool/parcel/tracking-detail': { __status: 502, body: 'bad gateway' },
    'cjlogistics.com/ko/tool/parcel/tracking': CJ_MAIN,
  });
  const out = await call('1234567891', 'CJ');
  assert.equal(out.status, 502);
  assert.equal(out.body.error.code, 'UPSTREAM');
  assert.equal(out.body.error.kind, 'SERVICE');
  assert.equal(out.body.error.retryable, true);
});

await test('country: an overseas place without a country code is not painted as Korea', async () => {
  await withLastscannedKey(async () => {
    stub({
      'nominatim.openstreetmap.org': JSON.stringify([{ lat: '38.2527', lon: '-85.7585', address: { country_code: 'us' } }]),
      'api.lastscanned.com/v1/track/1Z000Y770414233099': lastscannedJson({
        events: [
          { timestamp: '2026-07-31T12:55:04Z', localTime: '2026-07-31T14:55:00', status: 'delivered', description: 'DELIVERED', location: 'LOUISVILLE, KY', code: 'KB' },
        ],
      }),
    });
    const out = await call('1Z000Y770414233099', 'UPS');
    assert.equal(out.status, 200);
    assert.equal(out.body.route[0].countryCode, 'US', 'the geocoder decided the country');
    assert.equal(out.body.route[0].countryEn, 'United States');
    assert.ok(!calls.some((c) => c.url.includes('countrycodes=kr')), 'no Korean restriction on an unknown country');
  });
});

await test('country: the country named inside the scan text wins over the old KR default', async () => {
  const { makeLocation, countryFromText } = handler._internal;
  assert.equal(countryFromText('ROISSY CDG, FRANCE'), 'FR');
  assert.equal(countryFromText('KOELN, DE'), 'DE');
  assert.equal(countryFromText('UNITED STATES'), 'US');
  assert.equal(makeLocation('ROISSY CHARLES DE GAULLE CEDEX, FRANCE').countryCode, 'FR');
  assert.equal(makeLocation('PADUCAH, KENTUCKY').countryCode, 'KR', 'unknown until the geocoder answers');
  assert.equal(makeLocation('PADUCAH, KENTUCKY').countryUncertain, true);
  assert.equal(makeLocation('대전동부').countryCode, 'KR');
});

await test('lastscanned: UPS delivered, EDD normalised, events oldest-first', async () => {
  await withLastscannedKey(async () => {
    stub({ 'api.lastscanned.com/v1/track/1Z000Y770414233027': lastscannedJson() });
    const out = await call('1Z000Y770414233027', 'UPS');
    assert.equal(out.status, 200);
    assert.equal(out.body.carrier.code, 'UPS');
    assert.equal(out.body.status.code, 'DELIVERED');
    assert.equal(out.body.status.delivered, true);
    assert.equal(out.body.status.stage, 4);
    assert.equal(out.body.estimatedDelivery, '2026-08-07');
    assert.equal(out.body.meta.source, 'lastscanned');
    assert.equal(out.body.meta.upstream, 'ups');
    assert.equal(out.body.events.length, 4);
    assert.equal(out.body.events[0].status.code, 'REGISTERED');
    assert.equal(out.body.events.at(-1).status.code, 'DELIVERED');
    assert.equal(out.body.events.at(-1).location.countryCode, 'DE');
    assert.ok(calls[0].url.includes('carrier=ups'), calls[0].url);
  });
});

await test('lastscanned: koreapost 502 carrier_error is retried once', async () => {
  await withLastscannedKey(async () => {
    let tries = 0;
    stub({
      'trace.RetrieveDomRigiTraceList.comm': { __status: 404, body: 'not found' },
      'api.lastscanned.com/v1/track/1234567890125': () => {
        tries += 1;
        if (tries === 1) {
          return { __status: 502, body: JSON.stringify({ error: { code: 'carrier_error', message: 'parse' } }) };
        }
        return lastscannedJson({
          carrier: 'koreapost',
          status: 'in_transit',
          statusDescription: '배송중',
          estimatedDelivery: '2026-12-01',
          events: [
            { timestamp: '2026-11-27T02:00:00Z', localTime: null, status: 'in_transit', description: '간선하차', location: '대전, KR', code: null },
          ],
        });
      },
    });
    const out = await call('1234567890125', 'EPOST');
    assert.equal(out.status, 200);
    assert.equal(tries, 2, 'one retry after 502');
    assert.equal(out.body.carrier.code, 'EPOST');
    assert.equal(out.body.status.code, 'IN_TRANSIT');
    assert.equal(out.body.estimatedDelivery, '2026-12-01');
    assert.equal(out.body.meta.attempts[0].carrier, 'EPOST');
    assert.equal(out.body.meta.attempts.length, 1);
  });
});

await test('lastscanned: all seven statuses map, returned is not delivered', async () => {
  const { lastscannedStatus } = handler._internal;
  assert.equal(lastscannedStatus('label_created'), 'REGISTERED');
  assert.equal(lastscannedStatus('in_transit'), 'IN_TRANSIT');
  assert.equal(lastscannedStatus('out_for_delivery'), 'OUT_FOR_DELIVERY');
  assert.equal(lastscannedStatus('delivered'), 'DELIVERED');
  assert.equal(lastscannedStatus('exception'), 'EXCEPTION');
  assert.equal(lastscannedStatus('returned'), 'RETURNED');
  assert.equal(lastscannedStatus('unknown'), null);
  assert.equal(lastscannedStatus('something_new'), null);

  await withLastscannedKey(async () => {
    stub({
      'api.lastscanned.com/v1/track/1Z000Y770414230001': lastscannedJson({
        trackingNumber: '1Z000Y770414230001',
        status: 'returned',
        statusDescription: 'Returned to sender',
        estimatedDelivery: null,
        events: [
          { timestamp: '2026-07-31T12:55:04Z', status: 'delivered', description: 'DELIVERED', location: 'DITZINGEN, DE' },
          { timestamp: '2026-08-02T09:00:00Z', status: 'returned', description: 'RETURN TO SENDER', location: 'KOELN, DE' },
        ],
      }),
    });
    const out = await call('1Z000Y770414230001', 'UPS');
    assert.equal(out.status, 200);
    assert.equal(out.body.status.code, 'RETURNED');
    assert.equal(out.body.status.delivered, false);
    assert.equal(out.body.estimatedDelivery, null);
  });
});

await test('lastscanned: EDD instant moves to the Korean calendar day', async () => {
  const { estimatedDate } = handler._internal;
  assert.equal(estimatedDate('2026-12-01', []), '2026-12-01');
  assert.equal(estimatedDate(null, ['2026-11-30T16:30:00Z']), '2026-12-01');
  assert.equal(estimatedDate('2026-11-30T16:30:00Z', []), '2026-12-01');
  assert.equal(estimatedDate('2026-13-01', []), null);
  assert.equal(estimatedDate(null, [null, 'nonsense']), null);
});

await test('CJ: free parser miss falls back to lastscanned cjlogistics', async () => {
  await withLastscannedKey(async () => {
    stub({
      'cjlogistics.com/ko/tool/parcel/tracking-detail': JSON.stringify({ parcelDetailResultMap: { resultList: [] } }),
      'cjlogistics.com/ko/tool/parcel/tracking': CJ_MAIN,
      'api.lastscanned.com/v1/track/1234567802': lastscannedJson({
        carrier: 'cjlogistics',
        trackingNumber: '1234567802',
        status: 'in_transit',
        statusDescription: '배송중',
        estimatedDelivery: '2026-12-01',
        events: [
          { timestamp: '2026-11-27T01:00:00Z', localTime: null, status: 'in_transit', description: '간선하차', location: '수원, KR' },
        ],
      }),
    });
    const out = await call('1234567802', 'CJ');
    assert.equal(out.status, 200);
    assert.equal(out.body.carrier.code, 'CJ');
    assert.equal(out.body.status.code, 'IN_TRANSIT');
    assert.equal(out.body.estimatedDelivery, '2026-12-01');
    assert.equal(out.body.meta.source, 'lastscanned');
    assert.ok(calls.some((c) => c.url.includes('api.lastscanned.com') && c.url.includes('carrier=cjlogistics')));
  });
});

await test('auto: 12-digit domestic number reaches lastscanned only after the free carriers', async () => {
  await withLastscannedKey(async () => {
    stub({
      'cjlogistics.com/ko/tool/parcel/tracking-detail': JSON.stringify({ parcelDetailResultMap: { resultList: [] } }),
      'cjlogistics.com/ko/tool/parcel/tracking': CJ_MAIN,
      'lotteglogis.com/mobile/reservation/tracking/linkView': fixture('lotte-123456789013.html'),
      'hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do': fixture('hanjin-notfound.html'),
      'api.lastscanned.com/v1/track/123456780312': lastscannedJson({
        carrier: 'cjlogistics',
        trackingNumber: '123456780312',
        status: 'in_transit',
        statusDescription: '배송중',
        estimatedDelivery: null,
        events: [
          { timestamp: '2026-11-27T01:00:00Z', localTime: null, status: 'in_transit', description: '간선하차', location: '수원, KR' },
        ],
      }),
    });
    const out = await call('123456780312');
    assert.equal(out.status, 200);
    assert.equal(out.body.status.code, 'IN_TRANSIT');
    assert.equal(out.body.meta.attempts.length, 3, 'three free domestic attempts first');
    const lastscannedCall = calls.find((c) => c.url.includes('api.lastscanned.com'));
    assert.ok(lastscannedCall, 'lastscanned consulted');
    assert.ok(!lastscannedCall.url.includes('carrier='), 'no carrier pinned in auto mode');
  });
});

await test('auto: 1Z number goes straight to lastscanned UPS', async () => {
  await withLastscannedKey(async () => {
    stub({ 'api.lastscanned.com/v1/track/1Z000Y770414230002': lastscannedJson({ trackingNumber: '1Z000Y770414230002' }) });
    const out = await call('1Z000Y770414230002');
    assert.equal(out.status, 200);
    assert.equal(out.body.carrier.code, 'UPS');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('carrier=ups'));
  });
});

await test('GLOBAL: any of the 551 carriers is auto-detected', async () => {
  await withLastscannedKey(async () => {
    stub({
      'api.lastscanned.com/v1/track/YT2501234567890': lastscannedJson({
        carrier: 'yunexpress',
        trackingNumber: 'YT2501234567890',
        status: 'in_transit',
        statusDescription: 'In transit',
        estimatedDelivery: '2026-12-05',
        events: [
          { timestamp: '2026-11-26T03:00:00Z', status: 'in_transit', description: 'Departed origin', location: 'SHENZHEN, CN' },
        ],
      }),
    });
    const out = await call('YT2501234567890', 'GLOBAL');
    assert.equal(out.status, 200);
    assert.equal(out.body.carrier.code, 'YUNEXPRESS');
    assert.equal(out.body.estimatedDelivery, '2026-12-05');
    assert.equal(out.body.carrier.site, 'https://www.yuntrack.com/');
  });
});

await test('lastscanned: unknown carrier on an explicit pick returns BAD_REQUEST', async () => {
  await withLastscannedKey(async () => {
    stub({
      'api.lastscanned.com/v1/track/9999999999999': {
        __status: 400,
        body: JSON.stringify({ error: { code: 'unknown_carrier', message: 'no such number' } }),
      },
    });
    const out = await call('9999999999999', 'USPS');
    assert.equal(out.status, 400);
    assert.equal(out.body.error.code, 'BAD_REQUEST');
  });
});

await test('overseas carriers without any key explain LASTSCANNED_API_KEY', async () => {
  delete process.env.LASTSCANNED_API_KEY;
  delete process.env.DHL_API_KEY;
  stub({});
  const out = await call('1Z999AA10123456784', 'UPS');
  assert.equal(out.status, 501);
  assert.equal(out.body.error.code, 'NEEDS_KEY');
  assert.ok(out.body.error.message.includes('LASTSCANNED_API_KEY'));
});

await test('auto: 13-digit number goes straight to Korea Post', async () => {
  stub({ 'trace.RetrieveDomRigiTraceList.comm': fixture('epost-1234567890123.html') });
  const out = await call('1234567890124');
  assert.equal(out.status, 200);
  assert.equal(out.body.carrier.code, 'EPOST');
  assert.equal(calls.length, 1);
});

await test('auto: 12-digit number tries CJ, LOTTE, HANJIN in order', async () => {
  stub({
    'cjlogistics.com/ko/tool/parcel/tracking-detail': JSON.stringify({ parcelResultMap: { resultList: [] }, parcelDetailResultMap: { resultList: [] } }),
    'cjlogistics.com/ko/tool/parcel/tracking': CJ_MAIN,
    'lotteglogis.com/mobile/reservation/tracking/linkView': fixture('lotte-synthetic.html'),
    'hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do': fixture('hanjin-notfound.html'),
  });
  const out = await call('123456789019');
  assert.equal(out.status, 200);
  assert.equal(out.body.carrier.code, 'LOTTE');
  assert.ok(calls[0].url.includes('cjlogistics'), 'CJ probed first');
});

await test('auto: nothing found returns NOT_FOUND with per-carrier attempts', async () => {
  stub({
    'cjlogistics.com/ko/tool/parcel/tracking-detail': JSON.stringify({ parcelDetailResultMap: { resultList: [] } }),
    'cjlogistics.com/ko/tool/parcel/tracking': CJ_MAIN,
    'lotteglogis.com/mobile/reservation/tracking/linkView': fixture('lotte-123456789013.html'),
    'hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do': fixture('hanjin-notfound.html'),
  });
  const out = await call('999999999991');
  assert.equal(out.status, 404);
  assert.equal(out.body.error.code, 'NOT_FOUND');
  assert.equal(out.body.attempts.length, 3);
});

await test('input guards: empty, too short, no digits, UPS, unknown carrier', async () => {
  stub({});
  assert.equal((await call('', 'auto')).status, 400);
  assert.equal((await call('12345', 'auto')).status, 400);
  assert.equal((await call('ABCDEFG', 'auto')).status, 400);
  assert.equal((await call('1Z999AA10123456784', 'auto')).status, 501);
  assert.equal((await call('1234567890', 'NOPE')).status, 400);
});

await test('hub table covers the usual domestic terminals', () => {
  const { lookupGeo } = handler._internal;
  const cases = {
    곤지암HUB: '곤지암',
    부천물류센터: '부천',
    경기수원장안: '수원',
    대전동부: '대전',
    '성동AMP': '성동',
    청원HUB: '청원',
    서광주우체국: '광주',
    'Leipzig - HUB': 'Leipzig',
  };
  for (const [input, expected] of Object.entries(cases)) {
    const hit = lookupGeo(input);
    assert.ok(hit, input + ' should resolve');
    assert.equal(hit.name, expected, input + ' -> ' + (hit && hit.name));
  }
});

await test('unknown location falls back to Nominatim once and is cached', async () => {
  const json = fixture('cj-1234567890.json');
  const payload = JSON.parse(json);
  payload.parcelDetailResultMap.resultList[0].regBranNm = '광교동';
  stub({
    'nominatim.openstreetmap.org': JSON.stringify([{ lat: '37.2899', lon: '127.0553' }]),
    'cjlogistics.com/ko/tool/parcel/tracking-detail': payload,
    'cjlogistics.com/ko/tool/parcel/tracking': CJ_MAIN,
  });
  const out = await call('1234567801', 'CJ');
  assert.equal(out.status, 200);
  const point = out.body.route.find((p) => p.name === '광교동');
  assert.ok(point, 'unknown hub appears on the route');
  assert.ok(Math.abs(point.lat - 37.2899) < 0.002);
  assert.equal(point.precision, 'geocoded');
  const geoCalls = calls.filter((c) => c.url.includes('nominatim'));
  assert.equal(geoCalls.length, 1);
  assert.ok(geoCalls[0].url.includes('countrycodes=kr'));
});

globalThis.fetch = realFetch;

/* ------------------------------------------------------------------ *
 * Language pack
 * ------------------------------------------------------------------ */

const PUB = join(__dirname, '..', 'public');
const I18N_SRC = join(__dirname, '..', 'i18n-src');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const meta = readJson(join(I18N_SRC, '_meta.json'));
const baseDict = readJson(join(I18N_SRC, `${meta.base}.json`));

function flatten(value, path = '', out = {}) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => flatten(item, `${path}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) flatten(value[key], path ? `${path}.${key}` : key, out);
    return out;
  }
  out[path] = value;
  return out;
}

await test('i18n: 19 languages, each complete and free of Korean leakage outside CJK', async () => {
  assert.equal(meta.order.length, 19, '19 languages');
  const codes = meta.order.map((lang) => lang.code);
  assert.equal(new Set(codes).size, codes.length, 'no duplicate codes');
  assert.deepEqual(codes.slice(0, 3), ['ko', 'en', 'ja']);
  const natives = meta.order.map((lang) => lang.native);
  assert.equal(new Set(natives).size, natives.length, 'native names are unique');
  for (const lang of meta.order) {
    assert.ok(lang.native && lang.native !== lang.code, `${lang.code}: has a native name`);
    assert.ok(lang.locale && /^[a-z]{2}(-[A-Za-z0-9]+)?$/.test(lang.locale), `${lang.code}: has a locale`);
    assert.equal(lang.dir || 'ltr', lang.code === 'ar' ? 'rtl' : 'ltr');
  }
  const baseFlat = flatten(baseDict);
  const hangul = /[\uac00-\ud7a3]/;
  for (const { code } of meta.order) {
    const dict = readJson(join(I18N_SRC, `${code}.json`));
    const flat = flatten(dict);
    assert.deepEqual(Object.keys(flat).sort(), Object.keys(baseFlat).sort(), `${code}: same keys as en`);
    for (const [key, value] of Object.entries(flat)) {
      assert.equal(typeof value, 'string', `${code}: ${key} is a string`);
      assert.ok(value.trim(), `${code}: ${key} is filled in`);
      if (/^[a-z]+[A-Z]|^[A-Z_]+$/.test(key)) assert.notEqual(value.trim(), key, `${code}: ${key} is translated, not the key`);
      if (!['ko', 'ja', 'zh-CN', 'zh-TW'].includes(code)) {
        assert.ok(!hangul.test(value), `${code}: ${key} still holds Korean: ${value}`);
      }
    }
  }
});

await test('i18n: every error code the API can emit has a translation', async () => {
  const sources = ['api/track.js']
    .map((f) => readFileSync(join(__dirname, '..', f), 'utf8'))
    .join('\n');
  const codes = new Set();
  for (const match of sources.matchAll(/(?:TrackError|fail)\([^)]*?'([A-Z_]{4,})'/g)) codes.add(match[1]);
  assert.ok(codes.has('TIMEOUT'), 'found TIMEOUT among the API codes');
  assert.ok(codes.has('NOT_FOUND'), 'found NOT_FOUND among the API codes');
  for (const code of codes) {
    for (const group of ['errors', 'hints']) {
      assert.ok(baseDict[group][code], `en.${group}.${code} exists`);
      for (const { code: lang } of meta.order) {
        const dict = readJson(join(I18N_SRC, `${lang}.json`));
        assert.ok(dict[group][code], `${lang}.${group}.${code} is translated`);
        assert.ok(!/[\uac00-\ud7a3]/.test(dict[group][code]) || lang === 'ko', `${lang}.${group}.${code} is not Korean`);
      }
    }
  }
});

await test('i18n: public/i18n.js is the built output of i18n-src', async () => {
  const bundle = readFileSync(join(PUB, 'i18n.js'), 'utf8');
  assert.match(bundle, /Generated by scripts\/build-i18n\.mjs/, 'generated file');
  assert.ok(!/localStorage|sessionStorage|document\.cookie|indexedDB/.test(bundle), 'the language pack touches no browser storage');
  const js = bundle.slice(bundle.indexOf('window.WIMP_I18N = ') + 'window.WIMP_I18N = '.length);
  const data = JSON.parse(js.slice(0, js.lastIndexOf(';')));
  assert.equal(data.languages.length, 19);
  assert.equal(Object.keys(data.strings).length, 19);
  for (const { code } of meta.order) {
    assert.deepEqual(Object.keys(flatten(data.strings[code])).sort(), Object.keys(flatten(baseDict)).sort(), `${code}: bundle carries the whole dictionary`);
    assert.equal(data.strings[code].title, readJson(join(I18N_SRC, `${code}.json`)).title, `${code}: bundle matches i18n-src`);
  }
  assert.equal(data.aliases.zh, 'zh-CN', 'zh resolves to Simplified Chinese');
});

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) process.exit(1);
