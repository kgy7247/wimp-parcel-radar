/**
 * Live smoke test — hits the real carrier endpoints through the API handler.
 * Usage: node test/smoke.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const handler = require('../api/track.js');

function call(number, carrier = 'auto') {
  const req = { method: 'GET', url: `/api/track?number=${encodeURIComponent(number)}&carrier=${carrier}`, query: { number, carrier } };
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
        resolve({ status: this.statusCode, body: parsed });
      },
    };
    handler(req, res);
  });
}

const cases = [
  ['1234567890', 'CJ'],
  ['1234567890123', 'EPOST'],
  ['123456789013', 'LOTTE'],
  ['123456789013', 'HANJIN'],
  ['2746217154', 'DHL'],
  ['2746217154', 'auto'],
  ['12345', 'auto'],
  ['1Z999AA10123456784', 'auto'],
];

for (const [number, carrier] of cases) {
  const t0 = Date.now();
  const out = await call(number, carrier);
  const body = out.body;
  const ms = Date.now() - t0;
  if (body && body.ok) {
    console.log(`OK   ${carrier.padEnd(6)} ${number} -> ${body.carrier.code} ${body.status.code} events=${body.events.length} route=${body.route.length} countries=${body.countries.join('>')} (${ms}ms)`);
    console.log(`     latest: ${body.latest && body.latest.scan} @ ${body.latest && body.latest.location && body.latest.location.name}`);
    console.log(`     first:  ${body.events[0].time} ${body.events[0].scan} @ ${body.events[0].location && body.events[0].location.name}`);
  } else {
    console.log(`FAIL ${carrier.padEnd(6)} ${number} -> ${out.status} ${body && body.error && body.error.code}: ${body && body.error && body.error.message}`);
  }
}
