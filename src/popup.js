/* Toolbar popup: PIN-gated actions. */

/* global parseChannelKey, webext */

let unlockedPin = "";
let activeContext = null;
let pinLockoutTimer = 0;
let pinLockedUntil = 0;

async function getActiveTab() {
  const tabs = await webext.tabsQuery({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function setMsg(text, isError) {
  const el = document.getElementById("msg");
  if (!el) return;
  el.textContent = text;
  el.className = isError ? "msg err" : "msg";
}

function showActions() {
  document.getElementById("stepPin")?.classList.add("hidden");
  document.getElementById("stepActions")?.classList.remove("hidden");
}

function showPopup() {
  document.documentElement.classList.remove("booting");
}

async function refreshDefaultPinHint() {
  try {
    const resp = await webext.runtimeSendMessage({ type: "pin.default.get" });
    document.getElementById("defaultPinHint")?.classList.toggle("hidden", !(resp?.ok && resp.defaultPinActive));
  } catch {
    document.getElementById("defaultPinHint")?.classList.add("hidden");
  }
}

function focusPin() {
  const pinInput = document.getElementById("pin");
  if (!(pinInput instanceof HTMLInputElement)) return;
  // Defer to ensure layout/state is applied.
  window.setTimeout(() => {
    pinInput.focus();
    pinInput.select();
  }, 0);
}

function clearPin() {
  const pinInput = document.getElementById("pin");
  if (pinInput instanceof HTMLInputElement) pinInput.value = "";
}

function isFocusableButton(id) {
  const button = document.getElementById(id);
  return button instanceof HTMLButtonElement && !button.disabled && !button.classList.contains("hidden");
}

function focusButton(id) {
  const button = document.getElementById(id);
  if (!(button instanceof HTMLButtonElement)) return;
  window.setTimeout(() => button.focus(), 0);
}

function focusPrimaryAction() {
  if (isFocusableButton("addChannel")) {
    focusButton("addChannel");
    return;
  }
  if (isFocusableButton("enableForever")) {
    focusButton("enableForever");
    return;
  }
  focusButton("openOptions");
}

function setPinControlsDisabled(disabled) {
  const pinInput = document.getElementById("pin");
  const unlockButton = document.getElementById("unlock");
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
  setPinControlsDisabled(false);
}

function updatePinLockoutMessage() {
  const remainingSeconds = Math.ceil((pinLockedUntil - Date.now()) / 1000);
  if (remainingSeconds <= 0) {
    stopPinLockout();
    setMsg("");
    focusPin();
    return;
  }
  setMsg(`Lockout - ${remainingSeconds} seconds remaining.`, true);
}

function startPinLockout(response) {
  const remainingSeconds = Number(response?.remainingSeconds || 120);
  pinLockedUntil = Number(response?.lockedUntil || Date.now() + remainingSeconds * 1000);
  unlockedPin = "";
  clearPin();
  showPin();
  setPinControlsDisabled(true);
  updatePinLockoutMessage();
  if (pinLockoutTimer) window.clearInterval(pinLockoutTimer);
  pinLockoutTimer = window.setInterval(updatePinLockoutMessage, 1000);
}

async function refreshPinLockout() {
  try {
    const resp = await webext.runtimeSendMessage({ type: "pin.lockout.get" });
    if (resp?.ok && resp.locked) {
      startPinLockout(resp);
      return true;
    }
  } catch {
    // Best-effort startup state only.
  }
  return false;
}

function showPin() {
  document.getElementById("stepActions")?.classList.add("hidden");
  document.getElementById("stepPin")?.classList.remove("hidden");
  if (!isPinLocked()) focusPin();
}

async function unlock() {
  setMsg("");
  const pin = String(document.getElementById("pin")?.value || "").trim();
  if (!pin) {
    setMsg("Enter PIN.", true);
    return;
  }

  if (isPinLocked()) {
    updatePinLockoutMessage();
    return;
  }

  const btn = document.getElementById("unlock");
  if (btn) btn.disabled = true;
  try {
    const resp = await webext.runtimeSendMessage({ type: "pin.verify", pin });
    if (resp?.locked) {
      startPinLockout(resp);
      return;
    }
    if (!resp?.ok) throw new Error(resp?.error || "invalid pin");
    stopPinLockout();
    unlockedPin = pin;
    await refreshDefaultPinHint();
    showActions();
    await refreshActionState();
    focusPrimaryAction();
  } catch (e) {
    unlockedPin = "";
    clearPin();
    showPin();
    setMsg("Invalid PIN.", true);
  } finally {
    if (btn && !isPinLocked()) btn.disabled = false;
  }
}

function isProbablyYouTubeChannelUrl(tabUrl) {
  try {
    const url = new URL(String(tabUrl || ""));
    if (!/(^|\.)youtube\.com$/.test(url.hostname)) return false;
    return url.pathname.startsWith("/@") || url.pathname.startsWith("/channel/");
  } catch {
    return false;
  }
}

function isOptionsPageUrl(tabUrl) {
  try {
    const url = new URL(String(tabUrl || ""));
    return url.protocol === "moz-extension:" && url.pathname.endsWith("/src/options.html");
  } catch {
    return false;
  }
}

function hideActionButtons() {
  for (const id of ["addChannel", "allowDay", "enableForever", "enableDay", "switchForever", "switchDay", "disableChannel", "deleteChannel"]) {
    document.getElementById(id)?.classList.add("hidden");
  }
}

function setContextLabel(text) {
  const el = document.getElementById("contextLabel");
  if (el) el.textContent = text || "";
}

function channelLabel(context) {
  return context?.status?.entry?.name || context?.channelName || context?.channelKey || "";
}

function looksLikeHandleLabel(text) {
  return /^@[0-9A-Za-z._-]{3,}$/.test(String(text || "").trim());
}

function renderActionState() {
  hideActionButtons();
  setMsg("");

  if (!activeContext?.channelKey) {
    setContextLabel("");
    return;
  }

  setContextLabel(channelLabel(activeContext));
  const status = activeContext.status || {};
  const isListed = Boolean(status.whitelisted);
  const isEnabled = status.whitelisted && status.entry?.enabled !== false;
  const isActive = Boolean(status.active);

  if (isListed && !isEnabled) {
    document.getElementById("enableForever")?.classList.remove("hidden");
    document.getElementById("enableDay")?.classList.remove("hidden");
    document.getElementById("deleteChannel")?.classList.remove("hidden");
    return;
  }

  if (!status.whitelisted || !isActive) {
    document.getElementById("addChannel")?.classList.remove("hidden");
    document.getElementById("allowDay")?.classList.remove("hidden");
    return;
  }

  if (status.mode === "day") {
    document.getElementById("switchForever")?.classList.remove("hidden");
  } else {
    document.getElementById("switchDay")?.classList.remove("hidden");
  }
  document.getElementById("disableChannel")?.classList.remove("hidden");
  document.getElementById("deleteChannel")?.classList.remove("hidden");
}

async function getApprovalContext() {
  const tab = await getActiveTab();
  if (!tab?.id) return null;

  const fromBlocked = parseBlockedPageChannel(tab.url);
  if (fromBlocked) return { tab, channelKey: fromBlocked.channelKey, channelName: fromBlocked.channelName, originalUrl: fromBlocked.originalUrl };

  if (!isProbablyYouTubeChannelUrl(tab.url)) {
    try {
      const extracted = await webext.tabsSendMessage(tab.id, { type: "channel.extract" });
      if (extracted?.channelKey) {
        return { tab, channelKey: extracted.channelKey, channelName: extracted.channelName || "", originalUrl: tab.url };
      }
    } catch {
      // Fall through to URL resolver.
    }
  }

  const fromTabUrl = await resolveChannelFromTabUrl(tab.url);
  if (fromTabUrl.channelKey) return { tab, ...fromTabUrl, originalUrl: tab.url };
  return null;
}

async function refreshActionState() {
  activeContext = await getApprovalContext();
  if (activeContext?.channelKey) {
    const resp = await webext.runtimeSendMessage({ type: "channel.status", pin: unlockedPin, channelKey: activeContext.channelKey });
    if (resp?.ok) activeContext.status = resp;
    if (looksLikeHandleLabel(activeContext.channelName) || !activeContext.channelName) {
      try {
        const resolved = await webext.runtimeSendMessage({
          type: "resolve.channel",
          input: activeContext.originalUrl || activeContext.channelKey
        });
        if (resolved?.ok && resolved.channel?.name && !looksLikeHandleLabel(resolved.channel.name)) {
          activeContext.channelName = resolved.channel.name;
        }
      } catch {
        // Best-effort display enrichment only.
      }
    }
  }
  renderActionState();
}

function parseBlockedPageChannel(tabUrl) {
  try {
    const url = new URL(String(tabUrl || ""));
    const isBlocked = url.protocol === "moz-extension:" && url.pathname.endsWith("/src/blocked.html");
    if (!isBlocked) return null;
    const channelKey = url.searchParams.get("channelKey") || "";
    const channelName = url.searchParams.get("channelName") || "";
    const originalUrl = url.searchParams.get("url") || "";
    if (!channelKey) return null;
    return { channelKey, channelName, originalUrl };
  } catch {
    return null;
  }
}

async function resolveChannelFromTabUrl(tabUrl) {
  const rawUrl = String(tabUrl || "");
  if (!rawUrl) return { channelKey: "", channelName: "" };

  const direct = parseChannelKey(rawUrl);
  if (direct.startsWith("handle:") || direct.startsWith("channelId:")) {
    return { channelKey: direct, channelName: "" };
  }

  try {
    const resp = await webext.runtimeSendMessage({ type: "resolve.channel", input: rawUrl });
    if (!resp?.ok || !resp?.channel?.key) return { channelKey: "", channelName: "" };
    const resolved = parseChannelKey(resp.channel.key);
    if (!resolved || !(resolved.startsWith("handle:") || resolved.startsWith("channelId:"))) {
      return { channelKey: "", channelName: "" };
    }
    return { channelKey: resolved, channelName: String(resp.channel.name || "") };
  } catch {
    return { channelKey: "", channelName: "" };
  }
}

async function addChannel(duration = "permanent") {
  setMsg("");
  if (!unlockedPin) {
    showPin();
    setMsg("Enter PIN first.", true);
    return;
  }

  const context = activeContext || await getApprovalContext();
  if (!context?.tab?.id || !context.channelKey) {
    activeContext = null;
    renderActionState();
    setMsg("Open a YouTube video/channel page or the blocked page for that video.", true);
    return;
  }

  const addBtn = document.getElementById(duration === "day" ? "allowDay" : "addChannel");
  if (addBtn) addBtn.disabled = true;

  try {
    const resp = await webext.runtimeSendMessage({
      type: "approve.channel",
      pin: unlockedPin,
      channelKey: context.channelKey,
      channelName: context.channelName,
      url: context.originalUrl || context.tab.url,
      duration
    });
    if (!resp?.ok) throw new Error(resp?.error || "Approval failed");

    if (context.originalUrl && context.originalUrl !== context.tab.url) {
      await webext.tabsUpdate(context.tab.id, { url: context.originalUrl });
    } else {
      await webext.tabsReload(context.tab.id);
    }
    setMsg(`${duration === "day" ? "Allowed for 1 day" : "Allowed"}: ${context.channelName || context.channelKey}`);
    window.close();
  } catch (e) {
    setMsg(String(e?.message || e), true);
  } finally {
    if (addBtn) addBtn.disabled = false;
  }
}

async function updateChannel(action) {
  setMsg("");
  if (!unlockedPin) {
    showPin();
    setMsg("Enter PIN first.", true);
    return;
  }

  const context = activeContext || await getApprovalContext();
  if (!context?.channelKey) {
    activeContext = null;
    renderActionState();
    return;
  }

  try {
    const resp = await webext.runtimeSendMessage({
      type: "channel.update",
      pin: unlockedPin,
      channelKey: context.channelKey,
      channelName: context.channelName,
      url: context.originalUrl || context.tab?.url || "",
      action
    });
    if (!resp?.ok) throw new Error(resp?.error || "Update failed");
    await refreshActionState();
    if (context.tab?.id) await webext.tabsReload(context.tab.id);
    window.close();
  } catch (e) {
    setMsg(String(e?.message || e), true);
  }
}

document.getElementById("addChannel")?.addEventListener("click", () => void addChannel("permanent"));
document.getElementById("allowDay")?.addEventListener("click", () => void addChannel("day"));
document.getElementById("enableForever")?.addEventListener("click", () => void updateChannel("allow-permanent"));
document.getElementById("enableDay")?.addEventListener("click", () => void updateChannel("allow-day"));
document.getElementById("switchForever")?.addEventListener("click", () => void updateChannel("allow-permanent"));
document.getElementById("switchDay")?.addEventListener("click", () => void updateChannel("allow-day"));
document.getElementById("disableChannel")?.addEventListener("click", () => void updateChannel("disable"));
document.getElementById("deleteChannel")?.addEventListener("click", () => void updateChannel("delete"));

document.getElementById("openOptions")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (!unlockedPin) {
    showPin();
    setMsg("Enter PIN first.", true);
    return;
  }
  void chrome.runtime.openOptionsPage();
  window.close();
});

// Enter triggers unlock.
document.getElementById("pin")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void unlock();
});
document.getElementById("unlock")?.addEventListener("click", () => void unlock());
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "pin.lockout.changed" && message.locked) {
    startPinLockout(message);
  }
});

async function init() {
  const tab = await getActiveTab();
  if (isOptionsPageUrl(tab?.url)) {
    window.close();
    return;
  }
  showPin();
  await refreshDefaultPinHint();
  const locked = await refreshPinLockout();
  showPopup();
  if (!locked) focusPin();
}

void init().catch(() => {
  showPin();
  showPopup();
  focusPin();
});
