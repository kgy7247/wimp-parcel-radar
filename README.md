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

1. 애드센스에서 사이트를 추가하고 `ca-pub-…` 퍼블리셔 ID를 받습니다.
2. `public/index.html` 의 주석 처리된 스크립트를 풀고 `ca-pub-XXXXXXXXXXXXXXXX` 을 실제 ID로 바꿉니다.
3. 광고를 넣을 자리는 `#ad-slot` 입니다. `hidden` 속성을 지우고 `<ins class="adsbygoogle" …>` 를 채우세요.
4. 심사 필수 페이지인 **개인정보처리방침(`/privacy.html`)** 과 **이용약관(`/terms.html`)** 은 푸터에 연결되어 있습니다.
   광고·쿠키 고지 내용은 실제 게재 시점에 맞춰 확인해 주세요.
5. 배포 도메인이 `wimp-parcel-radar.vercel.app` 이 아니면 `public/sitemap.xml`, `robots.txt`, 각 페이지의 `canonical`/`og:url` 을 실제 도메인으로 바꿔 주세요.

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
│   └── track.js            # Vercel serverless function (의존성 0)
├── public/
│   ├── index.html          # 화면 + SEO/OG/JSON-LD 메타
│   ├── app.js              # UI·3D 지구본·API 연동 (ko/en/ja)
│   ├── style.css           # 원본 디자인 유지 + 로딩·에러·법적 링크 스타일
│   ├── globe.min.js        # globe.gl 2.46.2 (MIT)
│   ├── earth.jpg           # NASA Earth imagery
│   ├── privacy.html        # 개인정보처리방침
│   ├── terms.html          # 이용약관
│   ├── robots.txt
│   └── sitemap.xml
├── test/
│   ├── unit.mjs            # 픽스처 기반 단위 테스트
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

## 7. 라이선스·출처

- 3D 지구본: [globe.gl](https://github.com/vasturiano/globe.gl) (MIT)
- 지구 이미지: NASA Earth imagery (public domain)
- 택배 정보: 각 택배사 공개 조회 페이지, DHL Shipment Tracking API, [lastscanned](https://www.lastscanned.com/) (551개 택배사 단일 스키마)
- 지도 좌표 보완: © OpenStreetMap contributors (ODbL)
