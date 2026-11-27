# ◉ WIMP — Where Is My Parcel?

운송장 번호 하나로 **국내 택배·DHL 배송**을 3D 위성 지구본 위에서 확인하는 무료 배송조회 웹앱입니다.
Vercel 무료 플랜에서 바로 배포되며, 서버리스 함수(`api/track.js`)가 택배사 공개 조회 결과를 가져와 좌표·경로·진행 단계로 정규화합니다.

- 프론트엔드: 정적 HTML/CSS/JS + globe.gl(3D 지구본, 캔버스 폴백 포함), 한국어·영어·일본어
- 백엔드: Vercel Node.js Serverless Function, **의존성 0개** (npm install 없음)
- 저장 없음: 입력한 운송장 번호와 조회 결과를 서버에 남기지 않습니다 (메모리 15분 캐시만)
- 입력 정리: `#number` 입력창은 타이핑·붙여넣기 모두에서 하이픈(`-`)·공백·한글·특수문자를 즉시 버리고 **영문·숫자(A–Z a–z 0–9)만** 남깁니다(`1234-5678-90123` → `1234567890123`). 폼 제출 시 한 번 더 정리합니다.

---

## 1. 지원 택배사

| 택배사 | 코드 | 방식 | 상태 |
| --- | --- | --- | --- |
| CJ대한통운 | `CJ` | 공식 조회 JSON 엔드포인트(`_csrf` 핸드셰이크) | ✅ 실제 번호로 동작 검증 |
| 우체국택배 | `EPOST` | `trace.RetrieveDomRigiTraceList.comm` HTML 표 파싱 | ✅ 실제 번호로 동작 검증 |
| 롯데택배 | `LOTTE` | 모바일 조회 페이지(`/mobile/reservation/tracking/linkView`) 표 파싱 | ✅ 엔드포인트·응답 구조 검증 (이동 중인 실제 번호로는 미확인) |
| 한진택배 | `HANJIN` | `WaybillResult.do` HTML 표 파싱 | ⚠️ 엔드포인트·미등록 안내 경로 검증, 실제 이력 파싱 미확인 |
| DHL | `DHL` | `api-eu.dhl.com/track/shipments` (API 키 필요) | ✅ 키 연동 코드 검증 (키가 없으면 안내) |
| FedEx / UPS | — | 미지원 (안내 메시지 반환) | — |

키 없이 동작하는 국내 4개 택배사 중 **CJ·우체국은 실제 운송장으로 이력 파싱까지 검증**했습니다.
롯데·한진은 조회 페이지 구조가 확인됐지만, 검증에 쓸 실제 운송장이 없어 **표 파싱은 구조 기반으로 구현**했습니다. 해당 번호가 등록되지 않았을 때의 안내(404)는 정상 동작합니다.
택배사가 조회 페이지를 바꾸면 파서가 깨질 수 있으며, 그때는 "조회된 배송 정보가 없습니다" 또는 "택배사 조회 서버가 응답하지 않습니다" 안내와 함께 택배사 사이트 링크를 보여줍니다.

### 동작 방식

```
브라우저 ──GET /api/track?number=…&carrier=…──▶ Vercel Function
                                                │
        ┌───────────────────────────────────────┤
        ▼                                       ▼
  국내 택배사 공개 조회 페이지            DHL Shipment Tracking API
  (CJ / 우체국 / 한진 / 롯데)            (DHL_API_KEY, 무료 250건/일)
        │                                       │
        └────────── 스캔 이력 정규화 ◀──────────┘
                        │
        허브 좌표 테이블 + Nominatim 보완 (미등록 도시만, 1req/s·캐시)
                        │
                  events / route / countries / status
```

- **캐시**: `carrier:number` 조합으로 15분 TTL 인메모리 캐시 → 택배사 쿼터 보호
- **자동 인식**: 13자리는 우체국, 14자리는 한진, 12자리는 CJ→롯데→한진 순으로 시도, 10자리는 CJ→DHL 순으로 시도
- **좌표**: 곤지암·옥천·대전·군포·부천·청원 등 국내 허브 + Sofia·Leipzig·Frankfurt·Hong Kong·Los Angeles 등 글로벌 허브 내장. 표에 없는 지명만 OpenStreetMap Nominatim으로 보완 (결과 24시간 캐시)
- **개인정보 처리**: 스캔 문구에 찍히는 기사님 휴대폰 번호는 `010-****-****`로 마스킹, 수령인 이름은 버립니다

---

## 2. Vercel 배포 (1클릭)

<a href="https://vercel.com/new/clone?repository-url=https://github.com/kgy7247/wimp-parcel-radar"><img src="https://vercel.com/button" alt="Deploy with Vercel" height="32"></a>

1. 위 버튼(또는 <https://vercel.com/new>)에서 이 저장소를 선택합니다.
2. Framework Preset: **Other** 그대로 두고 Deploy를 누릅니다. (`vercel.json`이 `public/`을 정적 루트로, `api/track.js`를 함수로 잡습니다.)
3. 배포가 끝나면 `https://<프로젝트명>.vercel.app` 에서 바로 조회됩니다. 국내 4개 택배사는 추가 설정 없이 동작합니다.

### `DHL_API_KEY` 설정 (DHL 실시간 조회)

1. <https://developer.dhl.com> 에서 무료 계정을 만들고 **Shipment Tracking - Unified** API 키를 발급받습니다 (무료 250건/일).
2. Vercel 프로젝트 → **Settings → Environment Variables** →
   - Key: `DHL_API_KEY`
   - Value: 발급받은 키
   - Environments: Production / Preview / Development 모두 체크
3. **Redeploy** 후 DHL 운송장을 조회하면 실시간 이력이 표시됩니다.

키가 없으면 DHL 조회 시 아래 안내가 나옵니다:

```json
{ "ok": false, "error": { "code": "NEEDS_KEY",
  "message": "DHL_API_KEY 환경변수가 필요합니다 (developer.dhl.com 무료 250건/일)." } }
```

예시(데모) 데이터는 넣지 않았습니다. 키 없이 DHL 번호를 조회하면 위 `NEEDS_KEY` 안내가 나오고, 초기 화면은 지구본과 안내 문구만 있는 대기 상태(조회 결과 0건, 배지 `대기`)입니다.

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
GET /api/track?number=<운송장번호>&carrier=<auto|CJ|EPOST|HANJIN|LOTTE|DHL>
```

성공 (200):

```json
{
  "ok": true,
  "carrier": { "code": "CJ", "name": "CJ대한통운", "site": "https://www.cjlogistics.com/ko/tool/parcel/tracking" },
  "number": "1234567890",
  "status": { "code": "DELIVERED", "label": "배달 완료", "stage": 4, "delivered": true },
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
| 400 | `BAD_REQUEST` | 번호 형식 오류 |
| 404 | `NOT_FOUND` | 등록되지 않은 번호 / 이력 없음 |
| 501 | `NEEDS_KEY` | DHL 키 미설정 |
| 501 | `UNSUPPORTED` | 미지원 택배사 |
| 502 | `UPSTREAM` | 택배사 서버 무응답·차단 |

`status.stage` 는 0=접수, 1=집하, 2=이동 중, 3=배송 출발, 4=배달 완료 로 진행 단계 표시에 쓰입니다.
`events[].location.precision` 은 `hub`(내장 허브 표), `geocoded`(Nominatim), `country`(국가 중심점 근사) 중 하나입니다.

---

## 4. 로컬 실행·테스트

```bash
# 단위 테스트 (네트워크 없이 픽스처로 파싱·캐시·좌표·에러 처리 검증)
node test/unit.mjs

# 실시간 스모크 테스트 (실제 택배사 서버 조회)
node test/smoke.mjs

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
- Vercel 함수는 인스턴스마다 캐시가 따로 있어, 트래픽이 분산되면 캐시 적중률이 떨어집니다.
- Nominatim은 공용 서비스라 초당 1회·캐시 정책을 지킵니다. 트래픽이 커지면 자체 좌표 테이블 확장을 권장합니다.

## 7. 라이선스·출처

- 3D 지구본: [globe.gl](https://github.com/vasturiano/globe.gl) (MIT)
- 지구 이미지: NASA Earth imagery (public domain)
- 택배 정보: 각 택배사 공개 조회 페이지, DHL Shipment Tracking API
- 지도 좌표 보완: © OpenStreetMap contributors (ODbL)
