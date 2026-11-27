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

await test('CJ: csrf handshake then JSON history, phones masked, delivered', async () => {
  stub({
    'cjlogistics.com/ko/tool/parcel/tracking-detail': cjJson,
    'cjlogistics.com/ko/tool/parcel/tracking': CJ_MAIN,
  });
  const out = await call('1234567890', 'CJ');
  assert.equal(out.status, 200);
  assert.equal(out.body.ok, true);
  assert.equal(out.body.carrier.code, 'CJ');
  assert.equal(out.body.events.length, 6);
  assert.equal(out.body.status.code, 'DELIVERED');
  assert.equal(out.body.status.delivered, true);
  assert.equal(out.body.status.stage, 4);
  assert.ok(out.body.route.length >= 4, 'route points');
  assert.deepEqual(out.body.countries, ['KR']);
  const blob = JSON.stringify(out.body);
  assert.ok(!/010-3178-4370/.test(blob), 'driver phone number must be masked');
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

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) process.exit(1);
