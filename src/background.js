/* Background script: stores whitelist, PIN, and enforces video-whitelist policy. */

/* global parseChannelKey, isYouTubeVideoUrl, webext */

const STORAGE_KEY = "ytWhitelist.channels";
const SCHEMA_VERSION_KEY = "ytWhitelist.schemaVersion";
const PIN_SALT_KEY = "ytWhitelist.pinSalt";
const PIN_HASH_KEY = "ytWhitelist.pinHash";
const AUDIT_LOG_KEY = "ytWhitelist.auditLog";
const DEFAULTS_URL = "data/default_whitelist.json";
let whitelistCache = null;
let enforcementInFlight = new Map();

const SCHEMA_VERSION = 2;
const AUDIT_LIMIT = 200;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ADMIN_SESSION_MS = 5 * 60 * 1000;
let adminSessionUntil = 0;

const LEGACY_DEFAULT_WHITELIST = [
  "handle:@YouTube",
  "channelId:UC-9-kyTW8ZkZNDHQJ6FgpwQ"
];

function nowIso() {
  return new Date().toISOString();
}

function displayNameFromKey(key) {
  const k = String(key || "");
  if (k.startsWith("handle:")) return k.slice("handle:".length);
  if (k.startsWith("name:")) return k.slice("name:".length);
  if (k.startsWith("channelId:")) return k.slice("channelId:".length);
  return k;
}

function normalizeWhitelistEntry(input) {
  if (typeof input === "string") {
    const key = parseChannelKey(input);
    if (!isStableChannelKey(key)) return null;
    return {
      key,
      name: displayNameFromKey(key),
      enabled: true,
      expiresAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
  }

  if (!input || typeof input !== "object") return null;
  const key = parseChannelKey(input.key || input.channelKey || input.value || "");
  if (!isStableChannelKey(key)) return null;

  const expiresAt = normalizeOptionalIso(input.expiresAt || input.expires_at || null);
  const createdAt = normalizeOptionalIso(input.createdAt || input.created_at || input.addedAt || null) || nowIso();
  const updatedAt = normalizeOptionalIso(input.updatedAt || input.updated_at || input.modifiedAt || null) || createdAt;
  return {
    key,
    name: normalizeWhitespace(input.name || input.channelName || displayNameFromKey(key)),
    enabled: input.enabled !== false,
    expiresAt,
    createdAt,
    updatedAt
  };
}

function normalizeOptionalIso(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function isStableChannelKey(key) {
  const k = String(key || "");
  return k.startsWith("handle:") || k.startsWith("channelId:");
}

function dedupeEntries(entries) {
  const map = new Map();
  for (const item of entries || []) {
    const entry = normalizeWhitelistEntry(item);
    if (!entry) continue;
    const previous = map.get(entry.key);
    map.set(entry.key, previous ? { ...previous, ...entry, createdAt: previous.createdAt || entry.createdAt } : entry);
  }
  return [...map.values()].sort((a, b) => String(a.name || a.key).localeCompare(String(b.name || b.key)));
}

function extractStoredChannelItems(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.channels)) return value.channels;
  if (Array.isArray(value.entries)) return value.entries;

  const items = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (rawValue === false || rawValue == null) continue;
    if (rawValue === true || typeof rawValue === "string") {
      items.push({ key: rawKey, name: typeof rawValue === "string" ? rawValue : displayNameFromKey(rawKey) });
    } else if (typeof rawValue === "object") {
      items.push({ key: rawKey, ...rawValue });
    }
  }
  return items.length ? items : null;
}

function storageVersionFrom(value) {
  const version = Number(value);
  return Number.isInteger(version) && version >= 0 ? version : 0;
}

function migrateWhitelistStorageSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const originalVersion = storageVersionFrom(source[SCHEMA_VERSION_KEY]);
  const rawChannels = source[STORAGE_KEY];
  const extracted = extractStoredChannelItems(rawChannels);
  const hadStoredChannels = extracted !== null;

  let entries = [];
  if (extracted) {
    if (originalVersion === 0 && arraysEqualAsSets(extracted, LEGACY_DEFAULT_WHITELIST)) {
      entries = [];
    } else {
      entries = dedupeEntries(extracted);
    }
  }

  const changed =
    originalVersion !== SCHEMA_VERSION ||
    JSON.stringify(rawChannels) !== JSON.stringify(entries);

  return {
    entries,
    changed,
    hadStoredChannels,
    originalVersion,
    schemaVersion: SCHEMA_VERSION
  };
}

function isEntryActive(entry) {
  if (!entry || entry.enabled === false) return false;
  if (!entry.expiresAt) return true;
  const t = Date.parse(entry.expiresAt);
  return Number.isFinite(t) && t > Date.now();
}

function publicEntry(entry) {
  return {
    key: entry.key,
    name: entry.name || displayNameFromKey(entry.key),
    enabled: entry.enabled !== false,
    expiresAt: entry.expiresAt || null,
    active: isEntryActive(entry)
  };
}

function modeForEntry(entry) {
  return entry?.expiresAt ? "day" : "permanent";
}

async function appendAuditLog(event) {
  const item = {
    ts: nowIso(),
    action: String(event.action || ""),
    url: String(event.url || ""),
    channelKey: String(event.channelKey || ""),
    channelName: String(event.channelName || ""),
    reason: String(event.reason || ""),
    source: String(event.source || "")
  };
  const result = await webext.storageGet([AUDIT_LOG_KEY]);
  const log = Array.isArray(result[AUDIT_LOG_KEY]) ? result[AUDIT_LOG_KEY] : [];
  log.unshift(item);
  await webext.storageSet({ [AUDIT_LOG_KEY]: log.slice(0, AUDIT_LIMIT) });
}

function arraysEqualAsSets(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  for (const x of b) if (!setA.has(x)) return false;
  return true;
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSaltHex() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ensurePinInitialized() {
  const result = await webext.storageGet([PIN_SALT_KEY, PIN_HASH_KEY]);
  if (result[PIN_SALT_KEY] && result[PIN_HASH_KEY]) return;

  // MVP default PIN. Change it in Options.
  const salt = randomSaltHex();
  const hash = await sha256Hex(`${salt}:0000`);
  await webext.storageSet({ [PIN_SALT_KEY]: salt, [PIN_HASH_KEY]: hash });
}

async function verifyPin(pin) {
  await ensurePinInitialized();
  const result = await webext.storageGet([PIN_SALT_KEY, PIN_HASH_KEY]);
  const salt = result[PIN_SALT_KEY];
  const expectedHash = result[PIN_HASH_KEY];
  const actualHash = await sha256Hex(`${salt}:${String(pin || "")}`);
  return actualHash === expectedHash;
}

async function requireMessagePin(message) {
  if (adminSessionUntil > Date.now()) return;
  const pin = message?.currentPin || message?.adminPin || message?.pin || "";
  const ok = await verifyPin(pin);
  if (ok) adminSessionUntil = Date.now() + ADMIN_SESSION_MS;
  if (!ok) throw new Error("invalid pin");
}

async function setPin(pin) {
  const normalized = String(pin || "").trim();
  if (!/^[0-9]{4,12}$/.test(normalized)) {
    throw new Error("PIN must be 4-12 digits");
  }
  const salt = randomSaltHex();
  const hash = await sha256Hex(`${salt}:${normalized}`);
  await webext.storageSet({ [PIN_SALT_KEY]: salt, [PIN_HASH_KEY]: hash });
}

async function loadDefaultWhitelist() {
  const url = chrome.runtime.getURL(DEFAULTS_URL);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load ${DEFAULTS_URL}: ${resp.status}`);
  const json = await resp.json();
  const channels = Array.isArray(json.channels) ? json.channels : [];
  return channels.map(parseChannelKey).filter(Boolean);
}

async function getWhitelistEntries() {
  if (Array.isArray(whitelistCache)) return whitelistCache;

  const result = await webext.storageGet([STORAGE_KEY, SCHEMA_VERSION_KEY]);
  const migration = migrateWhitelistStorageSnapshot(result);

  if (migration.hadStoredChannels) {
    if (migration.changed) {
      await webext.storageSet({ [STORAGE_KEY]: migration.entries, [SCHEMA_VERSION_KEY]: SCHEMA_VERSION });
    }
    whitelistCache = migration.entries;
    return migration.entries;
  }

  const defaults = await loadDefaultWhitelist();
  const entries = dedupeEntries(defaults);
  await webext.storageSet({ [STORAGE_KEY]: entries, [SCHEMA_VERSION_KEY]: SCHEMA_VERSION });
  whitelistCache = entries;
  return entries;
}

async function getWhitelist() {
  const entries = await getWhitelistEntries();
  return entries.filter(isEntryActive).map((entry) => entry.key);
}

async function normalizeStoredWhitelistIfNeeded() {
  const result = await webext.storageGet([STORAGE_KEY, SCHEMA_VERSION_KEY]);
  const migration = migrateWhitelistStorageSnapshot(result);
  if (!migration.hadStoredChannels) return;
  if (migration.changed) {
    await webext.storageSet({ [STORAGE_KEY]: migration.entries, [SCHEMA_VERSION_KEY]: SCHEMA_VERSION });
    whitelistCache = migration.entries;
  }
}

function handleFromHtml(htmlText) {
  const html = String(htmlText || "");

  // Common patterns:
  // - "canonicalBaseUrl":"/@handle"
  // - href="/ @handle" or href="https://www.youtube.com/@handle"
  const mCanonical = html.match(/"canonicalBaseUrl"\s*:\s*"(?:\\\/|\/)(@[0-9A-Za-z._-]{3,})"/);
  if (mCanonical) return mCanonical[1];

  const mRelCanonical = html.match(/<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/(?:@)([0-9A-Za-z._-]{3,})"/i);
  if (mRelCanonical) return `@${mRelCanonical[1]}`;

  const mOgUrl = html.match(/<meta[^>]+property="og:url"[^>]+content="https:\/\/www\.youtube\.com\/(?:@)([0-9A-Za-z._-]{3,})"/i);
  if (mOgUrl) return `@${mOgUrl[1]}`;

  const mOwnerProfileUrl = html.match(/"ownerProfileUrl"\s*:\s*"(?:https?:\\\/\\\/www\\\.youtube\\\.com)?\\\/(?:@)([0-9A-Za-z._-]{3,})"/);
  if (mOwnerProfileUrl) return `@${mOwnerProfileUrl[1]}`;

  const mUrl = html.match(/https:\/\/www\.youtube\.com\/(?:@)([0-9A-Za-z._-]{3,})/);
  if (mUrl) return `@${mUrl[1]}`;

  const mHref = html.match(/href=\"(?:\\\/|\/)(@[0-9A-Za-z._-]{3,})\"/);
  if (mHref) return mHref[1];

  const mPlainHref = html.match(/href="\/(?:@)([0-9A-Za-z._-]{3,})"/);
  if (mPlainHref) return `@${mPlainHref[1]}`;

  const mEscapedAt = html.match(/\\\/(@[0-9A-Za-z._-]{3,})/);
  if (mEscapedAt) return mEscapedAt[1];

  return "";
}

function channelIdFromHtml(htmlText) {
  const html = String(htmlText || "");
  const m = html.match(/"channelId"\s*:\s*"(UC[0-9A-Za-z_-]{10,})"/);
  if (m) return m[1];
  return "";
}

function channelNameFromHtml(htmlText) {
  const html = String(htmlText || "");
  const patterns = [
    /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
    /<meta[^>]+name="title"[^>]+content="([^"]+)"/i,
    /"ownerChannelName"\s*:\s*"([^"]+)"/,
    /"author"\s*:\s*"([^"]+)"/,
    /<title>([^<]+)<\/title>/i
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (!m) continue;
    const raw = normalizeWhitespace(m[1].replace(/\\u0026/g, "&"));
    if (!raw) continue;
    return raw.replace(/\s+-\s+YouTube$/i, "");
  }
  return "";
}

function toYouTubeWatchUrl(urlString) {
  const url = new URL(urlString);
  if (url.hostname === "youtu.be") {
    const id = url.pathname.replace(/^\//, "");
    if (!id) return "";
    return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  }

  if (/(^|\.)youtube-nocookie\.com$/.test(url.hostname) && url.pathname.startsWith("/embed/")) {
    const id = url.pathname.split("/")[2] || "";
    if (!id) return "";
    return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  }

  return url.toString();
}

async function resolveHandleFromInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  // Already a handle
  if (raw.startsWith("@")) return `@${raw.slice(1).toLowerCase()}`;
  if (raw.startsWith("handle:")) {
    const h = raw.slice("handle:".length).trim();
    if (h.startsWith("@")) return `@${h.slice(1).toLowerCase()}`;
    return `@${h.toLowerCase()}`;
  }

  // channelId forms
  const mChannelIdPref = raw.match(/^channelId:(UC[0-9A-Za-z_-]{10,})$/);
  const mChannelIdBare = raw.match(/^(UC[0-9A-Za-z_-]{10,})$/);
  const channelId = mChannelIdPref?.[1] || mChannelIdBare?.[1] || "";

  let urlToFetch = "";
  try {
    // URLs
    const url = new URL(raw);
    const hostOk =
      url.hostname === "youtu.be" ||
      /(^|\.)youtube\.com$/.test(url.hostname) ||
      /(^|\.)youtube-nocookie\.com$/.test(url.hostname);
    if (!hostOk) return "";

    // Channel URLs can be fetched directly; video URLs as well.
    urlToFetch = toYouTubeWatchUrl(url.toString());
  } catch {
    // Not a URL
    if (channelId) urlToFetch = `https://www.youtube.com/channel/${channelId}`;
  }

  if (!urlToFetch) return "";

  // 1) Try oEmbed first (often avoids consent/interstitial HTML).
  try {
    const oembedUrl = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(urlToFetch)}`;
    const oResp = await fetch(oembedUrl, { credentials: "omit", redirect: "follow" });
    if (oResp.ok) {
      const oJson = await oResp.json();
      const authorUrl = String(oJson?.author_url || "");
      if (authorUrl) {
        const key = parseChannelKey(authorUrl);
        if (key.startsWith("handle:")) {
          return key.slice("handle:".length);
        }
        if (key.startsWith("channelId:")) {
          const cid = key.slice("channelId:".length);
          const cResp = await fetch(`https://www.youtube.com/channel/${cid}`, { credentials: "omit", redirect: "follow" });
          if (cResp.ok) {
            const cHtml = await cResp.text();
            const h2 = handleFromHtml(cHtml);
            if (h2) return `@${h2.replace(/^@/, "").toLowerCase()}`;
          }
        }
      }
    }
  } catch {
    // ignore and fall back
  }

  // 2) Fetch HTML and parse handle.
  const resp = await fetch(urlToFetch, { credentials: "omit", redirect: "follow" });
  if (!resp.ok) return "";
  const html = await resp.text();

  const handle = handleFromHtml(html);
  if (handle) return `@${handle.replace(/^@/, "").toLowerCase()}`;

  // 3) Fallback: extract channelId from HTML and resolve via channel page.
  const cid = channelIdFromHtml(html) || channelId;
  if (cid) {
    const cResp = await fetch(`https://www.youtube.com/channel/${cid}`, { credentials: "omit", redirect: "follow" });
    if (cResp.ok) {
      const cHtml = await cResp.text();
      const h2 = handleFromHtml(cHtml);
      if (h2) return `@${h2.replace(/^@/, "").toLowerCase()}`;
    }
  }

  return "";
}

async function setWhitelistEntries(entries) {
  const normalized = dedupeEntries(entries || []);
  await webext.storageSet({ [STORAGE_KEY]: normalized, [SCHEMA_VERSION_KEY]: SCHEMA_VERSION });
  whitelistCache = normalized;
  return normalized;
}

async function resolveChannelFromInput(input) {
  const raw = String(input || "").trim();
  const fallbackKey = parseChannelKey(raw);
  if (!raw) return { key: "", name: "" };
  if (raw.startsWith("@") || raw.startsWith("handle:") || raw.startsWith("name:")) {
    const key = parseChannelKey(raw);
    return { key, name: displayNameFromKey(key) };
  }

  let urlToFetch = "";
  try {
    const url = new URL(raw);
    const hostOk =
      url.hostname === "youtu.be" ||
      /(^|\.)youtube\.com$/.test(url.hostname) ||
      /(^|\.)youtube-nocookie\.com$/.test(url.hostname);
    if (hostOk) urlToFetch = toYouTubeWatchUrl(url.toString());
  } catch {
    if (fallbackKey.startsWith("channelId:")) {
      urlToFetch = `https://www.youtube.com/channel/${fallbackKey.slice("channelId:".length)}`;
    }
  }

  if (!urlToFetch) return { key: fallbackKey, name: displayNameFromKey(fallbackKey) };

  try {
    const oembedUrl = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(urlToFetch)}`;
    const oResp = await fetch(oembedUrl, { credentials: "omit", redirect: "follow" });
    if (oResp.ok) {
      const oJson = await oResp.json();
      const authorUrl = String(oJson?.author_url || "");
      const key = parseChannelKey(authorUrl) || fallbackKey;
      const name = normalizeWhitespace(oJson?.author_name || "");
      if (key) return { key, name: name || displayNameFromKey(key) };
    }
  } catch {
    // Fall back to HTML parsing.
  }

  const resp = await fetch(urlToFetch, { credentials: "omit", redirect: "follow" });
  if (!resp.ok) return { key: fallbackKey, name: displayNameFromKey(fallbackKey) };
  const html = await resp.text();
  const handle = handleFromHtml(html);
  const cid = channelIdFromHtml(html);
  const key = handle ? parseChannelKey(handle) : (cid ? parseChannelKey(`channelId:${cid}`) : fallbackKey);
  const name = channelNameFromHtml(html);
  return { key, name: name || displayNameFromKey(key) };
}

async function setWhitelist(channels) {
  const entries = await setWhitelistEntries(channels);
  return entries.filter(isEntryActive).map((entry) => entry.key);
}

async function addToWhitelist(channelKey, options = {}) {
  const key = parseChannelKey(channelKey || "");
  if (!isStableChannelKey(key)) throw new Error("Missing stable channel key");
  const current = await getWhitelistEntries();
  const expiresAt = options.duration === "day" ? new Date(Date.now() + ONE_DAY_MS).toISOString() : null;
  const name = normalizeWhitespace(options.channelName || displayNameFromKey(key));
  const existing = current.find((entry) => entry.key === key);
  const updated = existing
    ? current.map((entry) => entry.key === key
      ? { ...entry, name: name || entry.name, enabled: true, expiresAt, updatedAt: nowIso() }
      : entry)
    : [...current, { key, name, enabled: true, expiresAt, createdAt: nowIso(), updatedAt: nowIso() }];
  const normalized = dedupeEntries(updated);
  await webext.storageSet({ [STORAGE_KEY]: normalized, [SCHEMA_VERSION_KEY]: SCHEMA_VERSION });
  whitelistCache = normalized;
  return normalized;
}

async function getChannelStatus(channelKey) {
  const key = parseChannelKey(channelKey || "");
  if (!isStableChannelKey(key)) return { key: "", whitelisted: false, entry: null };
  const entries = await getWhitelistEntries();
  const entry = entries.find((item) => item.key === key) || null;
  return {
    key,
    whitelisted: Boolean(entry),
    active: entry ? isEntryActive(entry) : false,
    mode: entry ? modeForEntry(entry) : "",
    entry: entry ? publicEntry(entry) : null
  };
}

async function updateChannelPolicy(channelKey, action, options = {}) {
  const key = parseChannelKey(channelKey || "");
  if (!isStableChannelKey(key)) throw new Error("Missing stable channel key");
  const current = await getWhitelistEntries();
  const existing = current.find((entry) => entry.key === key);
  if (!existing && action !== "allow-permanent" && action !== "allow-day") {
    throw new Error("Channel is not in whitelist");
  }

  let updated = current;
  if (action === "delete") {
    updated = current.filter((entry) => entry.key !== key);
  } else if (action === "disable") {
    updated = current.map((entry) => entry.key === key ? { ...entry, enabled: false, updatedAt: nowIso() } : entry);
  } else {
    const duration = action === "allow-day" ? "day" : "permanent";
    return addToWhitelist(key, { duration, channelName: options.channelName });
  }

  const normalized = dedupeEntries(updated);
  await webext.storageSet({ [STORAGE_KEY]: normalized, [SCHEMA_VERSION_KEY]: SCHEMA_VERSION });
  whitelistCache = normalized;
  return normalized;
}

async function isAllowedChannel(channelKey, channelName) {
  const entries = await getWhitelistEntries();
  const activeEntries = entries.filter(isEntryActive);
  const byKey = parseChannelKey(channelKey || "");
  if (byKey && activeEntries.some((entry) => entry.key === byKey)) return true;

  return false;
}

async function getPolicyExport() {
  const entries = await getWhitelistEntries();
  return {
    exportedAt: nowIso(),
    schemaVersion: SCHEMA_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
    channels: entries.map(publicEntry)
  };
}

async function importPolicy(payload) {
  const source = payload && typeof payload === "object" ? payload.channels : null;
  if (!Array.isArray(source)) throw new Error("Import JSON must contain channels array");
  const entries = await setWhitelistEntries(source);
  await appendAuditLog({ action: "policy-import", reason: `channels:${entries.length}`, source: "options" });
  return entries;
}

async function getAuditLog() {
  const result = await webext.storageGet([AUDIT_LOG_KEY]);
  return Array.isArray(result[AUDIT_LOG_KEY]) ? result[AUDIT_LOG_KEY] : [];
}

async function clearAuditLog() {
  await webext.storageSet({ [AUDIT_LOG_KEY]: [] });
}

function blockedUrl({ videoUrl, channelKey, channelName, reason }) {
  const base = chrome.runtime.getURL("src/blocked.html");
  const qs = new URLSearchParams({
    url: videoUrl || "",
    channelKey: channelKey || "",
    channelName: channelName || "",
    reason: reason || "not-whitelisted"
  });
  return `${base}?${qs.toString()}`;
}

async function resolveChannelKeyForVideoUrl(videoUrl, maybeKnownChannelKey) {
  const handle = await resolveHandleFromInput(videoUrl);
  if (handle) return parseChannelKey(handle);

  // Fail closed. YouTube SPA navigation can temporarily expose the previous
  // video's owner in the DOM while the URL already points at a new video.
  // The content-script channelKey is useful as display context, not as proof.
  return "";
}

async function evaluateYouTubeUrl(url, context = {}) {
  const videoUrl = String(url || "");
  if (!isYouTubeVideoUrl(videoUrl)) {
    return { allowed: true, reason: "non-video-page", channelKey: "", channelName: "" };
  }

  const resolved = await resolveChannelFromInput(videoUrl);
  const channelKey = resolved.key || await resolveChannelKeyForVideoUrl(videoUrl, context.channelKey);
  const channelName = String(context.channelName || resolved.name || "");
  const allowed = await isAllowedChannel(channelKey, channelName);
  if (allowed) return { allowed: true, reason: "whitelisted", channelKey, channelName };
  return {
    allowed: false,
    reason: channelKey ? "not-whitelisted" : "channel-unresolved",
    channelKey,
    channelName,
    redirectUrl: blockedUrl({ videoUrl, channelKey, channelName, reason: channelKey ? "not-whitelisted" : "channel-unresolved" })
  };
}

async function enforceTabUrl(tabId, url, source) {
  if (typeof tabId !== "number" || !isYouTubeVideoUrl(url)) return;

  const key = `${tabId}:${url}`;
  if (enforcementInFlight.get(tabId) === key) return;
  enforcementInFlight.set(tabId, key);

  try {
    const result = await evaluateYouTubeUrl(url);
    await appendAuditLog({
      action: result.allowed ? "allow" : "block",
      url,
      channelKey: result.channelKey,
      channelName: result.channelName,
      reason: result.reason,
      source
    });
    if (!result.allowed && result.redirectUrl) {
      await webext.tabsUpdate(tabId, { url: result.redirectUrl });
    }
  } finally {
    if (enforcementInFlight.get(tabId) === key) {
      enforcementInFlight.delete(tabId);
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  // Ensure defaults exist.
  await getWhitelistEntries();
  await normalizeStoredWhitelistIfNeeded();
  whitelistCache = null;
  await ensurePinInitialized();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || typeof message !== "object") {
      sendResponse({ ok: false, error: "invalid message" });
      return;
    }

    if (message.type === "whitelist.get") {
      await requireMessagePin(message);
      const whitelist = await getWhitelist();
      sendResponse({ ok: true, whitelist });
      return;
    }

    if (message.type === "whitelist.entries.get") {
      await requireMessagePin(message);
      const entries = await getWhitelistEntries();
      sendResponse({ ok: true, entries: entries.map(publicEntry), version: chrome.runtime.getManifest().version });
      return;
    }

    if (message.type === "resolve.handle") {
      const handle = await resolveHandleFromInput(message.input);
      if (!handle) {
        sendResponse({ ok: false, error: "cannot resolve handle" });
        return;
      }
      sendResponse({ ok: true, handle });
      return;
    }

    if (message.type === "resolve.channel") {
      const channel = await resolveChannelFromInput(message.input);
      if (!channel.key) {
        sendResponse({ ok: false, error: "cannot resolve channel" });
        return;
      }
      sendResponse({ ok: true, channel });
      return;
    }

    if (message.type === "pin.set") {
      await requireMessagePin(message);
      await setPin(message.newPin);
      adminSessionUntil = Date.now() + ADMIN_SESSION_MS;
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "pin.verify") {
      const ok = await verifyPin(message.pin);
      if (!ok) {
        sendResponse({ ok: false, error: "invalid pin" });
        return;
      }
      adminSessionUntil = Date.now() + ADMIN_SESSION_MS;
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "admin.session.get") {
      sendResponse({ ok: true, unlocked: adminSessionUntil > Date.now(), until: adminSessionUntil });
      return;
    }

    if (message.type === "whitelist.set") {
      await requireMessagePin(message);
      const whitelist = await setWhitelist(message.whitelist);
      sendResponse({ ok: true, whitelist });
      return;
    }

    if (message.type === "whitelist.entries.set") {
      await requireMessagePin(message);
      const entries = await setWhitelistEntries(message.entries);
      sendResponse({ ok: true, entries: entries.map(publicEntry) });
      return;
    }

    if (message.type === "policy.export") {
      await requireMessagePin(message);
      const payload = await getPolicyExport();
      sendResponse({ ok: true, payload });
      return;
    }

    if (message.type === "policy.import") {
      await requireMessagePin(message);
      const entries = await importPolicy(message.payload);
      sendResponse({ ok: true, entries: entries.map(publicEntry) });
      return;
    }

    if (message.type === "audit.get") {
      await requireMessagePin(message);
      const log = await getAuditLog();
      sendResponse({ ok: true, log });
      return;
    }

    if (message.type === "audit.clear") {
      await requireMessagePin(message);
      await clearAuditLog();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "approve.channel") {
      const ok = await verifyPin(message.pin);
      if (!ok) {
        sendResponse({ ok: false, error: "invalid pin" });
        return;
      }
      const entries = await addToWhitelist(message.channelKey, {
        duration: message.duration === "day" ? "day" : "permanent",
        channelName: message.channelName
      });
      await appendAuditLog({
        action: message.duration === "day" ? "approve-day" : "approve-permanent",
        channelKey: message.channelKey,
        channelName: message.channelName,
        url: message.url,
        source: "popup"
      });
      sendResponse({ ok: true, entries: entries.map(publicEntry), whitelist: entries.filter(isEntryActive).map((entry) => entry.key) });
      return;
    }

    if (message.type === "channel.status") {
      await requireMessagePin(message);
      const status = await getChannelStatus(message.channelKey);
      sendResponse({ ok: true, ...status });
      return;
    }

    if (message.type === "channel.update") {
      await requireMessagePin(message);
      const entries = await updateChannelPolicy(message.channelKey, message.action, { channelName: message.channelName });
      await appendAuditLog({
        action: `channel-${message.action || "update"}`,
        channelKey: message.channelKey,
        channelName: message.channelName,
        url: message.url,
        source: "popup"
      });
      sendResponse({ ok: true, entries: entries.map(publicEntry) });
      return;
    }

    if (message.type === "youtube.check") {
      const url = String(message.url || "");
      const result = await evaluateYouTubeUrl(url, { channelKey: message.channelKey, channelName: message.channelName });
      await appendAuditLog({
        action: result.allowed ? "allow" : "block",
        url,
        channelKey: result.channelKey,
        channelName: result.channelName,
        reason: result.reason,
        source: message.source || "content"
      });
      sendResponse({ ok: true, ...result });
      return;
    }

    sendResponse({ ok: false, error: "unknown message type" });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  // Keep service worker alive until sendResponse is called.
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = String(changeInfo?.url || tab?.url || "");
  if (!url) return;
  void enforceTabUrl(tabId, url, "tabs.onUpdated");
});

if (chrome.webNavigation) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    void enforceTabUrl(details.tabId, details.url, "webNavigation.onCommitted");
  });

  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    void enforceTabUrl(details.tabId, details.url, "webNavigation.onHistoryStateUpdated");
  });
}
