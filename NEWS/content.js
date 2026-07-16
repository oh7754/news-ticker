// content.js — 모든 페이지에 티커 주입 (DOM 생성만 담당, 스타일은 ticker.css에서 관리)

(function () {
  "use strict";

  // 이미 주입됐으면 스킵
  if (document.getElementById("__news-ticker-root")) return;

  const DEFAULT_SPEED = 60; // px/s, --ticker-speed를 못 읽을 때의 fallback
  const CAT_LABELS = {
    politics: "정치",
    economy: "경제",
    society: "사회",
    world: "국제",
    culture: "문화",
    entertainment: "연예",
    sports: "스포츠",
    tech: "기술",
  };

  // ── DOM 구성 ──────────────────────────────────────────
  const root = document.createElement("div");
  root.id = "__news-ticker-root";

  const label = document.createElement("div");
  label.id = "__news-ticker-label";
  label.textContent = "📡 뉴스";

  const track = document.createElement("div");
  track.id = "__news-ticker-track";

  const inner = document.createElement("div");
  inner.id = "__news-ticker-inner";
  track.appendChild(inner);

  const controls = document.createElement("div");
  controls.id = "__news-ticker-controls";

  const btnClose = document.createElement("button");
  btnClose.className = "__news-ticker-btn";
  btnClose.textContent = "✕";
  btnClose.title = "이 페이지에서만 닫기 (새로고침하면 다시 보임)";
  btnClose.onclick = () => {
    if (tagMode) exitTagMode();
    else dismissTicker();
  };

  controls.append(btnClose);
  root.append(label, track, controls);

  // ── 기사 하나를 .ticker-item 구조로 렌더링 ──────────────
  function renderTickerItem(article) {
    const item = document.createElement("a");
    item.className = "ticker-item";
    item.href = article.link;
    item.target = "_blank";
    item.rel = "noopener noreferrer";

    const source = document.createElement("span");
    source.className = "ticker-source";

    const sourceName = document.createElement("span");
    sourceName.className = "ticker-source-name";
    sourceName.textContent = article.domain;
    source.appendChild(sourceName);

    if (article.cluster > 1) {
      const cluster = document.createElement("span");
      cluster.className = "ticker-cluster";
      cluster.textContent = `+${article.cluster - 1}`;
      source.appendChild(cluster);
    }

    if (article.signal === "breaking") {
      const dot = document.createElement("span");
      dot.className = "ticker-dot";
      source.appendChild(dot);
    }

    item.appendChild(source);

    if (article.cat) {
      const cat = document.createElement("span");
      cat.className = `ticker-cat cat-${article.cat}`;
      cat.textContent = CAT_LABELS[article.cat] || article.cat;
      item.appendChild(cat);
    }

    const articleEl = document.createElement("span");
    articleEl.className = "ticker-article";

    const title = document.createElement("span");
    title.className = "ticker-title";
    title.textContent = article.title;
    articleEl.appendChild(title);

    item.appendChild(articleEl);
    return item;
  }

  // ── 공통 렌더링: 아이템 목록을 두 벌 복사해서 seamless 마퀴로 흘려보낸다 ──
  // renderSlice(평소 로테이션)랑 renderClusterTag(관련기사 고정 목록) 둘 다
  // 이걸 씀 — 짧으면 짧은 대로 금방 한 바퀴 돌고, 길면 그만큼 흘러가며 전부 보여준다.
  function renderItemsToTicker(items) {
    inner.innerHTML = "";

    const fragment = () => {
      const frag = document.createDocumentFragment();
      items.forEach((article) => frag.appendChild(renderTickerItem(article)));
      return frag;
    };

    inner.appendChild(fragment());
    inner.appendChild(fragment());

    // 실제 렌더된 너비 + --ticker-speed로 애니메이션 시간을 계산해
    // CSS 변수로만 전달한다 (실제 style 규칙은 ticker.css가 소유)
    requestAnimationFrame(() => {
      const speed = parseFloat(getComputedStyle(root).getPropertyValue("--ticker-speed")) || DEFAULT_SPEED;
      const halfWidth = inner.scrollWidth / 2;
      const duration = halfWidth / speed;
      inner.style.setProperty("--ticker-computed-duration", `${duration}s`);
    });
  }

  // ── 헤드라인 로드 & 렌더 (평소 로테이션) ────────────────
  // 한 번에 다 렌더링하면(최대 150개) DOM이 무거워져서 프레임이 떨어지므로,
  // RENDER_COUNT개씩만 그리고 루프가 자연스럽게 한 바퀴 끝나는 시점
  // (animationiteration)에 다음 구간으로 교체한다. 네트워크 재요청 없이
  // 이미 받아둔 전체 목록(allHeadlines) 안에서만 순환하므로 API 부담이 없다.
  const RENDER_COUNT = 60;
  let allHeadlines = [];
  let renderOffset = 0;

  function renderSlice() {
    if (!allHeadlines.length) {
      inner.textContent = "뉴스를 불러오는 중...";
      return;
    }

    const count = Math.min(RENDER_COUNT, allHeadlines.length);
    const slice = [];
    for (let i = 0; i < count; i++) {
      slice.push(allHeadlines[(renderOffset + i) % allHeadlines.length]);
    }

    renderItemsToTicker(slice);
  }

  // ── 클러스터 태그 모드 ──────────────────────────────────
  // 지금 보고 있는 페이지가 클러스터링된 기사(여러 언론사가 같이 다룬 사건) 중
  // 하나면, 평소 로테이션 대신 같은 사건을 다룬 다른 언론사 기사들을 보여준다.
  // RSS 링크가 트래킹 파라미터나 AMP 버전 때문에 현재 주소창 URL과 완전히
  // 똑같지 않을 수 있어서, 쿼리스트링/해시/www를 뺀 "호스트+경로"만 비교하는
  // 느슨한 매칭을 쓴다.
  let tagMode = false;

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      return (u.hostname.replace(/^www\./, "") + u.pathname).replace(/\/$/, "");
    } catch {
      return url;
    }
  }

  function findClusterMatch() {
    const current = normalizeUrl(location.href);
    for (const item of allHeadlines) {
      const related = item.relatedArticles || [];
      if (!related.length) continue;
      const members = [{ domain: item.domain, link: item.link, title: item.title }, ...related];
      const isMatch = members.some((m) => normalizeUrl(m.link) === current);
      if (!isMatch) continue;
      const others = members.filter((m) => normalizeUrl(m.link) !== current);
      if (others.length) return others;
    }
    return null;
  }

  function renderClusterTag(others) {
    tagMode = true;
    // 닫기 버튼은 "티커 전체 닫기"가 아니라 "이 태그 해제"라서, 오른쪽 끝
    // 컨트롤 자리가 아니라 태그 라벨 바로 옆으로 옮긴다 (같은 맥락끼리 묶임).
    label.textContent = "🏷️ 같은 소식 다른 언론사";
    label.appendChild(btnClose);
    btnClose.title = "닫기 (원래 티커로 복귀)";
    renderItemsToTicker(others.map((article) => ({
      title: article.title,
      link: article.link,
      domain: article.domain,
      cat: null,
      cluster: 0,
      signal: null,
    })));
  }

  function exitTagMode() {
    tagMode = false;
    label.textContent = "📡 뉴스";
    controls.appendChild(btnClose);
    btnClose.title = "이 페이지에서만 닫기 (새로고침하면 다시 보임)";
    renderOffset = 0;
    renderSlice();
  }

  // background.js가 이미 그룹(4개 단위: top 1 + mid 2 + tail 1)까지 섞어서
  // 저장해두지만, 그건 10분 갱신 주기마다 한 번씩만 섞이는 거라 같은 주기
  // 안에서는 모든 탭이 똑같은 순서를 봄. renderOffset도 buildTicker가 호출될
  // 때마다(=페이지 로드마다) 0으로 리셋되니까, 그룹 "내부"만 섞으면 매번
  // 처음 60개(그룹 내부 순서만 다른, 같은 기사들)만 보게 되는 문제가 있다.
  // 그래서 그룹 "순서" 자체도 같이 섞어야 페이지를 옮겨다닐 때마다 실제로
  // 다른 기사들이 보인다 — 그룹 구성(어떤 기사 4개가 묶였는지)만 유지.
  function shuffleClient(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function reshuffleGroups(items) {
    const groups = [];
    for (let i = 0; i < items.length; i += 4) {
      groups.push(items.slice(i, i + 4));
    }
    shuffleClient(groups); // 그룹 순서 자체를 섞음 — 매번 다른 60개가 먼저 보이게
    groups.forEach((g) => shuffleClient(g)); // 그룹 내부 순서도 섞음
    return groups.flat();
  }

  function buildTicker(items) {
    allHeadlines = reshuffleGroups(items);
    renderOffset = 0;
    const match = findClusterMatch();
    if (match) {
      renderClusterTag(match);
    } else {
      renderSlice();
    }
  }

  // 루프가 한 바퀴 끝나는 순간(위치가 이미 처음으로 리셋된 시점)에 다음
  // RENDER_COUNT개로 교체 — 이 타이밍에 바꾸면 시각적으로 튀지 않는다.
  // 태그 모드일 때는 (고정된 관련기사 목록을 그대로 계속 반복하면 되므로)
  // 다음 구간으로 교체할 필요가 없어서 스킵한다.
  inner.addEventListener("animationiteration", () => {
    if (tagMode || allHeadlines.length <= RENDER_COUNT) return;
    renderOffset = (renderOffset + RENDER_COUNT) % allHeadlines.length;
    renderSlice();
  });

  function loadHeadlines() {
    chrome.runtime.sendMessage({ type: "GET_HEADLINES" }, (data) => {
      if (data && data.headlines) buildTicker(data.headlines);
    });
  }

  // ── 컨트롤 ────────────────────────────────────────────
  // ✕ 버튼: 이 페이지(탭)에서만 즉시 닫는다. chrome.storage에 저장하지
  // 않으므로 새로고침하거나 다른 탭으로 가면 다시 나타난다 — 유튜브처럼
  // 컨트롤을 가릴 때 잠깐 치우는 용도. 팝업의 "티커 표시" 토글(전역, 영구)과는
  // 별개로 동작한다.
  function dismissTicker() {
    root.classList.add("ticker-hidden");
  }

  // 팝업에서 끄고 켜는 전역 설정 (모든 탭·새로고침에 걸쳐 유지됨)
  function hideTicker() {
    root.classList.add("ticker-hidden");
    chrome.storage.local.set({ tickerHidden: true });
  }

  function showTicker() {
    root.classList.remove("ticker-hidden");
    chrome.storage.local.set({ tickerHidden: false });
  }

  // ── 탭 백그라운드 대응 ──────────────────────────────────
  // CSS 애니메이션은 탭이 안 보여도 실제 경과 시간 기준으로 내부 시계가
  // 계속 흐른다. 그래서 다른 탭에 오래 있다 돌아오면 그 시간만큼 밀린 걸
  // 한 번에 따라잡으면서 순식간에 확 지나가 버린다(루프 교체 이벤트도
  // 밀린 만큼 몰아서 발생). 탭이 안 보이는 동안은 아예 애니메이션을
  // 멈춰서 이 문제를 원천 차단한다.
  document.addEventListener("visibilitychange", () => {
    inner.classList.toggle("is-paused", document.hidden);
  });

  // ── 마운트 ────────────────────────────────────────────
  function mount() {
    // 숨김 상태 복원 (플로팅 카드는 오버레이라 페이지 레이아웃을 밀어낼 필요 없음)
    chrome.storage.local.get({ tickerHidden: false }, ({ tickerHidden }) => {
      if (tickerHidden) root.classList.add("ticker-hidden");
    });

    if (document.hidden) inner.classList.add("is-paused");

    document.documentElement.insertBefore(root, document.documentElement.firstChild);
    loadHeadlines();

    // 15분마다 자동 갱신
    setInterval(loadHeadlines, 15 * 60 * 1000);
  }

  // ── 팝업에서 show/hide 메시지 수신 ─────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SHOW_TICKER") showTicker();
    if (msg.type === "HIDE_TICKER") hideTicker();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
