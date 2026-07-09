const EXT = {
  ROOT_ID: "kr-news-ticker-root",
  SPACER_ID: "kr-news-ticker-spacer",
  HEIGHT: 32 // 28~34 사이
};

const DEFAULT_UI_LOCALE = "en-US";
const DEFAULT_UI_STRINGS = {
  brand: "NEWS",
  loading: "Loading headlines…",
  scoreTitle: "Score View (test)",
  scoreHint: "Click {brand} → sort by score (max {max})",
  close: "Close",
  empty: "No articles to show.",
  breakingTag: "[Breaking]",
  breakingLabel: "Breaking",
  categories: {}
};

let currentItems = [];
let dockBottom = false;
let hideOnScroll = false;
let scrollHandler = null;
let lastScrollY = 0;
let barRef = null;
let barHidden = false;
let uiStrings = { ...DEFAULT_UI_STRINGS };
let uiLocale = DEFAULT_UI_LOCALE;

init().catch(() => {});

async function init() {
  const state = await chrome.storage.local.get([
    "enabled",
    "blacklist",
    "items",
    "dockBottom",
    "hideOnScroll",
    "uiStrings",
    "uiLocale"
  ]);
  applyUiStrings(state.uiStrings, state.uiLocale);
  dockBottom = state.dockBottom === true;
  hideOnScroll = state.hideOnScroll === true;
  const enabled = state.enabled !== false;
  const blacklist = Array.isArray(state.blacklist) ? state.blacklist : [];

  if (!enabled) return;
  if (isBlacklisted(blacklist)) return;

  mountTicker(state.items || []);

  // items / 설정 변경 실시간 반영
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    const enabledChange = changes.enabled?.newValue;
    const blacklistChange = changes.blacklist?.newValue;
    const itemsChange = changes.items?.newValue;
    const dockChange = changes.dockBottom?.newValue;
    const hideChange = changes.hideOnScroll?.newValue;
    const uiStringsChange = changes.uiStrings?.newValue;
    const uiLocaleChange = changes.uiLocale?.newValue;

    const nowEnabled = typeof enabledChange === "boolean" ? enabledChange : null;
    const nowBlacklist = Array.isArray(blacklistChange) ? blacklistChange : null;

    if (nowEnabled === false) {
      unmountTicker();
      return;
    }

    if (nowBlacklist && isBlacklisted(nowBlacklist)) {
      unmountTicker();
      return;
    }

    if (nowEnabled === true) {
      // 다시 켜졌는데 아직 없으면 마운트
      if (!document.getElementById(EXT.ROOT_ID)) mountTicker(itemsChange || []);
    }

    if (itemsChange) {
      updateTickerItems(itemsChange);
    }
    if (typeof dockChange === "boolean") {
      dockBottom = dockChange;
      updateDockPosition();
    }
    if (typeof hideChange === "boolean") {
      hideOnScroll = hideChange;
      applyScrollBehavior();
    }
    if (uiStringsChange || uiLocaleChange) {
      applyUiStrings(uiStringsChange, uiLocaleChange);
      if (document.getElementById(EXT.ROOT_ID)) {
        unmountTicker();
        mountTicker(currentItems);
      }
    }
  });
}

function applyUiStrings(nextStrings, nextLocale) {
  const incoming = nextStrings && typeof nextStrings === "object" ? nextStrings : {};
  uiStrings = {
    ...DEFAULT_UI_STRINGS,
    ...incoming,
    categories: {
      ...DEFAULT_UI_STRINGS.categories,
      ...(incoming.categories || {})
    }
  };
  if (typeof nextLocale === "string" && nextLocale) {
    uiLocale = nextLocale;
  } else if (typeof incoming.locale === "string" && incoming.locale) {
    uiLocale = incoming.locale;
  } else {
    uiLocale = DEFAULT_UI_LOCALE;
  }
}

function formatTemplate(template, vars) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(vars?.[key] ?? ""));
}

function isBlacklisted(blacklist) {
  const host = location.hostname.replace(/^www\./, "");
  return blacklist.includes(host);
}

function mountTicker(items) {
  if (document.getElementById(EXT.ROOT_ID)) return;
  currentItems = Array.isArray(items) ? items : [];

  const spacer = document.createElement("div");
  spacer.id = EXT.SPACER_ID;
  setupSpacer(spacer);

  const root = document.createElement("div");
  root.id = EXT.ROOT_ID;

  // shadow DOM으로 스타일 충돌 최소화
  const shadow = root.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      color-scheme: light dark;
      --bg: rgba(10, 10, 12, 0.86);
      --fg: rgba(255, 255, 255, 0.92);
      --muted: rgba(255, 255, 255, 0.75);
      --border: rgba(255, 255, 255, 0.08);
      --badge-bg: rgba(255, 255, 255, 0.06);
      --badge-border: rgba(255, 255, 255, 0.14);
      --score-bg: rgba(255, 255, 255, 0.06);
      --score-border: rgba(255, 255, 255, 0.14);
      --imp-dot: rgba(239, 68, 68, 0.95);
      --imp-dot-glow: rgba(239, 68, 68, 0.18);
    }
    @media (prefers-color-scheme: light) {
      :host {
        --bg: rgba(248, 248, 250, 0.96);
        --fg: #0b0b10;
        --muted: rgba(0, 0, 0, 0.55);
        --border: rgba(0, 0, 0, 0.08);
        --badge-bg: rgba(0, 0, 0, 0.06);
        --badge-border: rgba(0, 0, 0, 0.12);
        --score-bg: rgba(0, 0, 0, 0.05);
        --score-border: rgba(0, 0, 0, 0.12);
        --imp-dot: #d92c2c;
        --imp-dot-glow: rgba(217, 44, 44, 0.12);
      }
    }
    .bar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: ${EXT.HEIGHT}px;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 10px;
      background: var(--bg);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      color: var(--fg);
      box-sizing: border-box;
      transition: transform 0.25s ease;
    }
    .bar.dockBottom {
      top: auto;
      bottom: 0;
      border-bottom: 0;
      border-top: 1px solid var(--border);
    }
    .bar.dockHeader {
      position: relative;
      top: auto;
      bottom: auto;
      width: 100%;
      border-bottom: 1px solid var(--border);
      border-top: 0;
    }
    .brand {
      font-size: 11px;
      letter-spacing: 0.14em;
      opacity: 0.85;
      white-space: nowrap;
      user-select: none;
      cursor: pointer;
    }
    .divider {
      width: 1px;
      height: 14px;
      background: var(--badge-border);
      flex: 0 0 auto;
    }
    .track {
      position: relative;
      overflow: hidden;
      flex: 1 1 auto;
      height: ${EXT.HEIGHT}px;
      display: flex;
      align-items: center;
      mask-image: linear-gradient(to right, transparent, black 18px, black calc(100% - 18px), transparent);
      -webkit-mask-image: linear-gradient(to right, transparent, black 18px, black calc(100% - 18px), transparent);
    }
    .marquee {
      display: inline-flex;
      align-items: center;
      gap: 28px;
      will-change: transform;
      white-space: nowrap;
      font-size: 12px;
      line-height: 1;
    }
    .item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      opacity: 0.92;
      white-space: nowrap;
    }
    .item:hover { opacity: 1; }
    .src {
      font-size: 11px;
      color: var(--muted);
    }
    .cat {
      font-size: 10px;
      letter-spacing: 0.08em;
      padding: 3px 6px;
      border-radius: 999px;
      border: 1px solid var(--badge-border);
      background: var(--badge-bg);
      line-height: 1;
      user-select: none;
      opacity: 0.95;
      transform: translateY(-0.5px);
      margin-left: 6px; /* 신문사 뒤에 살짝 간격 */
    }

    .cnt {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid var(--badge-border);
      background: var(--score-bg);
      opacity: 0.95;
      margin-left: 6px;
      line-height: 1;
      user-select: none;
      transform: translateY(-0.5px);
    }

    /* 탭(카테고리)별 톤 */
    .cat[data-cat="top"]       { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.14); }
    .cat[data-cat="politics"]  { background: rgba(239,68,68,0.14);  border-color: rgba(239,68,68,0.28); }
    .cat[data-cat="economy"]   { background: rgba(16,185,129,0.14); border-color: rgba(16,185,129,0.28); }
    .cat[data-cat="society"]   { background: rgba(59,130,246,0.14); border-color: rgba(59,130,246,0.28); }
    .cat[data-cat="world"]     { background: rgba(168,85,247,0.14); border-color: rgba(168,85,247,0.28); }
    .cat[data-cat="culture"]   { background: rgba(236,72,153,0.14); border-color: rgba(236,72,153,0.28); }
    .cat[data-cat="sports"]    { background: rgba(245,158,11,0.14); border-color: rgba(245,158,11,0.28); }
    
    .time {
      font-size: 11px;
      color: var(--muted);
    }
  
    .tag {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid var(--badge-border);
      opacity: 0.9;
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .tag.green {
      background: rgba(34,197,94,0.14);
      border-color: rgba(34,197,94,0.28);
    }
    .tag.red {
      background: rgba(239,68,68,0.14);
      border-color: rgba(239,68,68,0.28);
    }
    .tagBreaking {
      display: inline-block;
      position: relative;
      padding-left: 6px;
      font-size: 12px;
      color: #fff;
      font-weight: 600;
      line-height: 1.1;
    }
    .impDot {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--imp-dot);
      box-shadow: 0 0 0 2px var(--imp-dot-glow);
      flex: 0 0 auto;
    }
    .score {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid var(--score-border);
      background: var(--score-bg);
      opacity: 0.85;
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .shared {
      font-size: 10px;
      color: var(--muted);
      opacity: 0.85;
      margin-left: 6px;
      max-width: 140px;
      display: inline-flex;
      gap: 6px;
      flex-wrap: nowrap;
      white-space: nowrap;
      vertical-align: middle;
    }
    /* 점수 패널 */
    .scorePanel {
      position: fixed;
      inset: ${EXT.HEIGHT}px 0 0 0;
      z-index: 2147483647;
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 32px 16px 24px;
      box-sizing: border-box;
    }
    .scorePanelCard {
      width: min(960px, 100%);
      max-height: calc(100vh - 80px);
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.35);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .scorePanelHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      letter-spacing: 0.04em;
    }
    .scorePanelHeader .muted {
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0;
    }
    .scorePanelClose {
      border: 1px solid var(--border);
      background: var(--score-bg);
      color: var(--fg);
      border-radius: 10px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 11px;
    }
    .scoreList {
      overflow: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .scoreRow {
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      gap: 8px;
      align-items: center;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--score-bg);
      cursor: pointer;
    }
    .scoreRow:hover { background: rgba(255,255,255,0.08); }
    @media (prefers-color-scheme: light) {
      .scoreRow:hover { background: rgba(0,0,0,0.05); }
    }
    .scoreBadge {
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 999px;
      border: 1px solid var(--score-border);
      background: var(--score-bg);
      min-width: 44px;
      text-align: center;
    }
    .scoreRank {
      font-size: 11px;
      color: var(--muted);
      min-width: 22px;
      text-align: right;
    }
    .scoreMeta {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 11px;
    }
    .scoreTitle {
      font-size: 13px;
      line-height: 1.35;
      color: var(--fg);
    }
    .scoreSignals {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .scoreCnt {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 999px;
      border: 1px solid var(--score-border);
      background: var(--score-bg);
    }
    .scoreTime {
      font-size: 11px;
      color: var(--muted);
      justify-self: end;
    }
    /* 연관 기사 패널 */
    .relatedPanel {
      position: fixed;
      top: ${EXT.HEIGHT + 8}px;
      right: 10px;
      width: min(340px, 100%);
      z-index: 2147483646;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 12px;
      box-shadow: 0 12px 36px rgba(0,0,0,0.32);
      overflow: hidden;
      font-size: 12px;
    }
    .relatedHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      gap: 8px;
    }
    .relatedHeader .title {
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .relatedHeader .muted {
      font-size: 11px;
      color: var(--muted);
      letter-spacing: 0;
    }
    .relatedClose {
      border: 1px solid var(--border);
      background: var(--score-bg);
      color: var(--fg);
      border-radius: 8px;
      padding: 4px 8px;
      cursor: pointer;
      font-size: 11px;
    }
    .relatedList {
      max-height: 420px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
    }
    .relatedRow {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--score-bg);
      cursor: pointer;
    }
    .relatedRow:hover { background: rgba(255,255,255,0.08); }
    @media (prefers-color-scheme: light) {
      .relatedRow:hover { background: rgba(0,0,0,0.05); }
    }
    .relatedSignals {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 11px;
    }
    .relatedTitle {
      font-size: 13px;
      line-height: 1.35;
      color: var(--fg);
    }
    .relatedTime {
      font-size: 11px;
      color: var(--muted);
      justify-self: end;
    }
`;

  const bar = document.createElement("div");
  bar.className = "bar";

  const brand = document.createElement("div");
  brand.className = "brand";
  brand.textContent = uiStrings.brand || DEFAULT_UI_STRINGS.brand;
  brand.addEventListener("click", () => toggleScorePanel(shadow));

  const divider = document.createElement("div");
  divider.className = "divider";

  const track = document.createElement("div");
  track.className = "track";

  const marquee = document.createElement("div");
  marquee.className = "marquee";
  marquee.dataset.role = "marquee";

  track.appendChild(marquee);
  bar.appendChild(brand);
  bar.appendChild(divider);
  bar.appendChild(track);

  shadow.appendChild(style);
  shadow.appendChild(bar);

  document.documentElement.appendChild(root);
  placeSpacer(spacer);

  updateDockPosition();
  renderMarquee(items);
  startMarqueeLoop(shadow);
  applyScrollBehavior();
}

function unmountTicker() {
  const root = document.getElementById(EXT.ROOT_ID);
  if (root) root.remove();
  const spacer = document.getElementById(EXT.SPACER_ID);
  if (spacer) spacer.remove();
}

function updateTickerItems(items) {
  const root = document.getElementById(EXT.ROOT_ID);
  if (!root?.shadowRoot) return;
  currentItems = Array.isArray(items) ? items : [];
  renderMarquee(currentItems, root.shadowRoot);
}

function renderMarquee(items, shadowRootParam) {
  const root = document.getElementById(EXT.ROOT_ID);
  const shadow = shadowRootParam || root?.shadowRoot;
  if (!shadow) return;

  const marquee = shadow.querySelector('[data-role="marquee"]');
  if (!marquee) return;
  const bar = shadow.querySelector(".bar");
  if (bar) barRef = bar;

  marquee.innerHTML = "";

  currentItems = Array.isArray(items) ? items : [];

  const related = findRelatedItem(currentItems);
  const relatedMode = Boolean(related?.clusterMembers?.length);
  let safeItems = related?.clusterMembers?.length
    ? related.clusterMembers.slice(0, 60)
    : buildDisplayItems(currentItems, 60);

  if (safeItems.length > 0 && safeItems.length < 5) {
    const dup = [];
    while (dup.length < 5) {
      for (const it of safeItems) {
        dup.push({ ...it });
        if (dup.length >= 5) break;
      }
    }
    safeItems = dup;
  }

  if (!safeItems.length) {
    const empty = document.createElement("div");
    empty.className = "item";
    empty.style.opacity = "0.7";
    empty.textContent = uiStrings.loading || DEFAULT_UI_STRINGS.loading;
    marquee.appendChild(empty);
    marquee.dataset.contentWidth = "0";
    return;
  }

  const frag = document.createDocumentFragment();

  for (const it of safeItems) {
    const el = document.createElement("div");
    el.className = "item";
    el.title = it.link;

    const shared = Array.isArray(it.sharedTokens) ? it.sharedTokens.slice(0, 6) : [];
    const signal = String(it.signal || "");

    const src = document.createElement("span");
    src.className = "src";
    src.textContent = it.sourceName || it.domain || "NEWS";
    if (signal === "breaking") {
      src.style.position = "relative";
      src.style.display = "inline-block";
      const dot = document.createElement("span");
      dot.className = "impDot";
      dot.style.position = "absolute";
      dot.style.left = "-5px";
      dot.style.top = "-4px";
      dot.style.boxShadow = "none";
      dot.style.pointerEvents = "none";
      src.appendChild(dot);
      src.classList.add("breakingSrc");
    }

    const cat = document.createElement("span");
    cat.className = "cat";
    const catKey = normalizeCat(it.category);
    cat.dataset.cat = catKey;
    cat.textContent = it.categoryLabel || catLabel(catKey);

    const cnt = document.createElement("span");
    cnt.className = "cnt";

    const n = Number(it.clusterCount || 1);
    if (n > 1) {
      cnt.textContent = `×${n}`; // 총 몇 개 묶였는지
    } else {
      cnt.textContent = ""; // 1개면 숨김
    }

    let tag = null;
    if (signal === "breaking") {
      tag = document.createElement("span");
      tag.className = "tagBreaking";
      tag.textContent = uiStrings.breakingTag || DEFAULT_UI_STRINGS.breakingTag;
    }

    const score = document.createElement("span");
    score.className = "score";
    const sc = Number(it.score);
    score.textContent = Number.isFinite(sc) ? (sc >= 0 ? `+${sc}` : String(sc)) : "";

    const title = document.createElement("span");
    title.textContent = stripBracketed(it.title);

    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatTime(it.publishedAt || it.fetchedAt);

    el.appendChild(src);
    el.appendChild(cat);
    if (tag) el.appendChild(tag);
    el.appendChild(title);
    if (n > 1) el.appendChild(cnt);
    if (score.textContent) el.appendChild(score);
    el.appendChild(time);

    if (relatedMode && shared.length) {
      const sh = document.createElement("span");
      sh.className = "shared";
      const lines = shared.slice(0, 3);
      for (const t of lines) {
        const s = document.createElement("span");
        s.textContent = t;
        sh.appendChild(s);
      }
      el.appendChild(sh);
    }

    el.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_TAB", url: it.link });
    });

    frag.appendChild(el);
  }

  marquee.appendChild(frag);

  // 루프를 위해 1번 더 복제(부드러운 무한 스크롤)
  const clone = marquee.cloneNode(true);
  clone.removeAttribute("data-role");
  marquee.appendChild(clone);

  // width 측정은 다음 프레임에
  requestAnimationFrame(() => {
    const firstRunWidth = marquee.scrollWidth / 2;
    marquee.dataset.contentWidth = String(firstRunWidth);
  });
}

function formatTime(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return "";
  const d = new Date(t);

  // 오늘이면 HH:MM, 아니면 M/D HH:MM
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (sameDay) {
  return new Intl.DateTimeFormat(uiLocale || DEFAULT_UI_LOCALE, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

  return new Intl.DateTimeFormat(uiLocale || DEFAULT_UI_LOCALE, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(d);
}

function normalizeCat(c) {
  const s = String(c || "").toLowerCase().trim();
  // v4: tab id가 그대로 들어옴(politics/economy/...)
  if (!s) return "society";
  if (s === "top") return "society";
  return s;
}

function catLabel(catKey) {
  const key = String(catKey || "").toLowerCase();
  return uiStrings.categories?.[key] || key.toUpperCase();
}

function startMarqueeLoop(shadow) {
  const marquee = shadow.querySelector('[data-role="marquee"]');
  if (!marquee) return;

  // 한 탭에서만 루프가 돌도록 간단 플래그
  if (marquee.dataset.loopStarted === "1") return;
  marquee.dataset.loopStarted = "1";

  const speed = 42; // px/s
  const start = performance.now();

  function tick(now) {
    const w = Number(marquee.dataset.contentWidth || "0");
    if (w > 0) {
      const dist = speed * ((now - start) / 1000);
      const offset = dist % w;
      marquee.style.transform = `translate3d(-${offset}px, 0, 0)`;
    } else {
      marquee.style.transform = "translate3d(0,0,0)";
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

function setupSpacer(spacer) {
  if (!spacer) return;
  spacer.style.height = `${EXT.HEIGHT}px`;
  spacer.style.width = "100%";
  spacer.style.pointerEvents = "none";
  spacer.style.background = "transparent";
}

function placeSpacer(spacer) {
  if (!spacer || !document.body) return;
  if (spacer.parentNode) spacer.parentNode.removeChild(spacer);
  if (dockBottom) document.body.appendChild(spacer);
  else document.body.insertBefore(spacer, document.body.firstChild);
}

function updateDockPosition() {
  const root = document.getElementById(EXT.ROOT_ID);
  const bar = root?.shadowRoot?.querySelector(".bar");
  if (bar) {
    bar.classList.toggle("dockBottom", dockBottom);
    if (dockBottom) {
      bar.style.top = "";
      bar.style.bottom = "0";
      bar.style.position = "fixed";
    } else {
      bar.style.top = "0";
      bar.style.bottom = "";
      bar.style.position = "fixed";
    }
  }

  const spacer = document.getElementById(EXT.SPACER_ID);
  if (spacer) placeSpacer(spacer);
}

function findRelatedItem(items) {
  const cur = normalizeArticleUrl(location.href);
  if (!cur) return null;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it?.link) continue;
    if (normalizeArticleUrl(it.link) === cur) return it;
  }
  return null;
}

function normalizeArticleUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}${url.search}`;
  } catch {
    return "";
  }
}

function toggleScorePanel(shadow) {
  if (!shadow) return;
  const existing = shadow.querySelector(".scorePanel");
  if (existing) {
    existing.remove();
    return;
  }
  const panel = buildScorePanel(shadow);
  if (panel) shadow.appendChild(panel);
}

function buildScorePanel(shadow) {
  if (!shadow) return null;
  const panel = document.createElement("div");
  panel.className = "scorePanel";

  const card = document.createElement("div");
  card.className = "scorePanelCard";

  const header = document.createElement("div");
  header.className = "scorePanelHeader";

  const title = document.createElement("div");
  title.textContent = uiStrings.scoreTitle || DEFAULT_UI_STRINGS.scoreTitle;

  const hint = document.createElement("div");
  hint.className = "muted";
  hint.textContent = formatTemplate(uiStrings.scoreHint || DEFAULT_UI_STRINGS.scoreHint, {
    brand: uiStrings.brand || DEFAULT_UI_STRINGS.brand,
    max: 80
  });
  title.appendChild(document.createElement("br"));
  title.appendChild(hint);

  const closeBtn = document.createElement("button");
  closeBtn.className = "scorePanelClose";
  closeBtn.textContent = uiStrings.close || DEFAULT_UI_STRINGS.close;
  closeBtn.addEventListener("click", () => panel.remove());

  header.appendChild(title);
  header.appendChild(closeBtn);

  const list = document.createElement("div");
  list.className = "scoreList";

  const sorted = Array.isArray(currentItems)
    ? currentItems.slice(0, 80).sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    : [];

  if (!sorted.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.padding = "12px 14px";
    empty.textContent = uiStrings.empty || DEFAULT_UI_STRINGS.empty;
    list.appendChild(empty);
  } else {
    sorted.forEach((it, idx) => {
      const row = document.createElement("div");
      row.className = "scoreRow";

      const rank = document.createElement("div");
      rank.className = "scoreRank";
      rank.textContent = String(idx + 1);

      const badge = document.createElement("div");
      badge.className = "scoreBadge";
      const sc = Number(it.score);
      badge.textContent = Number.isFinite(sc) ? (sc >= 0 ? `+${sc}` : String(sc)) : "—";

      const body = document.createElement("div");
      body.className = "scoreBody";

      const signals = document.createElement("div");
      signals.className = "scoreSignals";

      const src = document.createElement("span");
      src.className = "src";
      src.textContent = it.sourceName || it.domain || "NEWS";
      signals.appendChild(src);

      const cat = document.createElement("span");
      cat.className = "cat";
      const catKey = normalizeCat(it.category);
      cat.dataset.cat = catKey;
      cat.textContent = it.categoryLabel || catLabel(catKey);
      signals.appendChild(cat);

      const signal = String(it.signal || "");
      if (signal === "breaking") {
        const tag = document.createElement("span");
        tag.className = "tag red";
        tag.textContent = uiStrings.breakingLabel || DEFAULT_UI_STRINGS.breakingLabel;
        signals.appendChild(tag);
      }

      const n = Number(it.clusterCount || 1);
      if (n > 1) {
        const cnt = document.createElement("span");
        cnt.className = "scoreCnt";
        cnt.textContent = `×${n}`;
        signals.appendChild(cnt);
      }

      const title = document.createElement("div");
      title.className = "scoreTitle";
      title.textContent = stripBracketed(it.title);

      const meta = document.createElement("div");
      meta.className = "scoreMeta";
      const time = document.createElement("span");
      time.textContent = formatTime(it.publishedAt || it.fetchedAt) || "—";
      meta.appendChild(time);

      body.appendChild(signals);
      body.appendChild(title);
      body.appendChild(meta);

      const timeCol = document.createElement("div");
      timeCol.className = "scoreTime";
      timeCol.textContent = formatTime(it.publishedAt || it.fetchedAt) || "";

      row.appendChild(rank);
      row.appendChild(badge);
      row.appendChild(body);
      row.appendChild(timeCol);

      row.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "OPEN_TAB", url: it.link });
      });

      list.appendChild(row);
    });
  }

  card.appendChild(header);
  card.appendChild(list);
  panel.appendChild(card);
  return panel;
}

function buildDisplayItems(items, target = 60) {
  const arr = Array.isArray(items) ? items.slice(0, 80) : [];
  const tier1 = arr.slice(0, 20);
  const tier2 = arr.slice(20, 40);
  const tier3 = arr.slice(40);

  shuffle(tier1);
  shuffle(tier2);
  shuffle(tier3);

  const out = [];

  function pick(primary, fallbackA, fallbackB) {
    if (primary.length) return primary.shift();
    if (fallbackA.length) return fallbackA.shift();
    if (fallbackB.length) return fallbackB.shift();
    return null;
  }

  while (out.length < target && (tier1.length || tier2.length || tier3.length)) {
    // 5개 블록: 1-2위권 2개, 21-40위권 2개, 나머지 1개
    const picks = [
      pick(tier1, tier2, tier3),
      pick(tier1, tier2, tier3),
      pick(tier2, tier1, tier3),
      pick(tier2, tier1, tier3),
      pick(tier3, tier2, tier1)
    ];
    for (const p of picks) {
      if (p && out.length < target) out.push(p);
    }
  }

  return out;
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function applyScrollBehavior() {
  if (scrollHandler) {
    window.removeEventListener("scroll", scrollHandler);
    scrollHandler = null;
  }
  if (!barRef) return;
  barRef.style.transform = "";
  barHidden = false;
  if (!hideOnScroll) return;

  lastScrollY = window.scrollY || 0;
  scrollHandler = () => {
    const y = window.scrollY || 0;
    const delta = y - lastScrollY;
    lastScrollY = y;

    if (y < 12 || delta < -6) {
      if (barHidden) {
        barRef.style.transform = "translateY(0)";
        barHidden = false;
      }
      return;
    }

    if (delta > 6 && !barHidden) {
      const shift = dockBottom ? EXT.HEIGHT : -EXT.HEIGHT;
      barRef.style.transform = `translateY(${shift}px)`;
      barHidden = true;
    }
  };
  window.addEventListener("scroll", scrollHandler, { passive: true });
}

function stripBracketed(s) {
  return String(s || "").replace(/\[[^\]]*]/g, "").trim();
}
