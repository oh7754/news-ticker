# 뉴스 티커 프로젝트 — 노트북 이어작업 안내

이 프로젝트는 두 개의 저장소로 구성되어 있어. 클론하고 셋업해줘.

## 1. 구조

- **news-ticker-worker** — Cloudflare Worker 백엔드 (RSS 수집/클러스터링/스코어링 API)
  - GitHub: `git@github.com:oh7754/news-ticker-worker.git`
  - 배포 주소: `https://news-ticker-worker.ojh7754.workers.dev`
- **news-ticker** — 크롬 확장프로그램(`NEWS/`) + 관리자 대시보드(`admin/index.html`)
  - GitHub: `git@github.com:oh7754/news-ticker.git`
  - `OLD/`는 예전 버전이라 참고용으로만 남겨둔 것, 지금은 안 씀

## 2. 클론 & 셋업

```bash
git clone git@github.com:oh7754/news-ticker-worker.git
git clone git@github.com:oh7754/news-ticker.git

cd news-ticker-worker
npm install
```

### 필요한 인증 (노트북에 처음이면 필요)
- GitHub SSH 키가 이 노트북에 등록되어 있어야 `git clone`(SSH) 가능. 없으면 `ssh-keygen`으로 만들고 GitHub 계정(Settings → SSH keys)에 등록.
- Cloudflare Worker를 배포하려면 `npx wrangler login` 한 번 실행 (브라우저 인증).

## 3. 전체 아키텍처 (중요 — 오늘 세션에 크게 바뀜)

```
Worker: 팩별 독립 cron (아래 참고)
  └─ RSS 수집 → 클러스터링 → 스코어링 → KV에 캐싱 (display:{pack})
         │
         ▼ (요청 시 KV 읽기만, 계산 없음 + Cache-Control 5분 엣지 캐싱)
  GET /?pack=kr → 평평한 스코어 정렬 리스트 (그룹핑 안 된 상태)
         │
         ▼
확장프로그램 background.js
  └─ buildDisplayOrder() 로컬 실행 → top/mid/tail 4개씩 그룹핑 + 셔플
         │
         ▼
content.js → 티커에 렌더링 (60개씩 순환, 페이지 로드마다 그룹 순서 재셔플)
```

**핵심 설계 원칙: Worker는 무거운 계산(클러스터링)만 하고 cron 주기로 캐싱, 그룹핑/셔플처럼
가벼운 연산은 클라이언트(확장프로그램)가 함.** 이유: 유저가 아무리 늘어도 Worker 쪽 계산량이
요청 수에 비례하지 않고 cron 주기에만 비례하게 하기 위함. admin은 `raw=1`을 따로 써서 이
구조랑 무관하게 자체 클러스터링 미리보기를 함 (아래 4번 참고).

## 4. news-ticker-worker 구조 (src/index.js 하나짜리 Worker)

- KV 네임스페이스 바인딩: `NEWS_KV` (wrangler.jsonc에 이미 id 들어있음, id: `b7673c1035144e299bc3b0f697bc03f0`)
- 주요 엔드포인트:
  - `GET /?pack=kr` — 클러스터링+스코어링 끝난 **평평한**(그룹핑 안 된) 헤드라인. `Cache-Control: public, max-age=300` 붙어있어서 5분 안의 반복 요청은 Cloudflare 엣지가 처리 (Worker 코드 실행 없이)
  - `GET /?pack=kr&raw=1` — 원본(클러스터링 전) 기사 목록. `Cache-Control: no-store`. admin이 자체 클러스터링 미리보기용으로 씀
  - `GET /debug?pack=kr` — 마지막 fetch 실패 로그 (KV 전파 지연 때문에 `wrangler kv key get`보다 이게 더 믿을만함)
  - `GET/POST /admin/config` — 점수 가중치/부스트·뮤트 키워드 저장. **POST하면 즉시 4팩 display 캐시를 재계산**해서 최대 다음 cron까지 기다리지 않고 바로 반영됨
- 배포: `npm run deploy` (= `wrangler deploy`)

### cron — 팩마다 독립 트리거 (오늘 바뀐 부분)
```jsonc
// wrangler.jsonc
"crons": [
  "*/7 * * * *",       // kr
  "1-59/7 * * * *",    // us
  "2-59/7 * * * *",    // en
  "3-59/7 * * * *"     // jp
]
```
Cloudflare Workers는 **한 번의 실행(invocation)당 외부 fetch(subrequest) 수에 한도**가 있음
(플랜에 따라 보통 50개). 4팩을 한 cron 실행에 몰아서 처리하면 합산 요청 수가 한도를 넘을 수
있어서, 팩별로 cron을 나눠 각자 독립된 실행 + 독립된 한도를 쓰게 함. `scheduled(event, env)`가
`event.cron` 문자열로 어느 팩인지 분기함 (src/index.js 맨 아래).

- `BATCH_SIZE = { kr: 45, us: 40, en: 40, jp: 40 }` — kr만 소스가 45개보다 많아서(53개) 여전히
  커서 기반 순환 배치가 필요. us/en/jp는 전체 소스가 40개 이하라 매 cron마다 전부 다 가져옴.

### 소스 현황 (오늘 대폭 확장)
- **kr (7개 언론사, 53개 피드)**: 연합뉴스, SBS, 조선일보, 동아일보, 매일경제, 한국경제, 머니투데이
  - 한겨레(hani.co.kr)는 raw 캐시 독점 문제로 완전 제외
  - 서울경제/헤럴드경제/연합뉴스TV는 Cloudflare Workers에서만 403 차단되어 제외
  - **⚠️ 미해결 이슈**: 오늘 확인해보니 **한국경제(hankyung.com) 9개 피드 전부 403**으로 막히고 있음. 오늘 작업 범위 밖이라 안 건드렸는데, 위 두 언론사랑 같은 패턴(Workers에서만 차단)일 가능성이 있어서 다음 세션에 확인 필요
- **us (12개 언론사)**: NYT, CNN, NPR, ABC News, CBS News, Fox News, BBC, CNBC, MarketWatch, Yahoo Finance, Forbes, Investing.com
  - ⚠️ 기존 CNN `edition.rss` 피드 하나가 로컬 테스트에서 계속 "Network connection lost" — 새로 추가한 CNN world/tech 피드는 정상이라 이 특정 URL만의 문제로 보임, 미해결
- **en (6개 언론사)**: BBC(10개 카테고리), The Guardian(7개 카테고리), Al Jazeera, Sky News, DW, France24
- **jp (2개 언론사)**: NHK(7개 카테고리), Japan Times
- `DOMAIN_NAMES` 매핑(파일 최상단)에 위 언론사 전부 등록해뒀음 — 티커에 도메인 대신 언론사명이 예쁘게 뜸

## 5. news-ticker (확장프로그램 + admin) 구조

### 티커는 하단 플로팅 카드
`NEWS/ticker.css`가 `#__news-ticker-root`를 화면 하단 중앙에 뜨는 카드로 스타일링함 (`position:fixed`, `border-radius`, `backdrop-filter: blur`, rgba 배경). 튜닝 포인트는 전부 `:root`의 `--ticker-*` CSS 변수.

**admin은 이 파일을 실제로 `<link>`로 직접 로드함** (`admin/index.html` 7번째 줄, 캐시버스팅 쿼리 붙여서 매번 새로 받아옴). admin 자체 `<style>` 안에는 티커 관련 CSS가 전혀 없음 — 전부 `NEWS/ticker.css` 하나로 통일됨. 즉 **`NEWS/ticker.css`를 고치면 admin과 실제 확장프로그램 둘 다 동시에 바뀜.**

- admin에서 확인하는 법: `admin/index.html`을 VSCode Live Server로 열면 `ticker.css` 저장할 때마다 자동 새로고침됨 (`file://`로 그냥 열면 캐시 때문에 하드리프레시 필요할 수 있음)
- 실제 확장프로그램에서 확인하는 법: `NEWS/ticker.css`나 `.js` 파일 저장 → `chrome://extensions`에서 News Ticker 새로고침 → 티커 떠있는 탭도 새로고침

### 그룹핑은 이제 클라이언트(background.js)에서
`background.js`의 `buildDisplayOrder()`가 Worker에서 받은 평평한 리스트를 top/mid/tail 4개씩
(1+2+1) 묶고 셔플한다 (예전엔 Worker가 하던 일). 알고리즘 자체는 그대로:
- top: 절대 개수(6~15개)로 고정, 승급 규칙(3개 매체 이상 동시보도 또는 breaking)
- mid/tail: 나머지를 75:25로, 전체 풀 크기에 비례
- 최종 약 150개(38그룹×4)로 캡
- 클러스터의 대표 기사 외 나머지 언론사 기사는 `relatedArticles`로 같이 옴 → 클러스터 태그 모드가 씀

`content.js`는 여기에 한 겹 더 셔플을 얹는다 — **페이지 로드/새로고침마다** `allHeadlines`를
4개 단위(그룹) 그대로 유지한 채 **그룹 순서 자체와 그룹 내부 순서를 다시 섞음**
(`reshuffleGroups()`). 이유: `background.js`의 셔플은 10분 갱신 주기마다 한 번뿐이라, 그것만
믿으면 같은 주기 안에서 새 탭을 열 때마다 항상 같은 첫 60개만 보게 됨. 매 페이지 로드마다
다시 섞어야 유저가 계속 다른 기사를 보게 됨.

### 마퀴(무한 스크롤) 구현 — 잡았던 버그 두 개
`content.js`가 헤드라인을 두 벌 복사해서 이어붙이고, `translateX(0)→translateX(-50%)` CSS 애니메이션으로 무한 루프처럼 보이게 함. 이 과정에서 실제 버그 두 개가 있었음:

1. **half-gap 어긋남**: flex `gap`을 쓰면 2N개(두 벌) 사이 gap 개수가 항상 홀수(2N-1)라 `-50%`가 정확히 반을 못 나눔 → 아이템별 `margin-right`로 교체해서 해결
2. **`-50%` 기준 오류**: `#__news-ticker-inner`가 `display:flex`인데 너비를 지정 안 해서, 기본값이 (콘텐츠가 넘쳐도) 부모(`track`) 폭만큼만 잡힘. `translateX(-50%)`는 `scrollWidth`가 아니라 이 "자기 자신의 박스 폭" 기준이라, 실제로는 전체 콘텐츠의 절반이 아니라 트랙 폭의 절반(아이템 몇 개 분량)만 이동하고 있었음 → `width: max-content` 추가로 해결

### 백그라운드 탭 대응 (오늘 추가)
CSS 애니메이션은 탭이 백그라운드에 있어도 실제 경과 시간 기준으로 내부 시계가 계속 흐른다.
그래서 다른 탭에 오래 있다 돌아오면 그 시간만큼 밀린 걸 한 번에 따라잡으며 순식간에 확
지나가 버리는 문제가 있었음 (루프 교체 이벤트도 밀린 만큼 몰아서 발생). `visibilitychange`
이벤트로 탭이 안 보이면 `.is-paused` 클래스를 붙여 애니메이션 자체를 멈추고, 다시 보이면
멈췄던 지점부터 재개하도록 해서 해결.

### 순환 렌더링
최대 150개를 `chrome.storage.local`에 받아두고(`background.js`), 화면엔 60개(`RENDER_COUNT`)씩만 렌더링. 루프가 자연스럽게 한 바퀴 끝나는 시점(`animationiteration` 이벤트)에 다음 60개 구간으로 교체 — 위치가 이미 처음(0%)으로 리셋된 타이밍이라 시각적으로 안 튐. 네트워크 재요청 없이 이미 받아둔 데이터 안에서만 순환하므로 API 부담 없음.

### 클러스터 태그 모드
지금 보고 있는 페이지가 클러스터링된 기사(여러 언론사가 같이 다룬 사건) 중 하나면, 평소 로테이션 대신 같은 사건을 다룬 다른 언론사 기사들을 보여줌.

- 매칭: `location.href`를 헤드라인들의 `link`/`relatedArticles[].link`와 비교. 쿼리스트링/해시/www 제거한 "호스트+경로"만 비교하는 느슨한 매칭 (RSS 링크가 AMP/트래킹 파라미터 때문에 정확히 안 맞을 수 있어서) — 완벽하진 않을 수 있음, 실사용하면서 지켜봐야 함
- 매칭되면 라벨이 "🏷️ 같은 소식 다른 언론사"로 바뀌고, 관련 기사들이 평소와 동일한 마퀴 방식(길면 흐르고 짧으면 짧은 대로 돎)으로 표시됨
- 닫기(✕) 버튼이 이때는 라벨 바로 옆으로 이동함 (평소엔 오른쪽 끝 컨트롤 자리) — "티커 전체 숨기기"랑 "태그 해제"는 서로 다른 동작이라 위치도 분리함. 닫으면 평소 로테이션으로 복귀 (그 페이지에서만, 새로고침하면 다시 감지됨)

### 컨트롤 버튼
일시정지/새로고침 버튼은 제거함 (팝업에 이미 "티커 표시" 토글 + "지금 새로고침" 버튼 있음). 남은 건 닫기(✕) 하나뿐:
- **✕ 버튼 (평소 모드)**: 이 페이지(탭)에서만 즉시 숨김. `chrome.storage`에 저장 안 하므로 새로고침하거나 다른 탭 가면 다시 나타남
- **팝업의 "티커 표시" 토글**: 전역, 영구 저장 (모든 탭·새로고침에 걸쳐 유지)
- 이 둘은 완전히 별개 메커니즘

### 성능 관련 참고사항
- `backdrop-filter: blur()`는 꽤 무거운 연산이라 지금 8px로 낮춰둔 상태 (원래 20px)
- Pretendard CDN 폰트 `@import` 제거하고 시스템 폰트로 교체함
- 확장은 `<all_urls>`에 다 주입되므로, 무거운 사이트(유튜브 등)에서의 영향은 아직 실측 안 해봄

## 6. 지금까지 진행된 작업 (최근 세션 순, 최신이 위)

**오늘 세션**
1. 해외(us/en/jp) 뉴스 소스 대폭 확장 — RSS 목록 조사 → curl로 검증 → 반영 (12/6/2개 언론사)
2. Worker subrequest 한도 문제 발견 → 팩별 독립 cron 트리거로 해결
3. `DOMAIN_NAMES`에 새 언론사 전부 등록
4. **아키텍처 변경**: Worker가 요청마다 재계산하던 걸 cron 때 미리 계산해 KV 캐싱 + 엣지 캐싱(`Cache-Control`)으로 전환. 그룹핑(top/mid/tail 묶기+셔플)은 Worker에서 빼서 클라이언트(`background.js`)로 이동
5. `content.js`에 페이지 로드마다 그룹 순서 재셔플 추가 (같은 10분 주기 안에서도 매번 다른 기사 노출)
6. 백그라운드 탭에서 오래 있다 돌아왔을 때 티커가 순식간에 확 지나가는 버그 수정 (`visibilitychange`로 애니메이션 멈춤/재개)
7. kr 한국경제 403, us CNN edition.rss 연결 문제 발견 (둘 다 미해결, 다음 세션 확인 필요)
8. **(다른 노트북에서)** 새 맥 개발 환경 처음부터 셋업 완료: Xcode 라이선스, GitHub SSH 키, nvm+Node.js v24, `npm install`, `wrangler login` — 이 노트북도 이제 바로 작업 가능한 상태
9. **`news-ticker-worker`의 cron을 완전히 꺼둠** (`wrangler.jsonc`, commit `bcd7777`) — 오픈 전이라 Cloudflare 한도(KV 쓰기 등) 아끼려는 목적. `GET /?pack=xx` 요청이 오면 캐시 없을 때만 그 순간에 라이브로 fetch해서 응답하니 admin 테스트 등은 그대로 동작함. **다시 켤 때는 `wrangler.jsonc`의 주석 처리된 4줄 `crons` 배열을 복원하면 됨** (배포/오픈 준비 시 꼭 확인)

**이전 세션**
- 워커에 노출 순서 그룹핑 로직 최초 추가 (이후 오늘 클라이언트로 이동함)
- admin이 `NEWS/ticker.css`를 직접 링크하도록 통합
- 마퀴 버그 두 개 수정 (half-gap, `-50%` 기준 오류)
- 순환 렌더링 추가, 컨트롤 버튼 정리, Pretendard → 시스템 폰트, 클러스터 태그 기능 추가

## 7. 다음에 할 일

- **미해결 이슈 확인** (우선순위 높음): kr 한국경제(hankyung.com) 403, us CNN edition.rss 연결 문제 — 둘 다 `/debug?pack=kr`, `/debug?pack=us`로 확인 가능
- **cron이 현재 꺼져있음** — `news-ticker-worker`의 `wrangler.jsonc`, 오픈 전 한도 절약 목적. 배포/오픈 준비되면 주석 처리된 4줄 복원해서 다시 켜야 함
- **브랜딩/디자인 수정** — 계속 대기 중 (며칠 전부터 예정돼 있었는데 오늘도 다른 작업 먼저 함)
- 그 다음 "1차 배포" 목표 (Chrome 웹스토어 등록 여부 등 아직 미정)
- 클러스터 태그 모드의 URL 매칭 로직은 실사용하면서 놓치는 경우 없는지 지켜봐야 함
- 새로 늘어난 해외 소스들이 실제로 안정적으로 계속 잘 들어오는지 며칠 지켜보면 좋음

## 8. 로컬에서 확인하는 법

```bash
open /Users/<사용자>/news-ticker/admin/index.html   # 브라우저로 바로 열림, Worker API를 직접 fetch함
# 더 나은 방법: VSCode에서 admin/index.html 우클릭 → "Open with Live Server"
# → ticker.css 저장할 때마다 자동 새로고침됨
```

크롬 확장프로그램 자체를 테스트하려면 `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드" → `NEWS/` 폴더 선택. 코드 수정 후에는 확장프로그램 새로고침(↻) + 티커 떠있는 탭도 새로고침해야 반영됨.

Worker cron을 로컬에서 안전하게 테스트하려면(production KV 안 건드림):
```bash
cd news-ticker-worker
npx wrangler dev --test-scheduled --port 8788
# 다른 터미널에서:
curl "http://localhost:8788/__scheduled?cron=*/7+*+*+*+*"   # kr
curl "http://localhost:8788/__scheduled?cron=1-59/7+*+*+*+*" # us
curl "http://localhost:8788/__scheduled?cron=2-59/7+*+*+*+*" # en
curl "http://localhost:8788/__scheduled?cron=3-59/7+*+*+*+*" # jp
curl "http://localhost:8788/debug?pack=kr"  # 실패 로그 확인
```
