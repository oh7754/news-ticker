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

cd news-ticker-worker/news-ticker-worker
npm install
```

### 필요한 인증 (노트북에 처음이면 필요)
- GitHub SSH 키가 이 노트북에 등록되어 있어야 `git clone`(SSH) 가능. 없으면 `ssh-keygen`으로 만들고 GitHub 계정(Settings → SSH keys)에 등록.
- Cloudflare Worker를 배포하려면 `npx wrangler login` 한 번 실행 (브라우저 인증).

## 3. news-ticker-worker 구조 (src/index.js 하나짜리 Worker)

- KV 네임스페이스 바인딩: `NEWS_KV` (wrangler.jsonc에 이미 id 들어있음, id: `b7673c1035144e299bc3b0f697bc03f0`)
- cron: 7분마다 `scheduled()`가 실행되어 `kr/us/en/jp` 각 팩을 배치로 갱신
- 주요 엔드포인트:
  - `GET /?pack=kr` — 클러스터링+스코어링 끝난 헤드라인 (확장프로그램이 씀)
  - `GET /?pack=kr&raw=1` — 원본(클러스터링 전) 기사 목록 (admin이 씀)
  - `GET /debug?pack=kr` — 마지막 fetch 실패 로그 (KV 전파 지연 때문에 `wrangler kv key get`보다 이게 더 믿을만함)
  - `GET/POST /admin/config` — 점수 가중치/부스트·뮤트 키워드 저장
- 배포: `npm run deploy` (= `wrangler deploy`)
- kr 소스는 현재 7개 언론사만 있음: 연합뉴스, SBS, 조선일보, 동아일보, 매일경제, 한국경제, 머니투데이
  - 한겨레(hani.co.kr)는 raw 캐시를 계속 독점(84%)해서 사용자 지정으로 완전 제외함
  - 서울경제/헤럴드경제/연합뉴스TV는 Cloudflare Workers 아웃바운드 자체를 403으로 막아서 (Chrome/Googlebot UA 다 시도했는데도 안 뚫림) 제외함 — 로컬 fetch는 되는데 Workers에서만 막힘

## 4. 지금까지 진행된 작업 (최근 순)

1. **한겨레 완전 제외** — 날짜 태그 없는 문제로 캐시 독점 → 도메인당 캡 제거 요청 이후 재발 → 결국 완전 제외로 정리
2. **크롬 확장 티커 CSS 리팩토링** (Figma 스펙 기반)
   - `NEWS/ticker.css` — 모든 스타일 + `:root`의 CSS 변수(`--ticker-height`, `--ticker-speed`, `--ticker-font-size` 등)로 튜닝 포인트 분리
   - `NEWS/content.js` — `renderTickerItem(article)` 함수가 클래스명만 붙여서 DOM 생성 (`.ticker-item/.ticker-source/.ticker-cluster/.ticker-cat/.ticker-article/.ticker-title/.ticker-dot`), 스타일은 전혀 안 건드림. pause/hide는 클래스 토글(`is-paused`, `ticker-hidden`)로 처리
   - `NEWS/background.js` — Worker API가 이미 클러스터링/스코어링 끝낸 데이터를 주므로 클라이언트 쪽 중복 클러스터링 로직 제거, `{domain, cat, cluster, signal}` 필드로 매핑만 함
3. **admin에 하단 플로팅 티커 프로토타입 추가** (지금 여기가 진행 중인 부분)
   - `admin/index.html`의 기존 상단 텍스트 나열형 티커를 제거하고, `#tickerFloat`이라는 화면 하단 중앙에 뜨는 카드형 티커로 교체
   - 실제 확장프로그램과 **동일한 클래스 구조**로 렌더링해서 나중에 그대로 포팅 가능하도록 맞춰놓음
   - 사이드바에 "티커 (하단 플로팅)" 슬라이더 섹션 추가: 전체너비 여부, 최대너비, 하단/좌우 여백, 높이, 모서리 둥글기, 배경 불투명도, 블러, 스크롤 속도, 폰트 크기, 아이템 간격, 카테고리 배지 크기
   - 값은 `localStorage`에 자동 저장됨 (브라우저별로 따로 저장되니 노트북에서는 처음엔 기본값부터 시작함)
   - "📋 CSS 변수 복사" 버튼 — 지금 튜닝한 값을 `:root {...}` CSS 텍스트로 클립보드 복사 (나중에 `NEWS/ticker.css`로 옮길 때 씀)

## 5. 다음에 할 일 (사용자가 원하는 방향)

- admin에서 하단 플로팅 티커 디자인을 계속 튜닝
- 마음에 들면 → "📋 CSS 변수 복사"로 뽑은 값을 실제 `NEWS/ticker.css`에 반영하고, `NEWS/content.js`도 상단 고정 → 하단 플로팅 구조로 포팅 (아직 확장프로그램 쪽은 안 건드림, admin에서만 프로토타입 중)

## 6. 로컬에서 확인하는 법

```bash
open /Users/<사용자>/news-ticker/admin/index.html   # 브라우저로 바로 열림, Worker API를 직접 fetch함
```

크롬 확장프로그램 자체를 테스트하려면 `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드" → `NEWS/` 폴더 선택.
