// service_worker.js (MV3, module)

const STORAGE_KEYS = {
  enabled: "enabled",
  blacklist: "blacklist",
  items: "items",
  lastUpdated: "lastUpdated",
  refreshMinutes: "refreshMinutes",
  sources: "sources",
  sourcesPackId: "sourcesPackId",
  devMode: "devMode",
  selectedTabId: "selectedTabId",
  selectedCategoryId: "selectedCategoryId",
  seenMap: "seenMap",
  usMetroEnabled: "usMetroEnabled",
  usMetroIds: "usMetroIds",
  uiLocale: "uiLocale",
  uiStrings: "uiStrings"
};

const ALARM_NAME = "kr_news_ticker_refresh";

const DEFAULTS = {
  enabled: true,
  blacklist: [],
  refreshMinutes: 7,
  items: [],
  sourcesPackId: "kr",
  devMode: false,
  selectedTabId: "all",
  selectedCategoryId: "*",
  seenMap: {},
  usMetroEnabled: true,
  usMetroIds: [],
  uiLocale: "en-US",
  uiStrings: {}
};

const DEFAULT_UI_LOCALE = "en-US";
const DEFAULT_UI_STRINGS = {
  appName: "News Ticker",
  brand: "NEWS",
  loading: "Loading headlines…",
  scoreTitle: "Score View (test)",
  scoreHint: "Click {brand} → sort by score (max {max})",
  close: "Close",
  empty: "No articles to show.",
  breakingTag: "[Breaking]",
  breakingLabel: "Breaking",
  sectionCountry: "Country",
  sectionTickerPosition: "Ticker Position",
  toggleDockBottom: "Dock to bottom",
  toggleHideOnScroll: "Hide on scroll",
  sectionHiddenSites: "Hidden sites",
  hideSite: "Hide this site",
  unhideSite: "Unhide this site",
  unhideButton: "Unhide",
  refresh: "Refresh",
  devSection: "DEV",
  devLogs: "Debug logs",
  reloadSources: "Reload sources",
  devHint: "Sources pack changes apply without clearing storage.",
  sourcesHint: "Replace sources/sources.<pack>.json to add locales.",
  noHiddenSites: "None",
  metroSection: "US Metro",
  metroEnabled: "Enable metro",
  metroToggle: "Toggle list",
  statusLastUpdated: "Last updated: {time}",
  statusCurrentHost: "Current: {host}",
  categories: {}
};

let ACTIVE_STOP_WORDS = new Set();
let PACK_SETTINGS_READY = false;

let DEV_MODE = false;

async function syncDevMode() {
  const { [STORAGE_KEYS.devMode]: devMode } = await chrome.storage.local.get([
    STORAGE_KEYS.devMode
  ]);
  DEV_MODE = devMode === true;
}

function logDev(...args) {
  if (DEV_MODE) console.log("[KR News Ticker]", ...args);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEYS.devMode]) {
    DEV_MODE = changes[STORAGE_KEYS.devMode].newValue === true;
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureInitialized();
  await syncDevMode();
  await scheduleAlarm();
  await refreshFeeds({ reason: "onInstalled" });
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureInitialized();
  await syncDevMode();
  await scheduleAlarm();
  await refreshFeeds({ reason: "onStartup" });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm?.name !== ALARM_NAME) return;
  await refreshFeeds({ reason: "alarm" });
});

// popup/content에서 메시지 처리
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "OPEN_TAB" && msg.url) {
        await chrome.tabs.create({ url: msg.url });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "FORCE_REFRESH") {
        await refreshFeeds({ reason: "manual" });
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "RELOAD_SOURCES_PACK") {
        const current = await chrome.storage.local.get([
          STORAGE_KEYS.sourcesPackId,
          STORAGE_KEYS.selectedTabId,
          STORAGE_KEYS.selectedCategoryId,
          STORAGE_KEYS.usMetroEnabled,
          STORAGE_KEYS.usMetroIds
        ]);
        const requestedPackId = typeof msg.packId === "string" ? msg.packId : "";
        const packId = requestedPackId || current[STORAGE_KEYS.sourcesPackId] || DEFAULTS.sourcesPackId;
        const pack = await loadSourcesPack(packId);
        const { uiStrings, uiLocale } = applyPackSettings(pack);
        const refreshMinutes =
          Number(pack?.default_refresh_minutes) > 0
            ? Number(pack.default_refresh_minutes)
            : DEFAULTS.refreshMinutes;
        const tabId = current[STORAGE_KEYS.selectedTabId] || DEFAULTS.selectedTabId;
        const categoryId = current[STORAGE_KEYS.selectedCategoryId] || DEFAULTS.selectedCategoryId;
        const metroEnabled =
          typeof current[STORAGE_KEYS.usMetroEnabled] === "boolean"
            ? current[STORAGE_KEYS.usMetroEnabled]
            : DEFAULTS.usMetroEnabled;
        const metroIds = Array.isArray(current[STORAGE_KEYS.usMetroIds])
          ? current[STORAGE_KEYS.usMetroIds]
          : DEFAULTS.usMetroIds;

        await chrome.storage.local.set({
          [STORAGE_KEYS.refreshMinutes]: refreshMinutes,
          [STORAGE_KEYS.sources]: compileSourcesFromPack(pack, {
            tabId,
            categoryId,
            metroEnabled,
            metroIds
          }),
          [STORAGE_KEYS.sourcesPackId]: pack?.pack_id || packId || DEFAULTS.sourcesPackId,
          [STORAGE_KEYS.uiLocale]: uiLocale,
          [STORAGE_KEYS.uiStrings]: uiStrings
        });

        await scheduleAlarm();
        await refreshFeeds({ reason: "reloadSourcesPack" });

        logDev("Sources pack reloaded:", pack?.pack_id, (pack?.sources || []).length);
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});

async function ensureInitialized() {
  const existing = await chrome.storage.local.get([
    STORAGE_KEYS.enabled,
    STORAGE_KEYS.blacklist,
    STORAGE_KEYS.refreshMinutes,
    STORAGE_KEYS.sources,
    STORAGE_KEYS.sourcesPackId,
    STORAGE_KEYS.devMode,
    STORAGE_KEYS.selectedTabId,
    STORAGE_KEYS.selectedCategoryId,
    STORAGE_KEYS.seenMap,
    STORAGE_KEYS.usMetroEnabled,
    STORAGE_KEYS.usMetroIds,
    STORAGE_KEYS.uiLocale,
    STORAGE_KEYS.uiStrings
  ]);

  const needsInit =
    typeof existing[STORAGE_KEYS.enabled] !== "boolean" ||
    !Array.isArray(existing[STORAGE_KEYS.blacklist]) ||
    typeof existing[STORAGE_KEYS.refreshMinutes] !== "number" ||
    !Array.isArray(existing[STORAGE_KEYS.sources]) ||
    typeof existing[STORAGE_KEYS.devMode] !== "boolean" ||
    typeof existing[STORAGE_KEYS.selectedTabId] !== "string" ||
    typeof existing[STORAGE_KEYS.selectedCategoryId] !== "string" ||
    typeof existing[STORAGE_KEYS.uiLocale] !== "string" ||
    !existing[STORAGE_KEYS.uiStrings] || typeof existing[STORAGE_KEYS.uiStrings] !== "object" ||
    (existing[STORAGE_KEYS.seenMap] && typeof existing[STORAGE_KEYS.seenMap] !== "object") ||
    (existing[STORAGE_KEYS.seenMap] && Array.isArray(existing[STORAGE_KEYS.seenMap]));

  const metroPatch = {};
  if (typeof existing[STORAGE_KEYS.usMetroEnabled] !== "boolean") {
    metroPatch[STORAGE_KEYS.usMetroEnabled] = DEFAULTS.usMetroEnabled;
  }
  if (!Array.isArray(existing[STORAGE_KEYS.usMetroIds])) {
    metroPatch[STORAGE_KEYS.usMetroIds] = DEFAULTS.usMetroIds;
  }
  if (Object.keys(metroPatch).length) {
    await chrome.storage.local.set(metroPatch);
  }

  const selectedPackId =
    typeof existing[STORAGE_KEYS.sourcesPackId] === "string"
      ? existing[STORAGE_KEYS.sourcesPackId]
      : DEFAULTS.sourcesPackId;
  const pack = await loadSourcesPack(selectedPackId);
  const { uiStrings, uiLocale } = applyPackSettings(pack);
  const refreshMinutes =
    Number(pack?.default_refresh_minutes) > 0
      ? Number(pack.default_refresh_minutes)
      : DEFAULTS.refreshMinutes;

  const uiPatch = {};
  if (typeof existing[STORAGE_KEYS.uiLocale] !== "string") {
    uiPatch[STORAGE_KEYS.uiLocale] = uiLocale;
  }
  if (!existing[STORAGE_KEYS.uiStrings] || typeof existing[STORAGE_KEYS.uiStrings] !== "object") {
    uiPatch[STORAGE_KEYS.uiStrings] = uiStrings;
  }
  if (Object.keys(uiPatch).length) {
    await chrome.storage.local.set(uiPatch);
  }

  if (!needsInit) return;

  await chrome.storage.local.set({
    [STORAGE_KEYS.enabled]: DEFAULTS.enabled,
    [STORAGE_KEYS.blacklist]: DEFAULTS.blacklist,
    [STORAGE_KEYS.refreshMinutes]: refreshMinutes,
    [STORAGE_KEYS.sources]: compileSourcesFromPack(pack, {
      tabId: DEFAULTS.selectedTabId,
      categoryId: DEFAULTS.selectedCategoryId,
      metroEnabled: DEFAULTS.usMetroEnabled,
      metroIds: DEFAULTS.usMetroIds
    }),
    [STORAGE_KEYS.sourcesPackId]: pack?.pack_id || selectedPackId || DEFAULTS.sourcesPackId,
    [STORAGE_KEYS.devMode]: DEFAULTS.devMode,
    [STORAGE_KEYS.selectedTabId]: DEFAULTS.selectedTabId,
    [STORAGE_KEYS.selectedCategoryId]: DEFAULTS.selectedCategoryId,
    [STORAGE_KEYS.seenMap]: DEFAULTS.seenMap,
    [STORAGE_KEYS.usMetroEnabled]: DEFAULTS.usMetroEnabled,
    [STORAGE_KEYS.usMetroIds]: DEFAULTS.usMetroIds,
    [STORAGE_KEYS.uiLocale]: uiLocale,
    [STORAGE_KEYS.uiStrings]: uiStrings
  });
}


function compileSourcesFromPack(pack, { tabId, categoryId, metroEnabled, metroIds } = {}) {
  // 레거시 포맷: [{id,name,url,category}] 형태면 그대로 사용
  if (Array.isArray(pack?.sources) && pack.sources.length && pack.sources[0]?.url) {
    return pack.sources;
  }

  const tabs = Array.isArray(pack?.tabs) ? pack.tabs : [];
  const catalog = Array.isArray(pack?.sources) ? pack.sources : [];
  const srcMap = new Map(catalog.map((s) => [s.id, s]));
  const hasTabs = tabs.length > 0;

  if (!hasTabs && (Array.isArray(pack?.national_sources) || Array.isArray(pack?.metros))) {
    return compileRegionalSources(pack, { metroEnabled, metroIds });
  }

  if (!hasTabs) return [];

  // ✅ 전체 카테고리 모드: tabId === "all" 이면 모든 탭을 컴파일
  if (tabId === "all") {
    const compiled = [];

    for (const t of tabs) {
      if (!t?.id) continue;
      if (t.id === "opinion") continue; // ✅ 사설/칼럼 완전 제외

      const categories = Array.isArray(t.categories) ? t.categories : [];
      for (const c of categories) {
        // categoryId가 "*"가 아니고 특정 값이면 그 카테고리만
        if (categoryId && categoryId !== "*" && c?.id !== categoryId) continue;

        const refs = Array.isArray(c?.sources) ? c.sources : [];
        for (const ref of refs) {
          const src = srcMap.get(ref.source_id);
          if (!src) continue;

          const feedUrl = src?.feeds?.[ref.feed_key];
          if (!feedUrl) continue;

          compiled.push({
            id: `${src.id}:${ref.feed_key}`,
            name: src.name_ko || src.name_en || src.name_jp || src.id,
            url: feedUrl,
            category: t.id,           // ✅ 기사에 표시될 카테고리(탭 id)
            categoryLabel: t.label || c.label || t.id || c.id,
            feedKey: ref.feed_key,
            sourceId: src.id
          });
        }
      }
    }

    appendMetroSources(compiled, pack, { tabId, categoryId, metroEnabled, metroIds, tabs, srcMap });
    return compiled;
  }

  // ✅ 단일 탭/카테고리 모드(기존)
  const tab = tabs.find((t) => t.id === tabId) || tabs[0];
  const cat = tab?.categories?.find((c) => c.id === categoryId) || tab?.categories?.[0];
  const refs = Array.isArray(cat?.sources) ? cat.sources : [];

  const compiled = [];
  for (const ref of refs) {
    const src = srcMap.get(ref.source_id);
    if (!src) continue;

    const feedUrl = src?.feeds?.[ref.feed_key];
    if (!feedUrl) continue;

    compiled.push({
      id: `${src.id}:${ref.feed_key}`,
      name: src.name_ko || src.name_en || src.name_jp || src.id,
      url: feedUrl,
      category: tab?.id || cat?.id || "etc",
      categoryLabel: tab?.label || cat?.label || tab?.id || cat?.id || "ETC",
      feedKey: ref.feed_key,
      sourceId: src.id
    });
  }

  appendMetroSources(compiled, pack, { tabId, categoryId, metroEnabled, metroIds, tabs, srcMap });
  return compiled;
}

function appendMetroSources(
  compiled,
  pack,
  { tabId, categoryId, metroEnabled, metroIds, tabs, srcMap }
) {
  const enabled = metroEnabled !== false;
  const metros = Array.isArray(pack?.metros) ? pack.metros : [];
  if (!enabled || !metros.length) return;

  const metroCategory = pack?.metro_category || "society";
  const shouldInclude =
    tabId === "all"
      ? (!categoryId || categoryId === "*" || categoryId === metroCategory)
      : (tabId === metroCategory && (!categoryId || categoryId === "*" || categoryId === metroCategory));
  if (!shouldInclude) return;

  const allowIds = resolveMetroIds(metros, metroIds, pack?.default_metros);
  const allowSet = new Set(allowIds);
  const categoryLabels =
    pack?.category_labels && typeof pack.category_labels === "object"
      ? pack.category_labels
      : {};
  const tabLabel = tabs?.find((t) => t?.id === metroCategory)?.label;
  const categoryLabel =
    categoryLabels[metroCategory] || tabLabel || String(metroCategory || "").toUpperCase();
  const existingIds = new Set(compiled.map((c) => c.id));

  for (const metro of metros) {
    if (!metro?.id || !allowSet.has(metro.id)) continue;
    const list = Array.isArray(metro.sources) ? metro.sources : [];
    for (const ref of list) {
      const src = srcMap.get(ref.source_id);
      if (!src) continue;
      const feedKey = ref.feed_key || "top";
      const feedUrl = src?.feeds?.[feedKey];
      if (!feedUrl) continue;
      const id = `${src.id}:${feedKey}`;
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      compiled.push({
        id,
        name: src.name_ko || src.name_en || src.name_jp || src.id,
        url: feedUrl,
        category: metroCategory,
        categoryLabel,
        feedKey,
        sourceId: src.id
      });
    }
  }
}

function compileRegionalSources(pack, { metroEnabled, metroIds } = {}) {
  const catalog = Array.isArray(pack?.sources) ? pack.sources : [];
  const srcMap = new Map(catalog.map((s) => [s.id, s]));
  const compiled = [];
  const categoryLabels =
    pack?.category_labels && typeof pack.category_labels === "object"
      ? pack.category_labels
      : {};
  const nationalCategory = pack?.national_category || "top";
  const metroCategory = pack?.metro_category || "society";
  const labelNational = categoryLabels[nationalCategory] || String(nationalCategory || "").toUpperCase();
  const labelMetro = categoryLabels[metroCategory] || String(metroCategory || "").toUpperCase();

  addRefs(pack?.national_sources, nationalCategory, labelNational);

  const metros = Array.isArray(pack?.metros) ? pack.metros : [];
  const enabled = metroEnabled !== false;
  if (enabled && metros.length) {
    const allowIds = resolveMetroIds(metros, metroIds, pack?.default_metros);
    const allowSet = new Set(allowIds);
    for (const metro of metros) {
      if (!metro?.id || !allowSet.has(metro.id)) continue;
      addRefs(metro.sources, metroCategory, labelMetro);
    }
  }

  return compiled;

  function addRefs(refs, category, categoryLabel) {
    const list = Array.isArray(refs) ? refs : [];
    for (const ref of list) {
      if (!ref?.source_id) continue;
      const src = srcMap.get(ref.source_id);
      if (!src) continue;
      const feedKey = ref.feed_key || "top";
      const feedUrl = src?.feeds?.[feedKey];
      if (!feedUrl) continue;
      compiled.push({
        id: `${src.id}:${feedKey}`,
        name: src.name_ko || src.name_en || src.name_jp || src.id,
        url: feedUrl,
        category,
        categoryLabel,
        feedKey,
        sourceId: src.id
      });
    }
  }
}

function resolveMetroIds(metros, metroIds, defaultMetros) {
  const ids = Array.isArray(metroIds) ? metroIds.filter(Boolean) : [];
  if (ids.length) return ids;

  const defaults = Array.isArray(defaultMetros) ? defaultMetros.filter(Boolean) : [];
  if (defaults.length) return defaults;

  return metros.map((m) => m?.id).filter(Boolean);
}


async function loadSourcesPack(packId) {
  const id = packId || DEFAULTS.sourcesPackId;
  const url = chrome.runtime.getURL(`sources/sources.${id}.json`);
  const res = await fetch(url);
  if (!res.ok) {
    if (id !== DEFAULTS.sourcesPackId) {
      return loadSourcesPack(DEFAULTS.sourcesPackId);
    }
    throw new Error(`Failed to load sources pack: ${res.status}`);
  }
  return await res.json();
}

function normalizeUiStrings(pack) {
  const ui = pack?.ui && typeof pack.ui === "object" ? pack.ui : {};
  const categoryLabels =
    pack?.category_labels && typeof pack.category_labels === "object"
      ? pack.category_labels
      : {};
  const merged = {
    ...DEFAULT_UI_STRINGS,
    ...ui,
    categories: {
      ...DEFAULT_UI_STRINGS.categories,
      ...categoryLabels,
      ...(ui.categories || {})
    }
  };
  const locale =
    typeof ui.locale === "string" && ui.locale
      ? ui.locale
      : (typeof pack?.meta?.locale === "string" ? pack.meta.locale : DEFAULT_UI_LOCALE);
  return { uiStrings: merged, uiLocale: locale };
}

function normalizeStopWord(word) {
  return String(word || "").toLowerCase().trim();
}

function setActiveStopWords(pack) {
  const list = Array.isArray(pack?.stopwords) ? pack.stopwords : [];
  const normalized = list.map(normalizeStopWord).filter(Boolean);
  ACTIVE_STOP_WORDS = new Set(normalized);
}

function applyPackSettings(pack) {
  setActiveStopWords(pack);
  PACK_SETTINGS_READY = true;
  return normalizeUiStrings(pack);
}

async function ensurePackSettingsReady() {
  if (PACK_SETTINGS_READY) return;
  const { [STORAGE_KEYS.sourcesPackId]: packId } = await chrome.storage.local.get([
    STORAGE_KEYS.sourcesPackId
  ]);
  const pack = await loadSourcesPack(packId || DEFAULTS.sourcesPackId);
  const { uiStrings, uiLocale } = applyPackSettings(pack);
  await chrome.storage.local.set({
    [STORAGE_KEYS.uiLocale]: uiLocale,
    [STORAGE_KEYS.uiStrings]: uiStrings
  });
}

async function scheduleAlarm() {
  const { [STORAGE_KEYS.refreshMinutes]: refreshMinutes } =
    await chrome.storage.local.get([STORAGE_KEYS.refreshMinutes]);

  const periodInMinutes = Math.max(5, Number(refreshMinutes) || 7);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes });
}

async function refreshFeeds({ reason }) {
  await ensurePackSettingsReady();
  const state = await chrome.storage.local.get([
    STORAGE_KEYS.enabled,
    STORAGE_KEYS.sources
  ]);

  if (!state[STORAGE_KEYS.enabled]) return;

  const sources = Array.isArray(state[STORAGE_KEYS.sources])
    ? state[STORAGE_KEYS.sources]
    : [];

  if (sources.length === 0) return;

  logDev("Refreshing feeds…", { reason, sources: sources.length });

  const allItems = await fetchAllFeeds(sources, { concurrency: 6 });

  // 최신순 정렬
  allItems.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));

  // 기본 중복 제거(“대충 묶기”): 제목 유사도 + 시간 근접
  const clustered = clusterItems(allItems, {
    timeWindowMs: 90 * 60 * 1000,     // 안전 모드 유지
    similarityThreshold: 0.90,
    minSharedTokens: 2,
    repStrategy: "priority_then_newest" // 대표 기사 선정 기준
  });

  const { [STORAGE_KEYS.seenMap]: seenMapRaw } = await chrome.storage.local.get([
    STORAGE_KEYS.seenMap
  ]);
  const seenMap =
    seenMapRaw && typeof seenMapRaw === "object" && !Array.isArray(seenMapRaw)
      ? seenMapRaw
      : {};

  const { picked: finalItems, nextSeenMap } = selectFinalItems(clustered, {
    limit: 80,
    seenMap
  });

  await chrome.storage.local.set({
    [STORAGE_KEYS.items]: finalItems,
    [STORAGE_KEYS.lastUpdated]: Date.now(),
    [STORAGE_KEYS.seenMap]: nextSeenMap
  });

  logDev("Refresh done. items:", finalItems.length);
}

async function fetchAllFeeds(sources, { concurrency = 6 } = {}) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < sources.length) {
      const cur = sources[idx++];
      try {
        const items = await fetchAndParseFeed(cur);
        for (const it of items) results.push(it);
      } catch (e) {
        logDev("Feed failed:", cur?.name || cur?.id || cur?.url, String(e?.message || e));
      }
    }
  }

  const n = Math.max(1, Math.min(concurrency, sources.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function fetchAndParseFeed(source) {
  const url = source?.url;
  if (!url) return [];

  const fetchedAt = Date.now();

  // 타임아웃 처리
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 12000);

  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    signal: controller.signal,
    headers: { "Cache-Control": "no-cache" }
  }).finally(() => clearTimeout(t));

  if (!res.ok) {
    logDev("Fetch failed:", res.status, url);
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }

  const text = await res.text();
  logDev("Fetched:", source?.name || source?.id || url);

  let parsedItems = [];

  // 1) DOMParser 우선
  if (typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(text, "text/xml");

      const rssItems = Array.from(doc.querySelectorAll("item"));
      const atomEntries = Array.from(doc.querySelectorAll("entry"));

      if (rssItems.length) {
        for (const item of rssItems) {
          const title = safeText(item.querySelector("title"));
          const link = safeText(item.querySelector("link"));
          const description =
            safeText(item.querySelector("description")) ||
            safeText(item.querySelector("summary"));
          const categories = collectCategories(item);
          const pubDate =
            safeText(item.querySelector("pubDate")) ||
            safeText(item.querySelector("dc\\:date"));

          const publishedAt = parseDateToMs(pubDate);
          if (!title || !link) continue;

          parsedItems.push(buildItem({
            title,
            link,
            description,
            categories,
            publishedAt,
            fetchedAt,
            source
          }));
        }
      } else if (atomEntries.length) {
        for (const entry of atomEntries) {
          const title = safeText(entry.querySelector("title"));
          const updated = safeText(entry.querySelector("updated"));
          const published = safeText(entry.querySelector("published"));
          const description = safeText(entry.querySelector("summary"));
          const categories = collectCategories(entry);
          const publishedAt = parseDateToMs(published || updated);

          let link = "";
          const linkEl =
            entry.querySelector('link[rel="alternate"]') || entry.querySelector("link");
          if (linkEl) link = linkEl.getAttribute("href") || "";

          if (!title || !link) continue;
          parsedItems.push(buildItem({
            title,
            link,
            description,
            categories,
            publishedAt,
            fetchedAt,
            source
          }));
        }
      }
    } catch (e) {
      logDev("DOMParser error, fallback:", String(e?.message || e));
    }
  }

  // 2) 그래도 0이면 fallback 파서 시도 (혹은 DOMParser 없는 환경)
  if (parsedItems.length === 0) {
    const fallback = parseFeedFallback(text);
    for (const fi of fallback) {
      const publishedAt = parseDateToMs(fi.pubDate);
      parsedItems.push(buildItem({
        title: fi.title,
        link: fi.link,
        description: fi.description,
        categories: fi.categories,
        publishedAt,
        fetchedAt,
        source
      }));
    }
  }

  logDev("Parsed items:", source?.name || source?.id || url, parsedItems.length);
  return parsedItems;
}

function parseFeedFallback(xmlText) {
  // 최소 RSS/Atom 파서 (정확도보다 "살아남기" 우선)
  const text = String(xmlText || "");

  const out = [];

  // RSS <item>..</item>
  const itemBlocks = text.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  if (itemBlocks.length) {
    for (const blk of itemBlocks) {
      const title = extractTagText(blk, "title");
      const link = extractTagText(blk, "link");
      const pubDate =
        extractTagText(blk, "pubDate") ||
        extractTagText(blk, "dc:date") ||
        extractTagText(blk, "date");
      const description =
        extractTagText(blk, "description") ||
        extractTagText(blk, "summary");
      const categories = [
        ...extractTagTexts(blk, "category"),
        ...extractTagTexts(blk, "tag")
      ];

      if (title && link) out.push({ title, link, pubDate, description, categories });
    }
    return out;
  }

  // Atom <entry>..</entry>
  const entryBlocks = text.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  if (entryBlocks.length) {
    for (const blk of entryBlocks) {
      const title = extractTagText(blk, "title");
      const updated = extractTagText(blk, "updated");
      const published = extractTagText(blk, "published");
      const description = extractTagText(blk, "summary");
      const categories = [
        ...extractTagTexts(blk, "category"),
        ...extractTagTexts(blk, "tag")
      ];

      let link = "";
      const m =
        blk.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i) ||
        blk.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
      if (m) link = decodeEntities(m[1]);

      if (title && link) out.push({ title, link, pubDate: published || updated, description, categories });
    }
  }

  return out;
}

function extractTagText(block, tagName) {
  const re = new RegExp(
    `<${escapeReg(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeReg(tagName)}>`,
    "i"
  );
  const m = block.match(re);
  if (!m) return "";
  return decodeEntities(stripCdata(m[1]).trim());
}

function extractTagTexts(block, tagName) {
  const re = new RegExp(
    `<${escapeReg(tagName)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeReg(tagName)}>`,
    "ig"
  );
  const out = [];
  let m;
  while ((m = re.exec(block))) {
    const val = decodeEntities(stripCdata(m[1]).trim());
    if (val) out.push(val);
  }
  return out;
}

function stripCdata(s) {
  return String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeReg(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function computeSignal(feedKey, title, description, categories) {
  const fk = String(feedKey || "").toLowerCase();
  if (fk === "newsflash") return "breaking";
  if (fk === "headline") return "headline";
  if (fk === "lead") return "";

  // 보조 신호(오탐 적은 것만)
  const catText = Array.isArray(categories) ? categories.join(" ") : String(categories || "");
  const t = `${title || ""} ${description || ""} ${catText}`;
  if (/(속보|긴급|速報|緊急|breaking|urgent)/i.test(t)) return "breaking";
  return "";
}

function buildItem({ title, link, description, categories, publishedAt, fetchedAt, source }) {
  let domain = "";
  try {
    domain = new URL(link).hostname.replace(/^www\./, "");
  } catch {}

  // pubDate 파싱 실패(0)면 '방금'으로 만들지 말고 0으로 둔다 (특정 매체 독식 방지)
  const ts = Number.isFinite(publishedAt) && publishedAt > 0 ? publishedAt : 0;
  const desc = cleanSnippet(description);
  const cats = Array.isArray(categories) ? categories.filter(Boolean) : [];

  const signal = computeSignal(source?.feedKey, title, desc, cats);
  const isImportant = signal === "headline" || signal === "breaking";

  return {
    id: hashString(`${source?.sourceId || source?.id || ""}|${source?.feedKey || ""}|${title}|${link}`),
    title: String(title || "").trim(),
    link,

    // ✅ 신문사 단위
    sourceId: source?.sourceId || "",
    sourceName: source?.name || domain || "Unknown",
    domain,

    // ✅ 카테고리(탭 id)
    category: source?.category || "",
    categoryLabel: source?.categoryLabel || source?.category || "",

    // ✅ 원문 발행 시각 / 가져온 시각
    publishedAt: ts,
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : Date.now(),

    // ✅ 피드/시그널
    feedKey: source?.feedKey || "",
    signal,
    isImportant,

    // ✅ 본문/요약(있으면)
    description: desc,
    categories: cats
  };
}

// ===== 연관 기사 계산 =====
function clusterItems(items, { timeWindowMs } = {}) {
  const list = Array.isArray(items) ? items.slice() : [];
  const out = list.map((it) => {
    const rep = { ...it };
    rep.clusterCount = 1;
    rep.clusterSources = [rep.sourceName || rep.domain || "NEWS"];
    rep.clusterMembers = [];
    rep.publishedAt = rep.publishedAt || Date.now();
    return rep;
  });

  // 연관 기사 계산: 제목+본문 공통 토큰 4개 이상(+선택적 시간 창)
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    const members = [];
    for (let j = 0; j < out.length; j++) {
      if (i === j) continue;
      const b = out[j];
      if (!a.link || !b.link) continue;
      if (timeWindowMs && Math.abs((a.publishedAt || 0) - (b.publishedAt || 0)) > timeWindowMs) continue;

      const titleSharedTokens = sharedTitleTokens(a.title, b.title);
      const descSharedTokens = sharedDescriptionTokens(a.description, b.description);
      if (!(titleSharedTokens.length >= 4 || descSharedTokens.length >= 10)) continue;

      const sharedTokens = [];
      for (const t of titleSharedTokens) {
        if (sharedTokens.length >= 6) break;
        sharedTokens.push(t);
      }
      if (sharedTokens.length < 6) {
        for (const t of descSharedTokens) {
          if (sharedTokens.length >= 6) break;
          if (!sharedTokens.includes(t)) sharedTokens.push(t);
        }
      }

      members.push({
        id: b.id,
        title: b.title || "",
        link: b.link,
        sourceName: b.sourceName || b.domain || "",
        domain: b.domain || "",
        category: b.category || "",
        categoryLabel: b.categoryLabel || b.category || "",
        signal: b.signal || "",
        publishedAt: b.publishedAt || 0,
        fetchedAt: b.fetchedAt || 0,
        sharedTokens
      });
      if (members.length >= 8) break;
    }
    a.clusterMembers = members;

    const srcSet = new Set(members.map((m) => m.sourceName || m.domain).filter(Boolean));
    if (a.sourceName) srcSet.add(a.sourceName);
    a.clusterSources = Array.from(srcSet).slice(0, 12);
    a.clusterCount = Math.max(1, members.length + 1);
  }

  out.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  return out;
}

// ===== 스코어링 + 노출 믹서(테스트용) =====
const SCORE_CFG = {
  recencyWindowMs: 6 * 60 * 60 * 1000,  // 최근 6시간
  recencyMax: 60,                       // 0~60점
  headlineBonus: 12,                    // 헤드라인
  leadBonus: 0,                         // 리드(보너스 없음)
  breakingBonus: 35,                    // 속보
  clusterUnit: 8,                       // (N-1)*8
  clusterMax: 40,                       // 최대 +40
  seenWindowMs: 20 * 60 * 1000,         // 20분
  seenPenalty: 50,                      // 최근 본 기사 -50
  seenPenaltyReduced: 20,               // 중요/클러스터 큰 건 -20만
  sourceSaturationStart: 6,             // 6개부터 쏠림 감점
  sourcePenaltyMin: 10,
  sourcePenaltyStep: 10,
  sourcePenaltyMax: 30,
  maxPerSource: 10,                     // 하드 캡
  clusterExtraPerSource: 3,             // 클러스터(×2+)는 +3개까지 허용
  phase1ClusterTarget: 40,              // 먼저 클러스터를 최대 40개까지 우선 채움
  scanTopKPerCategory: 25,              // 각 카테고리에서 상위 K개를 보고 최적 선택
  seenKeepMs: 24 * 60 * 60 * 1000       // seenMap 보관 24h
};

function getItemTimeMs(it) {
  const p = Number(it?.publishedAt || 0);
  if (Number.isFinite(p) && p > 0) return p;
  const f = Number(it?.fetchedAt || 0);
  return Number.isFinite(f) && f > 0 ? f : 0;
}

function recencyScore(it, now) {
  const t = getItemTimeMs(it);
  if (!t) return 0;
  const age = Math.max(0, now - t);
  if (age >= SCORE_CFG.recencyWindowMs) return 0;
  const ratio = 1 - age / SCORE_CFG.recencyWindowMs;
  return SCORE_CFG.recencyMax * ratio;
}

function clusterBonus(it) {
  const n = Math.max(1, Number(it?.clusterCount || 1));
  const bonus = Math.max(0, (n - 1) * SCORE_CFG.clusterUnit);
  return Math.min(SCORE_CFG.clusterMax, bonus);
}

function seenPenalty(it, now, seenMap) {
  const id = it?.id;
  if (!id || !seenMap) return 0;
  const last = Number(seenMap[id] || 0);
  if (!Number.isFinite(last) || last <= 0) return 0;
  const dt = now - last;
  if (dt < 0 || dt > SCORE_CFG.seenWindowMs) return 0;

  const n = Math.max(1, Number(it?.clusterCount || 1));
  const importantLike = it?.signal === "headline" || it?.signal === "breaking";
  const reduced = importantLike || n >= 3;
  return -(reduced ? SCORE_CFG.seenPenaltyReduced : SCORE_CFG.seenPenalty);
}

function baseScore(it, now, seenMap) {
  let important = 0;
  if (it?.signal === "headline") important = SCORE_CFG.headlineBonus;
  else if (it?.signal === "lead") important = SCORE_CFG.leadBonus;
  else if (it?.signal === "breaking") important = SCORE_CFG.breakingBonus;

  const s =
    recencyScore(it, now) +
    important +
    clusterBonus(it) +
    seenPenalty(it, now, seenMap);

  return Math.round(s);
}

function sourceSaturationPenalty(selectedCount) {
  const c = Number(selectedCount || 0);
  if (c < SCORE_CFG.sourceSaturationStart) return 0;
  const steps = c - SCORE_CFG.sourceSaturationStart;
  const pen = SCORE_CFG.sourcePenaltyMin + steps * SCORE_CFG.sourcePenaltyStep;
  return Math.min(SCORE_CFG.sourcePenaltyMax, pen);
}

function pruneSeenMap(seenMap, now) {
  const out = {};
  const cutoff = now - SCORE_CFG.seenKeepMs;
  for (const [k, v] of Object.entries(seenMap || {})) {
    const t = Number(v || 0);
    if (Number.isFinite(t) && t >= cutoff) out[k] = t;
  }
  return out;
}

function selectFinalItems(items, { limit = 80, seenMap = {} } = {}) {
  const now = Date.now();
  const prunedSeen = pruneSeenMap(seenMap, now);

  // 1) 스코어 계산(대표 기사 기준)
  const scored = (Array.isArray(items) ? items : []).map((it) => {
    const s = baseScore(it, now, prunedSeen);
    return { ...it, score: s, _base: s };
  });

  // (안전) 최신 우선 정렬은 유지하되 스코어 우선
  scored.sort((a, b) => (b._base - a._base) || (getItemTimeMs(b) - getItemTimeMs(a)));

  const clusterPool = scored.filter((x) => Number(x.clusterCount || 1) >= 2);
  const allPool = scored;

  const picked = [];
  const pickedIds = new Set();
  const perSource = new Map();

  function canPick(it) {
    const sid = it?.sourceId || "unknown";
    const n = perSource.get(sid) || 0;
    const cap = SCORE_CFG.maxPerSource + (Number(it.clusterCount || 1) >= 2 ? SCORE_CFG.clusterExtraPerSource : 0);
    return n < cap;
  }

  function markPick(it, effScore) {
    const sid = it?.sourceId || "unknown";
    perSource.set(sid, (perSource.get(sid) || 0) + 1);
    it.score = Math.round(effScore);
    picked.push(it);
    pickedIds.add(it.id);
  }

  function buildBuckets(pool) {
    const buckets = new Map();
    for (const it of pool) {
      if (!it?.id) continue;
      if (pickedIds.has(it.id)) continue;
      const c = it.category || "etc";
      if (!buckets.has(c)) buckets.set(c, []);
      buckets.get(c).push(it);
    }
    // 각 버킷은 base 스코어 순
    for (const arr of buckets.values()) {
      arr.sort((a, b) => (b._base - a._base) || (getItemTimeMs(b) - getItemTimeMs(a)));
    }

    const cats = Array.from(buckets.keys());
    cats.sort((a, b) => {
      const ta = getItemTimeMs(buckets.get(a)?.[0]) || 0;
      const tb = getItemTimeMs(buckets.get(b)?.[0]) || 0;
      return tb - ta;
    });

    return { buckets, cats };
  }

  function pickRoundRobin(pool, targetCount) {
    const { buckets, cats } = buildBuckets(pool);

    while (picked.length < targetCount) {
      let progressed = false;

      for (const c of cats) {
        const arr = buckets.get(c);
        if (!arr || arr.length === 0) continue;

        // 상위 K개만 스캔해서 "현재 쏠림"까지 반영한 최적 후보를 고른다
        let bestIdx = -1;
        let bestEff = -Infinity;

        const scanN = Math.min(SCORE_CFG.scanTopKPerCategory, arr.length);
        for (let i = 0; i < scanN; i++) {
          const it = arr[i];
          if (!it || pickedIds.has(it.id)) continue;
          if (!canPick(it)) continue;

          const sid = it.sourceId || "unknown";
          const cnt = perSource.get(sid) || 0;
          const eff = it._base - sourceSaturationPenalty(cnt);

          if (eff > bestEff) {
            bestEff = eff;
            bestIdx = i;
          }
        }

        if (bestIdx === -1) continue;

        const chosen = arr.splice(bestIdx, 1)[0];
        markPick(chosen, bestEff);
        progressed = true;

        if (picked.length >= targetCount) break;
      }

      if (!progressed) break;
    }
  }

  // 2) 1차: 클러스터(×2+) 우선 노출
  const phase1Target = Math.min(limit, SCORE_CFG.phase1ClusterTarget);
  pickRoundRobin(clusterPool, phase1Target);

  // 3) 2차: 전체 풀에서 나머지 채우기
  pickRoundRobin(allPool, limit);

  // 4) 최종 limit
  const final = picked.slice(0, limit).map((it) => {
    const out = { ...it };
    delete out._base;
    return out;
  });

  // 5) 다음 seenMap 갱신: 선택된 기사들을 "본 것"으로 처리
  const nextSeenMap = { ...prunedSeen };
  for (const it of final) {
    if (it?.id) nextSeenMap[it.id] = now;
  }

  return { picked: final, nextSeenMap };
}

function tokenizeTitle(title) {
  // normalizeTitle는 기존 함수 그대로 사용 (이미 특수문자/태그 제거함)
  const s = normalizeTitle(title);
  const tokens = s.split(" ").map((t) => t.trim()).filter(Boolean);

  return tokens
    .filter((t) => t.length >= 2)     // 1글자 토큰은 노이즈가 많음
    .filter((t) => !ACTIVE_STOP_WORDS.has(t));
}

function sharedTokenCount(a, b) {
  const A = new Set(tokenizeTitle(a));
  const B = new Set(tokenizeTitle(b));
  let c = 0;
  for (const x of A) if (B.has(x)) c++;
  return c;
}


function sharedTitleTokens(a, b) {
  const A = new Set(tokenizeTitle(a));
  const B = new Set(tokenizeTitle(b));
  const out = [];
  for (const x of A) if (B.has(x)) out.push(x);
  return out;
}

function sharedDescriptionTokens(a, b) {
  const A = new Set(tokenizeContent(a));
  const B = new Set(tokenizeContent(b));
  const out = [];
  for (const x of A) if (B.has(x)) out.push(x);
  return out;
}

function normalizeTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, " ")
    .replace(/(단독|속보|종합|인터뷰|기획|분석)\b/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeContent(s) {
  const txt = normalizeTitle(s);
  return txt
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 2)
    .filter((t) => !ACTIVE_STOP_WORDS.has(t));
}

function safeText(el) {
  if (!el) return "";
  return (el.textContent || "").trim();
}

function collectCategories(node) {
  if (!node || typeof node.querySelectorAll !== "function") return [];
  const out = [];
  const cats = Array.from(node.querySelectorAll("category"));
  for (const c of cats) {
    const term = c.getAttribute?.("term");
    const text = safeText(c);
    const val = (term || text || "").trim();
    if (val) out.push(val);
  }
  const tags = Array.from(node.querySelectorAll("tag"));
  for (const t of tags) {
    const text = safeText(t).trim();
    if (text) out.push(text);
  }
  return out;
}

function parseDateToMs(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function cleanSnippet(raw) {
  const s = String(raw || "");
  if (!s) return "";
  const noCdata = stripCdata(s);
  const noTags = noCdata.replace(/<[^>]+>/g, " ");
  const decoded = decodeEntities(noTags);
  const normalized = decoded.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 600);
}
