/**
 * UI test — public/index.html + public/app.js + public/guide.html, no network.
 * jsdom renders the real markup and runs the real app.js; every API response is stubbed.
 *
 * Usage: node test/ui.mjs
 *
 * What it pins down (2026-11 redesign):
 *   1. “이용 안내” is a link to guide.html and never opens the settings dialog;
 *      only the ⚙ button opens settings.
 *   2. Result order is status → last location → last scan → 3D globe → history timeline.
 *   3. guide.html is a real content page (AdSense tag, FAQ structured data, linked from index/footer/sitemap).
 *   4. privacy.html states only what the code does (no persistent storage, no browser storage).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUB = join(ROOT, 'public');
const read = (file) => readFileSync(join(PUB, file), 'utf8');
const appJs = read('app.js');
const i18nJs = read('i18n.js');
const apiJs = readFileSync(join(ROOT, 'api', 'track.js'), 'utf8');
const ADSENSE = 'pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7205132235653329';

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

/* ------------------------------------------------------------------ *
 * jsdom harness
 * ------------------------------------------------------------------ */

const CJ_RESPONSE = {
  ok: true,
  carrier: { code: 'CJ', name: 'CJ대한통운', site: 'https://www.cjlogistics.com/ko/tool/parcel/tracking' },
  number: '1234567890',
  status: { code: 'OUT_FOR_DELIVERY', label: '배송 출발', stage: 3, delivered: false },
  estimatedDelivery: '2026-12-01',
  latest: { time: '2026-11-21T12:42:12+09:00', scan: '배송출발', location: { name: '경기수원장안' } },
  events: [
    { time: '2026-11-07T13:45:41+09:00', scan: '집화처리', description: '상품을 인수받았습니다', status: { code: 'PICKED_UP' }, location: { name: '대전동부', city: '대전', code: 'DJN', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR', lat: 36.3504, lng: 127.3845 } },
    { time: '2026-11-19T02:14:24+09:00', scan: '간선상차', description: '배송지역으로 이동중입니다', status: { code: 'IN_TRANSIT' }, location: { name: '군포HUB', city: '군포', code: 'GNP', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR', lat: 37.3616, lng: 126.935 } },
    { time: '2026-11-21T12:42:12+09:00', scan: '배송출발', description: '배송할 예정입니다', status: { code: 'OUT_FOR_DELIVERY' }, location: { name: '경기수원장안', city: '수원', code: 'SWN', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR', lat: 37.2636, lng: 127.0286 } }
  ],
  route: [],
  countries: ['KR'],
  meta: { source: 'cjlogistics', cached: false, demo: false, fetchedAt: '2026-11-28T01:00:00.000Z' }
};

const NOT_FOUND_RESPONSE = {
  ok: false,
  error: {
    code: 'NOT_FOUND',
    message: '조회된 배송 정보가 없습니다.',
    hint: '운송장 번호와 자릿수를 확인하거나, 택배사가 아직 상품을 인수하지 않았을 수 있습니다.',
    carrier: { code: 'CJ', name: 'CJ대한통운', site: 'https://www.cjlogistics.com/ko/tool/parcel/tracking' }
  }
};

const DHL_RESPONSE = {
  ok: true,
  carrier: { code: 'DHL', name: 'DHL', site: 'https://www.dhl.com/kr-ko/home/tracking.html' },
  number: '1234567895',
  status: { code: 'IN_TRANSIT', label: '이동 중', stage: 2, delivered: false },
  estimatedDelivery: '2026-12-02',
  latest: { time: '2026-11-27T22:10:00+09:00', scan: 'Processed at LEIPZIG', location: { name: 'Leipzig' } },
  events: [
    { time: '2026-11-25T08:10:00+01:00', scan: 'Shipment picked up', description: 'DHL 화물이 접수되었습니다', status: { code: 'PICKED_UP' }, location: { name: 'Leipzig', city: 'Leipzig', code: 'LEJ', country: '독일', countryEn: 'Germany', countryCode: 'DE', lat: 51.4239, lng: 12.2364 } },
    { time: '2026-11-27T22:10:00+09:00', scan: 'Processed at INCHEON', description: '인천 허브에 도착했습니다', status: { code: 'IN_TRANSIT' }, location: { name: 'Incheon', city: '인천', code: 'ICN', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR', lat: 37.4602, lng: 126.4407 } }
  ],
  route: [],
  countries: ['DE', 'KR'],
  meta: { source: 'lastscanned', cached: false, demo: false, fetchedAt: '2026-11-28T01:00:00.000Z' }
};

const PLANE_RESPONSE = {
  ok: true,
  kind: 'planes',
  query: { type: 'point', carrier: 'DHL', callsigns: [], center: { lat: 37.46, lon: 126.44, distNM: 250 } },
  planes: [
    { hex: '400a1b', callsign: 'BCS123', iata: null, aircraftType: 'B763', registration: 'G-DHLX', lat: 51.42, lon: 12.23, altFt: 33000, speedKts: 421, heading: 178, onGround: false, seenSec: 4, operator: { code: 'DHL', label: 'DHL' }, matched: true }
  ],
  counts: { shown: 1, matched: 1, total: 4 },
  missing: [],
  message: null,
  source: 'adsb.lol',
  attribution: { text: '© adsb.lol (ODbL 1.0)', url: 'https://adsb.lol' },
  meta: { fetchedAt: '2026-11-28T01:00:05.000Z', elapsedMs: 120, cached: false }
};

/* The API answered 200 normally, but this flight number is not airborne right now. */
const PLANE_NONE_RESPONSE = {
  ok: true,
  kind: 'planes',
  query: { type: 'callsign', carrier: null, callsigns: [{ input: 'KE9999', icao: 'KAL9999', iata: 'KE9999' }], center: null },
  planes: [],
  counts: { shown: 0, matched: 0, total: 0 },
  missing: ['KE9999'],
  message: '지금 이 편명의 항공기가 관측되지 않습니다. 지상에 있거나 레이더 범위 밖일 수 있습니다.',
  source: 'adsb.lol',
  attribution: { text: '© adsb.lol (ODbL 1.0)', url: 'https://adsb.lol' },
  meta: { fetchedAt: '2026-11-28T01:00:05.000Z', elapsedMs: 90, cached: false }
};

/* The aircraft feed itself failed (429 from /api/plane) — a real connection problem. */
const PLANE_FAIL_RESPONSE = {
  ok: false,
  error: {
    code: 'RATE_LIMITED',
    message: '실시간 항공기 데이터 제공처가 잠시 응답하지 않습니다.',
    hint: '잠시 후 다시 시도해 주세요. 위치 데이터는 약 1분 단위로 갱신됩니다.'
  }
};

const AWB_RESPONSE = {
  ok: true,
  kind: 'awb',
  awb: {
    number: '98812345675',
    prefix: '988',
    airline: { code: 'OZ', name: '아시아나항공', site: 'https://www.asianacargo.com/tracking/viewTraceAirWaybill.do' },
    origin: { iata: 'LAX', name: 'LOS ANGELES', city: '로스앤젤레스', country: '미국', countryEn: 'United States', countryCode: 'US', lat: 33.9416, lng: -118.4085 },
    destination: { iata: 'ICN', name: 'INCHEON', city: '인천', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR', lat: 37.4602, lng: 126.4407 },
    pieces: 3,
    weight: 128.5,
    weightUnit: 'KG',
    status: { code: 'CUSTOMS', label: '통관·수령 통지', stage: 3, delivered: false },
    events: [
      { code: 'RCS', label: '화물 접수', detail: 'Received from shipper', at: null, atLabel: '2026-11-25 09:12', status: 'PICKED_UP', place: { iata: 'LAX', name: 'LOS ANGELES', city: '로스앤젤레스', countryCode: 'US', lat: 33.9416, lng: -118.4085 } },
      { code: 'DEP', label: '출발', detail: 'Departed', at: null, atLabel: '2026-11-26 02:25', status: 'IN_TRANSIT', flight: 'OZ201', place: { iata: 'LAX', name: 'LOS ANGELES', city: '로스앤젤레스', countryCode: 'US', lat: 33.9416, lng: -118.4085 } },
      { code: 'ARR', label: '항공편 도착', detail: 'Arrived', at: null, atLabel: '2026-11-26 17:48', status: 'ARRIVED', flight: 'OZ201', place: { iata: 'ICN', name: 'INCHEON', city: '인천', countryCode: 'KR', lat: 37.4602, lng: 126.4407 } },
      { code: 'NFD', label: '도착 통지', detail: 'Notified', at: null, atLabel: '2026-11-27 08:40', status: 'CUSTOMS', place: { iata: 'ICN', name: 'INCHEON', city: '인천', countryCode: 'KR', lat: 37.4602, lng: 126.4407 } }
    ],
    flights: [{ no: 'OZ201', from: 'LAX', to: 'ICN', date: '26 Nov 2026', live: true }],
    route: [
      { iata: 'LAX', name: 'LOS ANGELES', city: '로스앤젤레스', country: '미국', countryEn: 'United States', countryCode: 'US', lat: 33.9416, lng: -118.4085 },
      { iata: 'ICN', name: 'INCHEON', city: '인천', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR', lat: 37.4602, lng: 126.4407 }
    ],
    liveCallsigns: ['OZ201'],
    source: 'asiana'
  },
  meta: { source: 'asiana', prefix: '988', cached: false, checkDigitOk: true, fetchedAt: '2026-11-28T01:00:00.000Z', piiRemoved: true }
};

const AWB_MISSING = {
  ok: false,
  error: {
    code: 'AWB_NOT_FOUND',
    message: '아시아나항공에서 이 AWB의 운송 정보를 찾지 못했습니다.',
    hint: 'AWB 번호를 다시 확인해 주세요. 택배 송장이라면 배송사를 직접 선택하면 택배로 조회됩니다.',
    airline: { code: 'OZ', name: '아시아나항공', site: 'https://www.asianacargo.com/tracking/viewTraceAirWaybill.do' }
  }
};

const domErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => {
  const message = String((err && err.message) || err);
  if (!/Not implemented/.test(message)) domErrors.push(message);
});
let mode = 'cj';
let fetched = [];

function buildDom(url = 'https://www.wimp911.com/', browserLanguage = 'ko-KR') {
  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
  return new JSDOM(html, {
    url,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    virtualConsole,
    beforeParse(window) {
      Object.defineProperty(window.navigator, 'language', { value: browserLanguage, configurable: true });
      Object.defineProperty(window.navigator, 'languages', { value: [browserLanguage], configurable: true });
      const ctx = new Proxy({}, {
        get: (t, k) => {
          if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop() {} });
          if (k === 'createImageData') return (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) });
          if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(1024 * 512 * 4) });
          if (k === 'measureText') return () => ({ width: 12 });
          return () => {};
        },
        set: () => true
      });
      window.HTMLCanvasElement.prototype.getContext = () => ctx;
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; };
      window.fetch = async (url) => {
        const target = String(url);
        fetched.push(target);
        let payload;
        if (target.includes('api/plane')) payload = mode === 'plane-none' ? PLANE_NONE_RESPONSE : mode === 'plane-fail' ? PLANE_FAIL_RESPONSE : PLANE_RESPONSE;
        else if (target.includes('api/awb')) payload = mode === 'awb-missing' ? AWB_MISSING : AWB_RESPONSE;
        else if (mode === 'cj') payload = CJ_RESPONSE;
        else if (mode === 'dhl') payload = DHL_RESPONSE;
        else payload = NOT_FOUND_RESPONSE;
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
      };
    }
  });
}

/* index.html loads i18n.js and then app.js; the harness evaluates them the same way. */
function mount(url, browserLanguage) {
  const instance = buildDom(url, browserLanguage);
  instance.window.eval(i18nJs);
  instance.window.eval(appJs);
  return instance;
}

const dom = mount();
const { window } = dom;
const document = window.document;
const $ = (s) => document.querySelector(s);
const before = (a, b) => Boolean(a && b && (a.compareDocumentPosition(b) & window.Node.DOCUMENT_POSITION_FOLLOWING));

function submit() {
  $('#search').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

console.log('\nWIMP public UI — jsdom tests\n');

await test('idle: empty state, no default parcel, nothing fetched on load', async () => {
  assert.equal($('#number').value, '');
  assert.equal($('#events').querySelectorAll('.event').length, 0);
  assert.equal($('#count').textContent, '0');
  assert.equal($('#parcels').style.display, 'none');
  assert.equal(fetched.length, 0, 'no API call before the user asks');
});

await test('이용 안내: header entry is a link to guide.html', async () => {
  const link = $('#guide-link');
  assert.ok(link, 'guide link exists');
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('href'), 'guide.html');
  assert.equal(link.textContent, '이용 안내');
});

await test('이용 안내 click does not open the settings dialog', async () => {
  const modal = $('#modal');
  modal.open = false;
  const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  const notPrevented = $('#guide-link').dispatchEvent(ev);
  assert.equal(modal.open, false, 'settings dialog stayed closed');
  assert.equal(notPrevented, true, 'link default navigation is not prevented');
});

await test('⚙ button alone opens the settings dialog', async () => {
  $('#settings').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal($('#modal').open, true);
  $('#modal').close();
  assert.equal($('#modal').open, false);
});

await test('“조회 안내” in the result bar also links to the guide, not to settings', async () => {
  const notify = $('#notify');
  assert.equal(notify.tagName, 'A');
  assert.equal(notify.getAttribute('href'), 'guide.html#how');
  $('#modal').open = false;
  notify.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal($('#modal').open, false);
});

await test('layout order: status badge → last location → last scan → globe → history', async () => {
  const badge = $('.history-summary .badge');
  const location = $('#location');
  const lastTime = $('#last-time');
  const globe = $('#globe');
  const events = $('#events');
  assert.ok(badge && location && lastTime && globe && events);
  assert.ok(before($('#result-head'), $('.workspace')), 'status strip comes before the workspace');
  assert.ok(before(badge, location), 'status badge before last location');
  assert.ok(before(location, lastTime), 'last location before last scan time');
  assert.ok(before(lastTime, globe), 'last scan time before the globe');
  assert.ok(before(globe, events), 'globe before the detail timeline');
});

await test('layout order: everything sits between the parcel card and the globe', async () => {
  const parcels = $('#parcels');
  const head = $('#result-head');
  assert.ok(before(parcels, head), 'result strip below the parcel card');
});

await test('lookup: status, EDD, last location and last scan fill the strip', async () => {
  $('#number').value = '123-456-7890';
  $('#carrier').value = 'auto';
  submit();
  await tick(80);
  assert.equal($('#events').querySelectorAll('.event').length, 3);
  assert.equal($('.history-summary .badge').textContent, '배송 출발');
  assert.equal($('#edd').hidden, false);
  assert.equal($('#edd').textContent, '도착 예정 · 12월 1일');
  assert.equal($('#location').textContent, '수원, 대한민국');
  assert.equal($('#last-time').textContent, '11월 21일 12:42');
  assert.equal($('#updated').textContent.startsWith('최종 갱신'), true);
  assert.ok(fetched.at(-1).includes('number=1234567890'), fetched.at(-1));
});

await test('lookup: globe receives the route, timeline stays newest-first', async () => {
  assert.equal($('#events .event h3').textContent, '배송할 예정입니다');
  assert.equal($('#steps .step.current').textContent.includes('배송 출발'), true);
});

await test('error: strip keeps its place and shows the failure', async () => {
  mode = 'error';
  $('#number').value = '9999999999999';
  submit();
  await tick(80);
  assert.ok($('#events .error-box'));
  assert.equal($('.history-summary .badge').textContent, '—');
  assert.equal($('#location').textContent, '—');
  assert.equal($('.map-status').classList.contains('is-error'), true);
  assert.equal($('.bottom .panel-title .accent').textContent, '조회된 배송 정보가 없습니다.', 'an answer is not called a broken API');
  mode = 'cj';
});

function langOptions() {
  return [...document.querySelectorAll('#lang-list .lang-option')];
}

function pickLang(code) {
  if ($('#lang-menu').hidden) $('#lang-button').dispatchEvent(new window.Event('click', { bubbles: true }));
  const option = langOptions().find((o) => o.dataset.lang === code);
  assert.ok(option, 'option ' + code + ' exists');
  option.dispatchEvent(new window.Event('click', { bubbles: true }));
}

await test('language: the dropdown lists 19 languages by native name, no native <select>', async () => {
  assert.equal($('#language'), null, 'the old select is gone');
  $('#lang-button').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal($('#lang-menu').hidden, false, 'the panel opens');
  assert.equal($('#lang-button').getAttribute('aria-expanded'), 'true');
  const options = langOptions();
  assert.equal(options.length, 19);
  assert.deepEqual(options.slice(0, 3).map((o) => o.dataset.lang), ['ko', 'en', 'ja']);
  const natives = options.map((o) => o.querySelector('.lang-native').textContent);
  assert.equal(new Set(natives).size, natives.length, 'native names are unique');
  for (const name of ['한국어', 'English', '日本語', '简体中文', '繁體中文', 'Español', 'Français', 'Deutsch', 'Português', 'Italiano', 'Русский', 'العربية', 'Tiếng Việt', 'ภาษาไทย', 'Bahasa Indonesia', 'हिन्दी', 'Türkçe', 'Nederlands', 'Polski']) {
    assert.ok(natives.includes(name), 'dropdown shows ' + name);
  }
  assert.equal(options.find((o) => o.dataset.lang === 'ko').getAttribute('aria-selected'), 'true', 'current language marked');
  $('#lang-button').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal($('#lang-menu').hidden, true, 'the trigger closes it again');
});

await test('language: English relabels the strip, the count and the guide links', async () => {
  $('#number').value = '1234567890';
  submit();
  await tick(80);
  pickLang('en');
  assert.equal($('#lang-current').textContent, 'English');
  assert.equal($('#guide-link').textContent, 'How it works');
  assert.equal($('.result-label').textContent, 'Current status');
  assert.equal($('.result-head .map-status small').textContent, 'LAST CONFIRMED LOCATION');
  assert.equal($('#last-time').textContent, '21 Nov, 12:42');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(window.location.search, '?lang=en');
  assert.equal($('#guide-link').getAttribute('href'), 'guide.html?lang=en');
  assert.equal($('#notify').getAttribute('href'), 'guide.html?lang=en#how');
  assert.match($('#parcels').textContent, /3 events/, 'a space before the count in English');
  pickLang('ja');
  assert.equal($('.result-label').textContent, '現在の配送状況');
  assert.match($('#parcels').textContent, /3件/, 'no space before the count in Japanese');
  pickLang('ko');
  assert.equal($('.result-label').textContent, '현재 배송 상태');
  assert.equal($('#guide-link').getAttribute('href'), 'guide.html', 'Korean links stay clean');
  assert.equal(window.location.search, '?lang=ko');
});

await test('language: Arabic flips the page to RTL and back to LTR', async () => {
  pickLang('ar');
  assert.equal(document.documentElement.dir, 'rtl');
  assert.equal(document.documentElement.lang, 'ar');
  assert.equal($('.result-label').textContent, 'الحالة الحالية');
  pickLang('ko');
  assert.equal(document.documentElement.dir, 'ltr');
});

await test('language: ?lang=fr decides the first paint without any stored preference', async () => {
  const fr = mount('https://www.wimp911.com/?lang=fr');
  const doc = fr.window.document;
  assert.equal(doc.documentElement.lang, 'fr');
  assert.equal(doc.querySelector('.result-label').textContent, 'Statut actuel');
  assert.equal(doc.querySelector('#lang-current').textContent, 'Français');
  assert.equal(doc.querySelector('#guide-link').getAttribute('href'), 'guide.html?lang=fr');
  assert.equal(fr.window.localStorage.length, 0, 'nothing written to browser storage');
  fr.window.close();
});

await test('language: the browser preference decides on its own, unknown ones fall back to English', async () => {
  const de = mount('https://www.wimp911.com/', 'de-AT');
  assert.equal(de.window.document.documentElement.lang, 'de');
  assert.equal(de.window.document.querySelector('.result-label').textContent, 'Aktueller Status');
  de.window.close();
  const zh = mount('https://www.wimp911.com/', 'zh-Hant-HK');
  assert.equal(zh.window.document.documentElement.lang, 'zh-TW');
  zh.window.close();
  const sv = mount('https://www.wimp911.com/', 'sv-SE');
  assert.equal(sv.window.document.documentElement.lang, 'en');
  sv.window.close();
});

await test('language: every one of the 19 dictionaries fills the whole UI', async () => {
  const hangul = /[\uac00-\ud7a3]/;
  const codes = langOptions().map((o) => o.dataset.lang);
  const labels = [...document.querySelectorAll('[data-i]')].map((el) => el.dataset.i);
  for (const code of codes) {
    pickLang(code);
    assert.equal(document.documentElement.lang, code);
    for (const el of document.querySelectorAll('[data-i]')) {
      const text = el.textContent.trim();
      assert.ok(text, `${code}: data-i="${el.dataset.i}" is empty`);
      assert.notEqual(text, el.dataset.i, `${code}: shows the raw key ${el.dataset.i}`);
      if (!['ko', 'ja', 'zh-CN', 'zh-TW'].includes(code)) {
        assert.ok(!hangul.test(text), `${code}: data-i="${el.dataset.i}" still shows Korean: ${text}`);
      }
    }
    assert.ok($('#number').placeholder.trim(), `${code}: placeholder is empty`);
    for (const el of document.querySelectorAll('[data-i-aria]')) {
      const label = (el.getAttribute('aria-label') || '').trim();
      assert.ok(label, `${code}: aria-label on ${el.id || el.className} is empty`);
      if (!['ko', 'ja', 'zh-CN', 'zh-TW'].includes(code)) {
        assert.ok(!hangul.test(label), `${code}: aria-label still Korean: ${label}`);
      }
    }
  }
  assert.equal(labels.length > 40, true, 'the dictionary covers the whole page');
  pickLang('ko');
});

await test('app.js never touches browser storage (the privacy page says so)', async () => {
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(appJs), 'no browser storage in app.js');
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(apiJs), 'no cookie handling in the API');
});

await test('guide.html: AdSense tag, canonical and rich content sections', async () => {
  const guide = read('guide.html');
  assert.ok(guide.includes(ADSENSE), 'AdSense script on the guide page');
  assert.ok(guide.includes('<link rel="canonical" href="https://www.wimp911.com/guide.html">'));
  assert.ok(guide.includes('<html lang="ko">'));
  for (const id of ['how', 'carriers', 'status', 'not-found', 'route', 'edd', 'privacy', 'faq']) {
    assert.ok(guide.includes(`id="${id}"`), 'section #' + id);
  }
  const text = guide.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const phrase of ['Label created', 'Customs clearance', 'Out for delivery', '송장번호가 조회되지 않는 5가지 이유', '인천국제공항', '도착 예정일', '자주 묻는 질문']) {
    assert.ok(text.includes(phrase), 'guide mentions ' + phrase);
  }
  assert.ok(text.replace(/\s/g, '').length > 6000, 'guide has substantial content');
});

await test('guide.html: FAQ structured data matches the visible questions', async () => {
  const guide = read('guide.html');
  const blocks = [...guide.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const graph = blocks.flatMap((b) => b['@graph'] || [b]);
  const faq = graph.find((n) => n['@type'] === 'FAQPage');
  assert.ok(faq, 'FAQPage node present');
  assert.ok(faq.mainEntity.length >= 8, 'at least 8 questions');
  const visible = guide.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const q of faq.mainEntity) {
    assert.ok(visible.includes(q.name), 'visible question: ' + q.name);
    assert.ok(q.acceptedAnswer.text.length > 30, 'answer text for ' + q.name);
  }
  assert.ok(graph.some((n) => n['@type'] === 'BreadcrumbList'), 'breadcrumb present');
});

await test('index links the guide from the header, result bar, teaser and footer', async () => {
  const links = [...document.querySelectorAll('a[href^="guide.html"]')].map((a) => a.getAttribute('href'));
  assert.ok(links.includes('guide.html'), 'plain guide link');
  assert.ok(links.includes('guide.html#how'), 'how-to anchor');
  assert.ok(links.includes('guide.html#status'), 'status anchor');
  assert.ok(links.includes('guide.html#not-found'), 'not-found anchor');
  assert.ok(links.includes('guide.html#faq'), 'faq anchor');
  assert.ok($('.footer-legal a[href="guide.html"]'), 'footer link');
});

await test('sitemap.xml lists the guide page', async () => {
  const sitemap = read('sitemap.xml');
  assert.ok(sitemap.includes('<loc>https://www.wimp911.com/guide.html</loc>'));
  assert.ok(/<loc>https:\/\/www\.wimp911\.com\/guide\.html<\/loc>\s*<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/.test(sitemap));
});

await test('privacy.html describes the implementation, not a database', async () => {
  const privacy = read('privacy.html');
  assert.ok(privacy.includes('영구 저장하지 않습니다'));
  assert.ok(privacy.includes('최대 15분'));
  assert.ok(/localStorage/.test(privacy) && /IndexedDB/.test(privacy), 'browser storage scope spelled out');
  assert.ok(privacy.includes('lastscanned.com'), 'the aggregation API that receives the number is disclosed');
  assert.ok(privacy.includes('OpenStreetMap'), 'geocoding recipient disclosed');
  assert.ok(!/언어 설정<\/td>/.test(privacy), 'no longer claims a language preference is stored');
  assert.ok(privacy.includes('guide.html'), 'links to the guide');
});

await test('every published page carries the AdSense client and a canonical URL', async () => {
  for (const page of ['index.html', 'guide.html', 'privacy.html', 'terms.html']) {
    const html = read(page);
    assert.ok(html.includes(ADSENSE), page + ' has the AdSense tag');
    assert.ok(/<link rel="canonical"/.test(html), page + ' has a canonical link');
  }
});

await test('no key, mailbox or tracking number leaks into the public files', async () => {
  for (const page of ['index.html', 'guide.html', 'privacy.html', 'terms.html', 'app.js']) {
    const html = read(page);
    assert.ok(!/LASTSCANNED_API_KEY\s*=\s*['"][^'"]+/.test(html), 'no inline key in ' + page);
  }
  assert.ok(!/lsk_[A-Za-z0-9]/.test(JSON.stringify([read('guide.html'), read('app.js')])), 'no lastscanned key');
});

/* ------------------------------------------------------------------ *
 * Air cargo: dropdown, AWB result, flight result, freighter radar
 * ------------------------------------------------------------------ */

await test('search: the carrier list offers air cargo / flight lookup', async () => {
  const option = [...document.querySelectorAll('#carrier option')].find((o) => o.value === 'AIR');
  assert.ok(option, 'AIR option exists');
  assert.ok(option.textContent.includes('AWB'));
  assert.ok(option.textContent.includes('Flight'));
});

await test('awb: 988-12345675 renders the shipment, its flights and live aircraft', async () => {
  mode = 'cj';
  $('#number').value = '988-12345675';
  $('#carrier').value = 'AIR';
  submit();
  await tick(120);

  assert.equal($('#parcels .parcel strong').textContent, '988-12345675');
  assert.equal($('.history-summary .badge').textContent, '통관·수령 통지');
  assert.equal($('#events').querySelectorAll('.event').length, 4);
  assert.equal($('#events .event small').textContent, '2026-11-27 08:40 · 인천');
  assert.ok($('#location').textContent.includes('인천'));
  assert.equal(document.querySelectorAll('#steps .step').length, 5);
  assert.equal($('#steps .step.current').textContent.includes('통관·통지'), true);
  assert.ok(fetched.some((u) => u.includes('api/awb?no=98812345675')), 'AWB endpoint called');

  assert.ok(fetched.some((u) => u.includes('api/plane?cs=OZ201')), 'aircraft for the AWB flight requested');
});

await test('awb: the radar strip names the live aircraft and credits adsb.lol', async () => {
  assert.equal($('#radar').hidden, false);
  assert.equal($('#radar-title').textContent, '실시간 운항 화물기 레이더');
  assert.ok($('#radar-sub').textContent.includes('OZ201'));
  assert.ok($('#radar-list').textContent.includes('BCS123'));
  assert.ok($('#radar-list').textContent.includes('33,000 ft'));
  assert.ok($('#radar').querySelector('.radar-src').textContent.includes('adsb.lol'));
});

await test('awb: a number the airline does not know explains itself', async () => {
  mode = 'awb-missing';
  $('#number').value = '98812345675';
  submit();
  await tick(120);
  assert.ok($('#events .error-box'));
  assert.equal($('.history-summary .badge').textContent, '—');
  assert.equal($('#radar').hidden, true, 'no radar without a shipment');
  mode = 'cj';
});

await test('flight: KE082 shows the aircraft position in flight', async () => {
  $('#number').value = 'KE082';
  $('#carrier').value = 'AIR';
  submit();
  await tick(120);

  assert.equal($('#parcels .parcel strong').textContent, 'KE082');
  assert.equal($('.history-summary .badge').textContent, '운항 중');
  assert.equal($('#radar-title').textContent, '실시간 항공기 위치');
  assert.ok($('#location').textContent.includes('°N'));
  assert.equal($('.bottom').classList.contains('is-hidden'), true, 'parcel-only panels are hidden');
  assert.ok(fetched.at(-1).includes('api/plane?cs=KE082') || fetched.some((u) => u.includes('api/plane?cs=KE082')));
});

await test('flight: an answered lookup with no aircraft says “관측된 항공기 없음”, not “API 미연결”', async () => {
  mode = 'plane-none';
  $('#number').value = 'KE9999';
  $('#carrier').value = 'AIR';
  submit();
  await tick(120);

  const accent = $('.bottom .panel-title .accent');
  assert.ok($('#events .error-box'), 'the reason is still explained');
  assert.equal(accent.textContent, '관측된 항공기 없음');
  assert.ok(!accent.textContent.includes('API 미연결'), 'a 200 answer is not called a broken API');
  assert.ok(fetched.some((u) => u.includes('api/plane?cs=KE9999')), 'the flight endpoint was asked');

  pickLang('en');
  assert.equal($('.bottom .panel-title .accent').textContent, 'No aircraft observed');
  pickLang('ko');
  mode = 'cj';
});

await test('flight: a failed aircraft feed still says “최종 갱신: API 미연결”', async () => {
  mode = 'plane-fail';
  $('#number').value = 'KE082';
  $('#carrier').value = 'AIR';
  submit();
  await tick(120);

  const accent = $('.bottom .panel-title .accent');
  assert.ok($('#events .error-box'));
  assert.equal(accent.textContent, '최종 갱신: API 미연결');
  pickLang('en');
  assert.equal($('.bottom .panel-title .accent').textContent, 'Last updated: API not connected');
  pickLang('ko');
  mode = 'cj';
});

await test('parcel: an overseas parcel on the move gets the freighter radar', async () => {
  mode = 'dhl';
  $('#number').value = '1234567895';
  $('#carrier').value = 'auto';
  const before = fetched.length;
  submit();
  await tick(150);

  const planeCall = fetched.slice(before).find((u) => u.includes('api/plane'));
  assert.ok(planeCall, 'radar requested for an undelivered overseas parcel');
  assert.ok(planeCall.includes('carrier=DHL'));
  assert.equal($('#radar').hidden, false);
  assert.equal($('#radar-title').textContent, '실시간 운항 화물기 레이더');
  assert.equal($('.bottom').classList.contains('is-hidden'), false);
});

await test('parcel: a domestic parcel never asks for aircraft', async () => {
  mode = 'cj';
  $('#number').value = '1234567890';
  $('#carrier').value = 'auto';
  const before = fetched.length;
  submit();
  await tick(120);
  assert.equal(fetched.slice(before).filter((u) => u.includes('api/plane')).length, 0);
  assert.equal($('#radar').hidden, true);
  assert.equal($('.bottom').classList.contains('is-hidden'), false);
});

await test('privacy.html discloses the airline and adsb.lol recipients', async () => {
  const privacy = read('privacy.html');
  assert.ok(privacy.includes('adsb.lol'), 'adsb.lol row');
  assert.ok(privacy.includes('asianacargo.com') && privacy.includes('cargo.koreanair.com'), 'airline rows');
  assert.ok(privacy.includes('ODbL'), 'licence named');
  assert.ok(/화주·수하인/.test(privacy), 'shipper/consignee handling stated');
});

await test('guide.html explains the radar and AWB lookup', async () => {
  const guide = read('guide.html');
  assert.ok(guide.includes('id="aircargo"'), 'air cargo section');
  assert.ok(guide.includes('href="#aircargo"'), 'section is in the table of contents');
  const text = guide.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const phrase of ['항공 화물운송장(AWB)', 'adsb.lol', 'ODbL 1.0', '250NM', '체크디지트']) {
    assert.ok(text.includes(phrase), 'guide mentions ' + phrase);
  }
});

await test('index links the air cargo section from the guide teaser', async () => {
  const links = [...document.querySelectorAll('a[href^="guide.html"]')].map((a) => a.getAttribute('href'));
  assert.ok(links.includes('guide.html#aircargo'));
});

await test('names: airline and airport labels follow the chosen language', async () => {
  mode = 'awb';
  pickLang('en');
  $('#number').value = '98812345675';
  $('#carrier').value = 'auto';
  submit();
  await tick(80);
  assert.equal($('#location').textContent, 'Incheon, South Korea');
  assert.ok($('#parcels').textContent.includes('Asiana Airlines'), 'airline in romanised form');
  assert.ok(!/[\uac00-\ud7a3]/.test($('#parcels').textContent), 'no Korean left in the parcel row');
  assert.ok(!/[\uac00-\ud7a3]/.test($('#location').textContent), 'no Korean left in the location');
  pickLang('ko');
  assert.equal($('#location').textContent, '인천, 대한민국');
  assert.ok($('#parcels').textContent.includes('아시아나항공'), 'Korean airline name in Korean');
  pickLang('ko');
  mode = 'cj';
});

await test('flight: an unobserved flight number is explained in the chosen language', async () => {
  mode = 'plane-none';
  pickLang('ko');
  $('#number').value = 'KE9999';
  $('#carrier').value = 'auto';
  submit();
  await tick(120);
  const box = $('#events .error-box');
  assert.ok(box, 'an error box is shown');
  assert.equal(box.querySelector('h3').textContent, '이 편명의 항공기가 관측되지 않습니다.');
  assert.match(box.querySelector('p').textContent, /레이더/);
  pickLang('de');
  const deBox = $('#events .error-box');
  assert.equal(deBox.querySelector('h3').textContent, 'Mit dieser Flugnummer wird kein Flugzeug beobachtet.');
  assert.ok(!/[\uac00-\ud7a3]/.test(deBox.textContent), 'no Korean hint left in German');
  pickLang('ko');
  mode = 'cj';
});

await test('no runtime jsdom errors', async () => {
  assert.deepEqual(domErrors, []);
});

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) process.exit(1);
