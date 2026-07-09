// background.js — Workers API에서 클러스터링/점수 계산까지 끝난 헤드라인을 가져와
// content.js의 렌더링 필드(domain/cat/cluster/signal)로 변환해 저장한다.
// (클러스터링·스코어링은 Worker의 processItems()가 서버에서 이미 수행함)

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
  const headlines = buildHeadlines(items);

  await chrome.storage.local.set({
    headlines: headlines.slice(0, 150),
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
