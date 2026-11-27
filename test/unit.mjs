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
  assert.deepEqual(out.body.countries, ['BG', 'DE']);
  assert.ok(calls[0].url.includes('trackingNumber=1234567896'));
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

/* ------------------------------------------------------------------ *
 * Air cargo: /api/plane (adsb.lol) and /api/awb (Asiana / Korean Air)
 * ------------------------------------------------------------------ */

const planeHandler = require('../api/plane.js');
const awbHandler = require('../api/awb.js');
const awbInternal = awbHandler._internal;

function callAny(handler, url) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(body) {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        resolve({ status: this.statusCode, body: parsed, headers: this.headers });
      },
    };
    handler({ method: 'GET', url }, res);
  });
}

const callPlane = (qs) => callAny(planeHandler, `/api/plane?${qs}`);
const callAwb = (qs) => callAny(awbHandler, `/api/awb?${qs}`);

const AC = (over) => ({
  hex: '71c285', flight: 'KAL249  ', r: 'HL8285', t: 'B77L',
  alt_baro: 32000, gs: 384.8, track: 196.46, lat: 35.19, lon: 126.15, seen_pos: 0.8,
  ...over
});

await test('plane: KE082 becomes the KAL082 callsign and is shaped for the globe', async () => {
  stub({
    'api.adsb.lol/v2/callsign/KAL082': { ac: [AC({ flight: 'KAL082  ', t: 'A388', alt_baro: 38000, gs: 480.4, lat: 40.6, lon: -73.7 })], total: 1 },
  });
  const out = await callPlane('cs=KE082');
  assert.equal(out.status, 200);
  assert.equal(calls[0].url, 'https://api.adsb.lol/v2/callsign/KAL082');
  assert.equal(out.headers['cache-control'], 'public, s-maxage=45, stale-while-revalidate=120');
  assert.equal(out.body.source, 'adsb.lol');
  const plane = out.body.planes[0];
  assert.equal(plane.callsign, 'KAL082');
  assert.equal(plane.iata, 'KE082');
  assert.equal(plane.aircraftType, 'A388');
  assert.equal(plane.altFt, 38000);
  assert.equal(plane.speedKts, 480);
  assert.equal(plane.heading, 196);
  assert.equal(plane.onGround, false);
  assert.equal(plane.operator.code, 'KAL');
  assert.equal(out.body.attribution.text, '© adsb.lol (ODbL 1.0)');
});

await test('plane: several flight numbers cost one upstream request', async () => {
  stub({
    'api.adsb.lol/v2/callsign/': { ac: [AC(), AC({ hex: '71c286', flight: 'KAL213  ' })], total: 2 },
  });
  const out = await callPlane('cs=KAL249,KE213');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('KAL249'));
  assert.ok(calls[0].url.includes('KAL213'));
  assert.equal(out.body.planes.length, 2);
  assert.deepEqual(out.body.query.callsigns.map((c) => c.input), ['KAL249', 'KE213']);
});

await test('plane: a carrier query puts that carrier’s freighters first', async () => {
  stub({
    'api.adsb.lol/v2/lat/': {
      ac: [
        AC({ hex: '1', flight: 'KAL249  ' }),
        AC({ hex: '2', flight: 'BCS123  ', t: 'B763' }),
        AC({ hex: '3', flight: 'FDX99   ', t: 'B77F' }),
      ],
      total: 3,
    },
  });
  const out = await callPlane('carrier=DHL&lat=37.46&lon=126.44');
  assert.equal(out.status, 200);
  assert.ok(calls[0].url.includes('/lat/37.4600/lon/126.4400/dist/250'));
  assert.equal(out.body.planes[0].callsign, 'BCS123');
  assert.equal(out.body.planes[0].matched, true);
  assert.equal(out.body.planes[0].operator.code, 'DHL');
  assert.equal(out.body.counts.matched, 1);
  assert.equal(out.body.counts.total, 3);
});

await test('plane: adsb.lol 429 falls back to adsb.fi and says so', async () => {
  stub({
    'api.adsb.lol/v2/callsign/': { __status: 429, body: '{"msg":"rate limited"}' },
    'opendata.adsb.fi/api/v2/callsign/': { aircraft: [AC()] },
  });
  const out = await callPlane('cs=KAL249');
  assert.equal(out.status, 200);
  assert.equal(out.body.source, 'adsb.fi');
  assert.equal(out.body.planes.length, 1);
  assert.equal(out.body.meta.fallbackReason, 'rate-limited');
  assert.equal(calls.length, 2);
});

await test('plane: no aircraft for a flight number is a 200 with a clear message', async () => {
  stub({ 'api.adsb.lol/v2/callsign/': { ac: [], total: 0 } });
  const out = await callPlane('cs=KAL999');
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.planes, []);
  assert.ok(out.body.message.includes('관측되지 않습니다'));
  assert.deepEqual(out.body.missing, ['KAL999']);
});

await test('plane: bad coordinates, radius and callsigns are rejected', async () => {
  stub({});
  assert.equal((await callPlane('lat=200')).status, 400);
  assert.equal((await callPlane('lat=37&lon=126&dist=400')).status, 400);
  assert.equal((await callPlane('cs=XX')).status, 400);
  assert.equal((await callPlane('hex=zzz')).status, 400);
  assert.equal(calls.length, 0);
});

const ASIANA_PAGE = '<html><form><input type="hidden" name="_csrf" value="csrf-token-123"></form></html>';
const ASIANA_OK = fixture('awb-asiana-98812345675.json');

await test('awb: Asiana 988 normalises the shipment and drops shipper/consignee data', async () => {
  stub({
    'asianacargo.com/tracking/viewTraceAirWaybill.do': ASIANA_PAGE,
    'asianacargo.com/tracking/searchTraceAirWaybillResult.do': ASIANA_OK,
  });
  const out = await callAwb('no=988-12345675');
  assert.equal(out.status, 200);
  assert.equal(out.headers['cache-control'], 'public, s-maxage=300, stale-while-revalidate=600');
  const awb = out.body.awb;
  assert.equal(awb.number, '98812345675');
  assert.equal(awb.airline.code, 'OZ');
  assert.equal(awb.origin.iata, 'LAX');
  assert.equal(awb.destination.iata, 'ICN');
  assert.equal(awb.pieces, 3);
  assert.equal(awb.weight, 128.5);
  assert.equal(awb.status.code, 'CUSTOMS');
  assert.equal(awb.status.stage, 3);
  assert.deepEqual(awb.events.map((e) => e.code), ['RCS', 'DEP', 'ARR', 'NFD']);
  assert.equal(awb.events[0].atLabel, '2026-11-25 09:12');
  assert.equal(awb.events[1].flight, 'OZ201');
  assert.ok(awb.events[2].place.lat > 37 && awb.events[2].place.lat < 38);
  assert.deepEqual(awb.liveCallsigns, ['OZ201']);
  assert.deepEqual(awb.route.map((r) => r.iata), ['LAX', 'ICN']);
  assert.ok(awb.route.every((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng)), 'route stops keep both coordinates');
  assert.ok(awb.events.every((e) => e.place && Number.isFinite(e.place.lat) && Number.isFinite(e.place.lng)), 'event places keep both coordinates');
  assert.equal(out.body.meta.checkDigitOk, true);

  const text = JSON.stringify(out.body);
  for (const secret of ['HONG GILDONG', 'ACME INDUSTRIAL', '1234 WAREHOUSE', '101 DONG SEOUL', 'SHIP001', 'CONS999', 'FORWARDER LTD']) {
    assert.ok(!text.includes(secret), 'personal field must not leave the server: ' + secret);
  }
  assert.ok(!/"(shipper|consignee)/i.test(text), 'no shipper/consignee keys in the response');
});

await test('awb: unknown Asiana AWB is a 404 with the check-digit explained', async () => {
  stub({
    'asianacargo.com/tracking/viewTraceAirWaybill.do': ASIANA_PAGE,
    'asianacargo.com/tracking/searchTraceAirWaybillResult.do': { success: true, data: [] },
  });
  const out = await callAwb('no=98812345670');
  assert.equal(out.status, 404);
  assert.equal(out.body.error.code, 'AWB_NOT_FOUND');
  assert.ok(out.body.error.hint.includes('체크디지트'));
  assert.equal(out.body.meta.checkDigitOk, false);
});

await test('awb: unsupported airline prefixes and flight numbers get their own answers', async () => {
  stub({});
  const unsupported = await callAwb('no=99912345675');
  assert.equal(unsupported.status, 501);
  assert.equal(unsupported.body.error.code, 'AWB_UNSUPPORTED');

  const flight = await callAwb('no=KE082');
  assert.equal(flight.status, 400);
  assert.equal(flight.body.error.code, 'IS_FLIGHT');
  assert.ok(flight.body.error.hint.includes('/api/plane'));

  const short = await callAwb('no=988123');
  assert.equal(short.status, 400);
  assert.equal(short.body.error.code, 'BAD_REQUEST');
});

await test('awb: Korean Air session rejection is reported, not faked', async () => {
  stub({
    'cargo.koreanair.com/en/tracking': '<html><script>{"session_id":"abc123","region":"Asia"}</script></html>',
    'cargo.koreanair.com/cargoportal/services/trackawb': {
      generalInfo: { sessionId: 'next456', time: '28 Nov 2026 02:45' },
      messages: [{ type: 'ERROR', code: 'ESC401', text: 'Session Expired. Please reload the page and proceed.' }],
    },
  });
  const out = await callAwb('no=180-12345675');
  assert.equal(out.status, 503);
  assert.equal(out.body.error.code, 'AIRLINE_BLOCKED');
  assert.ok(out.body.error.hint.includes('cargo.koreanair.com'));
  assert.equal(calls.filter((c) => c.url.includes('trackawb')).length, 2, 'one retry with the new session id');
});

await test('awb: Korean Air success payload is normalised from an allowlist', async () => {
  const normalised = awbInternal.normaliseKoreanAir(
    {
      awbPrefix: '180',
      awbDocNo: '12345675',
      routes: ['ICN', 'LAX'],
      scc: 'XX',
      shipperName: 'DO NOT COPY',
      consigneeAddress: 'DO NOT COPY',
      eventDetails: [
        { eventCode: 'RCS', eventDate: '2026-11-27 09:00', airportCode: 'ICN', pieces: 2, weight: 40 },
        { eventCode: 'DEP', eventDate: '2026-11-27 13:30', airportCode: 'ICN', flightNo: 'KE011' },
      ],
      fltDetails: [{ fltNo: 'KE011', carType: 'B77F', depStn: 'ICN', arrStn: 'LAX', fltDate: '27 Nov 2026' }],
    },
    { prefix: '180', docNo: '12345675' }
  );
  assert.equal(normalised.number, '18012345675');
  assert.equal(normalised.status.code, 'IN_TRANSIT');
  assert.deepEqual(normalised.events.map((e) => e.code), ['RCS', 'DEP']);
  assert.deepEqual(normalised.liveCallsigns, ['KE011']);
  assert.deepEqual(normalised.route.map((r) => r.iata), ['ICN', 'LAX']);
  assert.ok(!JSON.stringify(normalised).includes('DO NOT COPY'));
});

await test('track: carrier=AIR forwards AWB and flight lookups to the right function', async () => {
  stub({
    'asianacargo.com/tracking/viewTraceAirWaybill.do': ASIANA_PAGE,
    'asianacargo.com/tracking/searchTraceAirWaybillResult.do': ASIANA_OK,
    'api.adsb.lol/v2/callsign/KAL249': { ac: [AC()], total: 1 },
  });
  const awbOut = await call('98812345675', 'AIR');
  assert.equal(awbOut.status, 200);
  assert.equal(awbOut.body.kind, 'awb');

  const flightOut = await call('KE249', 'AIR');
  assert.equal(flightOut.status, 200);
  assert.equal(flightOut.body.kind, 'planes');
  assert.equal(flightOut.body.planes[0].callsign, 'KAL249');

  const bad = await call('12345', 'AIR');
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.hint.includes('988-12345675'));
});

globalThis.fetch = realFetch;

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) process.exit(1);
