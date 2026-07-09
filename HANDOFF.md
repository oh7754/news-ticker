# 뉴스 티커 프로젝트 — 노트북 이어작업 안내

이 프로젝트는 두 개의 저장소로 구성되어 있어. 클론하고 셋업해줘.

## 1. 구조

- **news-ticker-worker** — Cloudflare Worker 백엔드 (RSS 수집/클러스터링/스코어링/그룹핑 API)
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

## 3. news-ticker-worker 구조 (src/index.js 하나짜리 Worker)

- KV 네임스페이스 바인딩: `NEWS_KV` (wrangler.jsonc에 이미 id 들어있음, id: `b7673c1035144e299bc3b0f697bc03f0`)
- cron: 7분마다 `scheduled()`가 실행되어 `kr/us/en/jp` 각 팩을 배치로 갱신
- 주요 엔드포인트:
  - `GET /?pack=kr` — 클러스터링+스코어링+그룹핑까지 끝난 헤드라인 (확장프로그램이 씀)
  - `GET /?pack=kr&raw=1` — 원본(클러스터링 전) 기사 목록 (admin이 자체 클러스터링 미리보기용으로 씀)
  - `GET /debug?pack=kr` — 마지막 fetch 실패 로그 (KV 전파 지연 때문에 `wrangler kv key get`보다 이게 더 믿을만함)
  - `GET/POST /admin/config` — 점수 가중치/부스트·뮤트 키워드 저장
- 배포: `npm run deploy` (= `wrangler deploy`)
- kr 소스는 현재 7개 언론사만 있음: 연합뉴스, SBS, 조선일보, 동아일보, 매일경제, 한국경제, 머니투데이
  - 한겨레(hani.co.kr)는 raw 캐시를 계속 독점(84%)해서 사용자 지정으로 완전 제외함
  - 서울경제/헤럴드경제/연합뉴스TV는 Cloudflare Workers 아웃바운드 자체를 403으로 막아서 (Chrome/Googlebot UA 다 시도했는데도 안 뚫림) 제외함 — 로컬 fetch는 되는데 Workers에서만 막힘

### 노출 순서 그룹핑 (`buildDisplayOrder()`, src/index.js)

`processItems()`가 스코어순으로 정렬한 뒤, 4개씩(top 1 + mid 2 + tail 1) 묶어서 최종 순서를 만든다.

- **top**: 순위 기준(상위 15%) + 승급 규칙(3개 이상 매체 동시보도 `sourceCount>=3` 또는 `breaking`)으로 뽑되, 절대 개수(`MIN_TOP`~`MAX_TOP` = 6~15개)로 캡. 풀이 커져도 top 개수가 같이 늘지 않게 해서 반복 노출 빈도를 유지함
- **mid/tail**: 나머지를 75:25 비율로 나눔. 전체 풀 크기에 비례해서 커지므로 롱테일 기사까지 후보에 들어감
- **groupCount**: `TARGET_GROUPS=38`로 캡 → 최종 노출 약 150개(38×4)
- 그룹 내부 4개 아이템 순서는 매번 Fisher–Yates 셔플
- 클러스터(같은 사건, 여러 언론사)의 대표 기사 외 나머지 언론사 기사들은 `relatedArticles: [{domain, link, title}]`로 같이 내려감 — 확장프로그램의 "클러스터 태그 모드"가 이걸 씀

## 4. news-ticker (확장프로그램 + admin) 구조

### 티커는 하단 플로팅 카드
`NEWS/ticker.css`가 `#__news-ticker-root`를 화면 하단 중앙에 뜨는 카드로 스타일링함 (`position:fixed`, `border-radius`, `backdrop-filter: blur`, rgba 배경). 튜닝 포인트는 전부 `:root`의 `--ticker-*` CSS 변수.

**admin은 이 파일을 실제로 `<link>`로 직접 로드함** (`admin/index.html` 7번째 줄, 캐시버스팅 쿼리 붙여서 매번 새로 받아옴). admin 자체 `<style>` 안에는 티커 관련 CSS가 전혀 없음 — 전부 `NEWS/ticker.css` 하나로 통일됨. 즉 **`NEWS/ticker.css`를 고치면 admin과 실제 확장프로그램 둘 다 동시에 바뀜.**

- admin에서 확인하는 법: `admin/index.html`을 VSCode Live Server로 열면 `ticker.css` 저장할 때마다 자동 새로고침됨 (`file://`로 그냥 열면 캐시 때문에 하드리프레시 필요할 수 있음)
- 실제 확장프로그램에서 확인하는 법: `NEWS/ticker.css` 저장 → `chrome://extensions`에서 News Ticker 새로고침 → 티커 떠있는 탭도 새로고침

### 마퀴(무한 스크롤) 구현 — 잡았던 버그 두 개
`content.js`가 헤드라인을 두 벌 복사해서 이어붙이고, `translateX(0)→translateX(-50%)` CSS 애니메이션으로 무한 루프처럼 보이게 함. 이 과정에서 실제 버그 두 개가 있었음:

1. **half-gap 어긋남**: flex `gap`을 쓰면 2N개(두 벌) 사이 gap 개수가 항상 홀수(2N-1)라 `-50%`가 정확히 반을 못 나눔 → 아이템별 `margin-right`로 교체해서 해결
2. **(진짜 근본 원인) `-50%` 기준 오류**: `#__news-ticker-inner`가 `display:flex`인데 너비를 지정 안 해서, 기본값이 (콘텐츠가 넘쳐도) 부모(`track`) 폭만큼만 잡힘. `translateX(-50%)`는 `scrollWidth`가 아니라 이 "자기 자신의 박스 폭" 기준이라, 실제로는 전체 콘텐츠의 절반이 아니라 트랙 폭의 절반(아이템 몇 개 분량)만 이동하고 있었음 → `width: max-content` 추가로 해결. 이게 "몇 개 지나가지도 않았는데 튀는" 증상의 진짜 원인이었음

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
- `backdrop-filter: blur()`는 꽤 무거운 연산이라 지금 8px로 낮춰둔 상태 (원래 20px). 더 가볍게 하려면 낮추거나 아예 빼는 것도 방법
- Pretendard CDN 폰트 `@import` 제거하고 시스템 폰트로 교체함 (페이지 로드마다 나가던 외부 요청 제거)
- 확장은 `<all_urls>`에 다 주입되므로, 무거운 사이트(유튜브 등)에서의 영향은 아직 실측 안 해봄

## 5. 지금까지 진행된 작업 (최근 순, 오늘 세션)

1. 워커에 노출 순서 그룹핑(top/mid/tail) 로직 추가, 여러 차례 조정 (비율→절대개수 하이브리드로 정착)
2. admin이 `NEWS/ticker.css`를 직접 링크하도록 통합 (중복 CSS 제거, 슬라이더 UI 삭제 — 이제 CSS 파일을 직접 수정하는 워크플로우로 전환)
3. 마퀴 버그 두 개 수정 (half-gap, `-50%` 기준 오류 — 위 참고)
4. 순환 렌더링 추가 (150개 중 60개씩, 루프 끝날 때 교체)
5. 컨트롤 버튼 정리 (일시정지/새로고침 제거, 닫기는 세션 한정으로)
6. Pretendard → 시스템 폰트 교체
7. 클러스터 태그 기능 추가 (관련 기사 표시 + 전용 닫기 버튼)
8. 두 저장소 모두 커밋 + push 완료

## 6. 다음에 할 일 (사용자가 원하는 방향)

- **브랜딩/디자인 수정** — 다음 세션에서 진행 예정 (이번 세션 마무리 시점 기준)
- 그 다음 "1차 배포"를 목표로 하고 있음 (정확히 어디에 배포할지 — Chrome 웹스토어 등록인지, 그냥 개인용 압축해제 로드 상태로 둘 건지는 아직 안 정해짐, 다음 세션에서 확인 필요)
- 클러스터 태그 모드의 URL 매칭 로직은 실사용하면서 놓치는 경우 없는지 지켜봐야 함

## 7. 로컬에서 확인하는 법

```bash
open /Users/<사용자>/news-ticker/admin/index.html   # 브라우저로 바로 열림, Worker API를 직접 fetch함
# 더 나은 방법: VSCode에서 admin/index.html 우클릭 → "Open with Live Server"
# → ticker.css 저장할 때마다 자동 새로고침됨
```

크롬 확장프로그램 자체를 테스트하려면 `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드" → `NEWS/` 폴더 선택. 코드 수정 후에는 확장프로그램 새로고침(↻) + 티커 떠있는 탭도 새로고침해야 반영됨.
