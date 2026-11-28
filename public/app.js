'use strict';

/* WIMP — Where Is My Parcel? · app.js
   Design, layout and the three languages are kept from the original build;
   everything that used to be fixed sample data is now driven by /api/track. */

const $ = (s) => document.querySelector(s);
const API = 'api/track';
const API_PLANE = 'api/plane';
const API_AWB = 'api/awb';
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

const strings = {
  ko: {
    dashboard: '배송 조회', shipments: '이용 안내', demo: '예시 데이터', live: '실시간 조회',
    title: '내 택배, 지금 어디쯤?', subtitle: '송장번호 하나로 만나는, 내 배송의 여정.', scan: '물류 스캔 기반 추적',
    track: '어디 있지?', loading: '배송 조회 중…', my: '조회 결과', local: '저장하지 않는 일회성 조회', notify: '조회 안내',
    journey: '배송 여정', satellite: '3D 위성 지구본', last: '마지막 확인 위치', confirmed: '확인된 경로', planned: '예정 경로',
    drag: '드래그하여 회전 · 스크롤하여 확대', history: '배송 이력', newest: '최신순', transit: '이동 중',
    historyNote: '제공된 경로 기반 예시 · 스캔 시각 미확인', notconnected: '최종 갱신: API 미연결',
    progress: '배송 진행 상황', international: '국제 운송 중', domestic: '국내 배송 중',
    notice: '인천 사전 통관 정보는 실제 도착을 의미하지 않습니다.', route: '국가별 이동 경로',
    footer: 'GPS 실시간 위치가 아닌 배송사 스캔 위치입니다.', settings: '글로벌 설정',
    settingNote: '화면 설정과 자동 갱신만 다루는 창입니다. 송장번호와 조회 결과는 저장하지 않습니다.',
    auto: '자동 갱신',
    apiNote: '실시간 조회는 택배사가 남긴 스캔 정보를 그대로 보여줍니다. 조회 결과는 15분 동안 캐시됩니다.',
    privacy: '새로고침하거나 창을 닫으면 입력한 정보가 사라집니다.',
    placeholder: '송장번호를 입력하세요', detect: '배송사 자동 인식', waiting: '배송사 선택 대기',
    edd: '도착 예정',
    carrierAuto: '배송사 자동 인식', carrierCJ: 'CJ대한통운', carrierEPOST: '우체국택배', carrierHANJIN: '한진택배', carrierLOTTE: '롯데택배',
    carrierLOGEN: '로젠택배', carrierILYANG: '일양택배', carrierDHL: 'DHL', carrierFEDEX: 'FedEx', carrierUPS: 'UPS', carrierUSPS: 'USPS',
    carrierCAINIAO: '알리익스프레스 (Cainiao)', carrierEMS: '우체국 EMS / 국제', carrierGLOBAL: '기타 글로벌 (550+ 자동)',
    stages: ['접수', '집하', '국제 운송', '배송 출발', '배송 완료'],
    stagesDomestic: ['접수', '집하', '이동 중', '배송 출발', '배달 완료'],
    sampleEvents: [
      { title: '출발지 확인', note: '출발지', place: 'Sofia, Bulgaria' },
      { title: '경유지 확인', note: '마지막 확인 위치', place: 'Leipzig, Germany' },
      { title: '사전 통관 정보 접수', note: '실제 도착 아님', place: 'Incheon, South Korea' }
    ],
    status: { DELIVERED: '배달 완료', OUT_FOR_DELIVERY: '배송 출발', IN_TRANSIT: '이동 중', PICKED_UP: '집하', REGISTERED: '접수', EXCEPTION: '예외', RETURNED: '반송', UNKNOWN: '확인 중', ARRIVED: '도착', CUSTOMS: '통관·수령 통지', IN_FLIGHT: '운항 중', GROUND: '지상' },
    errors: {
      NOT_FOUND: '조회된 배송 정보가 없습니다.', NEEDS_KEY: '해외 택배사 조회 키(LASTSCANNED_API_KEY)가 필요합니다.', UNSUPPORTED: '아직 지원하지 않는 택배사입니다.',
      UPSTREAM: '택배사 조회 서버가 응답하지 않습니다.', BAD_REQUEST: '송장번호를 다시 확인해 주세요.', NETWORK: '네트워크에 연결하지 못했습니다.',
      RATE_LIMITED: '택배사 조회 한도에 잠시 도달했습니다.',
      AWB_NOT_FOUND: '항공 화물 조회 결과가 없습니다.', AIRLINE_BLOCKED: '항공사가 자동 조회를 잠시 막고 있습니다.',
      AWB_UNSUPPORTED: '아직 지원하지 않는 항공사 AWB입니다.', IS_FLIGHT: 'AWB가 아니라 편명입니다.',
      AIR_BAD_INPUT: 'AWB(11자리) 또는 편명(KE082)을 입력해 주세요.', FLIGHT_NONE: '이 편명의 항공기가 관측되지 않습니다.'
    },
    hints: {
      NOT_FOUND: '송장번호와 자릿수를 확인하거나, 택배사가 아직 상품을 인수하지 않았을 수 있습니다.',
      NEEDS_KEY: 'lastscanned.com 키를 Vercel의 LASTSCANNED_API_KEY에 넣으면 로젠·FedEx·UPS·USPS·Cainiao·EMS 등 551개 택배사가 켜집니다.',
      UNSUPPORTED: '현재 지원: CJ대한통운 · 우체국택배 · 한진택배 · 롯데택배 · 로젠택배 · DHL · FedEx · UPS · USPS · Cainiao · EMS + 전 세계 550개 이상',
      UPSTREAM: '잠시 후 다시 시도하거나 택배사 사이트에서 직접 확인해 주세요.',
      BAD_REQUEST: '하이픈·공백·특수문자는 자동으로 정리됩니다.',
      NETWORK: '연결 상태를 확인하고 다시 시도해 주세요.',
      RATE_LIMITED: '1분 뒤 다시 시도해 주세요.',
      AWB_NOT_FOUND: 'AWB 번호를 다시 확인해 주세요. 택배 송장이라면 배송사를 직접 선택하면 택배로 조회됩니다.',
      AIRLINE_BLOCKED: '대한항공은 서버 자동 조회에 세션 확인을 요구합니다. 아래 링크에서 AWB를 직접 조회하거나 아시아나(988) · 편명 조회를 이용해 주세요.',
      AWB_UNSUPPORTED: '지금은 아시아나(988)와 대한항공(180) 화물 AWB만 조회됩니다.',
      IS_FLIGHT: '편명은 검색창에 그대로 입력하면 지구본에 항공기 위치가 표시됩니다.',
      AIR_BAD_INPUT: '예) 988-12345675 (아시아나) · 180-12345675 (대한항공) · KE082',
      FLIGHT_NONE: '지상에 있거나 레이더 범위 밖일 수 있습니다. 편명을 확인하거나 잠시 후 다시 시도해 주세요.'
    },
    openSite: '택배사 사이트에서 보기', again: '다시 조회', empty: '송장번호를 입력하면 배송 이력이 표시됩니다.',
    idle: '송장번호를 입력하면 배송 여정이 여기에 표시됩니다.', idleBadge: '대기',
    updated: '최종 갱신', events: '건', sampleNote: '예시 데이터 · 실제 조회가 아닙니다', liveNote: '택배사 스캔 기준',
    privacyLink: '개인정보처리방침', termsLink: '이용약관', noKey: 'DHL 키 없이 예시로 보기', routeDomestic: '국내 이동 경로', notYet: '조회 전',
    currentStatus: '현재 배송 상태', lastScan: '마지막 스캔', noTime: '스캔 시각 미확인', historyFoot: '최신 스캔이 가장 위에 표시됩니다',
    openGuide: '이용 안내 · 조회 방법과 오류 해결 보기 →',
    guideTitle: '배송 상태가 헷갈릴 때',
    guideLead: '“통관 중”이 멈췄는지, 송장번호가 왜 조회되지 않는지 — 해외배송 스캔 문구의 뜻과 해결법을 한 페이지에 정리했습니다.',
    guideAll: '이용 안내 전체 보기 →', guideStatus: 'DHL·FedEx·UPS·알리 배송 상태 뜻',
    guideNotFound: '송장번호가 조회되지 않는 5가지 이유', guideRoute: '해외배송 경유지 이해하기',
    guideEdd: '도착 예정일은 어떻게 계산되나', guideFaq: '자주 묻는 질문',
    guideAir: '화물기 레이더·항공 AWB 조회',
    carrierAIR: '항공 화물 / 편명 (AWB · Flight)',
    radarTitle: '실시간 운항 화물기 레이더', radarSub: '해당 구간 운항 중인 실제 항공기',
    radarFlight: '실시간 항공기 위치', radarFlightSub: '입력한 편명의 실제 항공기',
    radarNone: '지금 이 구간에서 관측된 화물기가 없습니다.',
    radarNoCarrier: '해당 택배사 화물기는 관측되지 않아 인근 화물기를 표시합니다.',
    radarUpdated: '갱신', radarError: '항공기 위치를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
    radarGround: '지상', radarAlt: '고도', radarSpeed: '속도', radarSeen: '초 전', radarNow: '방금',
    airAwb: '항공 화물 AWB', airFlight: '편명', airFlights: '운항 편명', airRoute: '구간',
    airPieces: '조각', airWeight: '중량', airNoEvents: '아직 화물 스캔 기록이 없습니다. 예약만 접수된 상태일 수 있습니다.',
    airNote: 'AWB로 조회한 항공 화물입니다. 택배 송장이라면 배송사를 직접 선택해 주세요.',
    airStages: ['접수', '출발', '도착', '통관·통지', '배송 완료'],
    flightLive: '실시간 항공기 위치', flightCoord: '관측 좌표', flightNoPlane: '지금 이 편명의 항공기가 관측되지 않습니다.',
    noAircraft: '관측된 항공기 없음'
  },
  en: {
    dashboard: 'Track a parcel', shipments: 'How it works', demo: 'SAMPLE DATA', live: 'LIVE',
    title: 'Where is my parcel?', subtitle: 'One tracking number. A whole journey, in view.', scan: 'Carrier scan tracking',
    track: 'Find my parcel', loading: 'Looking it up…', my: 'Tracking result', local: 'One-time lookup · nothing saved', notify: 'About tracking',
    journey: 'The journey', satellite: '3D satellite globe', last: 'LAST CONFIRMED LOCATION', confirmed: 'Confirmed route', planned: 'Planned route',
    drag: 'Drag to rotate · Scroll to zoom', history: 'Tracking history', newest: 'Newest first', transit: 'In transit',
    historyNote: 'Illustrative route · scan times unavailable', notconnected: 'Last updated: API not connected',
    progress: 'Delivery progress', international: 'International transit', domestic: 'Domestic delivery',
    notice: 'Pre-clearance in Incheon does not mean the parcel has arrived.', route: 'Across borders',
    footer: 'Locations reflect carrier scans, not live GPS.', settings: 'Global settings',
    settingNote: 'This window only holds display settings and auto-refresh. Tracking numbers and results are not saved.',
    auto: 'Auto refresh',
    apiNote: 'Live results show the scans your carrier recorded. Each lookup is cached for 15 minutes.',
    privacy: 'Refreshing or closing this page clears your input.',
    placeholder: 'Enter your tracking number', detect: 'Detect carrier', waiting: 'Waiting for a carrier',
    edd: 'Est. delivery',
    carrierAuto: 'Detect carrier', carrierCJ: 'CJ Logistics', carrierEPOST: 'Korea Post', carrierHANJIN: 'Hanjin', carrierLOTTE: 'Lotte',
    carrierLOGEN: 'Logen', carrierILYANG: 'Ilyang', carrierDHL: 'DHL', carrierFEDEX: 'FedEx', carrierUPS: 'UPS', carrierUSPS: 'USPS',
    carrierCAINIAO: 'AliExpress (Cainiao)', carrierEMS: 'Korea Post EMS / Intl', carrierGLOBAL: 'Other global (550+ auto)',
    stages: ['Registered', 'Collected', 'In transit', 'Out for delivery', 'Delivered'],
    stagesDomestic: ['Registered', 'Collected', 'In transit', 'Out for delivery', 'Delivered'],
    sampleEvents: [
      { title: 'Origin confirmed', note: 'Origin', place: 'Sofia, Bulgaria' },
      { title: 'Transit location confirmed', note: 'Last confirmed location', place: 'Leipzig, Germany' },
      { title: 'Pre-clearance information received', note: 'Not an arrival scan', place: 'Incheon, South Korea' }
    ],
    status: { DELIVERED: 'Delivered', OUT_FOR_DELIVERY: 'Out for delivery', IN_TRANSIT: 'In transit', PICKED_UP: 'Collected', REGISTERED: 'Registered', EXCEPTION: 'Exception', RETURNED: 'Returned', UNKNOWN: 'Checking', ARRIVED: 'Arrived', CUSTOMS: 'Customs / notice', IN_FLIGHT: 'In flight', GROUND: 'On ground' },
    errors: {
      NOT_FOUND: 'No tracking information found.', NEEDS_KEY: 'A LASTSCANNED_API_KEY is required for overseas carriers.', UNSUPPORTED: 'This carrier is not supported yet.',
      UPSTREAM: 'The carrier server did not respond.', BAD_REQUEST: 'Please check the tracking number.', NETWORK: 'Could not reach the server.',
      RATE_LIMITED: 'The carrier asked us to slow down for a moment.',
      AWB_NOT_FOUND: 'No air cargo record found for this AWB.', AIRLINE_BLOCKED: 'The airline is temporarily blocking automated lookups.',
      AWB_UNSUPPORTED: 'This airline AWB is not supported yet.', IS_FLIGHT: 'That is a flight number, not an AWB.',
      AIR_BAD_INPUT: 'Enter an AWB (11 digits) or a flight number (KE082).', FLIGHT_NONE: 'No aircraft with this flight number is being observed.'
    },
    hints: {
      NOT_FOUND: 'Check the number and its length — the carrier may not have collected the parcel yet.',
      NEEDS_KEY: 'Add a lastscanned.com key as LASTSCANNED_API_KEY on Vercel to unlock Logen, FedEx, UPS, USPS, Cainiao, EMS and 551 carriers.',
      UNSUPPORTED: 'Supported: CJ Logistics · Korea Post · Hanjin · Lotte · Logen · DHL · FedEx · UPS · USPS · Cainiao · EMS + 550 more worldwide',
      UPSTREAM: 'Try again shortly, or check the carrier site directly.',
      BAD_REQUEST: 'Hyphens, spaces and symbols are removed automatically.',
      NETWORK: 'Check your connection and try again.',
      RATE_LIMITED: 'Try again in a minute.',
      AWB_NOT_FOUND: 'Check the AWB number. If this was a parcel number, pick its carrier and it will be looked up as a parcel.',
      AIRLINE_BLOCKED: 'Korean Air requires a browser session for its cargo lookup. Open the airline link below, or try Asiana (988) or a flight number.',
      AWB_UNSUPPORTED: 'Only Asiana (988) and Korean Air (180) cargo AWBs are looked up for now.',
      IS_FLIGHT: 'Type the flight number in the search box and its aircraft appears on the globe.',
      AIR_BAD_INPUT: 'e.g. 988-12345675 (Asiana) · 180-12345675 (Korean Air) · KE082',
      FLIGHT_NONE: 'It may be on the ground or outside radar coverage. Check the flight number or try again shortly.'
    },
    openSite: 'Open the carrier site', again: 'Try again', empty: 'Enter a tracking number to see its journey.',
    idle: 'Enter a tracking number and its journey appears here.', idleBadge: 'Idle',
    updated: 'Updated', events: 'events', sampleNote: 'Sample data · not a live lookup', liveNote: 'Based on carrier scans',
    privacyLink: 'Privacy', termsLink: 'Terms', noKey: 'See the sample without a DHL key', routeDomestic: 'Domestic route', notYet: 'Not looked up yet',
    currentStatus: 'Current status', lastScan: 'Last scan', noTime: 'No scan time yet', historyFoot: 'Newest scan is shown first',
    openGuide: 'Guide · how to look up a parcel and fix errors →',
    guideTitle: 'When a tracking status makes no sense',
    guideLead: 'Whether “customs clearance” is stuck, or why a tracking number returns nothing — what each overseas scan line means and what to do, on one page.',
    guideAll: 'Read the full guide →', guideStatus: 'DHL · FedEx · UPS · AliExpress status meanings',
    guideNotFound: 'Five reasons a tracking number returns nothing', guideRoute: 'How an overseas route is structured',
    guideEdd: 'How the estimated delivery date is worked out', guideFaq: 'Frequently asked questions',
    guideAir: 'Freighter radar & air cargo AWB lookup',
    carrierAIR: 'Air cargo / flight (AWB · Flight)',
    radarTitle: 'Live freighter radar', radarSub: 'Real aircraft flying this leg',
    radarFlight: 'Live aircraft position', radarFlightSub: 'The aircraft on the flight number you entered',
    radarNone: 'No freighters observed on this leg right now.',
    radarNoCarrier: 'No aircraft of this carrier was observed, so nearby freighters are shown.',
    radarUpdated: 'updated', radarError: 'Could not load live aircraft positions. Try again shortly.',
    radarGround: 'on ground', radarAlt: 'alt', radarSpeed: 'speed', radarSeen: 's ago', radarNow: 'just now',
    airAwb: 'Air cargo AWB', airFlight: 'Flight', airFlights: 'Flights', airRoute: 'Route',
    airPieces: 'pieces', airWeight: 'weight', airNoEvents: 'No cargo scan records yet — the shipment may only be booked.',
    airNote: 'This is an air cargo AWB result. If you meant a parcel, pick its carrier instead.',
    airStages: ['Booked', 'Departed', 'Arrived', 'Customs / notice', 'Delivered'],
    flightLive: 'Live aircraft position', flightCoord: 'Observed position', flightNoPlane: 'No aircraft with this flight number is being observed right now.',
    noAircraft: 'No aircraft observed'
  },
  ja: {
    dashboard: '荷物追跡', shipments: '使い方', demo: 'サンプル', live: 'リアルタイム',
    title: '私の荷物、今どこ？', subtitle: '追跡番号ひとつで、荷物の旅を見渡そう。', scan: '配送会社のスキャン情報',
    track: '荷物を探す', loading: '照会中…', my: '検索結果', local: '一度きりの検索・保存なし', notify: '追跡について',
    journey: '配送の旅', satellite: '3D衛星地球儀', last: '最後に確認された場所', confirmed: '確認済みルート', planned: '予定ルート',
    drag: 'ドラッグで回転・スクロールで拡大', history: '配送履歴', newest: '新しい順', transit: '輸送中',
    historyNote: '提供された経路の例・時刻未確認', notconnected: '最終更新：API未接続',
    progress: '配送状況', international: '国際輸送中', domestic: '国内配送中',
    notice: '仁川の事前通関情報は、実際の到着を意味しません。', route: '国別の経路',
    footer: '位置は配送スキャンに基づき、リアルタイムGPSではありません。', settings: 'グローバル設定',
    settingNote: 'この画面は表示設定と自動更新のみを扱います。追跡番号と結果は保存されません。',
    auto: '自動更新',
    apiNote: '実際の追跡結果は配送会社のスキャン情報です。結果は15分間キャッシュされます。',
    privacy: '再読み込みやタブを閉じると入力情報は消えます。',
    placeholder: '追跡番号を入力', detect: '配送会社を自動検出', waiting: '配送会社の選択待ち',
    edd: '配達予定',
    carrierAuto: '配送会社を自動検出', carrierCJ: 'CJ大韓通運', carrierEPOST: '韓国郵便', carrierHANJIN: 'ハンジン', carrierLOTTE: 'ロッテ',
    carrierLOGEN: 'ロジェン', carrierILYANG: 'イリャン', carrierDHL: 'DHL', carrierFEDEX: 'FedEx', carrierUPS: 'UPS', carrierUSPS: 'USPS',
    carrierCAINIAO: 'AliExpress (Cainiao)', carrierEMS: '韓国郵便 EMS / 国際', carrierGLOBAL: 'その他グローバル (550+ 自動)',
    stages: ['受付', '集荷', '国際輸送', '配達中', '配達完了'],
    stagesDomestic: ['受付', '集荷', '輸送中', '配達中', '配達完了'],
    sampleEvents: [
      { title: '出発地を確認', note: '出発地', place: 'Sofia, Bulgaria' },
      { title: '経由地を確認', note: '最終確認位置', place: 'Leipzig, Germany' },
      { title: '事前通関情報を受信', note: '到着ではありません', place: 'Incheon, South Korea' }
    ],
    status: { DELIVERED: '配達完了', OUT_FOR_DELIVERY: '配達中', IN_TRANSIT: '輸送中', PICKED_UP: '集荷', REGISTERED: '受付', EXCEPTION: '例外', RETURNED: '返送', UNKNOWN: '確認中', ARRIVED: '到着', CUSTOMS: '通関・通知', IN_FLIGHT: '飛行中', GROUND: '地上' },
    errors: {
      NOT_FOUND: '追跡情報が見つかりません。', NEEDS_KEY: '海外配送会社には LASTSCANNED_API_KEY が必要です。', UNSUPPORTED: 'この配送会社はまだ未対応です。',
      UPSTREAM: '配送会社のサーバーが応答しません。', BAD_REQUEST: '追跡番号を確認してください。', NETWORK: 'サーバーに接続できませんでした。',
      RATE_LIMITED: '照会回数の上限に一時的に達しました。',
      AWB_NOT_FOUND: '航空貨物の照会結果がありません。', AIRLINE_BLOCKED: '航空会社が自動照会を一時的に遮断しています。',
      AWB_UNSUPPORTED: 'この航空会社のAWBはまだ未対応です。', IS_FLIGHT: 'AWBではなく便名です。',
      AIR_BAD_INPUT: 'AWB（11桁）または便名（KE082）を入力してください。', FLIGHT_NONE: 'この便名の航空機は観測されていません。'
    },
    hints: {
      NOT_FOUND: '番号と桁数を確認してください。まだ集荷前の可能性もあります。',
      NEEDS_KEY: 'lastscanned.com のキーを Vercel の LASTSCANNED_API_KEY に設定すると、ロジェン・FedEx・UPS・USPS・Cainiao・EMS など551社が使えます。',
      UNSUPPORTED: '対応：CJ大韓通運・韓国郵便・ハンジン・ロッテ・ロジェン・DHL・FedEx・UPS・USPS・Cainiao・EMS ＋ 世界550社以上',
      UPSTREAM: 'しばらくしてから再度お試しください。',
      BAD_REQUEST: 'ハイフン・空白・記号は自動で除去されます。',
      NETWORK: '接続を確認して再度お試しください。',
      RATE_LIMITED: '1分後に再度お試しください。',
      AWB_NOT_FOUND: 'AWB番号を確認してください。宅配便の番号なら配送会社を選択すると宅配便として照会されます。',
      AIRLINE_BLOCKED: '大韓航空はサーバー自動照会にセッション確認を求めます。下のリンクで直接照会するか、アシアナ(988)・便名照会をご利用ください。',
      AWB_UNSUPPORTED: '現在はアシアナ(988)と大韓航空(180)の貨物AWBのみ照会できます。',
      IS_FLIGHT: '便名は検索欄にそのまま入力すると地球儀に航空機が表示されます。',
      AIR_BAD_INPUT: '例）988-12345675（アシアナ）・180-12345675（大韓航空）・KE082',
      FLIGHT_NONE: '地上にあるか、レーダー範囲外の可能性があります。便名を確認するか、しばらくしてから再度お試しください。'
    },
    openSite: '配送会社サイトを開く', again: '再検索', empty: '追跡番号を入力すると配送履歴が表示されます。',
    idle: '追跡番号を入力すると、配送の旅がここに表示されます。', idleBadge: '待機中',
    updated: '最終更新', events: '件', sampleNote: 'サンプルデータ・実際の照会ではありません', liveNote: '配送会社スキャン基準',
    privacyLink: 'プライバシー', termsLink: '利用規約', noKey: 'DHLキーなしでサンプルを見る', routeDomestic: '国内の経路', notYet: '照会前',
    currentStatus: '現在の配送状況', lastScan: '最終スキャン', noTime: 'スキャン時刻なし', historyFoot: '最新のスキャンが上に表示されます',
    openGuide: '使い方ガイド・照会方法とエラー対処 →',
    guideTitle: '配送状況の表示がわからないとき',
    guideLead: '「通関中」が止まっているのか、追跡番号がなぜ照会できないのか — 海外配送のスキャン文言の意味と対処法を1ページにまとめました。',
    guideAll: 'ガイドをすべて見る →', guideStatus: 'DHL・FedEx・UPS・AliExpressの状況の意味',
    guideNotFound: '追跡番号が照会できない5つの理由', guideRoute: '海外配送の経由地を理解する',
    guideEdd: '配達予定日の計算方法', guideFaq: 'よくある質問',
    guideAir: '貨物機レーダー・航空AWB照会',
    carrierAIR: '航空貨物 / 便名 (AWB · Flight)',
    radarTitle: 'リアルタイム貨物機レーダー', radarSub: 'この区間を飛行中の実際の航空機',
    radarFlight: 'リアルタイム航空機位置', radarFlightSub: '入力した便名の実際の航空機',
    radarNone: '現在この区間で観測された貨物機はありません。',
    radarNoCarrier: 'この配送会社の貨物機は観測されず、近くの貨物機を表示しています。',
    radarUpdated: '更新', radarError: '航空機の位置を取得できませんでした。しばらくしてから再度お試しください。',
    radarGround: '地上', radarAlt: '高度', radarSpeed: '速度', radarSeen: '秒前', radarNow: 'たった今',
    airAwb: '航空貨物AWB', airFlight: '便名', airFlights: '運航便名', airRoute: '区間',
    airPieces: '個数', airWeight: '重量', airNoEvents: '貨物スキャン記録はまだありません。予約のみの可能性があります。',
    airNote: 'AWBで照会した航空貨物です。宅配便の場合は配送会社を選択してください。',
    airStages: ['受付', '出発', '到着', '通関・通知', '配達完了'],
    flightLive: 'リアルタイム航空機位置', flightCoord: '観測座標', flightNoPlane: 'この便名の航空機は現在観測されていません。',
    noAircraft: '観測された航空機なし'
  }
};

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  lang: 'ko',
  number: '',
  carrier: 'auto',
  view: null,
  loading: false,
  error: null,
  selected: -1,
  autoRefresh: 0,
  timer: null,
  planes: [],
  radar: null,
  planeTimer: null,
  planeToken: 0
};

const t = () => strings[state.lang];
const isKo = () => state.lang === 'ko';

/* ------------------------------------------------------------------ *
 * Time formatting
 * ------------------------------------------------------------------ */

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const locale = state.lang === 'ko' ? 'ko-KR' : state.lang === 'ja' ? 'ja-JP' : 'en-GB';
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
  const locale = state.lang === 'ko' ? 'ko-KR' : state.lang === 'ja' ? 'ja-JP' : 'en-US';
  const month = state.lang === 'en' ? 'short' : 'long';
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: 'Asia/Seoul', month, day: 'numeric' }).format(date);
  } catch {
    return String(dateText).slice(5).replace('-', '/');
  }
}

function clockNow() {
  try {
    return new Intl.DateTimeFormat(isKo() ? 'ko-KR' : 'en-GB', {
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
 * Air cargo: AWB + live aircraft
 *   · an 11-digit AWB with prefix 180/988 goes to /api/awb
 *   · a flight number (KE082, KAL249) goes to /api/plane
 *   · an overseas parcel that is still moving asks /api/plane for the
 *     cargo aircraft flying its leg, and draws them on the same globe
 * ------------------------------------------------------------------ */

function altText(p) {
  if (!p) return '';
  if (p.onGround) return t().radarGround;
  if (p.altFt == null) return '';
  return `${Math.round(p.altFt).toLocaleString('en-US')} ft`;
}

function speedText(p) {
  if (!p || p.speedKts == null) return '';
  return `${p.speedKts} kt`;
}

function seenText(sec) {
  if (sec == null) return '';
  if (sec < 3) return t().radarNow;
  const lang = state.lang;
  if (lang === 'ko') return `${Math.round(sec)}초 전`;
  if (lang === 'ja') return `${Math.round(sec)}秒前`;
  return `${Math.round(sec)}s ago`;
}

function coordText(p) {
  if (!p || !Number.isFinite(p.lat)) return '';
  const ns = p.lat >= 0 ? 'N' : 'S';
  const ew = p.lon >= 0 ? 'E' : 'W';
  return `${Math.abs(p.lat).toFixed(2)}°${ns} ${Math.abs(p.lon).toFixed(2)}°${ew}`;
}

function detectAir(raw, carrier) {
  const compact = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!compact) return null;
  const isFlight = /^[A-Z]{2,3}\d{1,4}$/.test(compact);
  const isAwb = /^\d{11}$/.test(compact);
  if (carrier === 'AIR') {
    if (isFlight) return { kind: 'flight', value: compact };
    if (isAwb) return { kind: 'awb', value: compact };
    return { kind: 'invalid', value: compact };
  }
  if (carrier !== 'auto') return null;
  if (isFlight) return { kind: 'flight', value: compact };
  // 180/988 + 8 digits is an airline AWB; every parcel carrier keeps its own prefix.
  if (/^(180|988)\d{8}$/.test(compact)) return { kind: 'awb', value: compact };
  return null;
}

function awbNumberText(awb) {
  const digits = String((awb && awb.number) || '').replace(/\D/g, '');
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return String((awb && awb.number) || '');
}

function buildAwbDataset(payload) {
  const awb = payload.awb || {};
  const points = [];
  const byIata = new Map();

  const addPoint = (stop) => {
    if (!stop) return null;
    const lat = Number(stop.lat);
    const lng = Number.isFinite(Number(stop.lng)) ? Number(stop.lng) : Number(stop.lon);
    // Without both coordinates a point would put the camera at NaN and blank the globe.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const iata = stop.iata || '';
    if (iata && byIata.has(iata)) return points[byIata.get(iata)];
    const last = points[points.length - 1];
    if (last && Math.abs(last.lat - lat) < 0.01 && Math.abs(last.lng - lng) < 0.01) return last;
    const point = {
      lat, lng,
      name: stop.city || iata, detail: iata,
      code: iata, country: stop.country || '', countryEn: stop.countryEn || '', countryCode: stop.countryCode || '',
      firstEvent: null, lastEvent: null
    };
    points.push(point);
    if (iata) byIata.set(iata, points.length - 1);
    return point;
  };

  for (const stop of awb.route || []) addPoint(stop);

  const events = (awb.events || []).map((ev) => {
    const point = ev.place ? addPoint(ev.place) : null;
    const view = {
      time: ev.at,
      timeLabel: ev.atLabel || '',
      title: ev.label,
      note: [ev.code, ev.flight, ev.place && ev.place.iata].filter(Boolean).join(' · '),
      statusCode: ev.status || 'IN_TRANSIT',
      location: ev.place
        ? {
            name: ev.place.name || ev.place.iata, city: ev.place.city || '', code: ev.place.iata || '',
            country: ev.place.country || '', countryEn: ev.place.countryEn || '', countryCode: ev.place.countryCode || '',
            lat: ev.place.lat, lng: ev.place.lng
          }
        : null,
      point: point ? points.indexOf(point) : -1
    };
    const pointIndex = view.point;
    if (pointIndex >= 0) {
      if (!points[pointIndex].firstEvent) points[pointIndex].firstEvent = view;
      points[pointIndex].lastEvent = view;
    }
    return view;
  });

  points.forEach((p, i) => { p.active = i === points.length - 1; });
  points.forEach((p, i) => {
    p.hideLabel = i > 0 && i < points.length - 1 && points.length > 3;
  });

  const arcs = [];
  for (let i = 1; i < points.length; i += 1) {
    arcs.push({ startLat: points[i - 1].lat, startLng: points[i - 1].lng, endLat: points[i].lat, endLng: points[i].lng, planned: false });
  }

  const countries = [];
  for (const p of points) {
    const last = countries[countries.length - 1];
    if (!last || last.code !== p.countryCode) {
      countries.push({ code: p.countryCode, flag: flagOf(p.countryCode), city: p.name, planned: false });
    }
  }

  const statusCode = (awb.status && awb.status.code) || 'UNKNOWN';
  const latestPoint = points[points.length - 1] || null;
  const facts = [];
  if (awb.pieces != null) facts.push(`${t().airPieces} ${awb.pieces}`);
  if (awb.weight != null) facts.push(`${t().airWeight} ${awb.weight}${awb.weightUnit || 'kg'}`);

  return {
    kind: 'awb',
    demo: false,
    number: awbNumberText(awb),
    carrierCode: 'AIR',
    carrierName: awb.airline ? awb.airline.name : t().airAwb,
    carrierSite: awb.airline ? awb.airline.site : '',
    statusCode,
    statusLabel: statusLabel(statusCode),
    stage: Number.isFinite(awb.status && awb.status.stage) ? awb.status.stage : 0,
    delivered: Boolean(awb.status && awb.status.delivered),
    estimatedDelivery: null,
    events,
    points,
    arcs,
    countries,
    international: true,
    latestLocation: latestPoint ? pair(latestPoint) : '',
    latestCode: latestPoint ? latestPoint.code : '',
    latestDetail: facts.join(' · '),
    fetchedAt: (payload.meta && payload.meta.fetchedAt) || new Date().toISOString(),
    cached: Boolean(payload.meta && payload.meta.cached),
    awb
  };
}

function buildFlightDataset(payload, requested) {
  const planes = (payload.planes || []).filter((p) => Number.isFinite(p.lat));
  const first = planes[0] || null;
  const looked = ((payload.query && payload.query.callsigns) || []).map((c) => c.iata || c.icao || c.input);
  const label = (looked.length ? looked : [requested]).filter(Boolean).join(', ');

  const events = planes.map((p) => ({
    time: null,
    timeLabel: seenText(p.seenSec),
    title: `${p.callsign || p.hex}${p.operator ? ' · ' + p.operator.label : ''}`,
    note: [p.aircraftType, altText(p), speedText(p)].filter(Boolean).join(' · '),
    statusCode: p.onGround ? 'GROUND' : 'IN_FLIGHT',
    location: { name: coordText(p), city: '', code: p.callsign || '', country: '', countryEn: '', countryCode: '', lat: p.lat, lng: p.lon },
    point: -1,
    plane: p
  }));

  return {
    kind: 'flight',
    demo: false,
    number: label,
    carrierCode: 'AIR',
    carrierName: first && first.operator ? first.operator.label : t().flightLive,
    carrierSite: '',
    statusCode: first ? (first.onGround ? 'GROUND' : 'IN_FLIGHT') : 'UNKNOWN',
    statusLabel: statusLabel(first ? (first.onGround ? 'GROUND' : 'IN_FLIGHT') : 'UNKNOWN'),
    stage: 0,
    delivered: false,
    estimatedDelivery: null,
    events,
    points: [],
    arcs: [],
    countries: [],
    international: true,
    latestLocation: first ? coordText(first) : '',
    latestCode: first ? first.callsign || '' : '',
    latestDetail: first ? [altText(first), speedText(first)].filter(Boolean).join(' · ') : '',
    fetchedAt: (payload.meta && payload.meta.fetchedAt) || new Date().toISOString(),
    cached: Boolean(payload.meta && payload.meta.cached),
    plane: first
  };
}

function planeMarkers() {
  return (state.planes || [])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => ({
      kind: 'plane', lat: p.lat, lng: p.lon, altFt: p.altFt, callsign: p.callsign, hex: p.hex,
      aircraftType: p.aircraftType, speedKts: p.speedKts, heading: p.heading, onGround: p.onGround,
      seenSec: p.seenSec, operator: p.operator, matched: Boolean(p.matched), active: false
    }));
}

function planeTooltip(p) {
  return [p.callsign || p.hex, p.operator && p.operator.label, p.aircraftType, altText(p), speedText(p), seenText(p.seenSec)]
    .filter(Boolean)
    .join(' · ');
}

function focusPlane(p) {
  if (!p) return;
  if (globe && globe.pointOfView) globe.pointOfView({ lat: p.lat, lng: p.lon, altitude: 0.55 }, 800);
  const info = $('#marker-info');
  if (info) {
    info.hidden = false;
    info.textContent = `${p.callsign || p.hex}${p.operator ? ' · ' + p.operator.label : ''} — ${[p.aircraftType, altText(p), speedText(p)].filter(Boolean).join(' · ')}`;
  }
}

function planeChip(p) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'radar-chip' + (p.matched ? ' matched' : '');
  btn.title = planeTooltip(p);

  const icon = document.createElement('span');
  icon.textContent = '✈';
  const cs = document.createElement('span');
  cs.className = 'rc-cs';
  cs.textContent = p.callsign || p.hex || '—';
  btn.append(icon, cs);

  if (p.operator) {
    const op = document.createElement('span');
    op.className = 'rc-op';
    op.textContent = p.operator.code;
    btn.append(op);
  }

  const meta = document.createElement('span');
  meta.className = 'rc-meta';
  meta.textContent = [p.aircraftType, altText(p), speedText(p)].filter(Boolean).join(' · ');
  btn.append(meta);

  btn.onclick = () => focusPlane(p);
  return btn;
}

function renderRadar() {
  const box = $('#radar');
  if (!box) return;
  const s = t();
  const radar = state.radar;
  const list = $('#radar-list');
  if (!radar || !state.view) {
    box.hidden = true;
    if (list) list.replaceChildren();
    return;
  }
  box.hidden = false;
  const title = $('#radar-title');
  const sub = $('#radar-sub');
  if (title) {
    title.textContent = radar.mode === 'flight' ? s.radarFlight : s.radarTitle;
  }
  if (sub) {
    if (radar.mode === 'flight') sub.textContent = s.radarFlightSub;
    else if (radar.mode === 'awb') sub.textContent = `${s.radarSub} · ${state.view.awb && state.view.awb.liveCallsigns ? state.view.awb.liveCallsigns.join(' · ') : ''}`;
    else sub.textContent = `${s.radarSub}${radar.carrierName ? ' · ' + radar.carrierName : ''}`;
  }
  if (!list) return;
  list.replaceChildren();

  if (radar.error) {
    const note = document.createElement('span');
    note.className = 'radar-note';
    note.textContent = s.radarError;
    list.append(note);
    return;
  }

  const planes = state.planes || [];
  if (!planes.length) {
    const note = document.createElement('span');
    note.className = 'radar-note';
    note.textContent = radar.loading ? s.loading : s.radarNone;
    list.append(note);
  } else {
    if (radar.mode === 'carrier' && radar.counts && radar.counts.matched === 0) {
      const note = document.createElement('span');
      note.className = 'radar-note';
      note.textContent = s.radarNoCarrier;
      list.append(note);
    }
    for (const p of planes) list.append(planeChip(p));
  }

  const updated = document.createElement('span');
  updated.className = 'radar-updated';
  updated.textContent = `${s.radarUpdated} ${clockNow()}`;
  list.append(updated);
}

async function loadPlanes(params) {
  if (!params) {
    stopPlanePolling();
    state.planes = [];
    state.radar = null;
    renderPlanes();
    return;
  }
  const token = state.planeToken + 1;
  state.planeToken = token;
  state.radar = { mode: params.mode || (params.cs ? 'flight' : 'carrier'), query: params.query || params, counts: null, loading: true, error: false };
  renderRadar();

  const search = new URLSearchParams(params.query || params);
  if (params.mode) search.delete('mode');
  try {
    const res = await fetch(`${API_PLANE}?${search.toString()}`, { headers: { accept: 'application/json' } });
    const payload = await res.json();
    if (token !== state.planeToken) return;
    if (!payload || payload.ok !== true) throw new Error((payload && payload.error && payload.error.code) || 'PLANE');
    state.planes = payload.planes || [];
    state.radar = {
      mode: params.mode || 'flight',
      query: params.query || params,
      counts: payload.counts || null,
      carrier: params.carrier || null,
      carrierName: params.carrierName || null,
      loading: false,
      error: false
    };
    renderPlanes();
    startPlanePolling();
  } catch (err) {
    if (token !== state.planeToken) return;
    state.planes = [];
    state.radar = { ...(state.radar || { mode: 'carrier', query: params }), loading: false, error: true };
    renderPlanes();
  }
}

function renderPlanes() {
  renderGlobe(state.view);
  renderRadar();
}

function startPlanePolling() {
  stopPlanePolling();
  state.planeTimer = setInterval(() => {
    if (document.hidden) return;
    if (state.radar && state.radar.query) loadPlanes({ mode: state.radar.mode, query: state.radar.query, carrier: state.radar.carrier, carrierName: state.radar.carrierName });
  }, 60000);
}

function stopPlanePolling() {
  if (state.planeTimer) clearInterval(state.planeTimer);
  state.planeTimer = null;
}

/* Planes for an overseas parcel that is still on its way. */
function radarForView(view) {
  if (!view || view.kind !== 'parcel') return null;
  if (!view.international || view.delivered) return null;
  const point = view.points[view.points.length - 1];
  const params = { carrier: view.carrierCode || 'GLOBAL', mode: 'carrier', carrierName: view.carrierName || '' };
  if (point && Number.isFinite(point.lat)) {
    params.lat = point.lat.toFixed(3);
    params.lon = point.lng.toFixed(3);
    if (point.code) params.iata = point.code;
  }
  params.query = { ...params };
  delete params.query.mode;
  delete params.query.carrierName;
  return params;
}

/* ------------------------------------------------------------------ *
 * Globe
 * ------------------------------------------------------------------ */

let globe = null;
let globeBroken = false;

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
      .arcColor((d) => (d.planned ? '#b4c6dd' : '#b7f373'))
      .arcStroke(0.5)
      .arcDashLength((d) => (d.planned ? 0.035 : 1))
      .arcDashGap((d) => (d.planned ? 0.022 : 0))
      // A fixed height sinks long-haul arcs (LAX→ICN is ~95°) inside the globe,
      // so the arc rises with the distance it covers.
      .arcAltitude((d) => {
        if (d.planned) return 0.24;
        const rad = Math.PI / 180;
        const cos =
          Math.sin(d.startLat * rad) * Math.sin(d.endLat * rad) +
          Math.cos(d.startLat * rad) * Math.cos(d.endLat * rad) * Math.cos((d.endLng - d.startLng) * rad);
        const distance = Math.acos(Math.max(-1, Math.min(1, cos)));
        return 0.06 + 0.28 * (distance / Math.PI);
      })
      .htmlElementsData([])
      .htmlLat('lat')
      .htmlLng('lng')
      .htmlAltitude(0.015)
      .htmlElement((d) => {
        if (d.kind === 'plane') {
          const plane = document.createElement('button');
          plane.type = 'button';
          plane.className = 'globe-plane' + (d.matched ? ' matched' : '') + (d.onGround ? ' ground' : '');
          plane.title = planeTooltip(d);
          const icon = document.createElement('span');
          icon.className = 'plane-icon';
          icon.textContent = '✈';
          icon.style.transform = `rotate(${(Number(d.heading) || 0) - 90}deg)`;
          const tag = document.createElement('span');
          tag.className = 'plane-tag';
          tag.textContent = d.callsign || d.hex || '';
          plane.append(icon, tag);
          plane.onclick = () => focusPlane(d);
          return plane;
        }
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
  const planes = planeMarkers();
  if (!view) {
    globe.htmlElementsData(planes);
    globe.arcsData([]);
    return;
  }
  const labels = view.points
    .map((p, i) => ({ ...p, index: i, pending: Boolean(view.demo && i === view.points.length - 1 && view.points.length > 1) }))
    // A point without both coordinates would put the camera at NaN; skip it instead.
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  globe.htmlElementsData(labels.concat(planes));
  globe.arcsData(view.arcs);
}

/* Air cargo: fit the whole airport-to-airport leg in view instead of the last scan. */
function sphericalMid(a, b) {
  const rad = Math.PI / 180;
  const va = [Math.cos(a.lat * rad) * Math.cos(a.lng * rad), Math.sin(a.lat * rad), Math.cos(a.lat * rad) * Math.sin(a.lng * rad)];
  const vb = [Math.cos(b.lat * rad) * Math.cos(b.lng * rad), Math.sin(b.lat * rad), Math.cos(b.lat * rad) * Math.sin(b.lng * rad)];
  const mid = [va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]];
  const len = Math.hypot(mid[0], mid[1], mid[2]) || 1;
  const y = mid[1] / len;
  const x = mid[0] / len;
  const z = mid[2] / len;
  return { lat: Math.asin(Math.max(-1, Math.min(1, y))) / rad, lng: Math.atan2(z, x) / rad };
}

function angularDistance(a, b) {
  const rad = Math.PI / 180;
  const cos = Math.sin(a.lat * rad) * Math.sin(b.lat * rad) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / rad;
}

function frameRoute() {
  const view = state.view;
  if (!view) return;
  const usable = view.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const last = usable[usable.length - 1];
  if (!last) return;
  const info = $('#marker-info');
  if (info) {
    info.hidden = false;
    info.textContent = pair(last);
  }
  if (!globe) return;
  if (usable.length < 2) {
    globe.pointOfView({ lat: last.lat, lng: last.lng, altitude: 1.1 }, 800);
    return;
  }
  const first = usable[0];
  const mid = sphericalMid(first, last);
  const distance = angularDistance(first, last);
  const altitude = Math.min(2.4, Math.max(1.35, 1.1 + distance / 120));
  globe.pointOfView({ lat: mid.lat, lng: mid.lng, altitude }, 900);
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
  let flyers = [];
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

    // Live aircraft: same ✈ marker as the WebGL globe, rotated by heading.
    flyers.forEach((f) => {
      if (!Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return;
      const p = project(f.lat, f.lng, r * 1.005);
      if (p[2] < 0.05) return;
      ctx.save();
      ctx.translate(p[0], p[1]);
      ctx.rotate((((Number(f.heading) || 0) - 90) * Math.PI) / 180);
      ctx.fillStyle = f.matched ? '#b7f373' : f.onGround ? '#9db0c4' : '#eaf3ff';
      ctx.font = f.matched ? '15px sans-serif' : '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✈', 0, 0);
      ctx.restore();
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
      if (!w || w > 520) {
        ctx.font = '9px sans-serif';
        ctx.fillStyle = '#c6d6e6';
        ctx.fillText(f.callsign || '', p[0] + 9, p[1] - 8);
      }
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
      const list = Array.isArray(a) ? a : [];
      points = list.filter((item) => item && item.kind !== 'plane');
      flyers = list.filter((item) => item && item.kind === 'plane');
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
  document.documentElement.lang = state.lang;
  document.querySelectorAll('[data-i]').forEach((el) => {
    const value = s[el.dataset.i];
    if (typeof value === 'string') el.textContent = value;
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
  renderRadar();
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
    DHL: 'DHL', FEDEX: 'FX', UPS: 'UPS', USPS: 'US', CAINIAO: 'CA', EMS: 'EMS', YUNEXPRESS: 'YX', AIR: '✈'
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
    const count = `${state.view.events.length}${isKo() || state.lang === 'ja' ? s.events : ' ' + s.events}`;
    if (state.view.kind === 'awb') {
      const awb = state.view.awb || {};
      small.textContent = [
        awb.airline ? awb.airline.name : s.airAwb,
        awb.origin && awb.destination ? `${awb.origin.iata} → ${awb.destination.iata}` : '',
        state.view.latestDetail,
        awb.flights && awb.flights.length ? `${s.airFlights} ${awb.flights.map((f) => f.no).join(' ')}` : ''
      ].filter(Boolean).join(' · ');
    } else if (state.view.kind === 'flight') {
      small.textContent = [state.view.carrierName, state.view.latestDetail].filter(Boolean).join(' · ') || s.flightLive;
    } else {
      small.textContent = state.view.demo
        ? (isKo() ? 'Sofia · Leipzig · Incheon' : state.view.points.map((p) => p.name).join(' · '))
        : `${state.view.latestDetail || state.view.latestLocation} · ${count}`;
    }
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
  $('#count').textContent = state.view && state.view.kind !== 'parcel' && !events ? '—' : String(events);
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
    note.textContent = state.view && state.view.kind === 'awb' ? s.airNoEvents : s.empty;
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
  const labels = view && view.kind === 'awb' ? s.airStages : view && view.international ? s.stages : s.stagesDomestic;
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
  else if (view && view.kind === 'awb') summary.textContent = [view.carrierName, s.airAwb, view.awb && view.awb.source === 'asiana' ? 'Asiana Cargo' : view.awb && view.awb.source === 'koreanair' ? 'Korean Air Cargo' : ''].filter(Boolean).join(' · ');
  else if (view && view.kind === 'flight') summary.textContent = `${s.radarFlight} · ${s.radarFlightSub}`;
  else if (view) summary.textContent = `${view.carrierName} · ${s.liveNote}`;
  else summary.textContent = '';
  summary.style.display = view || state.error ? '' : 'none';

  const accent = $('.panel-title .accent');
  accent.textContent = view
    ? view.kind === 'awb'
      ? s.airAwb
      : view.international
        ? s.international
        : s.domestic
    : state.error
      ? state.error.apiOk
        ? s.noAircraft
        : s.notconnected
      : s.idleBadge;
  accent.classList.toggle('done', Boolean(view && view.delivered));

  $('#notice-box').style.display = view && view.kind === 'awb' && !view.events.length ? 'flex' : view && view.demo ? 'flex' : 'none';
  if (view && view.kind === 'awb' && !view.events.length) {
    const box = $('#notice-box');
    if (box && box.lastElementChild) box.lastElementChild.textContent = s.airNoEvents;
  }

  const bottom = document.querySelector('.bottom');
  if (bottom) bottom.classList.toggle('is-hidden', Boolean(view && view.kind === 'flight'));
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
    city.textContent = country.city + (country.planned ? (isKo() ? ' (예정)' : ' (planned)') : '');
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
    $('#location').textContent = view.kind === 'flight' ? view.latestLocation : view.demo ? 'Leipzig, Germany' : pair(view.points[view.points.length - 1]);
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
    updated.textContent = `${s.updated} ${clockNow()}${view.cached ? ' · cache' : ''}`;
  } else {
    updated.textContent = s.notYet;
  }

  const plannedLegend = $('#legend-planned');
  plannedLegend.style.display = view && view.arcs.some((a) => a.planned) ? 'flex' : 'none';
  const legend = $('.legend');
  // A flight has no parcel route, so the route legend would be noise there.
  if (legend) legend.style.display = view && view.kind !== 'flight' ? 'flex' : 'none';
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
    title: s.errors[code] || (payload && payload.message) || s.errors.UPSTREAM,
    hint: (payload && payload.hint) || s.hints[code] || '',
    site: payload && payload.carrier ? payload.carrier.site : ''
  };
}

async function lookup(number, carrier) {
  if (state.loading) return;

  // Air cargo and flight numbers leave the parcel pipeline entirely.
  const air = detectAir(number, carrier);
  if (air && air.kind === 'awb') return lookupAwb(air.value);
  if (air && air.kind === 'flight') return lookupFlight(air.value, carrier);
  if (air && air.kind === 'invalid') {
    state.view = null;
    state.error = errorFor({ code: 'AIR_BAD_INPUT' });
    state.number = number;
    toast(state.error.title);
    render();
    return;
  }

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
    focusPoint(state.view.points.length - 1);
    // Overseas parcels still on the move get the live freighter radar.
    const radar = radarForView(state.view);
    if (radar) loadPlanes(radar);
    else loadPlanes(null);
  } catch (err) {
    state.error = errorFor({ code: 'NETWORK' });
    state.view = null;
    loadPlanes(null);
    toast(t().errors.NETWORK);
  } finally {
    state.loading = false;
    if (state.view) {
      $('#search .primary').disabled = false;
    }
    render();
  }
}

function resetForLookup() {
  state.loading = true;
  state.error = null;
  state.view = null;
  state.planes = [];
  state.radar = null;
  stopPlanePolling();
  $('#marker-info').hidden = true;
}

async function lookupAwb(value) {
  if (state.loading) return;
  resetForLookup();
  render();
  try {
    const res = await fetch(`${API_AWB}?no=${encodeURIComponent(value)}`, { headers: { accept: 'application/json' } });
    const payload = await res.json();
    if (!payload || payload.ok !== true) {
      state.error = errorFor(payload && payload.error);
      state.number = value;
      state.carrier = 'AIR';
      toast(state.error.title);
      return;
    }
    const awb = payload.awb || {};
    state.number = awbNumberText(awb);
    state.carrier = 'AIR';
    state.view = buildAwbDataset(payload);
    state.error = null;
    render();
    frameRoute();
    const callsigns = (awb.liveCallsigns || []).filter(Boolean);
    if (callsigns.length) {
      const query = { cs: callsigns.join(',') };
      loadPlanes({ mode: 'awb', query });
    }
  } catch (err) {
    state.error = errorFor({ code: 'NETWORK' });
    toast(t().errors.NETWORK);
  } finally {
    state.loading = false;
    render();
  }
}

async function lookupFlight(value, carrier) {
  if (state.loading) return;
  resetForLookup();
  render();
  try {
    const res = await fetch(`${API_PLANE}?cs=${encodeURIComponent(value)}`, { headers: { accept: 'application/json' } });
    const payload = await res.json();
    if (!payload || payload.ok !== true) {
      state.error = errorFor(payload && payload.error);
      state.number = value;
      state.carrier = 'AIR';
      toast(state.error.title);
      return;
    }
    if (!payload.planes || !payload.planes.length) {
      // 200 with zero aircraft is an answer, not a broken connection: mark it so the
      // progress panel says “no aircraft observed” instead of “API not connected”.
      state.error = { ...errorFor({ code: 'FLIGHT_NONE', hint: payload.message }), apiOk: true };
      state.number = value;
      state.carrier = 'AIR';
      return;
    }
    state.number = value;
    state.carrier = 'AIR';
    state.view = buildFlightDataset(payload, value);
    state.error = null;
    render();
    if (state.view.plane) focusPlane(state.view.plane);
    loadPlanes({ mode: 'flight', query: { cs: value } });
  } catch (err) {
    state.error = errorFor({ code: 'NETWORK' });
    toast(t().errors.NETWORK);
  } finally {
    state.loading = false;
    render();
  }
}

function submitSearch(event) {
  if (event) event.preventDefault();
  const raw = sanitizeField($('#number'));
  if (raw.length < 5) {
    toast(isKo() ? '송장번호는 영문·숫자 5~60자로 입력하세요.' : 'Use 5-60 letters or digits.');
    return;
  }
  const number = raw.replace(/-/g, '').toUpperCase();
  const carrier = $('#carrier').value;
  lookup(number, carrier, { force: true });
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

$('#language').onchange = (e) => {
  state.lang = e.target.value;
  render();
  if (state.view) focusPoint(state.view.points.length - 1);
};

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

initGlobe();
state.view = null;
state.number = '';
state.carrier = 'auto';
render();
if (globe) globe.pointOfView({ lat: 30, lng: 60, altitude: 1.95 }, 0);
