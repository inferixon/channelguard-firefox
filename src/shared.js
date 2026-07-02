/* Shared helpers for background/content/options. */

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHandle(handle) {
  const h = normalizeWhitespace(handle);
  if (!h) return "";
  const raw = h.startsWith("@") ? h.slice(1) : h;
  return `@${raw.toLowerCase()}`;
}

function parseChannelKey(input) {
  const raw = normalizeWhitespace(input);
  if (!raw) return "";

  if (raw.startsWith("channelId:")) return raw;
  if (raw.startsWith("handle:")) {
    const handle = raw.slice("handle:".length);
    return `handle:${normalizeHandle(handle)}`;
  }
  if (raw.startsWith("name:")) {
    const name = raw.slice("name:".length);
    return `name:${normalizeWhitespace(name).toLowerCase()}`;
  }

  // Accept common YouTube channel URL forms.
  // Examples:
  // - https://www.youtube.com/channel/UC....
  // - https://www.youtube.com/@handle
  // - /@handle
  const mId = raw.match(/(?:youtube\.com\/channel\/)(UC[0-9A-Za-z_-]{10,})/);
  if (mId) return `channelId:${mId[1]}`;

  const mHandle = raw.match(/(?:youtube\.com\/|^\/)?(@[0-9A-Za-z._-]{3,})/);
  if (mHandle) return `handle:${normalizeHandle(mHandle[1])}`;

  // Fallback: treat as channel display name.
  return `name:${raw.toLowerCase()}`;
}

function isYouTubeVideoUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (/(^|\.)youtube\.com$/.test(url.hostname) || /(^|\.)youtube-nocookie\.com$/.test(url.hostname)) {
      if (url.pathname === "/watch") return true;
      if (url.pathname.startsWith("/shorts/")) return true;
      if (url.pathname.startsWith("/embed/")) return true;
      if (url.pathname.startsWith("/live/")) return true;
      return false;
    }

    // https://youtu.be/<videoId>
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace(/^\//, "");
      return Boolean(id);
    }

    return false;
  } catch {
    return false;
  }
}

function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "";
  }
}

// --- WebExtension MV2 compatibility helpers ---
// Firefox MV2 APIs are callback-based; these wrappers provide Promise support.

function webextRuntimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function webextStorageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result || {});
      });
    } catch (e) {
      reject(e);
    }
  });
}

function webextStorageSet(items) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(items, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
}

function webextTabsUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.update(tabId, updateProperties, (tab) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(tab);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function webextTabsReload(tabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.reload(tabId, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
}

function webextTabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.query(queryInfo, (tabs) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(tabs || []);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function webextTabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// Global namespace used by other scripts.
const webext = {
  runtimeSendMessage: webextRuntimeSendMessage,
  storageGet: webextStorageGet,
  storageSet: webextStorageSet,
  tabsUpdate: webextTabsUpdate,
  tabsReload: webextTabsReload,
  tabsQuery: webextTabsQuery,
  tabsSendMessage: webextTabsSendMessage
};
