/* Options page: manage PIN, whitelist, backups, and audit log. */

/* global parseChannelKey, extensionVersion, webext */

let entries = [];
let savedSnapshot = "";
let adminPin = "";
let stateReloadInFlight = null;
let lastStateReloadAt = 0;
const STATE_RELOAD_DEBOUNCE_MS = 400;
let pinLockoutTimer = 0;
let pinLockedUntil = 0;

function setMsg(id, text, isError) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || "";
  el.className = isError ? "msg err" : "msg";
}

function isInvalidPinError(error) {
  return String(error?.message || error || "").toLowerCase().includes("invalid pin");
}

function setUnlockControlsDisabled(disabled) {
  const pinInput = document.getElementById("adminPin");
  const unlockButton = document.getElementById("unlockOptions");
  if (pinInput instanceof HTMLInputElement) pinInput.disabled = disabled;
  if (unlockButton instanceof HTMLButtonElement) unlockButton.disabled = disabled;
}

function isPinLocked() {
  return pinLockedUntil > Date.now();
}

function stopPinLockout() {
  if (pinLockoutTimer) window.clearInterval(pinLockoutTimer);
  pinLockoutTimer = 0;
  pinLockedUntil = 0;
  setUnlockControlsDisabled(false);
}

function updatePinLockoutMessage() {
  const remainingSeconds = Math.ceil((pinLockedUntil - Date.now()) / 1000);
  if (remainingSeconds <= 0) {
    stopPinLockout();
    setMsg("unlockMsg", "");
    return;
  }
  setMsg("unlockMsg", `Lockout - ${remainingSeconds} seconds remaining.`, true);
}

function startPinLockout(response) {
  const remainingSeconds = Number(response?.remainingSeconds || 120);
  pinLockedUntil = Number(response?.lockedUntil || Date.now() + remainingSeconds * 1000);
  const pinInput = document.getElementById("adminPin");
  if (pinInput instanceof HTMLInputElement) pinInput.value = "";
  setUnlockControlsDisabled(true);
  updatePinLockoutMessage();
  if (pinLockoutTimer) window.clearInterval(pinLockoutTimer);
  pinLockoutTimer = window.setInterval(updatePinLockoutMessage, 1000);
}

function lockOptions(message) {
  adminPin = "";
  document.getElementById("adminContent")?.classList.add("hidden");
  document.getElementById("unlockSection")?.classList.remove("hidden");
  setMsg("unlockMsg", message || "", Boolean(message));
  setMsg("wlMsg", "");
  setMsg("backupMsg", "");
  setMsg("auditMsg", "");
  setMsg("pinMsg", "");
  const pinInput = document.getElementById("adminPin");
  if (pinInput instanceof HTMLInputElement) {
    pinInput.value = "";
    pinInput.focus();
  }
}

function closeOptionsOnSessionExpired() {
  lockOptions("");
  window.setTimeout(() => {
    window.close();
  }, 0);
}

async function hasActiveAdminAuth() {
  if (adminPin) return true;
  const resp = await webext.runtimeSendMessage({ type: "admin.session.get" });
  return Boolean(resp?.ok && resp.unlocked);
}

async function requireAdminAuth(messageId) {
  if (await hasActiveAdminAuth()) return true;
  closeOptionsOnSessionExpired();
  return false;
}

async function runAdminAction(messageId, action) {
  try {
    if (!await requireAdminAuth(messageId)) return;
    await action();
  } catch (e) {
    if (isInvalidPinError(e)) {
      closeOptionsOnSessionExpired();
      return;
    }
    if (messageId) setMsg(messageId, String(e?.message || e), true);
    else throw e;
  }
}

function normalizeEntry(input) {
  const key = parseChannelKey(input.key || input.channelKey || input.value || "");
  if (!key) throw new Error("Invalid channel key");
  if (!(key.startsWith("handle:") || key.startsWith("channelId:"))) {
    throw new Error("Channel key must be @handle, channelId, or a resolvable YouTube URL");
  }
  return {
    key,
    name: String(input.name || labelForKey(key)).trim(),
    enabled: input.enabled !== false,
    expiresAt: input.expiresAt || null
  };
}

function labelForKey(key) {
  const k = String(key || "");
  if (k.startsWith("handle:")) return k.slice("handle:".length);
  if (k.startsWith("name:")) return k.slice("name:".length);
  if (k.startsWith("channelId:")) return k.slice("channelId:".length);
  return k;
}

function channelUrlForKey(key) {
  const k = parseChannelKey(key || "");
  if (k.startsWith("handle:")) return `https://www.youtube.com/${k.slice("handle:".length)}`;
  if (k.startsWith("channelId:")) return `https://www.youtube.com/channel/${k.slice("channelId:".length)}`;
  return "";
}

function modeFor(entry) {
  return entry.expiresAt ? "day" : "permanent";
}

function expiryFor(mode) {
  if (mode !== "day") return null;
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function isExpired(entry) {
  const timestamp = Date.parse(entry?.expiresAt || "");
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function normalizeExpiredEntryState(entry) {
  if (!isExpired(entry)) return entry;
  return { ...entry, enabled: false };
}

function hasExpiredEnabledEntries(list) {
  return (list || []).some((entry) => isExpired(entry) && entry.enabled !== false);
}

function normalizeChannelInput(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) throw new Error("Empty input");
  if (raw.startsWith("name:")) {
    throw new Error("Display names are labels only. Use a YouTube URL, @handle, or UC channel ID.");
  }

  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^youtu\.be\//i.test(raw)) return `https://${raw}`;
  if (/^youtube\.com\//i.test(raw) || /^www\.youtube\.com\//i.test(raw) || /^m\.youtube\.com\//i.test(raw)) {
    return `https://${raw}`;
  }
  if (/^@[^/?#\s]{3,}$/.test(raw)) return raw;
  if (/^handle:@?[^/?#\s]{3,}$/i.test(raw)) return raw;
  if (/^channelId:UC[0-9A-Za-z_-]{10,}$/i.test(raw)) return raw;
  if (/^UC[0-9A-Za-z_-]{10,}$/.test(raw)) return `channelId:${raw}`;

  throw new Error("Use a YouTube URL, @handle, or UC channel ID. Display names are not stable allow keys.");
}

function snapshot(list) {
  return JSON.stringify((list || []).map(normalizeEntry).sort((a, b) => a.key.localeCompare(b.key)));
}

function updateDirty() {
  const dirty = snapshot(entries) !== savedSnapshot;
  const btn = document.getElementById("apply");
  if (btn) btn.disabled = !dirty;
  if (btn) btn.classList.toggle("pending", dirty);
  if (btn) btn.classList.toggle("btn-idle", !dirty);
}

function auditExpanded() {
  return document.getElementById("auditToggle")?.getAttribute("aria-expanded") === "true";
}

async function setAuditExpanded(expanded) {
  const toggle = document.getElementById("auditToggle");
  const body = document.getElementById("auditBody");
  if (toggle) toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (body) body.classList.toggle("hidden", !expanded);
  if (expanded) await runAdminAction("auditMsg", loadAudit);
}

async function loadEntries() {
  const resp = await webext.runtimeSendMessage({ type: "whitelist.entries.get", pin: adminPin });
  if (!resp?.ok) throw new Error(resp?.error || "Failed to load whitelist");
  const loaded = (resp.entries || []).map(normalizeEntry);
  const shouldPersistExpiredState = hasExpiredEnabledEntries(loaded);
  entries = loaded.map(normalizeExpiredEntryState);
  if (shouldPersistExpiredState) {
    const saveResp = await webext.runtimeSendMessage({ type: "whitelist.entries.set", entries, pin: adminPin });
    if (!saveResp?.ok) throw new Error(saveResp?.error || "Failed to update expired whitelist entries");
    entries = (saveResp.entries || []).map(normalizeEntry).map(normalizeExpiredEntryState);
  }
  savedSnapshot = snapshot(entries);
  document.getElementById("version").textContent = resp.version || extensionVersion() || "-";
  renderEntries();
  updateDirty();
}

async function refreshDefaultPinHint() {
  const el = document.getElementById("defaultPinHint");
  if (!el) return;
  const resp = await webext.runtimeSendMessage({ type: "pin.default.get" });
  el.classList.toggle("hidden", !(resp?.ok && resp.defaultPinActive));
}

async function reloadOptionsState() {
  if (document.getElementById("adminContent")?.classList.contains("hidden")) return;
  if (!await hasActiveAdminAuth()) {
    closeOptionsOnSessionExpired();
    return;
  }

  await loadEntries();
  await refreshDefaultPinHint();
  if (auditExpanded()) await loadAudit();
}

function scheduleOptionsStateReload() {
  if (document.hidden) return;

  const now = Date.now();
  if (now - lastStateReloadAt < STATE_RELOAD_DEBOUNCE_MS) return;
  lastStateReloadAt = now;

  if (stateReloadInFlight) return;
  stateReloadInFlight = reloadOptionsState()
    .catch((e) => {
      if (isInvalidPinError(e)) {
        closeOptionsOnSessionExpired();
        return;
      }
      setMsg("wlMsg", String(e?.message || e), true);
    })
    .finally(() => {
      stateReloadInFlight = null;
    });
}

async function saveEntries() {
  const resp = await webext.runtimeSendMessage({ type: "whitelist.entries.set", entries, pin: adminPin });
  if (!resp?.ok) throw new Error(resp?.error || "Failed to save whitelist");
  entries = (resp.entries || []).map(normalizeEntry);
  savedSnapshot = snapshot(entries);
  renderEntries();
  updateDirty();
  await reloadYouTubeTabs();
  setMsg("wlMsg", `Applied ${entries.length} rows.`);
}

async function resolveToChannel(input) {
  const normalizedInput = normalizeChannelInput(input);
  const resp = await webext.runtimeSendMessage({ type: "resolve.channel", input: normalizedInput });
  if (!resp?.ok || !resp?.channel?.key) throw new Error(`Cannot resolve: ${String(input || "").trim()}`);
  return resp.channel;
}

async function reloadYouTubeTabs() {
  const tabs = await webext.tabsQuery({
    url: ["*://*.youtube.com/*", "*://youtube.com/*", "*://m.youtube.com/*", "*://youtu.be/*"]
  });
  for (const t of tabs || []) {
    if (typeof t?.id === "number") await webext.tabsReload(t.id);
  }
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text || "";
  if (className) td.className = className;
  return td;
}

function editCell(td, value, onCommit) {
  td.classList.add("editing");
  td.textContent = "";
  const input = document.createElement("input");
  input.type = "text";
  input.value = value || "";
  td.appendChild(input);
  input.focus();
  input.select();
  const commit = () => {
    td.classList.remove("editing");
    onCommit(input.value);
    renderEntries();
    updateDirty();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") renderEntries();
  });
  input.addEventListener("blur", commit, { once: true });
}

function renderEntries() {
  const tbody = document.getElementById("whitelistRows");
  if (!tbody) return;
  tbody.textContent = "";

  for (const entry of entries) {
    const expired = isExpired(entry);
    const tr = document.createElement("tr");

    const enabled = cell("");
    enabled.className = "col-enabled";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = entry.enabled !== false;
    checkbox.addEventListener("change", () => {
      entry.enabled = checkbox.checked;
      updateDirty();
    });
    enabled.appendChild(checkbox);
    tr.appendChild(enabled);

    const nameTd = cell("", "editable");
    const channelUrl = channelUrlForKey(entry.key);
    const channelName = entry.name || labelForKey(entry.key);
    if (channelUrl) {
      const link = document.createElement("a");
      link.href = channelUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = channelName;
      nameTd.appendChild(link);
    } else {
      nameTd.textContent = channelName;
    }
    nameTd.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      editCell(nameTd, entry.name, (value) => { entry.name = String(value || "").trim() || labelForKey(entry.key); });
    });
    tr.appendChild(nameTd);

    const keyTd = cell(entry.key, "editable mono");
    keyTd.addEventListener("dblclick", () => editCell(keyTd, entry.key, (value) => { entry.key = parseChannelKey(value); }));
    tr.appendChild(keyTd);

    const modeTd = cell("");
    const select = document.createElement("select");
    for (const [value, label] of [["permanent", "Forever"], ["day", "1 day"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = modeFor(entry);
    select.addEventListener("change", () => {
      entry.expiresAt = expiryFor(select.value);
      renderEntries();
      updateDirty();
    });
    modeTd.appendChild(select);
    tr.appendChild(modeTd);

    tr.appendChild(cell(expired ? "Expired" : (entry.expiresAt ? new Date(entry.expiresAt).toLocaleString() : "-"), "muted"));

    const delTd = cell("", "col-delete");
    const del = document.createElement("button");
    del.className = "icon secondary";
    del.title = "Delete";
    del.textContent = "🗑";
    del.addEventListener("click", () => {
      entries = entries.filter((x) => x !== entry);
      renderEntries();
      updateDirty();
    });
    delTd.appendChild(del);
    tr.appendChild(delTd);

    tbody.appendChild(tr);
  }
}

async function addChannel() {
  try {
    const input = document.getElementById("addInput");
    const mode = document.getElementById("addMode")?.value || "permanent";
    const channel = await resolveToChannel(input?.value);
    const key = channel.key;
    if (!key) throw new Error("Invalid channel");
    const existing = entries.find((entry) => entry.key === key);
    if (existing) {
      throw new Error(`Already in whitelist: ${existing.name || labelForKey(key)}`);
    }
    entries.push({ key, name: channel.name || labelForKey(key), enabled: true, expiresAt: expiryFor(mode) });
    if (input) input.value = "";
    renderEntries();
    updateDirty();
    setMsg("wlMsg", `Added: ${channel.name || labelForKey(key)}. Click Apply to save.`);
  } catch (e) {
    setMsg("wlMsg", String(e?.message || e), true);
  }
}

async function exportPolicy() {
  const resp = await webext.runtimeSendMessage({ type: "policy.export", pin: adminPin });
  if (!resp?.ok) throw new Error(resp?.error || "Export failed");
  const blob = new Blob([JSON.stringify(resp.payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `inferfox-channelguard-whitelist-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setMsg("backupMsg", "Exported whitelist JSON.");
}

async function importPolicyFile(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  const resp = await webext.runtimeSendMessage({ type: "policy.import", payload, pin: adminPin });
  if (!resp?.ok) throw new Error(resp?.error || "Import failed");
  entries = (resp.entries || []).map(normalizeEntry);
  savedSnapshot = snapshot(entries);
  renderEntries();
  updateDirty();
  setMsg("backupMsg", `Imported ${entries.length} rows.`);
}

async function loadAudit() {
  const resp = await webext.runtimeSendMessage({ type: "audit.get", pin: adminPin });
  if (!resp?.ok) throw new Error(resp?.error || "Failed to load audit");
  const tbody = document.getElementById("auditRows");
  if (!tbody) return;
  tbody.textContent = "";
  for (const item of resp.log || []) {
    const tr = document.createElement("tr");
    tr.appendChild(cell(item.ts ? new Date(item.ts).toLocaleString() : ""));
    tr.appendChild(cell(item.action || ""));
    tr.appendChild(cell(item.reason || ""));
    tr.appendChild(cell(item.source || ""));
    tr.appendChild(cell(item.channelName || item.channelKey || ""));
    tr.appendChild(cell(item.url || "", "mono"));
    tbody.appendChild(tr);
  }
}

async function unlockOptions() {
  const pin = String(document.getElementById("adminPin")?.value || "").trim();
  if (!pin) {
    setMsg("unlockMsg", "Enter PIN.", true);
    return;
  }
  if (isPinLocked()) {
    updatePinLockoutMessage();
    return;
  }
  const btn = document.getElementById("unlockOptions");
  if (btn) btn.disabled = true;
  try {
    const resp = await webext.runtimeSendMessage({ type: "pin.verify", pin });
    if (resp?.locked) {
      startPinLockout(resp);
      return;
    }
    if (!resp?.ok) throw new Error(resp?.error || "invalid pin");
    stopPinLockout();
    adminPin = pin;
    document.getElementById("unlockSection")?.classList.add("hidden");
    document.getElementById("adminContent")?.classList.remove("hidden");
    setMsg("unlockMsg", "");
    await loadEntries();
    await refreshDefaultPinHint();
  } catch {
    adminPin = "";
    const pinInput = document.getElementById("adminPin");
    if (pinInput instanceof HTMLInputElement) pinInput.value = "";
    setMsg("unlockMsg", "Invalid PIN.", true);
  } finally {
    if (btn && !isPinLocked()) btn.disabled = false;
  }
}

async function tryUseAdminSession() {
  try {
    const resp = await webext.runtimeSendMessage({ type: "admin.session.get" });
    if (!resp?.ok || !resp.unlocked) return;
    document.getElementById("unlockSection")?.classList.add("hidden");
    document.getElementById("adminContent")?.classList.remove("hidden");
    await loadEntries();
    await refreshDefaultPinHint();
  } catch {
    lockOptions("");
  }
}

document.getElementById("addChannel")?.addEventListener("click", () => void addChannel());
document.getElementById("apply")?.addEventListener("click", () => void runAdminAction("wlMsg", saveEntries));
document.getElementById("exportPolicy")?.addEventListener("click", () => void runAdminAction("backupMsg", exportPolicy));
document.getElementById("importPolicy")?.addEventListener("click", () => {
  void runAdminAction("backupMsg", async () => document.getElementById("importFile")?.click());
});
document.getElementById("importFile")?.addEventListener("change", (e) => {
  const file = e.target?.files?.[0];
  if (file) void runAdminAction("backupMsg", () => importPolicyFile(file));
});
document.getElementById("refreshAudit")?.addEventListener("click", () => void runAdminAction("auditMsg", loadAudit));
document.getElementById("clearAudit")?.addEventListener("click", () => void runAdminAction("auditMsg", async () => {
  const resp = await webext.runtimeSendMessage({ type: "audit.clear", pin: adminPin });
  if (!resp?.ok) throw new Error(resp?.error || "Failed to clear audit");
  await loadAudit();
}));
document.getElementById("savePin")?.addEventListener("click", async () => {
  void runAdminAction("pinMsg", async () => {
    const pin = String(document.getElementById("newPin")?.value || "").trim();
    const resp = await webext.runtimeSendMessage({ type: "pin.set", newPin: pin, currentPin: adminPin });
    if (!resp?.ok) throw new Error(resp?.error || "Failed to save PIN");
    adminPin = pin;
    setMsg("pinMsg", "PIN updated.");
    const inp = document.getElementById("newPin");
    if (inp) inp.value = "";
    await refreshDefaultPinHint();
  });
});
document.getElementById("newPin")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  document.getElementById("savePin")?.click();
});
document.getElementById("auditToggle")?.addEventListener("click", () => {
  void setAuditExpanded(!auditExpanded()).catch((e) => setMsg("auditMsg", String(e?.message || e), true));
});
document.getElementById("unlockOptions")?.addEventListener("click", () => void unlockOptions());
document.getElementById("adminPin")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  void unlockOptions();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "pin.lockout.changed" && message.locked) {
    startPinLockout(message);
  }
});
window.addEventListener("focus", scheduleOptionsStateReload);
window.addEventListener("pageshow", scheduleOptionsStateReload);
document.addEventListener("visibilitychange", scheduleOptionsStateReload);

void tryUseAdminSession().then(() => {
  if (document.getElementById("adminContent")?.classList.contains("hidden")) {
    document.getElementById("adminPin")?.focus();
  }
});
