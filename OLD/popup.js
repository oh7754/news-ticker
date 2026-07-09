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
  statusCurrentHost: "Current: {host}"
};

let uiStrings = { ...DEFAULT_UI_STRINGS };
let uiLocale = DEFAULT_UI_LOCALE;

document.addEventListener("DOMContentLoaded", async () => {
  const toggle = document.getElementById("toggleEnabled");
  const statusLine = document.getElementById("statusLine");
  const btnToggleSite = document.getElementById("btnToggleSite");
  const btnRefresh = document.getElementById("btnRefresh");
  const blacklistEl = document.getElementById("blacklist");
  const toggleDevMode = document.getElementById("toggleDevMode");
  const btnReloadSources = document.getElementById("btnReloadSources");
  const toggleDockBottom = document.getElementById("toggleDockBottom");
  const toggleHideOnScroll = document.getElementById("toggleHideOnScroll");
  const selectCountry = document.getElementById("selectCountry");
  const usMetroSection = document.getElementById("usMetroSection");
  const toggleUsMetroEnabled = document.getElementById("toggleUsMetroEnabled");
  const usMetroList = document.getElementById("usMetroList");
  const toggleMetroAccordion = document.getElementById("toggleMetroAccordion");
  const usMetroBody = document.getElementById("usMetroBody");
  let usMetroExpanded = false;

  const state = await chrome.storage.local.get([
    "enabled",
    "blacklist",
    "lastUpdated",
    "devMode",
    "dockBottom",
    "hideOnScroll",
    "sourcesPackId",
    "usMetroEnabled",
    "usMetroIds",
    "usMetroExpanded",
    "uiStrings",
    "uiLocale"
  ]);

  applyUiStrings(state.uiStrings, state.uiLocale);
  applyUiToPopup();

  toggle.checked = state.enabled !== false;
  if (toggleDevMode) toggleDevMode.checked = state.devMode === true;
  if (toggleDockBottom) toggleDockBottom.checked = state.dockBottom === true;
  if (toggleHideOnScroll) toggleHideOnScroll.checked = state.hideOnScroll === true;
  if (toggleUsMetroEnabled) toggleUsMetroEnabled.checked = state.usMetroEnabled !== false;
  if (toggleMetroAccordion && usMetroBody) {
    usMetroExpanded = state.usMetroExpanded === true;
    setMetroExpanded(usMetroExpanded);
  }
  if (selectCountry) selectCountry.value = state.sourcesPackId || "kr";

  const currentHost = await getActiveTabHostname();
  renderStatus(statusLine, state.lastUpdated, currentHost);

  await renderBlacklist(blacklistEl);
  let usPackCache = null;

  async function loadUsPack() {
    if (usPackCache) return usPackCache;
    try {
      const res = await fetch(chrome.runtime.getURL("sources/sources.us.json"));
      if (!res.ok) return null;
      usPackCache = await res.json();
      return usPackCache;
    } catch {
      return null;
    }
  }

  function resolveUsMetroSelection(pack, selectedIds) {
    const current = Array.isArray(selectedIds) ? selectedIds.filter(Boolean) : [];
    if (current.length) return current;
    const defaults = Array.isArray(pack?.default_metros) ? pack.default_metros.filter(Boolean) : [];
    if (defaults.length) return defaults;
    const metros = Array.isArray(pack?.metros) ? pack.metros : [];
    return metros.map((m) => m?.id).filter(Boolean);
  }

  async function refreshUsMetroSection(packIdOverride) {
    if (!usMetroSection || !toggleUsMetroEnabled || !usMetroList) return;
    const packId = packIdOverride || selectCountry?.value || state.sourcesPackId || "kr";
    if (packId !== "us") {
      usMetroSection.hidden = true;
      return;
    }

    const pack = await loadUsPack();
    if (!pack) {
      usMetroSection.hidden = true;
      return;
    }

    usMetroSection.hidden = false;
    setMetroExpanded(usMetroExpanded);

    const stored = await chrome.storage.local.get(["usMetroEnabled", "usMetroIds"]);
    const enabled = stored.usMetroEnabled !== false;
    let selectedIds = Array.isArray(stored.usMetroIds) ? stored.usMetroIds : [];

    if (!selectedIds.length) {
      selectedIds = resolveUsMetroSelection(pack, selectedIds);
      await chrome.storage.local.set({ usMetroIds: selectedIds });
    }

    toggleUsMetroEnabled.checked = enabled;
    renderUsMetroList(pack, selectedIds, enabled);
  }

  function renderUsMetroList(pack, selectedIds, enabled) {
    if (!usMetroList) return;
    usMetroList.innerHTML = "";

    const metros = Array.isArray(pack?.metros) ? pack.metros : [];
    const selected = new Set(selectedIds || []);

    for (const metro of metros) {
      if (!metro?.id) continue;
      const row = document.createElement("label");
      row.className = `metroItem${enabled ? "" : " disabled"}`;

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(metro.id);
      input.disabled = !enabled;

      input.addEventListener("change", async () => {
        const stored = await chrome.storage.local.get(["usMetroIds"]);
        const current = resolveUsMetroSelection(pack, stored.usMetroIds);
        const next = new Set(current);
        if (input.checked) next.add(metro.id);
        else next.delete(metro.id);
        const nextIds = Array.from(next);
        await chrome.storage.local.set({ usMetroIds: nextIds });
        if ((selectCountry?.value || state.sourcesPackId) === "us") {
          await chrome.runtime.sendMessage({ type: "RELOAD_SOURCES_PACK", packId: "us" });
        }
        renderUsMetroList(pack, nextIds, enabled);
      });

      const label = document.createElement("span");
      label.textContent = metro.label || metro.id;

      row.appendChild(input);
      row.appendChild(label);
      usMetroList.appendChild(row);
    }
  }

  await refreshUsMetroSection(state.sourcesPackId);

  if (toggleMetroAccordion) {
    toggleMetroAccordion.addEventListener("click", async () => {
      usMetroExpanded = !usMetroExpanded;
      setMetroExpanded(usMetroExpanded);
      await chrome.storage.local.set({ usMetroExpanded });
    });
  }

  // enabled 토글
  toggle.addEventListener("change", async () => {
    await chrome.storage.local.set({ enabled: toggle.checked });
    const st = await chrome.storage.local.get(["lastUpdated"]);
    const host = await getActiveTabHostname();
    renderStatus(statusLine, st.lastUpdated, host);
  });

  // 이 사이트 숨기기/해제
  btnToggleSite.addEventListener("click", async () => {
    const host = await getActiveTabHostname();
    if (!host) return;

    const { blacklist } = await chrome.storage.local.get(["blacklist"]);
    const list = Array.isArray(blacklist) ? blacklist : [];

    const idx = list.indexOf(host);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(host);

    await chrome.storage.local.set({ blacklist: list });
    await renderBlacklist(blacklistEl);

    const st = await chrome.storage.local.get(["lastUpdated"]);
    renderStatus(statusLine, st.lastUpdated, host);
    await updateToggleSiteButton(btnToggleSite, host);
  });

  // 강제 새로고침
  btnRefresh.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "FORCE_REFRESH" });
    const st = await chrome.storage.local.get(["lastUpdated"]);
    const host = await getActiveTabHostname();
    renderStatus(statusLine, st.lastUpdated, host);
  });

  // DEV: 디버그 로그 토글
  if (toggleDevMode) {
    toggleDevMode.addEventListener("change", async () => {
      await chrome.storage.local.set({ devMode: toggleDevMode.checked });
    });
  }

  // 위치: 하단 도킹
  if (toggleDockBottom) {
    toggleDockBottom.addEventListener("change", async () => {
      await chrome.storage.local.set({ dockBottom: toggleDockBottom.checked });
    });
  }

  if (toggleHideOnScroll) {
    toggleHideOnScroll.addEventListener("change", async () => {
      await chrome.storage.local.set({ hideOnScroll: toggleHideOnScroll.checked });
    });
  }

  if (toggleUsMetroEnabled) {
    toggleUsMetroEnabled.addEventListener("change", async () => {
      await chrome.storage.local.set({ usMetroEnabled: toggleUsMetroEnabled.checked });
      await refreshUsMetroSection(selectCountry?.value);
      if ((selectCountry?.value || state.sourcesPackId) === "us") {
        await chrome.runtime.sendMessage({ type: "RELOAD_SOURCES_PACK", packId: "us" });
      }
    });
  }

  // DEV: 소스팩 리로드 (sources/sources.kr.json -> storage 덮어쓰기)
  if (btnReloadSources) {
    btnReloadSources.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({ type: "RELOAD_SOURCES_PACK" });
      const st = await chrome.storage.local.get(["lastUpdated"]);
      const host = await getActiveTabHostname();
      renderStatus(statusLine, st.lastUpdated, host);
    });
  }

  if (selectCountry) {
    selectCountry.addEventListener("change", async () => {
      const packId = selectCountry.value;
      await chrome.storage.local.set({ sourcesPackId: packId });
      await chrome.runtime.sendMessage({ type: "RELOAD_SOURCES_PACK", packId });
      const st = await chrome.storage.local.get(["lastUpdated"]);
      const host = await getActiveTabHostname();
      renderStatus(statusLine, st.lastUpdated, host);
      await refreshUsMetroSection(packId);
    });
  }

  // 초기 버튼 라벨 갱신
  await updateToggleSiteButton(btnToggleSite, currentHost);

  // blacklist 변경 반영
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.blacklist) {
      await renderBlacklist(blacklistEl);
      const host = await getActiveTabHostname();
      await updateToggleSiteButton(btnToggleSite, host);
    }
    if (changes.lastUpdated) {
      const host = await getActiveTabHostname();
      renderStatus(statusLine, changes.lastUpdated.newValue, host);
    }
    if (changes.uiStrings || changes.uiLocale) {
      applyUiStrings(changes.uiStrings?.newValue, changes.uiLocale?.newValue);
      applyUiToPopup();
      const host = await getActiveTabHostname();
      renderStatus(statusLine, changes.lastUpdated?.newValue, host);
      await updateToggleSiteButton(btnToggleSite, host);
      await renderBlacklist(blacklistEl);
    }
    if (changes.devMode && toggleDevMode) {
      toggleDevMode.checked = changes.devMode.newValue === true;
    }
    if (changes.dockBottom && toggleDockBottom) {
      toggleDockBottom.checked = changes.dockBottom.newValue === true;
    }
    if (changes.hideOnScroll && toggleHideOnScroll) {
      toggleHideOnScroll.checked = changes.hideOnScroll.newValue === true;
    }
    if (changes.sourcesPackId && selectCountry) {
      selectCountry.value = changes.sourcesPackId.newValue || "kr";
      await refreshUsMetroSection(changes.sourcesPackId.newValue);
    }
    if (changes.usMetroExpanded) {
      usMetroExpanded = changes.usMetroExpanded.newValue === true;
      setMetroExpanded(usMetroExpanded);
    }
    if (changes.usMetroEnabled && toggleUsMetroEnabled) {
      toggleUsMetroEnabled.checked = changes.usMetroEnabled.newValue !== false;
      await refreshUsMetroSection(selectCountry?.value);
    }
    if (changes.usMetroIds) {
      await refreshUsMetroSection(selectCountry?.value);
    }
  });
});

async function getActiveTabHostname() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";
    if (!url.startsWith("http")) return "";
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return "";
  }
}

function renderStatus(el, lastUpdated, host) {
  const t = Number(lastUpdated || 0);
  const timeStr = t
    ? new Intl.DateTimeFormat(uiLocale || DEFAULT_UI_LOCALE, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      }).format(new Date(t))
    : "—";

  const base = formatTemplate(uiStrings.statusLastUpdated, { time: timeStr });
  if (!host) {
    el.textContent = base;
    return;
  }
  const hostText = formatTemplate(uiStrings.statusCurrentHost, { host });
  el.textContent = `${base} · ${hostText}`;
}

async function renderBlacklist(container) {
  const { blacklist } = await chrome.storage.local.get(["blacklist"]);
  const list = Array.isArray(blacklist) ? blacklist : [];

  container.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = uiStrings.noHiddenSites;
    container.appendChild(empty);
    return;
  }

  for (const host of list) {
    const row = document.createElement("div");
    row.className = "item";

    const label = document.createElement("div");
    label.textContent = host;

    const btn = document.createElement("button");
    btn.textContent = uiStrings.unhideButton;
    btn.addEventListener("click", async () => {
      const { blacklist } = await chrome.storage.local.get(["blacklist"]);
      const cur = Array.isArray(blacklist) ? blacklist : [];
      const next = cur.filter((h) => h !== host);
      await chrome.storage.local.set({ blacklist: next });
    });

    row.appendChild(label);
    row.appendChild(btn);
    container.appendChild(row);
  }
}

async function updateToggleSiteButton(btn, host) {
  if (!host) {
    btn.textContent = uiStrings.hideSite;
    btn.disabled = true;
    btn.style.opacity = "0.6";
    return;
  }

  btn.disabled = false;
  btn.style.opacity = "1";

  const { blacklist } = await chrome.storage.local.get(["blacklist"]);
  const list = Array.isArray(blacklist) ? blacklist : [];
  const hidden = list.includes(host);

  btn.textContent = hidden ? uiStrings.unhideSite : uiStrings.hideSite;
}

function applyUiStrings(nextStrings, nextLocale) {
  const incoming = nextStrings && typeof nextStrings === "object" ? nextStrings : {};
  uiStrings = {
    ...DEFAULT_UI_STRINGS,
    ...incoming
  };
  if (typeof nextLocale === "string" && nextLocale) {
    uiLocale = nextLocale;
  } else if (typeof incoming.locale === "string" && incoming.locale) {
    uiLocale = incoming.locale;
  } else {
    uiLocale = DEFAULT_UI_LOCALE;
  }
}

function applyUiToPopup() {
  setText("appTitle", uiStrings.appName);
  document.title = uiStrings.appName;
  setText("sectionCountryTitle", uiStrings.sectionCountry);
  setText("sectionTickerTitle", uiStrings.sectionTickerPosition);
  setText("toggleDockBottomLabel", uiStrings.toggleDockBottom);
  setText("toggleHideOnScrollLabel", uiStrings.toggleHideOnScroll);
  setText("sectionHiddenTitle", uiStrings.sectionHiddenSites);
  setText("devSectionTitle", uiStrings.devSection);
  setText("toggleDevModeLabel", uiStrings.devLogs);
  setText("metroSectionTitle", uiStrings.metroSection);
  setAriaLabel("toggleUsMetroEnabled", uiStrings.metroEnabled);
  setText("btnRefresh", uiStrings.refresh);
  setText("btnReloadSources", uiStrings.reloadSources);
  setHtml("devHint", uiStrings.devHint);
  setHtml("sourcesHint", uiStrings.sourcesHint);
  setTitle("toggleMetroAccordion", uiStrings.metroToggle);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text ?? "";
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = html ?? "";
}

function setTitle(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const value = text ?? "";
  el.title = value;
  el.setAttribute("aria-label", value);
}

function setAriaLabel(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  const value = text ?? "";
  el.setAttribute("aria-label", value);
  el.title = value;
}

function formatTemplate(template, vars) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(vars?.[key] ?? ""));
}

function setMetroExpanded(expanded) {
  const body = document.getElementById("usMetroBody");
  const toggle = document.getElementById("toggleMetroAccordion");
  if (!body || !toggle) return;
  body.classList.toggle("collapsed", !expanded);
  toggle.classList.toggle("expanded", expanded);
  toggle.setAttribute("aria-expanded", String(expanded));
}
