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
    kind: 'NOT_FOUND',
    retryable: false,
    carrier: { code: 'CJ', name: 'CJ대한통운', site: 'https://www.cjlogistics.com/ko/tool/parcel/tracking' }
  }
};

/* The carrier did not answer — a moment, not an answer. */
const UPSTREAM_RESPONSE = {
  ok: false,
  error: {
    code: 'UPSTREAM',
    message: '택배사 조회 서버가 응답하지 않습니다.',
    hint: '잠시 후 다시 시도하거나, 택배사 사이트에서 직접 확인해 주세요.',
    kind: 'SERVICE',
    retryable: true
  }
};

const DHL_INCHEON = { name: 'INCHEON OUTSKIRT OF SEOUL, KOREA, REPUBLIC OF (SOUTH K.)', city: '인천', code: 'ICN', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR', lat: 37.4563, lng: 126.7052 };
const DHL_SOFIA = { name: 'SOFIA, BULGARIA', city: 'Sofia', code: 'SOF', country: '불가리아', countryEn: 'Bulgaria', countryCode: 'BG', lat: 42.6977, lng: 23.3219 };
const DHL_LEIPZIG = { name: 'LEIPZIG, GERMANY', city: 'Leipzig', code: 'LEJ', country: '독일', countryEn: 'Germany', countryCode: 'DE', lat: 51.3397, lng: 12.3731 };
const PRE_CLEARANCE = 'Customs clearance status updated. Note - The Customs clearance process may start in the destination country';

/* The reported case: DHL opens the customs file at Incheon before the parcel
   ever leaves Sofia, so the raw scan order reads BG → KR → BG → DE → KR → DE. */
const DHL_PRECLEARANCE_RESPONSE = {
  ok: true,
  carrier: { code: 'DHL', name: 'DHL', site: 'https://www.dhl.com/kr-ko/home/tracking.html' },
  number: '2746217154',
  status: { code: 'IN_TRANSIT', label: '이동 중', stage: 2, delivered: false },
  estimatedDelivery: null,
  latest: { time: '2026-11-28T08:05:00+09:00', scan: 'Departed from LEIPZIG - GERMANY', location: { name: 'LEIPZIG, GERMANY' } },
  events: [
    { time: '2026-11-26T05:10:00+09:00', scan: PRE_CLEARANCE, description: '통관 정보가 갱신되었습니다', status: { code: 'IN_TRANSIT' }, location: DHL_INCHEON, physical: false },
    { time: '2026-11-26T22:57:00+09:00', scan: 'Shipment picked up', description: 'DHL 화물이 접수되었습니다', status: { code: 'PICKED_UP' }, location: DHL_SOFIA, physical: true },
    { time: '2026-11-27T03:26:00+09:00', scan: PRE_CLEARANCE, description: '통관 정보가 갱신되었습니다', status: { code: 'IN_TRANSIT' }, location: DHL_INCHEON, physical: false },
    { time: '2026-11-27T18:40:00+09:00', scan: 'Processed at LEIPZIG - GERMANY', description: '라이프치히 허브에서 처리되었습니다', status: { code: 'IN_TRANSIT' }, location: DHL_LEIPZIG, physical: true },
    { time: '2026-11-28T00:10:00+09:00', scan: 'Processed at LEIPZIG - GERMANY', description: '라이프치히 허브에서 처리되었습니다', status: { code: 'IN_TRANSIT' }, location: { ...DHL_LEIPZIG }, physical: true },
    { time: '2026-11-28T06:30:00+09:00', scan: 'Customs clearance status updated - INCHEON', description: '통관 정보가 갱신되었습니다', status: { code: 'IN_TRANSIT' }, location: { ...DHL_INCHEON }, physical: false },
    { time: '2026-11-28T08:05:00+09:00', scan: 'Departed from LEIPZIG - GERMANY', description: '라이프치히 허브를 출발했습니다', status: { code: 'IN_TRANSIT' }, location: { ...DHL_LEIPZIG }, physical: true }
  ],
  route: [],
  countries: ['BG', 'DE'],
  meta: { source: 'dhl', cached: false, demo: false, fetchedAt: '2026-11-28T01:00:00.000Z' }
};

/* The same parcel after it physically lands at Incheon: KR must appear once, at the end. */
const DHL_ARRIVED_RESPONSE = {
  ...DHL_PRECLEARANCE_RESPONSE,
  events: [
    ...DHL_PRECLEARANCE_RESPONSE.events,
    { time: '2026-11-29T09:20:00+09:00', scan: 'Arrived at INCHEON - KOREA', description: '인천에 도착했습니다', status: { code: 'IN_TRANSIT' }, location: { ...DHL_INCHEON }, physical: true }
  ],
  countries: ['BG', 'DE', 'KR'],
  meta: { source: 'dhl', cached: false, demo: false, fetchedAt: '2026-11-28T01:00:00.000Z' }
};

/* The API's own answer: the carrier's destination field names Seoul, while the
   customs notice sits at Incheon. The declared destination has to win. */
const DHL_PLANNED_RESPONSE = {
  ...DHL_PRECLEARANCE_RESPONSE,
  plannedDestination: { lat: 37.5665, lng: 126.978, name: 'SEOUL', detail: 'SEOUL, KOREA', code: 'SEL', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR', precision: 'hub' },
  meta: { source: 'lastscanned', cached: false, demo: false, fetchedAt: '2026-11-28T01:00:00.000Z' }
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

/* A miniature TopoJSON stands in for public/world-110m.json: quantized,
   delta-encoded arcs, one Polygon and one MultiPolygon — the same shapes the
   decoder has to handle, without a 107 KB fixture in the test. */
const WORLD_FIXTURE = {
  type: 'Topology',
  transform: { scale: [0.0001, 0.0001], translate: [124, 33] },
  objects: {
    countries: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Polygon', arcs: [[0]], properties: { name: 'Fixtureland' } },
        { type: 'MultiPolygon', arcs: [[[1]]], properties: { name: 'Fixtureisle' } }
      ]
    }
  },
  arcs: [
    [[0, 0], [130000, 0], [0, 80000], [-130000, 0], [0, -80000]],
    [[0, 0], [40000, 0], [0, 40000], [-40000, 0], [0, -40000]]
  ]
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
      window.WIMP_WORLD = WORLD_FIXTURE;
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; };
      window.fetch = async (url) => {
        const target = String(url);
        fetched.push(target);
        let payload;
        if (mode === 'cj') payload = CJ_RESPONSE;
        else if (mode === 'dhl') payload = DHL_RESPONSE;
        else if (mode === 'dhl-pre') payload = DHL_PRECLEARANCE_RESPONSE;
        else if (mode === 'dhl-planned') payload = DHL_PLANNED_RESPONSE;
        else if (mode === 'dhl-arrived') payload = DHL_ARRIVED_RESPONSE;
        else if (mode === 'upstream') payload = UPSTREAM_RESPONSE;
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
  assert.equal($('#count').textContent, '0건');
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
 * Parcel-only product: the air cargo / flight surface stays out
 * ------------------------------------------------------------------ */

await test('search: the carrier list has no air cargo / flight entry', async () => {
  const values = [...document.querySelectorAll('#carrier option')].map((o) => o.value);
  assert.ok(!values.includes('AIR'), 'no AIR option');
  assert.ok(!values.includes('AWB') && !values.includes('FLIGHT'), 'no AWB or FLIGHT option');
  assert.ok(values.includes('CJ') && values.includes('GLOBAL') && values.includes('DHL'), 'parcel carriers are still offered');
});

await test('index.html ships no freighter radar strip and no plane markers', async () => {
  assert.equal($('#radar'), null, 'radar strip element is gone');
  assert.equal($('#radar-list'), null);
  for (const selector of ['.radar', '.radar-chip', '.globe-plane']) assert.equal(document.querySelector(selector), null, selector + ' is gone');
});

await test('app.js never reaches the removed air endpoints', async () => {
  assert.ok(!/api\/plane|api\/awb/.test(appJs), 'no /api/plane or /api/awb call');
  assert.ok(!/radarTitle|radar-list|airStages|detectAir|lookupAwb|lookupFlight/.test(appJs), 'no radar / AWB / flight code paths');
  assert.ok(!/setInterval\([\s\S]{0,120}60000/.test(appJs), 'the 1-minute aircraft poll is gone');
});

await test('privacy.html lists no airline or adsb.lol recipient', async () => {
  const privacy = read('privacy.html');
  assert.ok(!privacy.includes('adsb.lol'), 'no adsb.lol row');
  assert.ok(!privacy.includes('asianacargo.com') && !privacy.includes('cargo.koreanair.com'), 'no airline rows');
  assert.ok(!/ODbL/.test(privacy), 'no ADS-B licence note');
  assert.ok(privacy.includes('lastscanned.com'), 'the aggregation API that receives the number is still disclosed');
  assert.ok(privacy.includes('Web Analytics'), 'Vercel Web Analytics stays disclosed');
});

await test('guide.html has no radar / AWB section and its numbering stays contiguous', async () => {
  const guide = read('guide.html');
  assert.ok(!guide.includes('id="aircargo"'), 'air cargo section removed');
  assert.ok(!/href="#aircargo"/.test(guide), 'table of contents cleaned');
  const heads = [...guide.matchAll(/<h2[^>]*>(\d)\.\s/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['1', '2', '3', '4', '5', '6', '7', '8'], 'sections renumbered 1-8');
});

await test('parcel: an overseas parcel is looked up without any aircraft request', async () => {
  mode = 'dhl';
  pickLang('ko');
  $('#number').value = '1234567895';
  $('#carrier').value = 'auto';
  const before = fetched.length;
  submit();
  await tick(150);
  assert.ok(fetched.slice(before).some((u) => u.includes('api/track')), 'the parcel endpoint was asked');
  assert.equal(fetched.slice(before).filter((u) => /plane|awb/.test(u)).length, 0, 'no aircraft request');
  assert.ok($('#location').textContent.includes('인천'), 'the last scan location still renders');
  mode = 'cj';
});

/* ------------------------------------------------------------------ *
 * 2026-11-28 — route accuracy, refresh safety, fetch time, count label
 * ------------------------------------------------------------------ */

await test('route: a destination customs notice never becomes a stop', async () => {
  mode = 'dhl-pre';
  pickLang('ko');
  $('#number').value = '2746217154';
  $('#carrier').value = 'auto';
  submit();
  await tick(120);

  const chips = [...document.querySelectorAll('#countries div')]
    .map((n) => `${n.querySelector('b').textContent} ${n.querySelector('small').textContent}`);
  assert.deepEqual(chips, ['BG Sofia', 'DE Leipzig', 'KR 인천 (예정)'], 'the stops it made, then where it is headed');
  assert.equal($('#location').textContent, 'Leipzig, 독일');

  const notice = [...$('#events').querySelectorAll('.event')].find((e) => /이동 스캔 아님/.test(e.querySelector('small').textContent));
  assert.ok(notice, 'the customs notice still appears in the timeline');
  assert.equal(notice.querySelector('h3').textContent, '통관 정보가 갱신되었습니다');
});

await test('route: the planned leg is drawn dashed from the last stop to the destination', async () => {
  assert.equal(window.WIMP_MAP.planned, '인천', 'the destination came back from the notice');
  assert.equal(window.WIMP_MAP.arcs, 2, 'one confirmed leg + one planned leg');
  assert.equal($('#legend-planned').style.display, 'flex', 'the legend explains the dashed line');
  assert.equal($('#legend-planned').textContent.trim(), '예정 경로');

  $('#view-flat').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(window.WIMP_MAP.arcs, 2, 'the 2D map draws the same two legs');
  assert.equal(window.WIMP_MAP.planned, '인천');
  $('#view-globe').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});

await test('route: the carrier destination field beats the customs port', async () => {
  mode = 'dhl-planned';
  submit();
  await tick(120);
  const chips = [...document.querySelectorAll('#countries div')]
    .map((n) => `${n.querySelector('b').textContent} ${n.querySelector('small').textContent}`);
  assert.deepEqual(chips, ['BG Sofia', 'DE Leipzig', 'KR SEOUL (예정)'], 'SEOUL is the address, INCHEON only the gateway');
  assert.equal($('#location').textContent, 'Leipzig, 독일', 'the destination is not a stop');
  const codes = [...$('#events').querySelectorAll('.event small')].map((n) => n.textContent);
  assert.ok(codes.some((t) => /이동 스캔 아님/.test(t)), 'the notice is still labelled as paperwork');
});

await test('route: a parcel that really lands shows its destination country once, at the end', async () => {
  mode = 'dhl-arrived';
  submit();
  await tick(120);
  const codes = [...document.querySelectorAll('#countries div b')].map((b) => b.textContent);
  assert.deepEqual(codes, ['BG', 'DE', 'KR']);
  assert.equal($('#location').textContent, '인천, 대한민국');
  assert.equal(window.WIMP_MAP.planned, null, 'arrived: no planned leg left to draw');
  assert.equal($('#legend-planned').style.display, 'none');
});

await test('globe: repeated scans at one city collapse into a single marker with its count', async () => {
  mode = 'dhl-pre';
  submit();
  await tick(120);
  assert.equal($('#events').querySelectorAll('.event').length, 7, 'every scan stays in the timeline');
  const leipzig = [...$('#events').querySelectorAll('.event')].find((e) => e.textContent.includes('LEIPZIG, GERMANY'));
  assert.ok(leipzig);
  leipzig.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.match($('#marker-info').textContent, /Leipzig, 독일 · 3건/, $('#marker-info').textContent);
});

await test('count: the header names what it counts — 배송 이력 7건', async () => {
  assert.equal($('.sectionline b').textContent, '배송 이력');
  assert.equal($('#count').textContent, '7건');
  pickLang('en');
  assert.equal($('.sectionline b').textContent, 'Tracking history');
  assert.equal($('#count').textContent, '7 events');
  pickLang('ko');
  assert.equal($('#count').textContent, '7건');
});

await test('updated: the fetch time comes from the result and survives a language switch', async () => {
  assert.equal($('#updated').textContent, '최종 갱신 11월 28일 10:00');
  pickLang('en');
  assert.equal($('#updated').textContent, 'Updated 28 Nov, 10:00');
  pickLang('ja');
  assert.equal($('#updated').textContent, '最終更新 11月28日 10:00');
  pickLang('ko');
  assert.equal($('#updated').textContent, '최종 갱신 11월 28일 10:00', 'the clock did not move with the redraw');
});

await test('refresh: a 5xx on the same number keeps the result and only adds a notice', async () => {
  const kept = $('#updated').textContent;
  mode = 'upstream';
  submit();
  await tick(120);

  assert.equal($('#stale-note').hidden, false);
  assert.match($('#stale-note').textContent, /다시 조회하지 못했습니다/);
  assert.match($('#stale-note').textContent, /택배사 조회 서버가 응답하지 않습니다/);
  assert.equal($('#events').querySelectorAll('.event').length, 7, 'the timeline is still there');
  assert.equal($('#events .error-box'), null, 'no error box replaced the result');
  assert.equal($('#location').textContent, 'Leipzig, 독일');
  assert.equal($('#updated').textContent, kept, 'the successful fetch time is unchanged');
  assert.equal($('#count').textContent, '7건');
});

await test('refresh: the notice disappears when the carrier answers again', async () => {
  mode = 'dhl-pre';
  submit();
  await tick(120);
  assert.equal($('#stale-note').hidden, true);
  assert.equal($('#events').querySelectorAll('.event').length, 7);
});

await test('error: a real “no such shipment” replaces the result instead of keeping it', async () => {
  mode = 'notfound';
  submit();
  await tick(120);
  assert.ok($('#events .error-box'));
  assert.equal($('#stale-note').hidden, true);
  assert.equal($('#location').textContent, '—');
  assert.equal($('.bottom .panel-title .accent').textContent, '조회된 배송 정보가 없습니다.');
});

await test('error: “the carrier is down” and “no such shipment” read differently', async () => {
  mode = 'upstream';
  $('#number').value = '1111111111';
  submit();
  await tick(120);
  assert.equal($('.bottom .panel-title .accent').textContent, '택배사 조회 서버가 응답하지 않습니다.');
  const box = $('#events .error-box');
  assert.ok(box);
  assert.match(box.querySelector('p').textContent, /다시 시도/);
  mode = 'cj';
});

/* ------------------------------------------------------------------ *
 * 3D globe ↔ 2D flat map
 * ------------------------------------------------------------------ */

await test('map switch: the panel offers 3D globe and 2D map, globe by default', async () => {
  pickLang('ko');
  const group = $('#map-switch');
  assert.ok(group, 'switch exists');
  assert.equal(group.getAttribute('role'), 'group');
  assert.equal(group.getAttribute('aria-label'), '지도 보기 전환');
  assert.ok(group.closest('.map-top'), 'the switch sits at the top of the map panel');
  assert.equal($('#view-globe').getAttribute('aria-pressed'), 'true');
  assert.equal($('#view-flat').getAttribute('aria-pressed'), 'false');
  assert.ok($('#view-globe').textContent.includes('3D 지구본'));
  assert.ok($('#view-flat').textContent.includes('2D 평면 지도'));
  assert.equal($('#map-panel').dataset.map, 'globe');
  assert.equal($('#flat-map').getAttribute('aria-hidden'), 'true');
});

await test('map switch: 2D keeps the current lookup, its route and its timeline', async () => {
  mode = 'dhl';
  $('#number').value = '1234567895';
  submit();
  await tick(120);
  const events = $('#events').querySelectorAll('.event').length;
  const location = $('#location').textContent;
  const lookups = fetched.filter((url) => url.includes('api/track')).length;
  assert.equal(events, 2);

  $('#view-flat').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal($('#map-panel').dataset.map, 'flat');
  assert.equal($('#view-flat').getAttribute('aria-pressed'), 'true');
  assert.equal($('#view-globe').getAttribute('aria-pressed'), 'false');
  assert.equal($('#flat-map').getAttribute('aria-hidden'), 'false');
  assert.equal($('#globe').getAttribute('aria-hidden'), 'true');
  assert.equal($('#location').textContent, location, 'the status strip did not move');
  assert.equal($('#events').querySelectorAll('.event').length, events, 'timeline kept');
  assert.equal(fetched.filter((url) => url.includes('api/track')).length, lookups, 'no second lookup');
  assert.ok(!fetched.some((url) => url.includes('world-50m.json')), 'the coastline file is not re-fetched when a topology is supplied');

  const state2d = window.WIMP_MAP;
  assert.equal(state2d.mode, 'flat');
  assert.equal(state2d.points, 2, 'both stops reached the 2D renderer');
  assert.equal(state2d.arcs, 1, 'the route arc reached the 2D renderer');
  assert.equal(state2d.world, 2, 'coastlines decoded from the topology');
  assert.ok($('#flat-canvas').width > 0, 'the canvas has a backing store');
  assert.ok(state2d.camera.scale > 0);

  $('#view-globe').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal($('#map-panel').dataset.map, 'globe');
  assert.equal(window.WIMP_MAP.mode, 'globe');
  assert.equal($('#flat-map').getAttribute('aria-hidden'), 'true');
  assert.equal($('#location').textContent, location, 'switching back changes nothing');
  mode = 'cj';
});

await test('map switch: both labels and the hint follow the language', async () => {
  $('#view-flat').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal($('#map-hint').textContent, '드래그하여 이동 · 스크롤하여 확대');
  assert.equal($('#map-credit').textContent, 'Map data · Natural Earth');
  pickLang('en');
  assert.ok($('#view-globe').textContent.includes('3D globe'));
  assert.ok($('#view-flat').textContent.includes('2D map'));
  assert.equal($('#map-switch').getAttribute('aria-label'), 'Map view');
  assert.equal($('#map-hint').textContent, 'Drag to pan · Scroll to zoom');
  pickLang('ja');
  assert.ok($('#view-flat').textContent.includes('2D平面地図'));
  pickLang('ar');
  assert.ok($('#view-flat').textContent.includes('2D'));
  pickLang('ko');
  $('#view-globe').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal($('#map-hint').textContent, '드래그하여 회전 · 스크롤하여 확대');
  assert.equal($('#map-credit').textContent, 'Earth imagery · NASA');
});

await test('map: the 2D view ships local vector coastlines, not a tile server', async () => {
  const html = read('index.html');
  const topoText = read('world-50m.json');
  const topo = JSON.parse(topoText);
  assert.equal(topo.type, 'Topology');
  assert.ok(topo.objects.countries.geometries.length > 100, 'a real world atlas');
  assert.ok(topoText.length < 600 * 1024, 'light enough to ship (' + topoText.length + ' bytes)');
  assert.ok(appJs.includes('world-50m.json'), 'the app reads the local file');
  assert.ok(!appJs.includes('mapbox.com') && !appJs.includes('openstreetmap.org/tiles'), 'no third-party tile host');
  assert.ok(!html.includes('leaflet') && !html.includes('mapbox'), 'no map library tag');
});

await test('no runtime jsdom errors', async () => {
  assert.deepEqual(domErrors, []);
});

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) process.exit(1);
