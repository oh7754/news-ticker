// popup.js

const DEFAULT_PACK = "kr";

const packSelect = document.getElementById("pack-select");
const btnSave = document.getElementById("btn-save");
const btnRefresh = document.getElementById("btn-refresh");
const toggleVisible = document.getElementById("toggle-visible");
const status = document.getElementById("status");

function setStatus(msg, type = "") {
  status.textContent = msg;
  status.className = "status " + type;
  if (msg) setTimeout(() => { status.textContent = ""; status.className = "status"; }, 3000);
}

// 초기 로드
chrome.storage.sync.get({ pack: DEFAULT_PACK }, data => {
  packSelect.value = data.pack;
});

chrome.storage.local.get({ tickerHidden: false }, ({ tickerHidden }) => {
  toggleVisible.checked = !tickerHidden;
});

// 저장
btnSave.onclick = () => {
  chrome.storage.sync.set({ pack: packSelect.value }, () => {
    setStatus("저장 완료!", "ok");
    // background에 새로고침 요청
    chrome.runtime.sendMessage({ type: "REFRESH" });
  });
};

// 새로고침
btnRefresh.onclick = () => {
  setStatus("새로고침 중...");
  chrome.runtime.sendMessage({ type: "REFRESH" }, () => {
    setStatus("완료!", "ok");
  });
};

// 티커 표시/숨기기
toggleVisible.onchange = () => {
  const show = toggleVisible.checked;
  chrome.storage.local.set({ tickerHidden: !show });
  // 현재 탭에 메시지 전송
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: show ? "SHOW_TICKER" : "HIDE_TICKER"
      });
    }
  });
};
