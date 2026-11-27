'use strict';

/* Shared air-cargo tables for api/plane.js and api/awb.js.
 * No network, no state — safe to require from any function. */

/* IATA airline code → ICAO callsign prefix. Only pairs that are actually
 * flown as callsigns; unknown airlines are left alone rather than guessed. */
const IATA_TO_ICAO = {
  KE: 'KAL', OZ: 'AAR', '7C': 'JJA', TW: 'TWB', LJ: 'JNA', BX: 'ABL', RS: 'ASV',
  NH: 'ANA', JL: 'JAL', MM: 'APJ', IJ: 'SJO',
  CA: 'CCA', MU: 'CES', CZ: 'CSN', HU: 'CHH', MF: 'CXA', '3U': 'CSC', ZH: 'CSZ',
  CI: 'CAL', BR: 'EVA', IT: 'TTW', JX: 'SJX',
  CX: 'CPA', UO: 'HKE', HX: 'CRK',
  SQ: 'SIA', TR: 'TGW', TG: 'THA', VN: 'HVN', VJ: 'VJC', MH: 'MAS', AK: 'AXM',
  PR: 'PAL', '5J': 'CEB', GA: 'GIA', JT: 'LNI', QZ: 'AWQ',
  AI: 'AIC', '6E': 'IGO', UK: 'VTI', UL: 'ALK', PK: 'PIA', BG: 'BBC',
  EK: 'UAE', EY: 'ETD', QR: 'QTR', TK: 'THY', SV: 'SVA', WY: 'OMA', GF: 'GFA',
  KL: 'KLM', AF: 'AFR', LH: 'DLH', LX: 'SWR', OS: 'AUA', SN: 'BEL', IB: 'IBE',
  AZ: 'ITY', TP: 'TAP', AY: 'FIN', SK: 'SAS', DY: 'NOZ', D8: 'IBK', BA: 'BAW',
  VS: 'VIR', EI: 'EIN', FR: 'RYR', U2: 'EZY', W6: 'WZZ',
  SU: 'AFL', LO: 'LOT', OK: 'CSA', RO: 'ROT', JU: 'ASL', A3: 'AEE',
  AC: 'ACA', WS: 'WJA', UA: 'UAL', AA: 'AAL', DL: 'DAL', WN: 'SWA', AS: 'ASA',
  B6: 'JBU', NK: 'NKS', HA: 'HAL', AM: 'AMX', AV: 'AVA', LA: 'LAN', G3: 'GLO',
  QF: 'QFA', JQ: 'JST', NZ: 'ANZ', VA: 'VOZ', SA: 'SAA', ET: 'ETH', MS: 'MSR',
  KQ: 'KQA', AT: 'RAM', TN: 'THT', '5Y': 'GTI'
};

/* Callsign prefix → who is flying. Cargo operators only: the radar is about
 * freight, so a passenger jet is not labelled as a carrier's freighter. */
const OPERATORS = [
  { code: 'DHL', label: 'DHL', prefixes: ['BCS', 'DHK', 'DHL', 'DAE', 'AHK'] },
  { code: 'FEDEX', label: 'FedEx', prefixes: ['FDX'] },
  { code: 'UPS', label: 'UPS', prefixes: ['UPS'] },
  { code: 'KAL', label: '대한항공', prefixes: ['KAL'] },
  { code: 'AAR', label: '아시아나항공', prefixes: ['AAR'] },
  { code: 'CKK', label: '중국화물항공', prefixes: ['CKK'] },
  { code: 'CAO', label: '에어차이나카고', prefixes: ['CAO'] },
  { code: 'CYZ', label: '중국우정항공', prefixes: ['CYZ'] },
  { code: 'CPA', label: '캐세이퍼시픽', prefixes: ['CPA'] },
  { code: 'GTI', label: '아틀라스에어', prefixes: ['GTI'] },
  { code: 'CLX', label: '카고룩스', prefixes: ['CLX'] },
  { code: 'GEC', label: '루프트한자카고', prefixes: ['GEC'] },
  { code: 'SQC', label: '싱가포르항공카고', prefixes: ['SQC'] },
  { code: 'BOX', label: '에어로로직', prefixes: ['BOX'] },
  { code: 'SVA', label: '사우디아항공카고', prefixes: ['SVA'] },
  { code: 'QTR', label: '카타르항공카고', prefixes: ['QTR'] },
  { code: 'UAE', label: '에미레이트스카이고', prefixes: ['UAE'] }
];

const PREFIX_TO_OPERATOR = new Map();
for (const op of OPERATORS) for (const p of op.prefixes) PREFIX_TO_OPERATOR.set(p, op);

/* Which operators count as "this parcel's plane" for a carrier code. */
const CARRIER_OPERATORS = {
  DHL: ['DHL'],
  FEDEX: ['FEDEX'],
  UPS: ['UPS'],
  CAINIAO: ['CAO', 'CKK', 'CYZ'],
  EMS: ['KAL', 'AAR', 'CKK', 'CPA', 'CYZ'],
  CJ: ['KAL', 'AAR'],
  EPOST: ['KAL', 'AAR'],
  HANJIN: ['KAL', 'AAR'],
  LOTTE: ['KAL', 'AAR'],
  USPS: ['FDX', 'UPS'],
  GLOBAL: []
};

/* Airports the cargo world actually flies through. */
const AIRPORTS = {
  ICN: { lat: 37.4602, lon: 126.4407, city: '인천', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR' },
  GMP: { lat: 37.5583, lon: 126.7906, city: '서울', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR' },
  PUS: { lat: 35.1795, lon: 128.9382, city: '부산', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR' },
  CJU: { lat: 33.5104, lon: 126.4911, city: '제주', country: '대한민국', countryEn: 'South Korea', countryCode: 'KR' },
  NRT: { lat: 35.772, lon: 140.3929, city: '도쿄', country: '일본', countryEn: 'Japan', countryCode: 'JP' },
  HND: { lat: 35.5494, lon: 139.7798, city: '도쿄', country: '일본', countryEn: 'Japan', countryCode: 'JP' },
  KIX: { lat: 34.4347, lon: 135.244, city: '오사카', country: '일본', countryEn: 'Japan', countryCode: 'JP' },
  PVG: { lat: 31.1443, lon: 121.8083, city: '상하이', country: '중국', countryEn: 'China', countryCode: 'CN' },
  PEK: { lat: 40.0801, lon: 116.5846, city: '베이징', country: '중국', countryEn: 'China', countryCode: 'CN' },
  CAN: { lat: 23.3924, lon: 113.2988, city: '광저우', country: '중국', countryEn: 'China', countryCode: 'CN' },
  SZX: { lat: 22.6393, lon: 113.8107, city: '선전', country: '중국', countryEn: 'China', countryCode: 'CN' },
  HGH: { lat: 30.2295, lon: 120.4344, city: '항저우', country: '중국', countryEn: 'China', countryCode: 'CN' },
  HKG: { lat: 22.308, lon: 113.9185, city: '홍콩', country: '홍콩', countryEn: 'Hong Kong', countryCode: 'HK' },
  TPE: { lat: 25.0777, lon: 121.2328, city: '타이베이', country: '대만', countryEn: 'Taiwan', countryCode: 'TW' },
  SIN: { lat: 1.3644, lon: 103.9915, city: '싱가포르', country: '싱가포르', countryEn: 'Singapore', countryCode: 'SG' },
  BKK: { lat: 13.69, lon: 100.7501, city: '방콕', country: '태국', countryEn: 'Thailand', countryCode: 'TH' },
  KUL: { lat: 2.7456, lon: 101.7099, city: '쿠알라룸푸르', country: '말레이시아', countryEn: 'Malaysia', countryCode: 'MY' },
  CGK: { lat: -6.1256, lon: 106.6559, city: '자카르타', country: '인도네시아', countryEn: 'Indonesia', countryCode: 'ID' },
  MNL: { lat: 14.5086, lon: 121.0198, city: '마닐라', country: '필리핀', countryEn: 'Philippines', countryCode: 'PH' },
  SGN: { lat: 10.8188, lon: 106.652, city: '호찌민', country: '베트남', countryEn: 'Vietnam', countryCode: 'VN' },
  HAN: { lat: 21.2212, lon: 105.8072, city: '하노이', country: '베트남', countryEn: 'Vietnam', countryCode: 'VN' },
  DEL: { lat: 28.5562, lon: 77.1, city: '델리', country: '인도', countryEn: 'India', countryCode: 'IN' },
  BOM: { lat: 19.0896, lon: 72.8656, city: '뭄바이', country: '인도', countryEn: 'India', countryCode: 'IN' },
  DXB: { lat: 25.2532, lon: 55.3657, city: '두바이', country: '아랍에미리트', countryEn: 'United Arab Emirates', countryCode: 'AE' },
  DOH: { lat: 25.2731, lon: 51.6081, city: '도하', country: '카타르', countryEn: 'Qatar', countryCode: 'QA' },
  IST: { lat: 41.2753, lon: 28.7519, city: '이스탄불', country: '튀르키예', countryEn: 'Türkiye', countryCode: 'TR' },
  FRA: { lat: 50.0379, lon: 8.5622, city: '프랑크푸르트', country: '독일', countryEn: 'Germany', countryCode: 'DE' },
  MUC: { lat: 48.3538, lon: 11.7861, city: '뮌헨', country: '독일', countryEn: 'Germany', countryCode: 'DE' },
  LEJ: { lat: 51.4239, lon: 12.2364, city: '라이프치히', country: '독일', countryEn: 'Germany', countryCode: 'DE' },
  AMS: { lat: 52.3105, lon: 4.7683, city: '암스테르담', country: '네덜란드', countryEn: 'Netherlands', countryCode: 'NL' },
  LGG: { lat: 50.6374, lon: 5.4432, city: '리에주', country: '벨기에', countryEn: 'Belgium', countryCode: 'BE' },
  CDG: { lat: 49.0097, lon: 2.5479, city: '파리', country: '프랑스', countryEn: 'France', countryCode: 'FR' },
  LHR: { lat: 51.47, lon: -0.4543, city: '런던', country: '영국', countryEn: 'United Kingdom', countryCode: 'GB' },
  MAD: { lat: 40.4936, lon: -3.5668, city: '마드리드', country: '스페인', countryEn: 'Spain', countryCode: 'ES' },
  MIL: { lat: 45.6301, lon: 8.7231, city: '밀라노', country: '이탈리아', countryEn: 'Italy', countryCode: 'IT' },
  LAX: { lat: 33.9416, lon: -118.4085, city: '로스앤젤레스', country: '미국', countryEn: 'United States', countryCode: 'US' },
  SFO: { lat: 37.6213, lon: -122.379, city: '샌프란시스코', country: '미국', countryEn: 'United States', countryCode: 'US' },
  SEA: { lat: 47.4502, lon: -122.3088, city: '시애틀', country: '미국', countryEn: 'United States', countryCode: 'US' },
  JFK: { lat: 40.6413, lon: -73.7781, city: '뉴욕', country: '미국', countryEn: 'United States', countryCode: 'US' },
  ORD: { lat: 41.9742, lon: -87.9073, city: '시카고', country: '미국', countryEn: 'United States', countryCode: 'US' },
  DFW: { lat: 32.8998, lon: -97.0403, city: '댈러스', country: '미국', countryEn: 'United States', countryCode: 'US' },
  MEM: { lat: 35.0424, lon: -89.9767, city: '멤피스', country: '미국', countryEn: 'United States', countryCode: 'US' },
  SDF: { lat: 38.1744, lon: -85.736, city: '루이빌', country: '미국', countryEn: 'United States', countryCode: 'US' },
  ANC: { lat: 61.1743, lon: -149.9982, city: '앵커리지', country: '미국', countryEn: 'United States', countryCode: 'US' },
  YYZ: { lat: 43.6777, lon: -79.6248, city: '토론토', country: '캐나다', countryEn: 'Canada', countryCode: 'CA' },
  YVR: { lat: 49.1947, lon: -123.1792, city: '밴쿠버', country: '캐나다', countryEn: 'Canada', countryCode: 'CA' },
  MEX: { lat: 19.4363, lon: -99.0721, city: '멕시코시티', country: '멕시코', countryEn: 'Mexico', countryCode: 'MX' },
  GRU: { lat: -23.4356, lon: -46.4731, city: '상파울루', country: '브라질', countryEn: 'Brazil', countryCode: 'BR' },
  SYD: { lat: -33.9399, lon: 151.1753, city: '시드니', country: '호주', countryEn: 'Australia', countryCode: 'AU' },
  MEL: { lat: -37.669, lon: 144.841, city: '멜버른', country: '호주', countryEn: 'Australia', countryCode: 'AU' }
};

const ATTRIBUTION = { text: '© adsb.lol (ODbL 1.0)', url: 'https://adsb.lol' };

function airport(iata) {
  const code = String(iata || '').toUpperCase().slice(0, 3);
  if (!code) return null;
  const found = AIRPORTS[code];
  if (!found) return { iata: code, name: code, lat: null, lon: null, city: null, country: null, countryEn: null, countryCode: null };
  return { iata: code, name: found.city, lat: found.lat, lon: found.lon, city: found.city, country: found.country, countryEn: found.countryEn, countryCode: found.countryCode };
}

function operatorOf(callsign) {
  const prefix = String(callsign || '').slice(0, 3).toUpperCase();
  return PREFIX_TO_OPERATOR.get(prefix) || null;
}

function reverseIata(icao) {
  const prefix = String(icao || '').slice(0, 3);
  for (const [iata, mapped] of Object.entries(IATA_TO_ICAO)) {
    if (mapped === prefix) return iata + String(icao).slice(3);
  }
  return null;
}

/* "ke082" / "KE 082" / "KAL249" / hex address → { input, icao, iata, hex } */
function normalizeCallsign(raw) {
  const input = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!input) return null;
  const iataMatch = /^([A-Z0-9]{2})(\d{1,4})[A-Z]?$/.exec(input);
  const icaoMatch = /^([A-Z]{3})(\d{1,4})[A-Z]?$/.exec(input);
  if (iataMatch && IATA_TO_ICAO[iataMatch[1]]) {
    return { input, icao: IATA_TO_ICAO[iataMatch[1]] + iataMatch[2], iata: iataMatch[1] + iataMatch[2], hex: null };
  }
  if (icaoMatch) return { input, icao: input, iata: reverseIata(input), hex: null };
  if (/^[0-9A-F]{6}$/.test(input)) return { input, icao: null, iata: null, hex: input };
  return null;
}

module.exports = {
  IATA_TO_ICAO,
  OPERATORS,
  PREFIX_TO_OPERATOR,
  CARRIER_OPERATORS,
  AIRPORTS,
  ATTRIBUTION,
  airport,
  operatorOf,
  reverseIata,
  normalizeCallsign
};
