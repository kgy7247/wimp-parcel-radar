'use strict';

/**
 * WIMP — Where Is My Parcel?
 * api/track.js — Vercel Node.js serverless function, zero dependencies.
 *
 * GET /api/track?number=1234567890&carrier=auto
 *
 * Hybrid routing
 *   1) Korean free direct parsers (no key, saves the pro quota)
 *        CJ      CJ대한통운   (public JSON endpoint + csrf)
 *        EPOST   우체국택배   (public HTML trace page)
 *        HANJIN  한진택배     (public HTML waybill page)
 *        LOTTE   롯데택배     (public mobile HTML page)
 *      If one of these fails, is blocked, or does not know the number, the
 *      same parcel is retried through lastscanned when a key is configured.
 *   2) lastscanned API — 551 carriers worldwide (needs LASTSCANNED_API_KEY)
 *        GET https://api.lastscanned.com/v1/track/{number}?carrier=...
 *        LOGEN, ILYANG, DHL, FEDEX, UPS, USPS, CAINIAO, YUNEXPRESS, EMS,
 *        or auto-detection for any of the 551 carriers.
 *   3) DHL direct API — kept for older deployments that only have DHL_API_KEY.
 *
 * Nothing is stored. Responses are cached in memory for 15 minutes per carrier+number.
 * The lastscanned key is read from the environment only and never leaves the server.
 */

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 400;
const cache = new Map(); // `${via}:${carrier}:${number}` -> { payload, expires }
const UPSTREAM_TIMEOUT_MS = 7000;
const TOTAL_BUDGET_MS = 8800;
const LASTSCANNED_BASE = 'https://api.lastscanned.com/v1/track';
const LASTSCANNED_TIMEOUT_MS = 7000;
const LASTSCANNED_RETRY_MS = 450;

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const NOMINATIM_UA = 'WIMP-ParcelRadar/1.0 (+https://github.com/kgy7247/wimp-parcel-radar)';

/* ------------------------------------------------------------------ *
 * Carriers
 * ------------------------------------------------------------------ */

const CARRIERS = {
  CJ: {
    code: 'CJ',
    name: 'CJ대한통운',
    nameEn: 'CJ Logistics',
    site: 'https://www.cjlogistics.com/ko/tool/parcel/tracking',
    domestic: true,
  },
  EPOST: {
    code: 'EPOST',
    name: '우체국택배',
    nameEn: 'Korea Post',
    site: 'https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm',
    domestic: true,
  },
  HANJIN: {
    code: 'HANJIN',
    name: '한진택배',
    nameEn: 'Hanjin',
    site: 'https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038',
    domestic: true,
  },
  LOTTE: {
    code: 'LOTTE',
    name: '롯데택배',
    nameEn: 'Lotte Global Logistics',
    site: 'https://www.lotteglogis.com/home/reservation/tracking/index',
    domestic: true,
  },
  LOGEN: {
    code: 'LOGEN',
    name: '로젠택배',
    nameEn: 'Logen',
    site: 'https://www.ilogen.com/web/personal/trace',
    domestic: true,
  },
  ILYANG: {
    code: 'ILYANG',
    name: '일양택배',
    nameEn: 'Ilyang Logis',
    site: 'https://www.ilyanglogis.com/waybill_search',
    domestic: true,
  },
  DHL: {
    code: 'DHL',
    name: 'DHL',
    nameEn: 'DHL Express',
    site: 'https://www.dhl.com/kr-ko/home/tracking.html',
    domestic: false,
  },
  FEDEX: {
    code: 'FEDEX',
    name: 'FedEx',
    nameEn: 'FedEx',
    site: 'https://www.fedex.com/fedextrack/',
    domestic: false,
  },
  UPS: {
    code: 'UPS',
    name: 'UPS',
    nameEn: 'UPS',
    site: 'https://www.ups.com/track',
    domestic: false,
  },
  USPS: {
    code: 'USPS',
    name: 'USPS',
    nameEn: 'USPS',
    site: 'https://tools.usps.com/go/TrackConfirmAction_input',
    domestic: false,
  },
  CAINIAO: {
    code: 'CAINIAO',
    name: '알리익스프레스 (Cainiao)',
    nameEn: 'AliExpress (Cainiao)',
    site: 'https://global.cainiao.com/',
    domestic: false,
  },
  EMS: {
    code: 'EMS',
    name: '우체국 EMS / 국제',
    nameEn: 'Korea Post EMS',
    site: 'https://service.epost.go.kr/trace.RetrieveEmsTraceList.comm',
    domestic: false,
  },
  YUNEXPRESS: {
    code: 'YUNEXPRESS',
    name: '윈익스프레스',
    nameEn: 'YunExpress',
    site: 'https://www.yuntrack.com/',
    domestic: false,
  },
};

/* ------------------------------------------------------------------ *
 * lastscanned — 551 carriers, one response shape
 * ------------------------------------------------------------------ */

/** WIMP carrier code -> lastscanned carrier id. */
const LASTSCANNED_CARRIERS = {
  CJ: 'cjlogistics',
  EPOST: 'koreapost',
  HANJIN: 'hanjin',
  LOTTE: 'lotte',
  LOGEN: 'logen',
  ILYANG: 'ilyanglogis',
  DHL: 'dhl',
  FEDEX: 'fedex',
  UPS: 'ups',
  USPS: 'usps',
  CAINIAO: 'cainiao',
  EMS: 'epostglobal',
  YUNEXPRESS: 'yunexpress',
};

const CODE_BY_LASTSCANNED = Object.fromEntries(
  Object.entries(LASTSCANNED_CARRIERS).map(([code, id]) => [id, code])
);

/** The seven states lastscanned reports, mapped onto the WIMP status model. */
const LASTSCANNED_STATUS = {
  label_created: 'REGISTERED',
  in_transit: 'IN_TRANSIT',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  delivered: 'DELIVERED',
  exception: 'EXCEPTION',
  returned: 'RETURNED',
  unknown: null,
};

function lastscannedStatus(raw) {
  return LASTSCANNED_STATUS[String(raw || '').toLowerCase()] || null;
}

function lastscannedKey() {
  const key = process.env.LASTSCANNED_API_KEY;
  return key && String(key).trim() ? String(key).trim() : '';
}

function carrierForLastscanned(id) {
  const key = String(id || '').toLowerCase();
  if (!key) return null;
  const code = CODE_BY_LASTSCANNED[key];
  if (code && CARRIERS[code]) return CARRIERS[code];
  const label = key.charAt(0).toUpperCase() + key.slice(1);
  return {
    code: key.toUpperCase(),
    name: label,
    nameEn: label,
    site: 'https://www.lastscanned.com/',
    domestic: false,
    lastscanned: key,
  };
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

class TrackError extends Error {
  constructor(code, message, hint, status) {
    super(message);
    this.code = code;
    this.hint = hint || null;
    this.status = status || 400;
  }
}

const notFound = (hint) =>
  new TrackError(
    'NOT_FOUND',
    '조회된 배송 정보가 없습니다.',
    hint || '운송장 번호를 다시 확인하거나, 택배사가 아직 상품을 인수하지 않았을 수 있습니다.',
    404
  );

const upstreamError = (detail) =>
  new TrackError(
    'UPSTREAM',
    '택배사 조회 서버가 응답하지 않습니다.',
    detail || '잠시 후 다시 시도해 주세요.',
    502
  );

/* ------------------------------------------------------------------ *
 * Geo table — logistics hubs, Korean cities and global gateways
 * name|lat|lng|code|countryCode   (blank code is fine)
 * ------------------------------------------------------------------ */

const GEO_RAW = `
곤지암|37.3505|127.3463|GJM|KR
옥천|36.3064|127.5715|OKC|KR
청원|36.5500|127.4800|CHW|KR
청주|36.6424|127.4890|CJJ|KR
대전|36.3504|127.3845|DJN|KR
서울|37.5665|126.9780|SEL|KR
부산|35.1796|129.0756|PUS|KR
인천|37.4563|126.7052|ICN|KR
군포|37.3616|126.9350|GNP|KR
용인|37.2411|127.1776|YIN|KR
동서울|37.5547|127.1260|DSL|KR
수원|37.2636|127.0286|SWN|KR
성남|37.4200|127.1265|SEN|KR
안양|37.3943|126.9568|ANY|KR
부천|37.5035|126.7660|BCN|KR
고양|37.6584|126.8320|GYG|KR
일산|37.6584|126.7700|ILS|KR
김포|37.6152|126.7157|GMP|KR
파주|37.7599|126.7800|PJU|KR
의정부|37.7380|127.0337|UJB|KR
남양주|37.6360|127.2165|NYJ|KR
하남|37.5393|127.2148|HN|KR
이천|37.2720|127.4350|ICE|KR
평택|36.9921|127.1129|PTK|KR
안성|37.0079|127.2797|ASG|KR
화성|37.1994|126.8314|HSE|KR
시흥|37.3800|126.8030|SHE|KR
안산|37.3219|126.8309|ASN|KR
오산|37.1498|127.0772|OSN|KR
광명|37.4786|126.8640|GMG|KR
구리|37.5943|127.1296|GRI|KR
과천|37.4292|126.9876|GCN|KR
의왕|37.3448|126.9683|UWN|KR
포천|37.8949|127.2002|PCH|KR
양주|37.7853|127.0460|YJU|KR
동두천|37.9036|127.0606|DDC|KR
가평|37.8315|127.5106|GPY|KR
양평|37.4917|127.4875|YPY|KR
여주|37.2982|127.6370|YJU|KR
경기광주|37.4294|127.2550|GGJ|KR
춘천|37.8813|127.7298|CCN|KR
원주|37.3422|127.9202|WJU|KR
강릉|37.7519|128.8761|KLG|KR
속초|38.2070|128.5918|SKO|KR
동해|37.5247|129.1143|DHK|KR
태백|37.1639|128.9856|TBK|KR
삼척|37.4500|129.1650|SCH|KR
홍천|37.6970|127.8880|HCC|KR
횡성|37.4910|127.9850|HSE|KR
영월|37.1837|128.4617|YWL|KR
평창|37.3700|128.3900|PCH|KR
정선|37.3800|128.6600|JSN|KR
철원|38.1460|127.3130|CHW|KR
화천|38.1060|127.7080|HCH|KR
양구|38.1100|127.9900|YGU|KR
인제|38.0700|128.1700|IJE|KR
양양|38.0750|128.6200|YNY|KR
충주|36.9910|127.9259|CJU|KR
제천|37.1326|128.1910|JC|KR
단양|36.9845|128.3654|DY|KR
음성|36.9400|127.6900|EUS|KR
진천|36.8550|127.4350|JCN|KR
괴산|36.8150|127.7870|GSN|KR
증평|36.7830|127.5810|JPG|KR
보은|36.4890|127.7290|BEN|KR
영동|36.1749|127.7834|YDO|KR
천안|36.8151|127.1139|CAN|KR
아산|36.7898|127.0019|ASN|KR
서산|36.7848|126.4503|SSN|KR
당진|36.8899|126.6298|DGJ|KR
공주|36.4465|127.1190|GJU|KR
논산|36.1872|127.0987|NSN|KR
보령|36.3334|126.6128|BRY|KR
홍성|36.6010|126.6600|HSC|KR
예산|36.6800|126.8450|YSN|KR
태안|36.7450|126.2980|TAN|KR
금산|36.1080|127.4880|GSN|KR
부여|36.2750|126.9100|BYO|KR
서천|36.0800|126.6900|SCN|KR
청양|36.4590|126.8020|CYN|KR
세종|36.4800|127.2890|SJG|KR
전주|35.8242|127.1480|CJU|KR
익산|35.9483|126.9576|IKS|KR
군산|35.9676|126.7367|GSN|KR
정읍|35.5699|126.8560|JEU|KR
남원|35.4164|127.3905|NWN|KR
김제|35.8036|126.8809|GJE|KR
완주|35.9050|127.1620|WJU|KR
진안|35.7917|127.4247|JAN|KR
무주|36.0070|127.6610|MJU|KR
장수|35.6470|127.5210|JSU|KR
임실|35.6170|127.2890|ISL|KR
순창|35.3740|127.1370|SCG|KR
고창|35.4350|126.7020|GCG|KR
부안|35.7310|126.7330|BAN|KR
광주|35.1595|126.8526|KWJ|KR
목포|34.8118|126.3922|MPK|KR
여수|34.7604|127.6622|YSU|KR
순천|34.9506|127.4872|SCH|KR
나주|35.0159|126.7108|NJU|KR
광양|34.9407|127.6958|GYG|KR
담양|35.3210|126.9880|DYG|KR
곡성|35.2820|127.2920|GSE|KR
구례|35.2020|127.4630|GRE|KR
고흥|34.6110|127.2850|GHG|KR
보성|34.7710|127.0800|BSG|KR
화순|35.0640|126.9860|HSN|KR
장흥|34.6810|126.9070|JHG|KR
강진|34.6420|126.7670|GJN|KR
해남|34.5730|126.5990|HNA|KR
영암|34.8000|126.6970|YAM|KR
무안|34.9900|126.4810|MAN|KR
함평|35.0660|126.5170|HPG|KR
영광|35.2770|126.5120|YGG|KR
장성|35.3020|126.7850|JSG|KR
완도|34.3110|126.7550|WDO|KR
진도|34.4870|126.2630|JDO|KR
신안|34.8330|126.1090|SAN|KR
대구|35.8714|128.6014|TAE|KR
구미|36.1195|128.3446|KUM|KR
경산|35.8250|128.7415|GSN|KR
포항|36.0190|129.3435|KPO|KR
안동|36.5684|128.7294|ADG|KR
김천|36.1398|128.1136|GCE|KR
영주|36.8057|128.6240|YJU|KR
경주|35.8562|129.2247|GJU|KR
상주|36.4109|128.1591|SJU|KR
문경|36.5866|128.1867|MGY|KR
영천|35.9733|128.9385|YCH|KR
칠곡|35.9950|128.4010|CGK|KR
성주|35.9190|128.2830|SJU|KR
고령|35.7260|128.2630|GRY|KR
군위|36.2428|128.5728|GWU|KR
의성|36.3525|128.6970|USG|KR
청송|36.4350|129.0570|CSG|KR
영양|36.6670|129.1130|YYG|KR
영덕|36.4150|129.3650|YDK|KR
청도|35.6470|128.7340|CDO|KR
봉화|36.8930|128.7320|BHA|KR
울진|36.9930|129.4000|UJN|KR
울릉|37.4840|130.9050|ULD|KR
창원|35.2280|128.6811|CHW|KR
김해|35.2342|128.8898|KMH|KR
진주|35.1800|128.1076|JNU|KR
양산|35.3350|129.0370|YSN|KR
거제|34.8800|128.6210|GJE|KR
통영|34.8540|128.4330|TYG|KR
사천|35.0040|128.0640|SCH|KR
밀양|35.5030|128.7460|MYY|KR
함안|35.2720|128.4060|HAN|KR
창녕|35.5440|128.4920|CNG|KR
남해|34.8370|127.8920|NHJ|KR
하동|35.0670|127.7510|HDG|KR
산청|35.4150|127.8730|SCG|KR
함양|35.5200|127.7250|HYG|KR
거창|35.6870|127.9090|GCG|KR
합천|35.5660|128.1660|HCC|KR
울산|35.5384|129.3114|USN|KR
제주|33.4996|126.5312|CJU|KR
서귀포|33.2541|126.5600|SGP|KR
수성|35.8580|128.6300|SUS|KR
달서|35.8290|128.5330|DAS|KR
성동|37.5636|127.0360|SDG|KR
성수|37.5445|127.0557|SSU|KR
강남|37.5172|127.0473|GNN|KR
송파|37.5145|127.1059|SPA|KR
잠실|37.5133|127.1001|JSL|KR
강서|37.5509|126.8495|GSE|KR
마포|37.5663|126.9016|MPO|KR
영등포|37.5264|126.8963|YDP|KR
구로|37.4954|126.8874|GRO|KR
금천|37.4569|126.8956|GCN|KR
관악|37.4784|126.9516|GAK|KR
동작|37.5124|126.9393|DJK|KR
서초|37.4837|127.0324|SCH|KR
종로|37.5735|126.9790|JNO|KR
용산|37.5384|126.9654|YSN|KR
은평|37.6027|126.9291|EPG|KR
서대문|37.5791|126.9368|SDM|KR
노원|37.6542|126.0561|NWN|KR
도봉|37.6688|127.0471|DBG|KR
강북|37.6396|127.0257|GBK|KR
성북|37.5894|127.0167|SBK|KR
중랑|37.6063|127.0927|JRN|KR
광진|37.5384|127.0823|GJN|KR
동대문|37.5744|127.0396|DDM|KR
강동|37.5301|127.1238|GDG|KR
양천|37.5169|126.8664|YCN|KR
부평|37.5070|126.7219|BPG|KR
남동|37.4470|126.7310|NDG|KR
해운대|35.1631|129.1636|HUD|KR
사상|35.1528|128.9900|SSG|KR
Sofia|42.6977|23.3219|SOF|BG
Leipzig|51.3397|12.3731|LEJ|DE
Frankfurt|50.1109|8.6821|FRA|DE
Cologne|50.9375|6.9603|CGN|DE
Munich|48.1351|11.5820|MUC|DE
Hamburg|53.5511|9.9937|HAM|DE
Berlin|52.5200|13.4050|BER|DE
Amsterdam|52.3676|4.9041|AMS|NL
Rotterdam|51.9244|4.4777|RTM|NL
Brussels|50.8503|4.3517|BRU|BE
Paris|48.8566|2.3522|CDG|FR
London|51.5074|-0.1278|LHR|GB
Madrid|40.4168|-3.7038|MAD|ES
Barcelona|41.3874|2.1686|BCN|ES
Milan|45.4642|9.1900|MXP|IT
Rome|41.9028|12.4964|FCO|IT
Warsaw|52.2297|21.0122|WAW|PL
Prague|50.0755|14.4378|PRG|CZ
Vienna|48.2082|16.3738|VIE|AT
Zurich|47.3769|8.5417|ZRH|CH
Bucharest|44.4268|26.1025|OTP|RO
Budapest|47.4979|19.0402|BUD|HU
Istanbul|41.0082|28.9784|IST|TR
Dubai|25.2048|55.2708|DXB|AE
Doha|25.2854|51.5310|DOH|QA
Hong Kong|22.3193|114.1694|HKG|HK
Taipei|25.0330|121.5654|TPE|TW
Shenzhen|22.5431|114.0579|SZX|CN
Guangzhou|23.1291|113.2644|CAN|CN
Shanghai|31.2304|121.4737|PVG|CN
Beijing|39.9042|116.4074|PEK|CN
Hangzhou|30.2741|120.1551|HGH|CN
Yiwu|29.3069|120.0750|YIW|CN
Xiamen|24.4798|118.0894|XMN|CN
Qingdao|36.0671|120.3826|TAO|CN
Tianjin|39.3434|117.3616|TSN|CN
Chengdu|30.5728|104.0668|CTU|CN
Zhengzhou|34.7466|113.6254|CGO|CN
Wuhan|30.5928|114.3055|WUH|CN
Tokyo|35.6762|139.6503|NRT|JP
Narita|35.7720|140.3929|NRT|JP
Osaka|34.6937|135.5023|KIX|JP
Nagoya|35.1815|136.9066|NGO|JP
Fukuoka|33.5904|130.4017|FUK|JP
Sapporo|43.0618|141.3545|CTS|JP
Singapore|1.3521|103.8198|SIN|SG
Bangkok|13.7563|100.5018|BKK|TH
Kuala Lumpur|3.1390|101.6869|KUL|MY
Jakarta|-6.2088|106.8456|CGK|ID
Hanoi|21.0278|105.8342|HAN|VN
Ho Chi Minh|10.8231|106.6297|SGN|VN
Manila|14.5995|120.9842|MNL|PH
Mumbai|19.0760|72.8777|BOM|IN
Delhi|28.7041|77.1025|DEL|IN
Los Angeles|34.0522|-118.2437|LAX|US
Long Beach|33.7701|-118.1937|LGB|US
San Francisco|37.7749|-122.4194|SFO|US
Seattle|47.6062|-122.3321|SEA|US
Chicago|41.8781|-87.6298|ORD|US
New York|40.7128|-74.0060|JFK|US
Newark|40.7357|-74.1724|EWR|US
Memphis|35.1495|-90.0490|MEM|US
Louisville|38.2527|-85.7585|SDF|US
Cincinnati|39.1031|-84.5120|CVG|US
Anchorage|61.2181|-149.9003|ANC|US
Miami|25.7617|-80.1918|MIA|US
Dallas|32.7767|-96.7970|DFW|US
Atlanta|33.7490|-84.3880|ATL|US
Toronto|43.6532|-79.3832|YYZ|CA
Vancouver|49.2827|-123.1207|YVR|CA
Mexico City|19.4326|-99.1332|MEX|MX
Sao Paulo|-23.5505|-46.6333|GRU|BR
Sydney|-33.8688|151.2093|SYD|AU
Melbourne|-37.8136|144.9631|MEL|AU
Auckland|-36.8485|174.7633|AKL|NZ
Almaty|43.2220|76.8512|ALA|KZ
Tashkent|41.2995|69.2401|TAS|UZ
Incheon|37.4563|126.7052|ICN|KR
Seoul|37.5665|126.9780|SEL|KR
Busan|35.1796|129.0756|PUS|KR
Daegu|35.8714|128.6014|TAE|KR
Daejeon|36.3504|127.3845|DJN|KR
Gwangju|35.1595|126.8526|KWJ|KR
Suwon|37.2636|127.0286|SWN|KR
Cheongju|36.6424|127.4890|CJJ|KR
Ulsan|35.5384|129.3114|USN|KR
Jeju|33.4996|126.5312|CJU|KR
Gimpo|37.6152|126.7157|GMP|KR
Ansan|37.3219|126.8309|ASN|KR
Yongin|37.2411|127.1776|YIN|KR
Gunpo|37.3616|126.9350|GNP|KR
Pyeongtaek|36.9921|127.1129|PTK|KR
Cheonan|36.8151|127.1139|CAN|KR
Gimhae|35.2342|128.8898|KMH|KR
Changwon|35.2280|128.6811|CHW|KR
Jeonju|35.8242|127.1480|CJU|KR
Wonju|37.3422|127.9202|WJU|KR
Chuncheon|37.8813|127.7298|CCN|KR
Mokpo|34.8118|126.3922|MPK|KR
Yeosu|34.7604|127.6622|YSU|KR
Suncheon|34.9506|127.4872|SCH|KR
Icheon|37.2720|127.4350|ICE|KR
Paju|37.7599|126.7800|PJU|KR
`;

const COUNTRY = {
  KR: { name: '대한민국', nameEn: 'South Korea', lat: 36.5, lng: 127.9, flag: '🇰🇷' },
  BG: { name: '불가리아', nameEn: 'Bulgaria', lat: 42.7339, lng: 25.4858, flag: '🇧🇬' },
  DE: { name: '독일', nameEn: 'Germany', lat: 51.1657, lng: 10.4515, flag: '🇩🇪' },
  NL: { name: '네덜란드', nameEn: 'Netherlands', lat: 52.1326, lng: 5.2913, flag: '🇳🇱' },
  BE: { name: '벨기에', nameEn: 'Belgium', lat: 50.5039, lng: 4.4699, flag: '🇧🇪' },
  FR: { name: '프랑스', nameEn: 'France', lat: 46.2276, lng: 2.2137, flag: '🇫🇷' },
  GB: { name: '영국', nameEn: 'United Kingdom', lat: 55.3781, lng: -3.436, flag: '🇬🇧' },
  ES: { name: '스페인', nameEn: 'Spain', lat: 40.4637, lng: -3.7492, flag: '🇪🇸' },
  IT: { name: '이탈리아', nameEn: 'Italy', lat: 41.8719, lng: 12.5674, flag: '🇮🇹' },
  PL: { name: '폴란드', nameEn: 'Poland', lat: 51.9194, lng: 19.1451, flag: '🇵🇱' },
  CZ: { name: '체코', nameEn: 'Czechia', lat: 49.8175, lng: 15.473, flag: '🇨🇿' },
  AT: { name: '오스트리아', nameEn: 'Austria', lat: 47.5162, lng: 14.5501, flag: '🇦🇹' },
  CH: { name: '스위스', nameEn: 'Switzerland', lat: 46.8182, lng: 8.2275, flag: '🇨🇭' },
  RO: { name: '루마니아', nameEn: 'Romania', lat: 45.9432, lng: 24.9668, flag: '🇷🇴' },
  HU: { name: '헝가리', nameEn: 'Hungary', lat: 47.1625, lng: 19.5033, flag: '🇭🇺' },
  TR: { name: '튀르키예', nameEn: 'Türkiye', lat: 38.9637, lng: 35.2433, flag: '🇹🇷' },
  AE: { name: '아랍에미리트', nameEn: 'UAE', lat: 23.4241, lng: 53.8478, flag: '🇦🇪' },
  QA: { name: '카타르', nameEn: 'Qatar', lat: 25.3548, lng: 51.1839, flag: '🇶🇦' },
  HK: { name: '홍콩', nameEn: 'Hong Kong', lat: 22.3193, lng: 114.1694, flag: '🇭🇰' },
  TW: { name: '대만', nameEn: 'Taiwan', lat: 23.6978, lng: 120.9605, flag: '🇹🇼' },
  CN: { name: '중국', nameEn: 'China', lat: 35.8617, lng: 104.1954, flag: '🇨🇳' },
  JP: { name: '일본', nameEn: 'Japan', lat: 36.2048, lng: 138.2529, flag: '🇯🇵' },
  SG: { name: '싱가포르', nameEn: 'Singapore', lat: 1.3521, lng: 103.8198, flag: '🇸🇬' },
  TH: { name: '태국', nameEn: 'Thailand', lat: 15.87, lng: 100.9925, flag: '🇹🇭' },
  MY: { name: '말레이시아', nameEn: 'Malaysia', lat: 4.2105, lng: 101.9758, flag: '🇲🇾' },
  ID: { name: '인도네시아', nameEn: 'Indonesia', lat: -0.7893, lng: 113.9213, flag: '🇮🇩' },
  VN: { name: '베트남', nameEn: 'Vietnam', lat: 14.0583, lng: 108.2772, flag: '🇻🇳' },
  PH: { name: '필리핀', nameEn: 'Philippines', lat: 12.8797, lng: 121.774, flag: '🇵🇭' },
  IN: { name: '인도', nameEn: 'India', lat: 20.5937, lng: 78.9629, flag: '🇮🇳' },
  US: { name: '미국', nameEn: 'United States', lat: 39.8283, lng: -98.5795, flag: '🇺🇸' },
  CA: { name: '캐나다', nameEn: 'Canada', lat: 56.1304, lng: -106.3468, flag: '🇨🇦' },
  MX: { name: '멕시코', nameEn: 'Mexico', lat: 23.6345, lng: -102.5528, flag: '🇲🇽' },
  BR: { name: '브라질', nameEn: 'Brazil', lat: -14.235, lng: -51.9253, flag: '🇧🇷' },
  AU: { name: '호주', nameEn: 'Australia', lat: -25.2744, lng: 133.7751, flag: '🇦🇺' },
  NZ: { name: '뉴질랜드', nameEn: 'New Zealand', lat: -40.9006, lng: 174.886, flag: '🇳🇿' },
  KZ: { name: '카자흐스탄', nameEn: 'Kazakhstan', lat: 48.0196, lng: 66.9237, flag: '🇰🇿' },
  UZ: { name: '우즈베키스탄', nameEn: 'Uzbekistan', lat: 41.3775, lng: 64.5853, flag: '🇺🇿' },
};

const GEO = GEO_RAW.trim()
  .split('\n')
  .map((line) => {
    const [name, lat, lng, code, cc] = line.split('|');
    return { name, lat: Number(lat), lng: Number(lng), code: code || '', countryCode: cc || 'KR' };
  })
  .filter((g) => g.name && Number.isFinite(g.lat) && Number.isFinite(g.lng))
  .sort((a, b) => b.name.length - a.name.length);

const geoCache = new Map(); // lowercased query -> { value, expires }
let geocodeChain = Promise.resolve();
let lastGeocodeAt = 0;

function normaliseKey(text) {
  return String(text || '')
    .replace(/[\s\-_.()（）\[\]]/g, '')
    .toUpperCase();
}

/** Hub/city lookup against the built-in table (no network). */
function lookupGeo(name) {
  if (!name) return null;
  const raw = String(name).trim();
  const compact = normaliseKey(raw);
  for (const entry of GEO) {
    if (compact.includes(normaliseKey(entry.name))) return entry;
  }
  return null;
}

/** Build a location object for one carrier location string. */
function makeLocation(name, opts) {
  const options = opts || {};
  const cleanName = cleanText(name);
  if (!cleanName) return null;

  const hit = lookupGeo(cleanName);
  if (hit) {
    const country = COUNTRY[hit.countryCode] || COUNTRY.KR;
    return {
      name: cleanName,
      city: hit.name,
      code: hit.code,
      countryCode: hit.countryCode,
      country: country.name,
      countryEn: country.nameEn,
      lat: hit.lat,
      lng: hit.lng,
      precision: 'hub',
    };
  }

  /* A UPS scan says “ROISSY CDG, FRANCE”; the old default of KR painted
     every unrecognised overseas terminal with a Korean flag. Read the
     country out of the text first, then the carrier hint, and only then
     fall back — a Korean branch string is the only thing left. */
  const hint = String(options.countryCode || '').toUpperCase();
  const fromText = countryFromText(cleanName);
  const cc = (hint && COUNTRY[hint] ? hint : '') || fromText || 'KR';
  const country = COUNTRY[cc] || COUNTRY.KR;
  return {
    name: cleanName,
    city: cleanName.split(/[,(]/)[0].trim(),
    code: countryCode3(cc),
    countryCode: cc,
    country: country.name,
    countryEn: country.nameEn,
    lat: country.lat,
    lng: country.lng,
    precision: 'country',
    needsGeocode: true,
    /* No hint and no country in the text: let the geocoder decide the country too. */
    countryUncertain: !(hint && COUNTRY[hint]) && !fromText,
  };
}

const COUNTRY_ALIASES = {
  KR: ['South Korea', 'Korea', 'Republic of Korea', '대한민국', '한국'],
  BG: ['Bulgaria'], DE: ['Germany', 'Deutschland'], NL: ['Netherlands', 'Holland'],
  BE: ['Belgium'], FR: ['France'], GB: ['United Kingdom', 'Great Britain', 'England', 'UK'],
  ES: ['Spain'], IT: ['Italy'], PL: ['Poland'], CZ: ['Czech Republic', 'Czechia'],
  AT: ['Austria'], CH: ['Switzerland'], RO: ['Romania'], HU: ['Hungary'],
  TR: ['Türkiye', 'Turkey'], AE: ['United Arab Emirates', 'UAE'], QA: ['Qatar'],
  HK: ['Hong Kong'], TW: ['Taiwan'], CN: ['China'], JP: ['Japan'], SG: ['Singapore'],
  TH: ['Thailand'], MY: ['Malaysia'], ID: ['Indonesia'], VN: ['Vietnam'],
  PH: ['Philippines'], IN: ['India'], US: ['United States', 'USA', 'U.S.A.'],
  CA: ['Canada'], MX: ['Mexico'], BR: ['Brazil'], AU: ['Australia'],
  NZ: ['New Zealand'], KZ: ['Kazakhstan'], UZ: ['Uzbekistan'],
};

/** “ROISSY CDG, FRANCE”, “…, DE”, “(JP)” → the ISO code, when the text names one. */
function countryFromText(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const tail = raw.trim().match(/(?:^|[\s,(\-])([A-Z]{2})[)\].]?\s*$/);
  if (tail && COUNTRY[tail[1]]) return tail[1];
  const padded = ` ${raw.toLowerCase().replace(/[^a-z0-9\uac00-\ud7a3]+/g, ' ')} `;
  for (const [cc, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (aliases.some((alias) => padded.includes(` ${alias.toLowerCase()} `))) return cc;
  }
  return '';
}


const ALPHA3 = { KR: 'KOR', BG: 'BGR', DE: 'DEU', NL: 'NLD', BE: 'BEL', FR: 'FRA', GB: 'GBR', ES: 'ESP', IT: 'ITA', PL: 'POL', CZ: 'CZE', AT: 'AUT', CH: 'CHE', RO: 'ROU', HU: 'HUN', TR: 'TUR', AE: 'ARE', QA: 'QAT', HK: 'HKG', TW: 'TWN', CN: 'CHN', JP: 'JPN', SG: 'SGP', TH: 'THA', MY: 'MYS', ID: 'IDN', VN: 'VNM', PH: 'PHL', IN: 'IND', US: 'USA', CA: 'CAN', MX: 'MEX', BR: 'BRA', AU: 'AUS', NZ: 'NZL', KZ: 'KAZ', UZ: 'UZB' };
const countryCode3 = (cc) => ALPHA3[cc] || cc;

/** Nominatim fallback for locations the built-in table does not know (1 req/s, cached). */
function geocodeRemote(location) {
  if (!location || !location.needsGeocode) return Promise.resolve(location);
  /* When the country was only guessed, do not restrict the search to it. */
  const certain = !location.countryUncertain;
  const key = normaliseKey(location.name) + '|' + (certain ? location.countryCode : '??');
  const cached = geoCache.get(key);
  if (cached && cached.expires > Date.now()) return Promise.resolve({ ...location, ...cached.value });
  if (geoCache.size > 300) geoCache.clear();

  const run = geocodeChain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
    if (wait > 0) await sleep(wait);
    lastGeocodeAt = Date.now();
    const korean = certain && location.countryCode === 'KR';
    const q = certain ? `${location.name}, ${korean ? '대한민국' : (location.countryEn || location.countryCode)}` : location.name;
    const url =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&addressdetails=1' +
      (korean ? '&countrycodes=kr' : '') +
      '&accept-language=' + (korean ? 'ko' : 'en') +
      '&q=' + encodeURIComponent(q);
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': NOMINATIM_UA, accept: 'application/json' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error('nominatim ' + res.status);
      const list = await res.json();
      if (!Array.isArray(list) || !list.length) throw new Error('no result');
      const point = { lat: Number(list[0].lat), lng: Number(list[0].lon), precision: 'geocoded' };
      // The geocoder knows the country even when the scan text did not.
      const found = String((list[0].address && list[0].address.country_code) || '').toUpperCase();
      if (!certain && COUNTRY[found]) {
        point.countryCode = found;
        point.country = COUNTRY[found].name;
        point.countryEn = COUNTRY[found].nameEn;
        point.code = countryCode3(found);
      }
      geoCache.set(key, { value: point, expires: Date.now() + 24 * 3600 * 1000 });
      return { ...location, ...point };
    } catch {
      geoCache.set(key, { value: {}, expires: Date.now() + 6 * 3600 * 1000 });
      return location;
    }
  });
  geocodeChain = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** HTML cell/row text: drop tags, scripts, comments and collapse whitespace. */
function cleanText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|tr|td|th)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Personal data that appears in carrier scan text (driver phone numbers, recipient lines). */
function maskPersonal(text) {
  return String(text || '')
    .replace(/\b(0\d{1,2})[-.\s]?(\d{3,4})[-.\s]?(\d{4})\b/g, '$1-****-****')
    .replace(/\((?:수령인|받는분)\s*:[^)]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function tablesOf(html) {
  const out = [];
  const re = /<table\b[\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[0]);
  return out;
}

function rowsOf(html) {
  const out = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function cellsOf(rowHtml) {
  const out = [];
  const re = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(rowHtml))) {
    const attrs = (rowHtml.slice(0, m.index).match(/<(td|th)\b[^>]*>$/i) || [''])[0];
    const colspan = Number((attrs.match(/colspan\s*=\s*["']?(\d+)/i) || [])[1] || 1);
    out.push({ tag: m[1].toLowerCase(), html: m[2], text: cleanText(m[2]), colspan });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Time helpers
 * ------------------------------------------------------------------ */

function kstToIso(dateText, timeText) {
  const d = String(dateText || '').match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!d) return null;
  const t = String(timeText || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const hh = t ? t[1].padStart(2, '0') : '00';
  const mm = t ? t[2] : '00';
  const ss = t && t[3] ? t[3] : '00';
  const iso = `${d[1]}-${d[2].padStart(2, '0')}-${d[3].padStart(2, '0')}T${hh}:${mm}:${ss}+09:00`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function isoToKst(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

/* ------------------------------------------------------------------ *
 * Estimated delivery date
 *   A carrier gives either a local calendar date ("2026-12-01") or an
 *   instant ("2026-12-01T14:00:00Z"). We keep one normalised field,
 *   estimatedDelivery: "YYYY-MM-DD" in Korean calendar days.
 * ------------------------------------------------------------------ */

function calendarDate(value) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function kstDateOf(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Normalise whatever a carrier reports into one KST calendar date.
 * localDate  — a date the carrier printed in the receiver's timezone.
 * instants   — ISO timestamps (UTC/offset) that must first move to KST.
 */
function estimatedDate(localDate, instants) {
  const plain = String(localDate || '').trim();
  const looksLikeInstant = /T.*(Z|[+-]\d{2}:?\d{2})$/i.test(plain);
  if (plain && !looksLikeInstant) {
    const date = calendarDate(plain);
    if (date) return date;
  }
  if (looksLikeInstant) {
    const date = kstDateOf(plain);
    if (date) return date;
  }
  for (const value of instants || []) {
    const date = kstDateOf(value);
    if (date) return date;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Status model
 * ------------------------------------------------------------------ */

const STAGE = {
  REGISTERED: 0,
  PICKED_UP: 1,
  IN_TRANSIT: 2,
  OUT_FOR_DELIVERY: 3,
  DELIVERED: 4,
  EXCEPTION: -1,
  RETURNED: -1,
  UNKNOWN: -2,
};

const STATUS_LABEL = {
  REGISTERED: '접수',
  PICKED_UP: '집하',
  IN_TRANSIT: '이동 중',
  OUT_FOR_DELIVERY: '배송 출발',
  DELIVERED: '배달 완료',
  EXCEPTION: '예외',
  RETURNED: '반송',
  UNKNOWN: '확인 중',
};

function statusOf(code) {
  return { code, label: STATUS_LABEL[code] || STATUS_LABEL.UNKNOWN, stage: STAGE[code] ?? -2 };
}

function includesAny(text, needles) {
  return needles.some((n) => text.includes(n));
}

/* ------------------------------------------------------------------ *
 * Physical movement vs paperwork
 *   DHL opens the customs file at the destination days before the parcel
 *   gets there (“Customs clearance status updated – INCHEON”) and many
 *   feeds carry the pre-advice (“Shipment information received”, “label
 *   created”). Those scans describe data, not a stop: drawing them as a
 *   route sends the parcel Sofia → Incheon → Sofia → Leipzig → Incheon.
 *   Only a scan that says the parcel itself moved may become a route node.
 * ------------------------------------------------------------------ */

const DOCUMENT_SCAN = [
  /customs clearance status/i,
  /clearance status updated/i,
  /customs status updated/i,
  /customs (?:clearance )?(?:information|notification|pre-?notification)/i,
  /shipment information (?:received|sent)/i,
  /shipment data (?:received|sent)/i,
  /information received/i,
  /electronic (?:notification|data|advance|pre-?advice)/i,
  /pre-?advice/i,
  /pre-?alert/i,
  /label (?:created|printed|issued)/i,
  /waybill (?:created|issued)/i,
  /사전\s*통관/,
  /통관\s*(?:정보|서류|신고\s*접수)/,
  /전자\s*(?:통관|정보|사전\s*신고)/,
  /수입\s*신고\s*접수/,
  /(?:書類|電子)\s*(?:受信|通知)/,
  /通関\s*(?:情報|書類)/,
  /事前\s*通関/,
];

const CUSTOMS_SCAN = /customs|clearance|통관|通関|zoll|douane|aduana/i;

/** True when the scan announces paperwork/notification rather than a physical scan. */
function isDocumentScan(ev) {
  if (!ev) return false;
  const text = `${(ev && ev.scan) || ''} ${(ev && ev.description) || ''}`.trim();
  if (!text) return false;
  return DOCUMENT_SCAN.some((re) => re.test(text));
}

function isCustomsScan(ev) {
  if (!ev) return false;
  return CUSTOMS_SCAN.test(`${(ev && ev.scan) || ''} ${(ev && ev.description) || ''}`);
}

/* One route node per city/terminal, however many scans land there. */
function locationKey(loc) {
  if (!loc) return '';
  const city = String(loc.city || loc.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\uac00-\ud7a3]/g, '');
  const cc = String(loc.countryCode || '').toUpperCase();
  if (city) return `${cc}|${city}`;
  return `${Number(loc.lat).toFixed(2)},${Number(loc.lng).toFixed(2)}`;
}

/* Events that can move a parcel: they carry coordinates and are not paperwork. */
function locatedEvents(events) {
  return events.filter((ev) => ev && ev.location && Number.isFinite(ev.location.lat) && Number.isFinite(ev.location.lng));
}

/** A customs scan the parcel never physically reached: same country on both sides of it. */
function dropSandwichedCustoms(list) {
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const ev = list[i];
    if (!isCustomsScan(ev)) {
      out.push(ev);
      continue;
    }
    const prev = out[out.length - 1];
    const next = list.slice(i + 1).find((other) => !isCustomsScan(other));
    const cc = ev.location.countryCode;
    if (prev && next && cc && prev.location.countryCode === next.location.countryCode && cc !== prev.location.countryCode) {
      continue;
    }
    out.push(ev);
  }
  return out;
}

function cjStatus(row) {
  switch (String(row.crgSt || '')) {
    case '11':
      return 'PICKED_UP';
    case '21':
    case '41':
    case '42':
    case '43':
    case '44':
    case '46':
    case '47':
    case '48':
    case '49':
      return 'IN_TRANSIT';
    case '81':
    case '82':
    case '83':
    case '84':
      return 'OUT_FOR_DELIVERY';
    case '91':
      return 'DELIVERED';
    case '99':
      return 'EXCEPTION';
    default:
      break;
  }
  const scan = String(row.scanNm || '') + ' ' + String(row.crgNm || '');
  if (includesAny(scan, ['배달완료', '배송완료'])) return 'DELIVERED';
  if (includesAny(scan, ['배송출발', '배달출발'])) return 'OUT_FOR_DELIVERY';
  if (includesAny(scan, ['집화', '집하'])) return 'PICKED_UP';
  if (includesAny(scan, ['상차', '하차', '이동', '입고', '도착', '출발', '간선'])) return 'IN_TRANSIT';
  if (includesAny(scan, ['접수', '등록'])) return 'REGISTERED';
  return 'UNKNOWN';
}

function epostStatus(text) {
  const s = String(text || '');
  if (includesAny(s, ['배달완료', '배달 완료', '인수완료'])) return 'DELIVERED';
  if (s.includes('배달준비')) return 'OUT_FOR_DELIVERY';
  if (includesAny(s, ['미배달', '반송', '취소', '사고'])) return 'EXCEPTION';
  if (includesAny(s, ['도착', '발송', '이동', '집하완료', '간선'])) return 'IN_TRANSIT';
  if (includesAny(s, ['접수', '운송장출력'])) return 'REGISTERED';
  return 'UNKNOWN';
}

function hanjinStatus(text) {
  const s = String(text || '');
  if (s.includes('배송완료')) return 'DELIVERED';
  if (s.includes('배송출발')) return 'OUT_FOR_DELIVERY';
  if (includesAny(s, ['미배송', '반송', '사고', '보류'])) return 'EXCEPTION';
  if (includesAny(s, ['집하', '인수'])) return 'PICKED_UP';
  if (includesAny(s, ['이동', '도착', '출발', '간선', '상차', '하차', '입고', '통관', '항공', '선편'])) return 'IN_TRANSIT';
  if (includesAny(s, ['접수', '등록', '예정'])) return 'REGISTERED';
  return 'UNKNOWN';
}

function lotteStatus(code, text) {
  switch (String(code || '')) {
    case '10':
      return 'PICKED_UP';
    case '12':
      return 'REGISTERED';
    case '20':
    case '21':
    case '23':
    case '24':
    case '25':
    case '26':
    case '30':
      return 'IN_TRANSIT';
    case '40':
      return 'OUT_FOR_DELIVERY';
    case '41':
    case '45':
      return 'DELIVERED';
    case '09':
      return 'EXCEPTION';
    default:
      break;
  }
  const s = String(text || '');
  if (s.includes('배달완료')) return 'DELIVERED';
  if (s.includes('배송출발')) return 'OUT_FOR_DELIVERY';
  if (includesAny(s, ['취소', '반송', '사고'])) return 'EXCEPTION';
  if (includesAny(s, ['집하', '인수'])) return 'PICKED_UP';
  if (includesAny(s, ['이동', '도착', '출발', '간선'])) return 'IN_TRANSIT';
  if (includesAny(s, ['접수', '등록', '준비'])) return 'REGISTERED';
  return 'UNKNOWN';
}

function dhlStatus(code, description) {
  const s = String(description || '');
  switch (String(code || '').toLowerCase()) {
    case 'delivered':
      return 'DELIVERED';
    case 'transit':
      return 'IN_TRANSIT';
    case 'delivery':
      return 'OUT_FOR_DELIVERY';
    case 'failure':
    case 'exception':
      return 'EXCEPTION';
    case 'pre-transit':
    case 'pretransit':
      return 'REGISTERED';
    default:
      break;
  }
  if (s.includes('delivered')) return 'DELIVERED';
  if (s.toLowerCase().includes('out for delivery')) return 'OUT_FOR_DELIVERY';
  if (includesAny(s, ['with delivery courier', '배송 출발'])) return 'OUT_FOR_DELIVERY';
  return 'IN_TRANSIT';
}

/* ------------------------------------------------------------------ *
 * Upstream fetch helpers
 * ------------------------------------------------------------------ */

async function httpFetch(url, options, timeoutMs) {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs || UPSTREAM_TIMEOUT_MS),
    redirect: 'follow',
  });
  return res;
}

function baseHeaders(extra) {
  return {
    'user-agent': DESKTOP_UA,
    'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
    ...(extra || {}),
  };
}

function cookieOf(res) {
  try {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return list.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * Carrier adapters
 * ------------------------------------------------------------------ */

async function trackCJ(number) {
  if (!/^\d{10}$|^\d{12}$/.test(number)) {
    throw new TrackError('BAD_REQUEST', 'CJ대한통운 운송장 번호는 10자리 또는 12자리 숫자입니다.', null, 400);
  }

  const entry = 'https://www.cjlogistics.com/ko/tool/parcel/tracking';
  const page = await httpFetch(entry, { headers: baseHeaders({ accept: 'text/html' }) });
  if (!page.ok) throw upstreamError('CJ 진입 페이지 응답 ' + page.status);
  const html = await page.text();
  const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/i) || html.match(/_csrf["']\s*[:=]\s*["']([0-9a-f-]{20,})/i);
  if (!csrfMatch) throw upstreamError('CJ 보안 토큰(_csrf)을 받지 못했습니다.');
  const cookie = cookieOf(page);

  const body = new URLSearchParams({ _csrf: csrfMatch[1], paramInvcNo: number }).toString();
  const detailUrl = `https://www.cjlogistics.com/ko/tool/parcel/tracking-detail?paramInvcNo=${encodeURIComponent(number)}&_csrf=${encodeURIComponent(csrfMatch[1])}`;
  const res = await httpFetch(detailUrl, {
    method: 'POST',
    headers: baseHeaders({
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      referer: entry,
      origin: 'https://www.cjlogistics.com',
      ...(cookie ? { cookie } : {}),
    }),
    body,
  });
  if (!res.ok) throw upstreamError('CJ 조회 응답 ' + res.status);

  let json;
  try {
    json = await res.json();
  } catch {
    throw upstreamError('CJ 응답 형식을 읽을 수 없습니다.');
  }

  const rows = (json.parcelDetailResultMap && json.parcelDetailResultMap.resultList) || [];
  if (!Array.isArray(rows) || rows.length === 0) throw notFound();

  const events = rows.map((row) => {
    const code = cjStatus(row);
    return {
      time: kstToIso(row.dTime, String(row.dTime || '').slice(11)),
      status: statusOf(code),
      description: maskPersonal(row.crgNm || row.scanNm || ''),
      scan: cleanText(row.scanNm || ''),
      location: makeLocation(row.regBranNm, { countryCode: 'KR' }),
    };
  });

  return { events, source: 'cjlogistics', raw: { count: rows.length } };
}

async function trackEPOST(number) {
  if (!/^\d{9,15}$/.test(number)) {
    throw new TrackError('BAD_REQUEST', '우체국 등기번호는 13자리 숫자입니다.', null, 400);
  }
  const url = `https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=${encodeURIComponent(number)}&displayHeader=N`;
  const res = await httpFetch(url, { headers: baseHeaders({ accept: 'text/html' }) });
  if (!res.ok) throw upstreamError('우체국 조회 응답 ' + res.status);
  const html = await res.text();

  const tableMatch =
    html.match(/<table[^>]*id\s*=\s*["']?processTable["']?[^>]*>([\s\S]*?)<\/table>/i) || null;
  if (!tableMatch) throw upstreamError('우체국 응답에서 배송 진행 표를 찾지 못했습니다.');

  const events = [];
  for (const rowHtml of rowsOf(tableMatch[1])) {
    const cells = cellsOf(rowHtml);
    if (cells.length < 4) continue;
    if (cells[0].tag === 'th') continue; // header row
    const statusText = extractEpostStatus(cells[3].html);
    const locationText = extractEpostLocation(cells[2].html);
    const time = kstToIso(cells[0].text, cells[1].text);
    if (!statusText && !locationText && !time) continue;
    events.push({
      time,
      status: statusOf(epostStatus(statusText)),
      description: maskPersonal([statusText, locationText].filter(Boolean).join(' · ')),
      scan: statusText,
      location: makeLocation(locationText, { countryCode: 'KR' }),
    });
  }

  if (events.length === 0) throw notFound('우체국에 등록되지 않았거나 아직 접수 전인 번호입니다.');
  return { events, source: 'epost' };
}

function extractEpostLocation(html) {
  const span = String(html).match(/<span[^>]*>([\s\S]*?)<\/span>/i);
  if (span && cleanText(span[1])) return cleanText(span[1]);
  const text = cleanText(html);
  return text.split(/TEL|전화|문의/i)[0].trim();
}

function extractEpostStatus(html) {
  const evtnm = String(html).match(/<span[^>]*class\s*=\s*["'][^"']*evtnm[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  if (evtnm && cleanText(evtnm[1])) return cleanText(evtnm[1]);
  return cleanText(html).split(/\(|▶|※/)[0].trim();
}

async function trackHANJIN(number) {
  if (!/^\d{10,14}$/.test(number)) {
    throw new TrackError('BAD_REQUEST', '한진택배 운송장 번호는 12자리(또는 14자리) 숫자입니다.', null, 400);
  }
  const url = 'https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do';
  const res = await httpFetch(url, {
    method: 'POST',
    headers: baseHeaders({
      accept: 'text/html',
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038',
    }),
    body: new URLSearchParams({ wblnum: number, mCode: 'MN038', schLang: 'KR' }).toString(),
  });
  if (res.status === 403) throw upstreamError('한진택배가 이 서버의 조회를 차단했습니다.');
  if (!res.ok) throw upstreamError('한진 조회 응답 ' + res.status);
  const html = await res.text();

  if (/운송장이 등록되지 않|잘못된 운송장/.test(html)) {
    throw notFound('한진택배에 등록되지 않은 번호입니다. 송장번호와 자릿수를 확인해 주세요.');
  }

  const tables = tablesOf(html);
  if (tables.length < 2) throw upstreamError('한진 응답에서 배송 표를 찾지 못했습니다.');

  const infoText = cleanText(tables[0]);
  if (!infoText.includes(number)) {
    throw notFound('한진택배에 등록되지 않은 번호입니다.');
  }

  const events = [];
  for (const rowHtml of rowsOf(tables[1])) {
    const cells = cellsOf(rowHtml);
    if (cells.length < 4) continue;
    if (cells[0].tag === 'th') continue;
    if (/상품위치|현재위치|처리현황/.test(cells[2].text)) continue;
    const statusText = cells[3].text;
    const locationText = cells[2].text;
    const time = kstToIso(cells[0].text, cells[1].text);
    if (!statusText && !time) continue;
    events.push({
      time,
      status: statusOf(hanjinStatus(statusText)),
      description: maskPersonal(statusText),
      scan: statusText,
      location: makeLocation(locationText, { countryCode: 'KR' }),
    });
  }

  if (events.length === 0) throw notFound('한진택배 배송 이력이 아직 없습니다.');
  return { events, source: 'hanjin' };
}

async function trackLOTTE(number) {
  if (!/^\d{10,13}$/.test(number)) {
    throw new TrackError('BAD_REQUEST', '롯데택배 운송장 번호는 12자리 숫자입니다.', null, 400);
  }
  const url = `https://www.lotteglogis.com/mobile/reservation/tracking/linkView?InvNo=${encodeURIComponent(number)}`;
  const res = await httpFetch(url, { headers: baseHeaders({ accept: 'text/html', 'user-agent': MOBILE_UA }) });
  if (!res.ok) throw upstreamError('롯데 조회 응답 ' + res.status);
  const html = await res.text();

  const tables = tablesOf(html);
  if (tables.length === 0) throw upstreamError('롯데 응답에서 배송 표를 찾지 못했습니다.');

  let summary = {};
  let eventRows = [];
  for (const table of tables) {
    const text = cleanText(table);
    if (text.includes('운송장 번호') && (text.includes('발송지') || text.includes('도착지'))) {
      for (const rowHtml of rowsOf(table)) {
        const cells = cellsOf(rowHtml);
        if (cells.length >= 2) summary[cells[0].text] = cells[1].text;
      }
      continue;
    }
    if (text.includes('처리현황') || text.includes('현위치')) {
      eventRows = rowsOf(table).map(cellsOf).filter((cells) => cells.length >= 4);
    }
  }

  if (!summary['운송장 번호']) throw notFound('롯데택배에 등록되지 않은 번호입니다.');

  const events = [];
  for (const cells of eventRows) {
    if (cells[0].tag === 'th') continue;
    const time = kstToIso(cells[1].text, cells[1].text);
    const statusText = cells[3].text;
    if (!time && !statusText) continue;
    events.push({
      time,
      status: statusOf(lotteStatus(null, statusText)),
      description: maskPersonal(statusText),
      scan: statusText,
      location: makeLocation(cells[2].text, { countryCode: 'KR' }),
    });
  }

  if (events.length === 0) {
    const result = summary['배달결과'] || '조회 결과 없음';
    if (/취소/.test(result)) {
      throw new TrackError('NOT_FOUND', '접수 취소된 운송장입니다.', result, 404);
    }
    const from = makeLocation(summary['발송지'], { countryCode: 'KR' });
    const to = makeLocation(summary['도착지'], { countryCode: 'KR' });
    events.push({
      time: null,
      status: statusOf(/완료/.test(result) ? 'DELIVERED' : 'REGISTERED'),
      description: maskPersonal(result),
      scan: result,
      location: from,
    });
    if (to && from && (to.lat !== from.lat || to.lng !== from.lng)) {
      events.push({
        time: null,
        status: statusOf(/완료/.test(result) ? 'DELIVERED' : 'REGISTERED'),
        description: '도착지',
        scan: '도착지',
        location: to,
      });
    }
  }

  return { events, source: 'lotte', raw: { summary } };
}

async function trackDHL(number) {
  const key = process.env.DHL_API_KEY;
  if (!key) {
    throw new TrackError(
      'NEEDS_KEY',
      'DHL_API_KEY 또는 LASTSCANNED_API_KEY 환경변수가 필요합니다.',
      'developer.dhl.com 무료 키(일 250건)를 Vercel의 DHL_API_KEY에 넣거나, lastscanned 키를 LASTSCANNED_API_KEY에 넣으면 DHL 실시간 조회가 켜집니다.',
      501
    );
  }

  const url = `https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(number)}`;
  const res = await httpFetch(url, {
    headers: baseHeaders({ accept: 'application/json', 'DHL-API-Key': key }),
  });
  if (res.status === 404) throw notFound('DHL에 등록되지 않은 번호입니다.');
  if (res.status === 401 || res.status === 403) {
    throw new TrackError('NEEDS_KEY', 'DHL API 키가 거부되었습니다.', 'Vercel의 DHL_API_KEY 값을 다시 확인해 주세요.', 502);
  }
  if (!res.ok) throw upstreamError('DHL 조회 응답 ' + res.status);

  const json = await res.json();
  const shipment = (json.shipments || [])[0];
  if (!shipment) throw notFound('DHL에 등록되지 않은 번호입니다.');

  const events = (shipment.events || []).map((ev) => {
    const addr = (ev.location && ev.location.address) || {};
    /* The event's own location string usually names the country; do not
default a US or French event to Germany. */
    const place = addr.addressLocality || (ev.location && ev.location.address && ev.location.address.countryCode) || '';
    const cc = (addr.countryCode || '').toUpperCase();
    return {
      time: isoToKst(ev.timestamp),
      status: statusOf(dhlStatus(ev.statusCode, ev.status)),
      description: maskPersonal(ev.status || ''),
      scan: ev.status || '',
      location: makeLocation(place, { countryCode: cc }),
    };
  });

  if (events.length === 0) throw notFound('DHL 배송 이력이 아직 없습니다.');
  return {
    events,
    source: 'dhl',
    carrier: CARRIERS.DHL,
    estimatedDelivery: estimatedDate(null, [shipment.estimatedTimeOfDelivery, shipment.estimatedDeliveryDate]),
  };
}

/* ------------------------------------------------------------------ *
 * lastscanned adapter — one request, 551 carriers
 * ------------------------------------------------------------------ */

async function trackLastscanned(number, carrierId) {
  const key = lastscannedKey();
  if (!key) {
    throw new TrackError(
      'NEEDS_KEY',
      'LASTSCANNED_API_KEY 환경변수가 필요합니다.',
      'lastscanned.com API 키를 Vercel의 LASTSCANNED_API_KEY에 넣으면 로젠·일양·FedEx·UPS·USPS·Cainiao·EMS 등 전 세계 551개 택배사를 조회할 수 있습니다.',
      501
    );
  }

  const url = new URL(`${LASTSCANNED_BASE}/${encodeURIComponent(number)}`);
  if (carrierId) url.searchParams.set('carrier', carrierId);
  const endpoint = url.toString();

  let status = 0;
  let payload = null;
  let failure = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
    try {
      res = await fetch(endpoint, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(LASTSCANNED_TIMEOUT_MS),
        redirect: 'follow',
      });
    } catch {
      throw new TrackError('TIMEOUT', '배송 조회 서버 응답이 너무 늦습니다.', '잠시 후 다시 시도해 주세요.', 504);
    }
    status = res.status;
    const text = await res.text();
    payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    failure = payload && payload.error ? String(payload.error.code || '') : '';

    // carrier_error / carrier_unavailable are the flaky ones (koreapost parse); one short retry.
    if ((status === 502 || status === 503) && attempt === 0) {
      await sleep(LASTSCANNED_RETRY_MS);
      continue;
    }
    break;
  }

  const errorMessage = (payload && payload.error && payload.error.message) || '';

  if (status === 404 || failure === 'not_found') {
    throw notFound(
      carrierId === 'koreapost'
        ? '우체국에 등록되지 않았거나 아직 접수 전인 번호입니다.'
        : '택배사에 등록된 배송 정보가 없습니다. 운송장 번호를 다시 확인해 주세요.'
    );
  }
  if (status === 401 || failure === 'unauthorized') {
    throw new TrackError(
      'NEEDS_KEY',
      'LASTSCANNED_API_KEY가 거부되었습니다.',
      'Vercel의 LASTSCANNED_API_KEY 값을 다시 확인해 주세요.',
      502
    );
  }
  if (status === 429 || failure === 'rate_limited') {
    throw new TrackError(
      'RATE_LIMITED',
      '택배사 조회 한도에 잠시 도달했습니다.',
      '1분 뒤 또는 00:00 UTC 이후에 다시 시도해 주세요.',
      429
    );
  }
  if (status === 400 && (failure === 'unknown_carrier' || failure === 'bad_request' || failure === 'postcode_required')) {
    throw new TrackError(
      'BAD_REQUEST',
      failure === 'postcode_required'
        ? '이 택배사는 우편번호가 함께 필요합니다.'
        : '이 번호 형식을 택배사가 인식하지 못했습니다.',
      '운송장 번호를 다시 확인하거나 다른 택배사를 선택해 주세요.',
      400
    );
  }
  if (status === 502 || status === 503) {
    throw upstreamError(
      'lastscanned에서 택배사 응답을 받지 못했습니다' + (failure ? ` (${failure})` : '') + '.'
    );
  }
  if (status < 200 || status >= 300) {
    throw upstreamError('lastscanned 응답 ' + status + (errorMessage ? ' · ' + errorMessage.slice(0, 80) : ''));
  }
  if (!payload || typeof payload !== 'object') {
    throw upstreamError('lastscanned 응답 형식을 읽을 수 없습니다.');
  }

  const declared = lastscannedStatus(payload.status);
  const rawEvents = Array.isArray(payload.events) ? payload.events : [];

  // lastscanned returns newest first; the rest of the server works oldest first.
  const events = rawEvents
    .slice()
    .reverse()
    .map((ev) => {
      const place = cleanText(ev.location || '');
      const ccMatch = place.match(/(?:,\s*|\s)([A-Z]{2})$/);
      const statusCode = lastscannedStatus(ev.status) || 'UNKNOWN';
      const local = ev.localTime ? String(ev.localTime) : '';
      return {
        time: isoToKst(ev.timestamp) || (local ? isoToKst(/[Zz]|[+-]\d{2}:?\d{2}$/.test(local) ? local : local + 'Z') : null),
        status: statusOf(statusCode),
        description: maskPersonal(ev.description || ''),
        scan: cleanText(ev.description || '') || STATUS_LABEL[statusCode],
        location: place ? makeLocation(place, { countryCode: ccMatch ? ccMatch[1] : undefined }) : null,
      };
    });

  if (events.length === 0) {
    if (!declared && !payload.statusDescription) {
      throw notFound('택배사에 등록된 배송 정보가 없습니다.');
    }
    const code = declared || 'UNKNOWN';
    events.push({
      time: isoToKst(payload.deliveredAt) || null,
      status: statusOf(code),
      description: maskPersonal(payload.statusDescription || payload.message || ''),
      scan: cleanText(payload.statusDescription || '') || STATUS_LABEL[code],
      location: null,
    });
  }

  return {
    events,
    source: 'lastscanned',
    upstreamCarrier: payload.carrier || carrierId || null,
    carrier: carrierForLastscanned(payload.carrier || carrierId),
    declaredStatus: declared,
    estimatedDelivery: estimatedDate(payload.estimatedDelivery, [payload.estimatedDeliveryAt]),
    service: payload.service || null,
    message: payload.message || null,
  };
}

async function runStep(step, number) {
  if (step.via === 'lastscanned') return trackLastscanned(number, step.ls);
  if (step.via === 'dhl') return trackDHL(number);
  const adapter = ADAPTERS[step.carrier];
  if (!adapter) {
    throw new TrackError('BAD_REQUEST', '알 수 없는 택배사입니다.', '택배사를 다시 선택해 주세요.', 400);
  }
  return adapter(number);
}

const ADAPTERS = {
  CJ: trackCJ,
  EPOST: trackEPOST,
  HANJIN: trackHANJIN,
  LOTTE: trackLOTTE,
  DHL: trackDHL,
};

/* ------------------------------------------------------------------ *
 * Carrier detection
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Carrier routing
 *   A plan is an ordered list of attempts. Domestic free parsers come
 *   first (they cost nothing); lastscanned is the fallback and the only
 *   route for the other 547 carriers.
 * ------------------------------------------------------------------ */

const FREE_DOMESTIC = ['CJ', 'EPOST', 'HANJIN', 'LOTTE'];

const needsLastscannedKey = (carrierCode) => {
  const name = carrierCode && CARRIERS[carrierCode] ? CARRIERS[carrierCode].name + '는 ' : '';
  return new TrackError(
    'NEEDS_KEY',
    'LASTSCANNED_API_KEY 환경변수가 필요합니다.',
    `${name}lastscanned.com 키를 Vercel의 LASTSCANNED_API_KEY에 넣으면 로젠·일양·FedEx·UPS·USPS·Cainiao·EMS 등 전 세계 551개 택배사를 조회할 수 있습니다.`,
    501
  );
};

function planRoute(number, requested) {
  const hasLastscanned = Boolean(lastscannedKey());

  if (requested && requested !== 'AUTO') {
    if (requested === 'GLOBAL') {
      if (!hasLastscanned) throw needsLastscannedKey('');
      return [{ carrier: null, via: 'lastscanned', ls: '', auto: true }];
    }

    if (FREE_DOMESTIC.includes(requested)) {
      const plan = [{ carrier: requested, via: 'free' }];
      if (hasLastscanned) {
        plan.push({ carrier: requested, via: 'lastscanned', ls: LASTSCANNED_CARRIERS[requested], fallback: true });
      }
      return plan;
    }

    if (requested === 'DHL') {
      const plan = [];
      if (hasLastscanned) plan.push({ carrier: 'DHL', via: 'lastscanned', ls: 'dhl' });
      // Older deployments only have DHL_API_KEY — keep that path working.
      if (process.env.DHL_API_KEY) plan.push({ carrier: 'DHL', via: 'dhl' });
      if (plan.length === 0) plan.push({ carrier: 'DHL', via: 'dhl' });
      return plan;
    }

    if (LASTSCANNED_CARRIERS[requested]) {
      if (!hasLastscanned) throw needsLastscannedKey(requested);
      return [{ carrier: requested, via: 'lastscanned', ls: LASTSCANNED_CARRIERS[requested] }];
    }

    if (!ADAPTERS[requested]) {
      throw new TrackError('BAD_REQUEST', '알 수 없는 택배사입니다.', '택배사를 다시 선택해 주세요.', 400);
    }
    return [{ carrier: requested, via: 'free' }];
  }

  // AUTO: domestic by number length first, then lastscanned auto-detection.
  if (/^1Z[0-9A-Z]{16}$/i.test(number)) {
    if (!hasLastscanned) {
      throw new TrackError(
        'UNSUPPORTED',
        'UPS는 아직 지원하지 않습니다.',
        'Vercel에 LASTSCANNED_API_KEY를 추가하면 UPS·FedEx·USPS 등 551개 택배사를 바로 조회할 수 있습니다.',
        501
      );
    }
    return [{ carrier: 'UPS', via: 'lastscanned', ls: 'ups', auto: true }];
  }

  const plan = [];
  if (/^\d+$/.test(number)) {
    const len = number.length;
    if (len === 13) plan.push({ carrier: 'EPOST', via: 'free' });
    else if (len === 14) plan.push({ carrier: 'HANJIN', via: 'free' });
    else if (len === 10) plan.push({ carrier: 'CJ', via: 'free' });
    else if (len === 12) {
      plan.push({ carrier: 'CJ', via: 'free' });
      plan.push({ carrier: 'LOTTE', via: 'free' });
      plan.push({ carrier: 'HANJIN', via: 'free' });
    } else if (len === 11) plan.push({ carrier: 'LOTTE', via: 'free' });
    else if (len >= 9) FREE_DOMESTIC.forEach((carrier) => plan.push({ carrier, via: 'free' }));
  }

  if (hasLastscanned) {
    // A 12-digit domestic number can be mistaken for FedEx, so this stays last.
    plan.push({ carrier: null, via: 'lastscanned', ls: '', auto: true, fallback: true });
  }

  if (plan.length === 0) {
    throw new TrackError(
      'UNSUPPORTED',
      '이 번호 형식은 지금은 자동 인식할 수 없습니다.',
      hasLastscanned
        ? '택배사를 직접 선택해 주세요.'
        : 'Vercel에 LASTSCANNED_API_KEY를 추가하면 해외 551개 택배사까지 자동 인식됩니다.',
      501
    );
  }
  return plan;
}

function detectCandidates(number, requested) {
  return planRoute(number, requested).map((step) => step.carrier || 'LASTSCANNED');
}

/* ------------------------------------------------------------------ *
 * Response shaping
 * ------------------------------------------------------------------ */

function sortEvents(events) {
  return events
    .map((ev, index) => ({ ev, index }))
    .sort((a, b) => {
      const ta = a.ev.time ? Date.parse(a.ev.time) : Number.POSITIVE_INFINITY;
      const tb = b.ev.time ? Date.parse(b.ev.time) : Number.POSITIVE_INFINITY;
      if (ta === tb) return a.index - b.index;
      return ta - tb;
    })
    .map((x) => x.ev);
}

function dedupeEvents(events) {
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    const key = [ev.time || '', ev.scan || '', ev.description || '', ev.location ? ev.location.name : ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

function routeModel(events) {
  const located = locatedEvents(events);
  const moving = located.filter((ev) => !isDocumentScan(ev));
  // With no physical scan at all (label only), show where the record says it is.
  const usable = moving.length ? dropSandwichedCustoms(moving) : located;

  const points = [];
  const byKey = new Map();
  const visits = [];
  for (const ev of usable) {
    const loc = ev.location;
    const key = locationKey(loc);
    let index = byKey.get(key);
    if (index === undefined) {
      index = points.findIndex((p) => Math.abs(p.lat - loc.lat) < 0.01 && Math.abs(p.lng - loc.lng) < 0.01);
      if (index < 0) {
        points.push({
          lat: loc.lat,
          lng: loc.lng,
          name: loc.city || loc.name,
          detail: loc.name,
          code: loc.code,
          country: loc.country,
          countryEn: loc.countryEn,
          countryCode: loc.countryCode,
          precision: loc.precision,
          count: 0,
          firstEvent: null,
          lastEvent: null,
          active: false,
        });
        index = points.length - 1;
      }
      byKey.set(key, index);
    }
    const point = points[index];
    point.count += 1;
    if (!point.firstEvent) point.firstEvent = ev;
    point.lastEvent = ev;
    if (visits[visits.length - 1] !== index) visits.push(index);
  }

  const lastIndex = visits.length ? visits[visits.length - 1] : -1;
  points.forEach((p, i) => { p.active = i === lastIndex; });
  return { points, visits };
}

function buildRoute(events) {
  return routeModel(events).points;
}

/* The countries in the order the parcel actually passed through them. */
function routeCountries(points, visits) {
  const countries = [];
  for (const index of visits) {
    const point = points[index];
    if (!point) continue;
    if (!countries.length || countries[countries.length - 1] !== point.countryCode) countries.push(point.countryCode);
  }
  return countries;
}

function summarise(carrierCode, number, events, meta, extra) {
  const opts = extra || {};
  const ordered = sortEvents(dedupeEvents(events));
  const withTime = ordered.filter((e) => e.time);
  const latest = withTime[withTime.length - 1] || ordered[ordered.length - 1] || null;

  // The newest scan wins. A delivered scan from yesterday must not hide a
  // "out for delivery" scan from today (re-delivery, correction, return).
  const declared = opts.declaredStatus && STAGE[opts.declaredStatus] !== undefined ? opts.declaredStatus : null;
  const code = declared || (latest ? latest.status.code : 'UNKNOWN');

  const highest = ordered.reduce(
    (acc, ev) => (ev.status.stage >= 0 ? Math.max(acc, ev.status.stage) : acc),
    0
  );
  const stage =
    code === 'DELIVERED'
      ? STAGE.DELIVERED
      : STAGE[code] !== undefined && STAGE[code] < 0
        ? STAGE[code]
        : latest && latest.status.stage >= 0
          ? latest.status.stage
          : highest;

  const delivered = code === 'DELIVERED';

  const route = routeModel(ordered);
  const countries = routeCountries(route.points, route.visits);

  return {
    ok: true,
    carrier: opts.carrier || CARRIERS[carrierCode] || carrierForLastscanned(carrierCode),
    number,
    status: {
      code,
      label: STATUS_LABEL[code] || STATUS_LABEL.UNKNOWN,
      stage,
      delivered,
    },
    estimatedDelivery: opts.estimatedDelivery || null,
    latest: latest
      ? {
          time: latest.time,
          scan: latest.scan || latest.status.label,
          description: latest.description,
          location: latest.location,
        }
      : null,
    events: ordered.map((ev) => ({
      time: ev.time,
      scan: ev.scan || '',
      description: ev.description,
      status: ev.status,
      location: ev.location,
      /* false = a notice/paperwork scan, not a place the parcel went. */
      physical: !isDocumentScan(ev),
    })),
    route: route.points,
    countries,
    meta,
  };
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

function cacheSet(key, payload) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, { payload, expires: Date.now() + CACHE_TTL_MS });
}

/* ------------------------------------------------------------------ *
 * Handler
 * ------------------------------------------------------------------ */

function normalizeNumber(input) {
  return String(input || '')
    .replace(/[\s-]/g, '')
    .toUpperCase();
}

/* “No such shipment” is an answer; “the carrier did not answer” is a moment
   that may pass. The client keeps the last good result only for the second. */
const NOT_FOUND_CODES = new Set(['NOT_FOUND', 'AWB_NOT_FOUND', 'FLIGHT_NONE']);
const RETRYABLE_CODES = new Set(['UPSTREAM', 'TIMEOUT', 'NETWORK', 'RATE_LIMITED']);
const SERVICE_CODES = new Set([...RETRYABLE_CODES, 'NEEDS_KEY', 'AIRLINE_BLOCKED']);

function errorMeta(code) {
  const key = String(code || '');
  return {
    kind: NOT_FOUND_CODES.has(key) ? 'NOT_FOUND' : SERVICE_CODES.has(key) ? 'SERVICE' : 'INPUT',
    retryable: RETRYABLE_CODES.has(key),
  };
}

function respond(res, status, body) {
  // The UI has to tell “no such shipment” from “the carrier is down right now”.
  let out = body;
  if (body && body.ok === false && body.error) {
    out = { ...body, error: { ...body.error, ...errorMeta(body.error.code) } };
  }
  const payload = JSON.stringify(out);
  res.statusCode = status;
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', status === 200 ? 'public, s-maxage=60, stale-while-revalidate=300' : 'no-store');
    res.setHeader('access-control-allow-origin', '*');
    // Tracking numbers are not credentials, but keep them out of search results and referrers.
    res.setHeader('x-robots-tag', 'noindex');
    res.setHeader('referrer-policy', 'no-referrer');
  }
  res.end(payload);
}

function readQuery(req) {
  if (req.query && (req.query.number || req.query.carrier)) {
    return { number: req.query.number, carrier: req.query.carrier };
  }
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    return { number: url.searchParams.get('number'), carrier: url.searchParams.get('carrier') };
  } catch {
    return { number: null, carrier: null };
  }
}

async function handler(req, res) {
  const startedAt = Date.now();

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    if (typeof res.setHeader === 'function') {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
    }
    res.end('');
    return;
  }

  if (req.method && req.method !== 'GET') {
    respond(res, 405, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: 'GET만 지원합니다.' },
    });
    return;
  }

  const { number: rawNumber, carrier: rawCarrier } = readQuery(req);
  const number = normalizeNumber(rawNumber);
  const requested = String(rawCarrier || 'auto').toUpperCase();

  if (!number) {
    respond(res, 400, {
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: '운송장 번호를 입력해 주세요.',
        hint: '예) /api/track?number=1234567890&carrier=CJ',
      },
    });
    return;
  }

  if (!/^[0-9A-Z]{5,60}$/.test(number)) {
    respond(res, 400, {
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: '운송장 번호는 영문·숫자 5~60자로 입력해 주세요.',
        hint: '하이픈과 공백은 자동으로 제거됩니다.',
      },
    });
    return;
  }

  if (!/\d/.test(number)) {
    respond(res, 400, {
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: '운송장 번호에 숫자가 없습니다.',
        hint: '송장번호를 다시 확인해 주세요.',
      },
    });
    return;
  }

  if (requested === 'AUTO' && number.length < 9) {
    respond(res, 400, {
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: '운송장 번호가 너무 짧습니다.',
        hint: '국내 택배는 보통 10~13자리, DHL은 10자리입니다.',
      },
    });
    return;
  }

  let plan;
  try {
    plan = planRoute(number, requested);
  } catch (err) {
    respond(res, err.status || 400, {
      ok: false,
      error: { code: err.code, message: err.message, hint: err.hint },
    });
    return;
  }

  const attempts = [];

  for (const step of plan) {
    const attemptLabel = step.carrier || (step.ls ? String(step.ls).toUpperCase() : 'LASTSCANNED');
    const cacheKey = `${step.via}:${step.ls || step.carrier || 'auto'}:${number}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      respond(res, 200, {
        ...cached,
        meta: { ...cached.meta, cached: true, elapsedMs: Date.now() - startedAt },
      });
      return;
    }

    try {
      const result = await runStep(step, number);

      // Fill in coordinates for locations the built-in hub table did not know.
      const stillTime = Date.now() - startedAt < 5000;
      const unknown = (stillTime ? result.events : [])
        .map((ev) => ev.location)
        .filter((loc) => loc && loc.needsGeocode)
        .slice(0, 2);
      for (const loc of unknown) {
        const geo = await geocodeRemote(loc);
        if (geo && Number.isFinite(geo.lat)) {
          for (const ev of result.events) {
            if (ev.location && ev.location.name === loc.name) {
              ev.location.lat = geo.lat;
              ev.location.lng = geo.lng;
              ev.location.precision = geo.precision;
              /* The geocoder may also be the only source of the country. */
              if (geo.countryCode) {
                ev.location.countryCode = geo.countryCode;
                ev.location.country = geo.country;
                ev.location.countryEn = geo.countryEn;
                ev.location.code = geo.code;
              }
            }
          }
        }
      }

      const meta = {
        source: result.source,
        via: step.via,
        upstream: result.upstreamCarrier || null,
        cached: false,
        demo: Boolean(result.demo),
        fetchedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        attempts,
      };
      if (result.service) meta.service = result.service;
      if (result.message) meta.message = result.message;

      const payload = summarise(step.carrier, number, result.events, meta, {
        carrier: result.carrier,
        declaredStatus: result.declaredStatus,
        estimatedDelivery: result.estimatedDelivery,
      });
      cacheSet(cacheKey, payload);
      respond(res, 200, payload);
      return;
    } catch (err) {
      attempts.push({ carrier: attemptLabel, via: step.via, code: err.code, message: err.message });

      if (err instanceof TrackError && err.code === 'BAD_REQUEST' && requested !== 'AUTO') {
        respond(res, err.status, {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
            hint: err.hint,
            carrier: step.carrier ? CARRIERS[step.carrier] : null,
          },
        });
        return;
      }

      if (Date.now() - startedAt > TOTAL_BUDGET_MS) break;
    }
  }

  const needsKey = attempts.find((a) => a.code === 'NEEDS_KEY');
  if (needsKey) {
    respond(res, 501, {
      ok: false,
      error: {
        code: 'NEEDS_KEY',
        message: 'DHL_API_KEY 또는 LASTSCANNED_API_KEY 환경변수가 필요합니다.',
        hint: 'Vercel → Settings → Environment Variables 에 LASTSCANNED_API_KEY(lastscanned.com, 551개 택배사)를 넣으면 해외 택배사까지 조회됩니다. DHL만 쓰려면 DHL_API_KEY를 넣어도 됩니다.',
        carrier: CARRIERS.DHL,
      },
      attempts,
    });
    return;
  }

  const unsupported = attempts.find((a) => a.code === 'UNSUPPORTED');
  if (unsupported) {
    respond(res, 501, {
      ok: false,
      error: { code: 'UNSUPPORTED', message: '이 택배사는 아직 지원하지 않습니다.', hint: '택배사를 직접 선택해 주세요.' },
      attempts,
    });
    return;
  }

  const single = attempts.length === 1 ? attempts[0] : null;
  if (single) {
    const statusMap = { BAD_REQUEST: 400, RATE_LIMITED: 429, UPSTREAM: 502, TIMEOUT: 504, NOT_FOUND: 404 };
    const status = statusMap[single.code] || 0;
    if (status && status !== 404) {
      respond(res, status, {
        ok: false,
        error: {
          code: single.code,
          message: single.message,
          hint:
            single.code === 'RATE_LIMITED'
              ? '잠시(1분) 뒤 또는 00:00 UTC 이후에 다시 시도해 주세요.'
              : '잠시 후 다시 시도하거나, 택배사 사이트에서 직접 확인해 주세요.',
          carrier: single.carrier && CARRIERS[single.carrier] ? CARRIERS[single.carrier] : null,
        },
        attempts,
      });
      return;
    }
  }

  const upstream = attempts.find((a) => a.code === 'UPSTREAM' || a.code === 'TIMEOUT');
  if (upstream && attempts.every((a) => a.code !== 'NOT_FOUND')) {
    respond(res, 502, {
      ok: false,
      error: {
        code: 'UPSTREAM',
        message: '택배사 조회 서버가 응답하지 않습니다.',
        hint: '잠시 후 다시 시도하거나, 택배사 사이트에서 직접 확인해 주세요.',
      },
      attempts,
    });
    return;
  }

  const specific = single;
  respond(res, 404, {
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: specific && specific.message ? specific.message : '조회된 배송 정보가 없습니다.',
      hint:
        number.length === 12 && !specific
          ? '12자리 번호는 CJ대한통운·롯데택배·한진택배가 함께 씁니다. 택배사를 직접 선택하면 더 정확합니다.'
          : '운송장 번호를 확인하거나, 택배사가 아직 상품을 인수하지 않았을 수 있습니다.',
      carrier: specific && CARRIERS[specific.carrier] ? CARRIERS[specific.carrier] : null,
    },
    attempts,
  });
}

module.exports = handler;
module.exports.handler = handler;
module.exports._internal = {
  normalizeNumber,
  detectCandidates,
  planRoute,
  summarise,
  buildRoute,
  routeModel,
  routeCountries,
  isDocumentScan,
  isCustomsScan,
  locationKey,
  countryFromText,
  errorMeta,
  makeLocation,
  lookupGeo,
  maskPersonal,
  cleanText,
  tablesOf,
  rowsOf,
  cellsOf,
  kstToIso,
  cjStatus,
  epostStatus,
  hanjinStatus,
  lotteStatus,
  dhlStatus,
  lastscannedStatus,
  estimatedDate,
  carrierForLastscanned,
  LASTSCANNED_CARRIERS,
  trackLastscanned,
  CARRIERS,
  cache,
};
