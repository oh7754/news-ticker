// background.js — Workers API에서 클러스터링/점수 계산까지 끝난 헤드라인을 가져와
// content.js의 렌더링 필드(domain/cat/cluster/signal)로 변환해 저장한다.
// (클러스터링·스코어링은 Worker의 processItems()가 서버에서 이미 수행하고 cron
// 주기로 캐싱해둠. 노출 순서 그룹핑(4개씩 묶기+셔플)은 여기, 클라이언트에서 함
// — 그래야 유저가 늘어도 Worker 쪽 계산량이 안 늘고, 유저마다 순서도 달라짐)

const API_BASE = "https://news-ticker-worker.ojh7754.workers.dev";
const DEFAULT_PACK = "kr";
const REFRESH_INTERVAL_MINUTES = 10;

async function fetchPack(pack) {
  try {
    const res = await fetch(`${API_BASE}/?pack=${pack}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data.items || [];
  } catch (e) {
    console.warn(`[NewsTicker] Workers API 실패: ${pack}`, e.message);
    return [];
  }
}

// ── 노출 순서 그룹핑 (예전엔 Worker의 buildDisplayOrder였음, 동일 알고리즘) ──
// top/mid/tail 3개 티어로 나눠 4개씩(1+2+1) 묶는다. top은 절대 개수(6~15개)로
// 고정해 풀이 커져도 반복 노출 빈도가 안 옅어지게 하고, mid/tail은 풀 크기에
// 비례해서 롱테일 기사까지 후보에 포함시킨다. 그룹 내부 순서는 매번 랜덤 셔플.
const GROUP_SIZE = 4;
const TARGET_GROUPS = 38; // 최종 노출 목표 약 150개(38 * 4)
const TOP_RATIO = 0.15;
const MIN_TOP = 6;
const MAX_TOP = 15;
const MID_SHARE_OF_REST = 0.75;
const PROMOTE_SOURCE_COUNT = 3;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDisplayOrder(processed) {
  const total = processed.length;
  if (total < GROUP_SIZE) return processed;

  const topCount = Math.min(
    MAX_TOP,
    Math.max(MIN_TOP, Math.round(total * TOP_RATIO)),
    Math.max(1, total - 2)
  );

  const top = [];
  const rest = [];
  processed.forEach((item, i) => {
    const promoted = item.sourceCount >= PROMOTE_SOURCE_COUNT || item.breaking;
    if (top.length < topCount && (i < topCount || promoted)) {
      top.push(item);
    } else {
      rest.push(item);
    }
  });

  const midCount = Math.max(1, Math.round(rest.length * MID_SHARE_OF_REST));
  const mid = rest.slice(0, midCount);
  const tail = rest.slice(midCount);
  if (!tail.length) tail.push(...mid);

  const groupCount = Math.min(TARGET_GROUPS, Math.max(1, Math.floor(total / 2)));
  let topCur = 0;
  let midCur = 0;
  let tailCur = 0;
  const ordered = [];

  for (let g = 0; g < groupCount; g++) {
    const group = [
      top[topCur++ % top.length],
      mid[midCur++ % mid.length],
      mid[midCur++ % mid.length],
      tail[tailCur++ % tail.length],
    ];
    ordered.push(...shuffle(group));
  }
  return ordered;
}

function buildHeadlines(items) {
  return items.map((item) => ({
    title: item.title,
    link: item.link,
    domain: item.domain,
    cat: item.category,
    cluster: item.sourceCount,
    signal: item.breaking ? "breaking" : null,
    publishedAt: item.publishedAt,
    score: item.score,
    relatedArticles: item.relatedArticles || [],
  }));
}

async function refreshHeadlines() {
  const { pack } = await chrome.storage.sync.get({ pack: DEFAULT_PACK });
  const items = await fetchPack(pack);
  const ordered = buildDisplayOrder(items);
  const headlines = buildHeadlines(ordered);

  // buildDisplayOrder가 이미 4개 단위(그룹)로 깔끔하게 캡해서 반환하므로
  // (TARGET_GROUPS=38 → 최대 152개) 여기서 추가로 자르지 않는다. 자르면
  // 4의 배수가 깨져서 content.js가 그룹 단위로 재셔플할 때 마지막 그룹이
  // 어중간해진다.
  await chrome.storage.local.set({
    headlines,
    lastUpdated: Date.now()
  });

  console.log(`[NewsTicker] ${headlines.length}개 헤드라인 로드 (pack=${pack})`);
}

// 설치 시 초기 로드
chrome.runtime.onInstalled.addListener(async () => {
  await refreshHeadlines();
  chrome.alarms.create("refreshNews", { periodInMinutes: REFRESH_INTERVAL_MINUTES });
});

// 주기적 갱신
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "refreshNews") refreshHeadlines();
});

// content.js / popup.js 에서 요청
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "REFRESH") {
    refreshHeadlines().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_HEADLINES") {
    chrome.storage.local.get({ headlines: [], lastUpdated: 0 }, data => {
      sendResponse(data);
    });
    return true;
  }
});
