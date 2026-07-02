/* Content script: extracts channel info and enforces whitelist on YouTube video pages. */

/* global parseChannelKey, isYouTubeVideoUrl, webext */

let lastHref = "";
let pendingTimer = null;
let lastCheckSignature = "";
let retryAttempts = 0;
let retryExpectedVideoId = "";
let retryObserver = null;

const RETRY_MAX_ATTEMPTS = 12;
const RETRY_BASE_DELAY_MS = 140;
const RETRY_MAX_DELAY_MS = 900;

async function sendCheck(url, channelKey, channelName) {
  const signature = `${url}|${channelKey || ""}`;
  if (signature === lastCheckSignature) return null;
  lastCheckSignature = signature;
  return webext.runtimeSendMessage({ type: "youtube.check", url, channelKey, channelName, source: "content-script" });
}

function clearPendingRetryTimer() {
  if (!pendingTimer) return;
  window.clearTimeout(pendingTimer);
  pendingTimer = null;
}

function stopRetry() {
  clearPendingRetryTimer();
  retryAttempts = 0;
  retryExpectedVideoId = "";
  if (retryObserver) {
    retryObserver.disconnect();
    retryObserver = null;
  }
}

function nextRetryDelay(attempt) {
  const growth = Math.floor((attempt - 1) / 2);
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** growth));
}

function ensureRetryObserver() {
  if (retryObserver || !window.MutationObserver) return;
  const root = document.documentElement;
  if (!root) return;

  retryObserver = new MutationObserver(() => {
    if (!pendingTimer) return;
    clearPendingRetryTimer();
    pendingTimer = window.setTimeout(() => {
      pendingTimer = null;
      void checkNow({ allowRetry: true, expectedVideoId: retryExpectedVideoId || undefined });
    }, 60);
  });

  retryObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "video-id"]
  });
}

function videoIdFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (/(^|\.)youtube\.com$/.test(url.hostname) || /(^|\.)youtube-nocookie\.com$/.test(url.hostname)) {
      if (url.pathname === "/watch") return url.searchParams.get("v") || "";
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || "";
      if (url.pathname.startsWith("/embed/")) return url.pathname.split("/")[2] || "";
      if (url.pathname.startsWith("/live/")) return url.pathname.split("/")[2] || "";
      return "";
    }

    if (url.hostname === "youtu.be") {
      return url.pathname.replace(/^\//, "");
    }

    return "";
  } catch {
    return "";
  }
}

function renderedVideoId() {
  // Watch pages
  const watch = document.querySelector("ytd-watch-flexy[video-id]");
  if (watch && watch.getAttribute) {
    const id = watch.getAttribute("video-id") || "";
    if (id) return id;
  }

  // Shorts pages (best-effort)
  const shortsActive = document.querySelector("ytd-reel-video-renderer[is-active][video-id]");
  if (shortsActive && shortsActive.getAttribute) {
    const id = shortsActive.getAttribute("video-id") || "";
    if (id) return id;
  }

  const shortsAny = document.querySelector("ytd-reel-video-renderer[video-id]");
  if (shortsAny && shortsAny.getAttribute) {
    const id = shortsAny.getAttribute("video-id") || "";
    if (id) return id;
  }

  return "";
}

function findChannelAnchor() {
  // IMPORTANT: only look in the video owner/header area.
  // Do NOT scan arbitrary links on the page (sidebar/comments), otherwise we may
  // accidentally read a channel link that is not the currently playing video.
  const selectors = [
    // Watch
    "ytd-video-owner-renderer a.yt-simple-endpoint[href]",
    "#owner #channel-name a.yt-simple-endpoint[href]",
    "#owner a.yt-simple-endpoint[href^='/@']",
    "#owner a.yt-simple-endpoint[href^='/channel/']",

    // Shorts (best-effort)
    "ytd-reel-player-overlay-renderer a[href^='/@']",
    "ytd-reel-player-overlay-renderer a[href^='/channel/']"
  ];

  for (const sel of selectors) {
    const a = document.querySelector(sel);
    if (a && a.getAttribute) {
      const href = a.getAttribute("href") || "";
      if (href.startsWith("/@") || href.startsWith("/channel/") || href.startsWith("https://www.youtube.com/@") || href.startsWith("https://www.youtube.com/channel/")) {
        return a;
      }
    }
  }
  return null;
}

function extractChannelInfo() {
  const anchor = findChannelAnchor();
  if (!anchor) return null;

  const href = anchor.getAttribute("href") || "";
  const channelKey = parseChannelKey(href);
  const channelName = (anchor.textContent || "").trim();

  if (!channelKey) return null;
  return { channelKey, channelName };
}

async function checkNow({ allowRetry, expectedVideoId }) {
  const url = String(window.location.href || "");
  if (!isYouTubeVideoUrl(url)) return;

  // Embedded players may not expose channel owner markup; let background resolve via URL.
  if (url.includes("/embed/")) {
    const resp = await sendCheck(url, "", "");
    if (resp?.redirectUrl) window.location.replace(String(resp.redirectUrl));
    stopRetry();
    return;
  }

  // Ensure the DOM has switched to the new video before trusting extracted channel.
  if (expectedVideoId) {
    const rendered = renderedVideoId();
    if (!rendered) {
      if (allowRetry) {
        scheduleRetry({ expectedVideoId });
        return;
      }
    } else if (rendered !== expectedVideoId) {
      if (allowRetry) {
        scheduleRetry({ expectedVideoId });
        return;
      }
    }
  }

  const info = extractChannelInfo();
  if (!info) {
    if (allowRetry) {
      // YouTube SPA renders late; retry a few times.
      scheduleRetry({ expectedVideoId });
      return;
    }
    const resp = await sendCheck(url, "", "");
    if (resp?.redirectUrl) window.location.replace(String(resp.redirectUrl));
    stopRetry();
    return;
  }

  stopRetry();
  const resp = await sendCheck(url, info.channelKey, info.channelName);
  if (resp?.redirectUrl) window.location.replace(String(resp.redirectUrl));
}

function scheduleRetry({ expectedVideoId }) {
  if (pendingTimer) return;

  retryExpectedVideoId = String(expectedVideoId || "");
  retryAttempts += 1;

  if (retryAttempts >= RETRY_MAX_ATTEMPTS) {
    stopRetry();
    void checkNow({ allowRetry: false, expectedVideoId: retryExpectedVideoId || undefined });
    return;
  }

  ensureRetryObserver();

  const delay = nextRetryDelay(retryAttempts);
  pendingTimer = window.setTimeout(() => {
    pendingTimer = null;
    void checkNow({ allowRetry: true, expectedVideoId: retryExpectedVideoId || undefined });
  }, delay);
}

function onUrlChange() {
  const href = String(window.location.href || "");
  if (href === lastHref) return;
  lastHref = href;
  lastCheckSignature = "";
  stopRetry();
  const expectedVideoId = videoIdFromUrl(href);
  void checkNow({ allowRetry: true, expectedVideoId });
}

// YouTube is an SPA; listen to navigation events.
window.addEventListener("yt-navigate-finish", onUrlChange, true);
window.addEventListener("popstate", onUrlChange, true);
window.addEventListener("hashchange", onUrlChange, true);

// SPA fallback for pages that navigate via history API without events.
const originalPushState = history.pushState;
history.pushState = function pushStatePatched(...args) {
  const result = originalPushState.apply(this, args);
  onUrlChange();
  return result;
};

const originalReplaceState = history.replaceState;
history.replaceState = function replaceStatePatched(...args) {
  const result = originalReplaceState.apply(this, args);
  onUrlChange();
  return result;
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "channel.extract") {
    const info = extractChannelInfo();
    sendResponse({ ok: true, url: String(window.location.href || ""), ...(info || { channelKey: "", channelName: "" }) });
    return;
  }
});

// Initial check.
onUrlChange();
