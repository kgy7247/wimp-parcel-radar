# ◉ WIMP — Where Is My Parcel?

운송장 번호 하나로 **국내 택배와 전 세계 550개 이상 택배사 배송**을 3D 위성 지구본 위에서 확인하는 무료 배송조회 웹앱입니다.
Vercel 무료 플랜에서 바로 배포되며, 서버리스 함수(`api/track.js`)가 택배사 공개 조회 결과를 가져와 좌표·경로·진행 단계·도착 예정일로 정규화합니다.

- **하이브리드 라우팅**: 키 없이 동작하는 국내 직연동(CJ·우체국·한진·롯데)을 먼저 시도하고, 실패하거나 차단되면 lastscanned로 자동 폴백. 로젠·일양·DHL·FedEx·UPS·USPS·Cainiao·EMS 등 나머지 545개사는 lastscanned 한 줄(`LASTSCANNED_API_KEY`)로 조회합니다.
- **예상 도착일(EDD)**: 택배사가 준 `estimatedDelivery`/`estimatedTimeOfDelivery`를 한국 시간 기준 날짜로 정규화해 `estimatedDelivery` 로 내려주고, 화면에는 `도착 예정 · 12월 1일` 배지로 표시합니다.
- **최신 스캔 우선 상태**: 과거에 `배달완료`가 한 번이라도 있으면 완료로 고정하지 않고, 가장 최신 스캔의 상태를 따릅니다(재배송·정정·반송 반영).

- 프론트엔드: 정적 HTML/CSS/JS + globe.gl(3D 지구본, 캔버스 폴백 포함), 한국어·영어·일본어
- 백엔드: Vercel Node.js Serverless Function, **의존성 0개** (npm install 없음)
- 저장 없음: 입력한 운송장 번호와 조회 결과를 서버에 남기지 않습니다 (메모리 15분 캐시만)
- 입력 정리: `#number` 입력창은 타이핑·붙여넣기 모두에서 하이픈(`-`)·공백·한글·특수문자를 즉시 버리고 **영문·숫자(A–Z a–z 0–9)만** 남깁니다(`1234-5678-90123` → `1234567890123`). 폼 제출 시 한 번 더 정리합니다.

---

## 1. 지원 택배사

**하이브리드 라우팅** — 국내 4대 택배사는 무료 직연동을 먼저 시도하고(쿼터 0), 실패·차단·미등록이면 같은 조회를 lastscanned로 한 번 더 시도합니다. 그 밖의 택배사는 lastscanned 하나로 551개까지 조회합니다.

| 택배사 | 코드 | 방식 | 상태 |
| --- | --- | --- | --- |
| CJ대한통운 | `CJ` | 공식 JSON(`_csrf` 핸드셰이크) → 실패 시 lastscanned `cjlogistics` | ✅ 실제 운송장 검증 |
| 우체국택배 | `EPOST` | `RetrieveDomRigiTraceList` HTML 표 → 실패 시 `koreapost` | ✅ 실제 운송장 검증 |
| 롯데택배 | `LOTTE` | 모바일 조회 페이지 표 → 실패 시 `lotte` | ⚠️ 구조 기반 파서 (미등록 안내 검증) |
| 한진택배 | `HANJIN` | `WaybillResult.do` 표 → 실패 시 `hanjin` | ⚠️ 구조 기반 파서 (미등록 안내 검증) |
| 로젠택배 | `LOGEN` | lastscanned `logen` | ✅ 실제 응답 검증 |
| 일양택배 | `ILYANG` | lastscanned `ilyanglogis` | ✅ 실제 응답 검증 |
| DHL | `DHL` | lastscanned `dhl` (또는 `DHL_API_KEY` 직연동) | ✅ 실제 운송장·EDD 검증 |
| FedEx | `FEDEX` | lastscanned `fedex` | ✅ |
| UPS | `UPS` | lastscanned `ups` | ✅ 실제 운송장 검증 |
| USPS | `USPS` | lastscanned `usps` | ✅ |
| 알리익스프레스 | `CAINIAO` | lastscanned `cainiao` | ✅ |
| 우체국 EMS / 국제 | `EMS` | lastscanned `epostglobal` | ✅ |
| 윈익스프레스 | `YUNEXPRESS` | lastscanned `yunexpress` | ✅ |
| 그 외 전 세계 | `GLOBAL` | lastscanned 자동 인식(551개 중) | ✅ |

- lastscanned는 **`LASTSCANNED_API_KEY`** 하나로 동작합니다(Pro 기준 기간 1,000건, 재조회 무료). 키가 없어도 국내 4대 택배사는 그대로 동작하고, 해외 택배사를 고르면 `NEEDS_KEY` 안내가 나옵니다.
- **`auto`** 는 13자리→우체국, 14자리→한진, 12자리→CJ→롯데→한진, 10자리→CJ, 11자리→롯데를 먼저 확인한 뒤 lastscanned 자동 감지로 넘깁니다. 국내 12자리 번호가 FedEx로 잘못 잡히지 않도록 순서를 고정했습니다.
- `koreapost` 등에서 `502 carrier_error`가 오면 1회(0.45초 뒤) 짧게 재시도합니다.
- 택배사가 조회 페이지를 바꾸면 직연동 파서가 깨질 수 있지만, 이때도 lastscanned 폴백이 이어받습니다.

### 동작 방식

```
브라우저 ──GET /api/track?number=…&carrier=…──▶ Vercel Function
                                                │
                        1순위 국내 무료 직연동 (쿼터 0)
        ┌───────────────────────────────────────┤
        ▼                                       ▼
  CJ / 우체국 / 한진 / 롯데                    DHL_API_KEY (선택·하위호환)
  공개 조회 페이지 표·JSON                    api-eu.dhl.com
        │                                       │
        └─────── 실패·차단·미등록 시 폴백 ──────┘
                        │
                        2순위 lastscanned (551개 택배사)
            GET api.lastscanned.com/v1/track/{번호}?carrier=…
                        │
        스캔 이력·상태 7종·도착 예정일 정규화
                        │
        허브 좌표 테이블 + Nominatim 보완 (미등록 도시만, 1req/s·캐시)
                        │
            events / route / countries / status / estimatedDelivery
```

- **캐시**: `via:carrier:number` 조합으로 15분 TTL 인메모리 캐시 → 택배사·lastscanned 쿼터 보호
- **자동 인식**: 13자리→우체국, 14자리→한진, 12자리→CJ→롯데→한진, 10자리→CJ, 11자리→롯데를 먼저 시도하고, 모두 실패하면 lastscanned 자동 감지. `1Z…`는 바로 UPS로, 영문 포함 번호는 lastscanned 자동 감지로 보냅니다.
- **상태 판정**: 가장 최신 스캔의 상태를 우선합니다. lastscanned의 7상태(`label_created`·`in_transit`·`out_for_delivery`·`delivered`·`exception`·`returned`·`unknown`)는 `REGISTERED`·`IN_TRANSIT`·`OUT_FOR_DELIVERY`·`DELIVERED`·`EXCEPTION`·`RETURNED`·`UNKNOWN`으로 매핑됩니다.
- **도착 예정일**: `estimatedDelivery`(현지 날짜)는 그대로, `estimatedDeliveryAt`·DHL `estimatedTimeOfDelivery`(UTC/오프셋)는 한국 날짜로 변환해 `estimatedDelivery: "YYYY-MM-DD"` 하나로 내려줍니다.
- **좌표**: 곤지암·옥천·대전·군포·부천·청원 등 국내 허브 + Sofia·Leipzig·Frankfurt·Hong Kong·Los Angeles 등 글로벌 허브 내장. 표에 없는 지명만 OpenStreetMap Nominatim으로 보완 (결과 24시간 캐시)
- **개인정보 처리**: 스캔 문구에 찍히는 기사님 휴대폰 번호는 `010-****-****`로 마스킹, 수령인 이름은 버립니다

---

## 2. Vercel 배포 (1클릭)

<a href="https://vercel.com/new/clone?repository-url=https://github.com/kgy7247/wimp-parcel-radar"><img src="https://vercel.com/button" alt="Deploy with Vercel" height="32"></a>

1. 위 버튼(또는 <https://vercel.com/new>)에서 이 저장소를 선택합니다.
2. Framework Preset: **Other** 그대로 두고 Deploy를 누릅니다. (`vercel.json`이 `public/`을 정적 루트로, `api/track.js`를 함수로 잡습니다.)
3. 배포가 끝나면 `https://<프로젝트명>.vercel.app` 에서 바로 조회됩니다. 국내 4개 택배사는 추가 설정 없이 동작합니다.

### `LASTSCANNED_API_KEY` 설정 (551개 택배사·예상 도착일)

1. <https://app.lastscanned.com/login> 에서 비밀번호 없는 매직링크로 가입·로그인한 뒤 Dashboard → API keys 에서 `lsk_live_…` 키를 발급받습니다 (Pro $4.99/월, 기간 1,000건 포함·재조회 무료).
2. Vercel 프로젝트 → **Settings → Environment Variables** →
   - Key: `LASTSCANNED_API_KEY`
   - Value: 발급받은 키
   - Environments: Production / Preview / Development
3. **Redeploy** 후 로젠·일양·DHL·FedEx·UPS·USPS·Cainiao·EMS·기타 글로벌을 조회하면 됩니다.

키가 없으면 해외 택배사를 고를 때 `NEEDS_KEY` 안내가 나옵니다. 국내 4대 택배사는 키 없이 그대로 동작합니다.
키는 서버 환경변수에서만 쓰이고 프론트엔드로 내려가지 않습니다(lastscanned는 CORS 헤더를 보내지 않아 브라우저 직접 호출도 불가). 저장소·로그·응답에 키를 넣지 마세요.

### `DHL_API_KEY` 설정 (선택·하위호환)

lastscanned가 DHL을 포함하므로 보통은 필요하지 않습니다. DHL 직접 연동을 같이 쓰고 싶으면:

1. <https://developer.dhl.com> 에서 무료 계정을 만들고 **Shipment Tracking - Unified** API 키를 발급받습니다 (무료 250건/일).
2. Vercel 프로젝트 → **Settings → Environment Variables** → Key: `DHL_API_KEY`
3. **Redeploy**. lastscanned가 먼저 시도되고, 실패하면 DHL 직연동으로 넘어갑니다.

키가 둘 다 없으면 DHL 조회 시 아래 안내가 나옵니다:

```json
{ "ok": false, "error": { "code": "NEEDS_KEY",
  "message": "DHL_API_KEY 또는 LASTSCANNED_API_KEY 환경변수가 필요합니다." } }
```

예시(데모) 데이터는 넣지 않았습니다. 초기 화면은 지구본과 안내 문구만 있는 대기 상태(조회 결과 0건, 배지 `대기`)입니다.

### 애드센스 (Google AdSense)

1. 애드센스에서 사이트를 추가하고 `ca-pub-…` 퍼블리셔 ID를 받습니다. 현재 `ca-pub-7205132235653329` 가 `index.html`·`guide.html`·`privacy.html`·`terms.html` 네 페이지에 모두 들어가 있습니다.
2. 광고를 넣을 자리는 `index.html` 의 `#ad-slot` 입니다. `hidden` 속성을 지우고 `<ins class="adsbygoogle" …>` 를 채우세요. 조회 버튼·지구본 조작 버튼 바로 옆은 피하고, 조회 결과 아래나 안내 글 중간에 두는 편이 좋습니다.
3. 심사에 필요한 **이용 안내(`/guide.html`)**, **개인정보처리방침(`/privacy.html`)**, **이용약관(`/terms.html`)** 은 푸터와 헤더에 연결되어 있습니다. 광고·쿠키 고지 내용은 실제 게재 시점에 맞춰 확인해 주세요.
4. 배포 도메인이 `wimp-parcel-radar.vercel.app` 이 아니면 `public/sitemap.xml`, `robots.txt`, 각 페이지의 `canonical`/`og:url` 을 실제 도메인으로 바꿔 주세요.

### 화면 구조 (2026-11 개편)

- 헤더의 **이용 안내**는 `guide.html` 로 이동하는 링크이고, 설정 모달은 **⚙ 버튼만** 엽니다.
- 조회 결과는 **현재 상태·도착 예정 → 마지막 확인 위치·마지막 스캔 → 3D 지구본 → 상세 이력** 순서로 배치됩니다(`#result-head` 가 `.workspace` 앞).
- `guide.html` 은 배송 상태 뜻, 조회가 안 될 때의 5가지 이유, 해외배송 경유지, 도착 예정일 계산, **항공 화물·실시간 레이더**, FAQ 를 담은 독립 콘텐츠 페이지이며 `FAQPage` 구조화 데이터를 포함합니다.
- 해외 배송이 아직 이동 중이면 지구본 아래 **실시간 운항 화물기 레이더** 스트립이 열리고, 지구본에는 ✈ 마커(고도·속도·편명 툴팁)가 함께 뜹니다. 탭이 백그라운드면 1분 폴링이 멈춥니다.

---

## 3. API

```
GET /api/track?number=<운송장번호>&carrier=<auto|CJ|EPOST|HANJIN|LOTTE|LOGEN|ILYANG|DHL|FEDEX|UPS|USPS|CAINIAO|EMS|YUNEXPRESS|GLOBAL>
```

`carrier` 생략 혹은 `auto` 는 국내 번호 형식을 먼저 확인하고 lastscanned 자동 감지로 넘깁니다. `GLOBAL` 은 번호만으로 551개 택배사 중 하나를 찾습니다.

성공 (200):

```json
{
  "ok": true,
  "carrier": { "code": "CJ", "name": "CJ대한통운", "site": "https://www.cjlogistics.com/ko/tool/parcel/tracking" },
  "number": "1234567890",
  "status": { "code": "IN_TRANSIT", "label": "이동 중", "stage": 2, "delivered": false },
  "estimatedDelivery": "2026-12-01",
  "latest": { "time": "2026-11-21T12:42:12+09:00", "scan": "배송출발", "description": "고객님의 상품을 배송할 예정입니다.", "location": { "name": "경기수원장안", "city": "수원", "lat": 37.2636, "lng": 127.0286 } },
  "events": [
    { "time": "2026-11-07T13:45:41+09:00", "scan": "집화처리", "description": "보내시는 고객님으로부터 상품을 인수받았습니다",
      "status": { "code": "PICKED_UP", "label": "집하", "stage": 1 },
      "location": { "name": "대전동부", "city": "대전", "countryCode": "KR", "lat": 36.3504, "lng": 127.3845, "precision": "hub" } }
  ],
  "route": [ { "lat": 36.35, "lng": 127.38, "name": "대전", "detail": "대전동부", "countryCode": "KR" } ],
  "countries": ["KR"],
  "meta": { "source": "cjlogistics", "cached": false, "demo": false, "fetchedAt": "2026-11-28T00:41:00.000Z", "elapsedMs": 812 }
}
```

실패:

| HTTP | `error.code` | 의미 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 번호 형식 오류 / 택배사가 형식을 인식하지 못함 |
| 404 | `NOT_FOUND` | 등록되지 않은 번호 / 이력 없음 |
| 429 | `RATE_LIMITED` | 택배사·lastscanned 조회 한도(잠시 후 재시도) |
| 501 | `NEEDS_KEY` | LASTSCANNED_API_KEY(또는 DHL_API_KEY) 미설정 |
| 501 | `UNSUPPORTED` | 미지원 번호 형식 |
| 502 | `UPSTREAM` | 택배사 서버 무응답·차단 |
| 504 | `TIMEOUT` | 조회 시간 초과 |

`status.code` 는 `REGISTERED`·`PICKED_UP`·`IN_TRANSIT`·`OUT_FOR_DELIVERY`·`DELIVERED`·`EXCEPTION`·`RETURNED`·`UNKNOWN` 중 하나이며, **가장 최신 스캔** 기준입니다.

`status.stage` 는 0=접수, 1=집하, 2=이동 중, 3=배송 출발, 4=배달 완료 로 진행 단계 표시에 쓰입니다. `EXCEPTION`·`RETURNED` 는 진행 단계 없음(-1)입니다.
`estimatedDelivery` 는 택배사가 예상 도착일을 줄 때만 `YYYY-MM-DD`(한국 날짜)로 내려가고, 모르면 `null` 입니다.
`meta.source` 는 `cjlogistics`·`epost`·`hanjin`·`lotte`·`dhl`·`lastscanned` 중 하나이고, `meta.upstream` 은 lastscanned가 실제로 사용한 택배사 id입니다.
`events[].location.precision` 은 `hub`(내장 허브 표), `geocoded`(Nominatim), `country`(국가 중심점 근사) 중 하나입니다.

### 실시간 항공기 — `GET /api/plane`

```
GET /api/plane?cs=KE082,KAL249          # 편명(IATA·ICAO·여러 개)으로 조회
GET /api/plane?carrier=DHL&lat=37.46&lon=126.44&dist=250
                                        # 좌표 반경 250NM 안의 화물기, 해당 택배사 우선
GET /api/plane?hex=71c285               # ICAO24 트랜스폰더 주소
```

- 데이터: **adsb.lol** (ODbL 1.0). `ADSB_LOL_API_KEY` 가 있으면 `x-api-key` 로 전송하고, 없으면 익명 한도(500회/일/IP)로 동작합니다.
- adsb.lol이 `429`/`5xx`일 때만 **adsb.fi**(`source: "adsb.fi"`)로 폴백합니다. 응답의 `source`·`meta.fallbackReason` 에 근거가 남습니다.
- 응답은 `Cache-Control: public, s-maxage=45, stale-while-revalidate=120` 이라 방문자가 늘어도 업스트림 호출은 45초에 한 번입니다. 서버리스 메모리 캐시는 쓰지 않습니다.
- `planes[]` 는 `{ callsign, iata, aircraftType, registration, lat, lon, altFt, speedKts, heading, onGround, seenSec, operator, matched }` 이고 최대 8대입니다. `matched` 는 요청한 택배사(`carrier`)의 화물기인지를 뜻합니다.
- 반경은 250NM을 넘길 수 없습니다(제공자 제약). 전 지구 실시간 레이더가 아니라 **추적형** 조회입니다.

### 항공 화물 AWB — `GET /api/awb`

```
GET /api/awb?no=988-12345675    # 아시아나 카고
GET /api/awb?no=180-12345675    # 대한항공 카고
```

- 11자리(항공사 3 + 일련 8, 마지막 자리는 일련번호 mod 7 체크디지트)만 받습니다. 하이픈·공백은 무시합니다.
- 지금 연동된 곳은 **아시아나(988)·대한항공(180)** 뿐이고, 다른 prefix는 `501 AWB_UNSUPPORTED` 입니다.
- 응답은 `awb.{number, airline, origin, destination, pieces, weight, status, events[], flights[], route[], liveCallsigns[]}` 로 정규화됩니다. **화주·수하인 이름·주소·연락처는 허용목록 방식으로 아예 복사하지 않습니다.**
- `meta.checkDigitOk` 로 체크디지트 일치 여부를 알려주고, 데이터가 없으면 `404 AWB_NOT_FOUND` 로 체크디지트를 안내합니다.
- 대한항공은 게스트 세션 핸드셰이크(`ESC401` → 1회 재시도)가 필요하고, 세션이 열리지 않으면 `503 AIRLINE_BLOCKED` 와 함께 `cargo.koreanair.com` 직접 조회를 안내합니다. **성공 응답은 실존 AWB로 아직 검증하지 못했습니다.**
- 항공사 응답은 서버 메모리에 5분, CDN에 `s-maxage=300` 으로 캐시합니다.

`/api/track?carrier=AIR` 은 위 두 함수로 위임합니다(11자리 → AWB, 편명 → 항공기).

---

## 4. 로컬 실행·테스트

```bash
# 단위 테스트 (네트워크 없이 픽스처로 파싱·라우팅·폴백·EDD·캐시·좌표·에러 처리 검증)
node test/unit.mjs

# 실시간 스모크 테스트 (실제 택배사 서버·lastscanned 조회)
LASTSCANNED_API_KEY=… node test/smoke.mjs

# 문법 검사
node --check api/track.js && node --check public/app.js

# 프론트엔드까지 함께 실행하려면 Vercel CLI
npx vercel dev
```

`api/track.js` 는 `req.query` / `res.statusCode`·`setHeader`·`end` 만 쓰는 순수 Node 핸들러라 Vercel 없이도 테스트할 수 있습니다.

---

## 5. 프로젝트 구조

```
.
├── api/
│   ├── track.js            # 택배 조회 (의존성 0)
│   ├── plane.js            # 실시간 항공기 (adsb.lol, ODbL 1.0)
│   └── awb.js              # 항공 화물 AWB (아시아나·대한항공)
├── lib/
│   └── air-cargo.js        # 항공사·공항·콜사인 공용 표
├── public/
│   ├── index.html          # 화면 + SEO/OG/JSON-LD 메타
│   ├── app.js              # UI·3D 지구본·API 연동 (ko/en/ja)
│   ├── style.css           # 원본 디자인 유지 + 로딩·에러·법적 링크 스타일
│   ├── globe.min.js        # globe.gl 2.46.2 (MIT)
│   ├── earth.jpg           # NASA Earth imagery
│   ├── guide.html          # 이용 안내 (조회 방법·배송 상태 뜻·FAQ, AdSense용 콘텐츠)
│   ├── privacy.html        # 개인정보처리방침
│   ├── terms.html          # 이용약관
│   ├── robots.txt
│   └── sitemap.xml
├── test/
│   ├── unit.mjs            # 픽스처 기반 단위 테스트
│   ├── ui.mjs              # jsdom UI 테스트 (링크·화면 순서·AWB/레이더·콘텐츠 페이지)
│   ├── smoke.mjs           # 실서버 스모크 테스트
│   └── fixtures/           # 실제 응답 캡처 + 구조 기반 합성 픽스처
├── vercel.json
└── package.json
```

---

## 6. 알려진 한계

- 위치는 **택배사 스캔 지점**이며 실시간 GPS가 아닙니다. 좌표는 허브·도시 단위 근사값입니다.
- 한진·롯데는 실제 운송장으로 이력 파싱을 확인하지 못했습니다(§1 참고). 파서는 공개된 표 구조 기준입니다.
- 택배사가 비정상적으로 응답하거나 해외 IP를 차단하면 `UPSTREAM` 안내로 대체됩니다.
- lastscanned는 Pro 기준 기간 1,000건까지 포함이고 초과분은 건당 $0.015입니다. 같은 번호 재조회는 기간 내 무료. 국내 4대는 무료 직연동이 먼저라 키 없이도 대부분의 국내 조회는 쿼터를 쓰지 않습니다.
- 실시간 추적·웹훅은 넣지 않았습니다(조회 시점 스냅샷). 필요하면 lastscanned Watches/Webhook 또는 cron으로 확장할 수 있습니다.
- Vercel 함수는 인스턴스마다 캐시가 따로 있어, 트래픽이 분산되면 캐시 적중률이 떨어집니다.
- Nominatim은 공용 서비스라 초당 1회·캐시 정책을 지킵니다. 트래픽이 커지면 자체 좌표 테이블 확장을 권장합니다.
- 실시간 항공기는 **추적형**입니다. adsb.lol은 250NM 반경 제한과 익명 500회/일 한도가 있어 "전 세계 비행기 전부" 화면은 무료로 불가능합니다. 레이더의 항공기는 **내 물건이 실린 바로 그 기**가 아니라 그 구간을 운항 중인 실제 화물기입니다.
- 대한항공 카고 AWB는 세션 확인(Akamai 봇 쿠키) 때문에 서버 자동 조회가 막힐 수 있습니다. 그때는 화면 안내대로 직접 조회해야 하며, 아시아나(988) AWB와 편명 조회는 정상 동작합니다.
- 에어인천·티웨이·제주항공은 공개 AWB 조회가 없어 지원하지 않습니다.

## 7. 라이선스·출처

- 3D 지구본: [globe.gl](https://github.com/vasturiano/globe.gl) (MIT)
- 지구 이미지: NASA Earth imagery (public domain)
- 택배 정보: 각 택배사 공개 조회 페이지, DHL Shipment Tracking API, [lastscanned](https://www.lastscanned.com/) (551개 택배사 단일 스키마)
- 지도 좌표 보완: © OpenStreetMap contributors (ODbL)
