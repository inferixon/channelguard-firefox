/* Blocked page approval UI. */

/* global isYouTubeVideoUrl, parseChannelKey, webext */

function qs(name) {
  const pageUrl = new URL(window.location.href);
  return pageUrl.searchParams.get(name) || "";
}

const originalUrl = qs("url");
let channelKey = qs("channelKey");
let channelName = qs("channelName");
const reason = qs("reason") || "not-whitelisted";
let unlockedPin = "";
let channelStatus = null;
let pinLockoutTimer = 0;
let pinLockedUntil = 0;

function setMsg(text, isError) {
  const el = document.getElementById("msg");
  if (!el) return;
  el.textContent = text || "";
  el.className = isError ? "msg err" : "msg";
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
  if (isFocusableButton("allowForever")) {
    focusButton("allowForever");
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
  document.getElementById("pinBox")?.classList.remove("hidden");
  document.getElementById("actions")?.classList.add("hidden");
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

function returnToOriginalUrl() {
  if (originalUrl && isYouTubeVideoUrl(originalUrl)) {
    window.location.replace(originalUrl);
    return true;
  }
  return false;
}

function renderDetails() {
  const details = document.getElementById("details");
  if (!details) return;
  const parts = [];
  if (channelName) parts.push(`Channel: ${channelName}`);
  if (channelKey) parts.push(`Key: ${channelKey}`);
  if (reason) parts.push(`Reason: ${reason}`);
  if (originalUrl) parts.push(`URL: ${originalUrl}`);
  details.textContent = parts.join(" | ");
}

function approvalRequestText() {
  return [
    "ChannelGuard approval request",
    `URL: ${originalUrl || "(unknown)"}`,
    `Channel: ${channelName || "(unknown)"}`,
    `Channel key: ${channelKey || "(unresolved)"}`,
    `Reason: ${reason}`
  ].join("\n");
}

async function enrichChannel() {
  if ((!channelName || channelName === channelKey) && originalUrl) {
    try {
      const resp = await webext.runtimeSendMessage({ type: "resolve.channel", input: originalUrl });
      if (resp?.ok && resp.channel?.key) {
        channelKey = channelKey || resp.channel.key;
        channelName = resp.channel.name || channelName;
        renderDetails();
      }
    } catch {
      // Best-effort display enrichment only.
    }
  }
}

function setActionVisible(id, visible) {
  document.getElementById(id)?.classList.toggle("hidden", !visible);
}

function renderActions() {
  const hasChannel = Boolean(channelKey);
  const status = channelStatus || {};
  const isListed = Boolean(status.whitelisted);
  const isDisabled = isListed && status.entry?.enabled === false;
  const isActive = Boolean(status.active);
  const canAllow = hasChannel && (!isListed || (!isDisabled && !isActive));
  const canManage = hasChannel && isListed && !isDisabled && isActive;

  setActionVisible("allowForever", canAllow);
  setActionVisible("allowDay", canAllow);
  setActionVisible("enableForever", hasChannel && isDisabled);
  setActionVisible("enableDay", hasChannel && isDisabled);
  setActionVisible("switchForever", canManage && status.mode === "day");
  setActionVisible("switchDay", canManage && status.mode !== "day");
  setActionVisible("disableChannel", canManage);
  setActionVisible("deleteChannel", hasChannel && isListed);
  setActionVisible("copyRequest", !hasChannel || (!isDisabled && !isActive));
  setActionVisible("openOptions", true);
}

async function refreshChannelStatus() {
  channelStatus = null;
  if (!unlockedPin) return;
  if (!channelKey) await enrichChannel();
  if (!channelKey) {
    renderActions();
    return;
  }
  const resp = await webext.runtimeSendMessage({
    type: "channel.status",
    pin: unlockedPin,
    channelKey
  });
  if (resp?.ok) channelStatus = resp;
  renderActions();
}

async function unlock() {
  const pin = String(document.getElementById("pin")?.value || "").trim();
  if (!pin) {
    setMsg("Enter PIN.", true);
    return;
  }
  if (isPinLocked()) {
    updatePinLockoutMessage();
    return;
  }
  const resp = await webext.runtimeSendMessage({ type: "pin.verify", pin });
  if (resp?.locked) {
    startPinLockout(resp);
    return;
  }
  if (!resp?.ok) {
    clearPin();
    focusPin();
    setMsg("Invalid PIN.", true);
    return;
  }
  stopPinLockout();
  unlockedPin = pin;
  await refreshDefaultPinHint();
  document.getElementById("pinBox")?.classList.add("hidden");
  document.getElementById("actions")?.classList.remove("hidden");
  setMsg("");
  await refreshChannelStatus();
  focusPrimaryAction();
}

async function approve(duration) {
  if (!unlockedPin) {
    setMsg("Enter PIN first.", true);
    return;
  }
  if (!channelKey) {
    await enrichChannel();
  }
  if (!channelKey) {
    setMsg("Channel is unresolved. Copy request instead.", true);
    return;
  }
  const resp = await webext.runtimeSendMessage({
    type: "approve.channel",
    pin: unlockedPin,
    channelKey,
    channelName,
    url: originalUrl,
    duration
  });
  if (!resp?.ok) {
    setMsg(resp?.error || "Approval failed.", true);
    return;
  }
  if (!returnToOriginalUrl()) setMsg("Approved.");
}

async function updateChannel(action) {
  if (!unlockedPin) {
    setMsg("Enter PIN first.", true);
    return;
  }
  if (!channelKey) await enrichChannel();
  if (!channelKey) {
    setMsg("Channel is unresolved. Copy request instead.", true);
    return;
  }
  const resp = await webext.runtimeSendMessage({
    type: "channel.update",
    pin: unlockedPin,
    channelKey,
    channelName,
    url: originalUrl,
    action
  });
  if (!resp?.ok) {
    setMsg(resp?.error || "Update failed.", true);
    return;
  }
  if (action === "disable" || action === "delete") {
    setMsg(action === "delete" ? "Channel removed." : "Channel disabled.");
    await refreshChannelStatus();
  } else if (!returnToOriginalUrl()) {
    setMsg("Updated.");
    await refreshChannelStatus();
  }
}

async function copyRequest() {
  const text = approvalRequestText();
  const area = document.getElementById("requestText");
  if (area) {
    area.hidden = false;
    area.value = text;
    area.select();
  }
  try {
    await navigator.clipboard.writeText(text);
    setMsg("Approval request copied.");
  } catch {
    try {
      document.execCommand("copy");
      setMsg("Approval request selected/copied.");
    } catch {
      setMsg("Approval request is selected. Copy it manually.");
    }
  }
}

document.getElementById("unlock")?.addEventListener("click", () => void unlock());
document.getElementById("pin")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void unlock();
});
document.getElementById("allowForever")?.addEventListener("click", () => void approve("permanent"));
document.getElementById("allowDay")?.addEventListener("click", () => void approve("day"));
document.getElementById("enableForever")?.addEventListener("click", () => void updateChannel("allow-permanent"));
document.getElementById("enableDay")?.addEventListener("click", () => void updateChannel("allow-day"));
document.getElementById("switchForever")?.addEventListener("click", () => void updateChannel("allow-permanent"));
document.getElementById("switchDay")?.addEventListener("click", () => void updateChannel("allow-day"));
document.getElementById("disableChannel")?.addEventListener("click", () => void updateChannel("disable"));
document.getElementById("deleteChannel")?.addEventListener("click", () => void updateChannel("delete"));
document.getElementById("copyRequest")?.addEventListener("click", () => void copyRequest());
document.getElementById("openOptions")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "pin.lockout.changed" && message.locked) {
    startPinLockout(message);
  }
});

renderDetails();
renderActions();
void enrichChannel();
void (async () => {
  await refreshDefaultPinHint();
  const locked = await refreshPinLockout();
  if (!locked) focusPin();
})();
