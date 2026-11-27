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

const domErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => {
  const message = String((err && err.message) || err);
  if (!/Not implemented/.test(message)) domErrors.push(message);
});
let mode = 'cj';
let fetched = [];

function buildDom() {
  const html = read('index.html').replace(/<script[\s\S]*?<\/script>/g, '');
  return new JSDOM(html, {
    url: 'https://www.wimp911.com/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    virtualConsole,
    beforeParse(window) {
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
        fetched.push(String(url));
        const payload = mode === 'cj' ? CJ_RESPONSE : NOT_FOUND_RESPONSE;
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
      };
    }
  });
}

const dom = buildDom();
const { window } = dom;
window.eval(appJs);
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
  mode = 'cj';
});

await test('language switch relabels the strip and the guide link label', async () => {
  $('#number').value = '1234567890';
  submit();
  await tick(80);
  $('#language').value = 'en';
  $('#language').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal($('#guide-link').textContent, 'How it works');
  assert.equal($('.result-label').textContent, 'Current status');
  assert.equal($('.result-head .map-status small').textContent, 'LAST CONFIRMED LOCATION');
  assert.equal($('#last-time').textContent, '21 Nov, 12:42');
  $('#language').value = 'ja';
  $('#language').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal($('.result-label').textContent, '現在の配送状況');
  $('#language').value = 'ko';
  $('#language').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal($('.result-label').textContent, '현재 배송 상태');
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

await test('no runtime jsdom errors', async () => {
  assert.deepEqual(domErrors, []);
});

const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (failed.length) process.exit(1);
