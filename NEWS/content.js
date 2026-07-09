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

  let paused = false;

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

  const btnPause = document.createElement("button");
  btnPause.textContent = "⏸";
  btnPause.title = "일시정지 / 재생";
  btnPause.onclick = togglePause;

  const btnRefresh = document.createElement("button");
  btnRefresh.textContent = "↺";
  btnRefresh.title = "새로고침";
  btnRefresh.onclick = () => {
    chrome.runtime.sendMessage({ type: "REFRESH" }, () => {
      setTimeout(loadHeadlines, 2000);
    });
  };

  const btnHide = document.createElement("button");
  btnHide.textContent = "✕";
  btnHide.title = "숨기기 (팝업에서 다시 표시)";
  btnHide.onclick = hideTicker;

  controls.append(btnPause, btnRefresh, btnHide);
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
    item.appendChild(source);

    if (article.cat) {
      const cat = document.createElement("span");
      cat.className = `ticker-cat cat-${article.cat}`;
      cat.textContent = CAT_LABELS[article.cat] || article.cat;
      item.appendChild(cat);
    }

    const articleEl = document.createElement("span");
    articleEl.className = "ticker-article";

    if (article.signal === "breaking") {
      const dot = document.createElement("span");
      dot.className = "ticker-dot";
      articleEl.appendChild(dot);
    }

    const title = document.createElement("span");
    title.className = "ticker-title";
    title.textContent = article.title;
    articleEl.appendChild(title);

    item.appendChild(articleEl);
    return item;
  }

  // ── 헤드라인 로드 & 렌더 ──────────────────────────────
  function buildTicker(items) {
    if (!items.length) {
      inner.textContent = "뉴스를 불러오는 중...";
      return;
    }

    inner.innerHTML = "";

    // 두 벌 복사해서 seamless loop
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

  function loadHeadlines() {
    chrome.runtime.sendMessage({ type: "GET_HEADLINES" }, (data) => {
      if (data && data.headlines) buildTicker(data.headlines);
    });
  }

  // ── 컨트롤 ────────────────────────────────────────────
  function togglePause() {
    paused = !paused;
    inner.classList.toggle("is-paused", paused);
    btnPause.textContent = paused ? "▶" : "⏸";
  }

  function hideTicker() {
    root.classList.add("ticker-hidden");
    document.documentElement.classList.remove("__news-ticker-offset");
    chrome.storage.local.set({ tickerHidden: true });
  }

  function showTicker() {
    root.classList.remove("ticker-hidden");
    document.documentElement.classList.add("__news-ticker-offset");
    chrome.storage.local.set({ tickerHidden: false });
  }

  // ── 마운트 ────────────────────────────────────────────
  function mount() {
    // 숨김 상태 복원
    chrome.storage.local.get({ tickerHidden: false }, ({ tickerHidden }) => {
      if (tickerHidden) {
        root.classList.add("ticker-hidden");
      } else {
        document.documentElement.classList.add("__news-ticker-offset");
      }
    });

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
