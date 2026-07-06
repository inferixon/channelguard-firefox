/* Content script: extracts channel info and enforces whitelist on YouTube video pages. */

/* global parseChannelKey, isYouTubeVideoUrl, webext */

let lastHref = "";
let pendingTimer = null;
let lastCheckSignature = "";
let lastMiniPlayerSignature = "";
let retryAttempts = 0;
let retryExpectedVideoId = "";
let retryObserver = null;
let miniPlayerTimer = null;
let miniPlayerObserver = null;

const RETRY_MAX_ATTEMPTS = 12;
const RETRY_BASE_DELAY_MS = 140;
const RETRY_MAX_DELAY_MS = 900;

async function sendCheck(url, channelKey, channelName) {
  const signature = `${url}|${channelKey || ""}`;
  if (signature === lastCheckSignature) return null;
  lastCheckSignature = signature;
  return webext.runtimeSendMessage({ type: "youtube.check", url, channelKey, channelName, source: "content-script" });
}

async function sendMiniPlayerCheck(url) {
  const signature = String(url || "");
  if (!signature || signature === lastMiniPlayerSignature) return null;
  lastMiniPlayerSignature = signature;
  return webext.runtimeSendMessage({ type: "youtube.check", url, channelKey: "", channelName: "", source: "content-script-miniplayer" });
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

function watchUrlFromVideoId(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return "";
  return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
}

function isElementVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
  if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 20 && rect.height > 20;
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

function miniplayerRoot() {
  const root = document.querySelector("ytd-miniplayer");
  if (!root || !isElementVisible(root)) return null;
  return root;
}

function videoUrlFromMiniplayer(root) {
  if (!root) return "";

  const directVideoId = root.getAttribute?.("video-id") || root.getAttribute?.("data-video-id") || "";
  if (directVideoId) return watchUrlFromVideoId(directVideoId);

  const withVideoId = root.querySelector?.("[video-id], [data-video-id]");
  const nestedVideoId = withVideoId?.getAttribute?.("video-id") || withVideoId?.getAttribute?.("data-video-id") || "";
  if (nestedVideoId) return watchUrlFromVideoId(nestedVideoId);

  const links = root.querySelectorAll?.("a[href]") || [];
  for (const link of links) {
    const href = link.getAttribute("href") || "";
    if (!href) continue;
    try {
      const url = new URL(href, window.location.origin);
      if (isYouTubeVideoUrl(url.toString())) return url.toString();
    } catch {
      // Ignore malformed internal links.
    }
  }

  return "";
}

function suppressMiniplayer(root) {
  if (!root) return;
  const videos = root.querySelectorAll?.("video") || [];
  for (const video of videos) {
    try {
      video.pause();
      video.currentTime = 0;
    } catch {
      // Best effort only.
    }
  }
  root.setAttribute("data-channelguard-blocked", "true");
  root.style.display = "none";
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

async function checkMiniPlayerNow() {
  const root = miniplayerRoot();
  if (!root) return;

  const url = videoUrlFromMiniplayer(root);
  if (!url) {
    suppressMiniplayer(root);
    return;
  }

  const resp = await sendMiniPlayerCheck(url);
  if (resp?.redirectUrl) {
    suppressMiniplayer(root);
    window.location.replace(String(resp.redirectUrl));
  }
}

function scheduleMiniPlayerCheck() {
  if (miniPlayerTimer) return;
  miniPlayerTimer = window.setTimeout(() => {
    miniPlayerTimer = null;
    void checkMiniPlayerNow();
  }, 80);
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
  lastMiniPlayerSignature = "";
  stopRetry();
  const expectedVideoId = videoIdFromUrl(href);
  void checkNow({ allowRetry: true, expectedVideoId });
  scheduleMiniPlayerCheck();
}

function ensureMiniPlayerObserver() {
  if (miniPlayerObserver || !window.MutationObserver) return;
  const root = document.documentElement;
  if (!root) return;

  miniPlayerObserver = new MutationObserver(() => {
    scheduleMiniPlayerCheck();
  });

  miniPlayerObserver.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href", "video-id", "data-video-id", "hidden", "style", "class"]
  });
}

// YouTube is an SPA; listen to navigation events.
window.addEventListener("yt-navigate-finish", onUrlChange, true);
window.addEventListener("popstate", onUrlChange, true);
window.addEventListener("hashchange", onUrlChange, true);

// Best-effort SPA fallback for pages that navigate via history API without
// events. In Firefox, content scripts run in an isolated world, so background
// webNavigation listeners remain the primary SPA enforcement path.
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
ensureMiniPlayerObserver();
onUrlChange();
scheduleMiniPlayerCheck();
