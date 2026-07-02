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

function setMsg(text, isError) {
  const el = document.getElementById("msg");
  if (!el) return;
  el.textContent = text || "";
  el.className = isError ? "msg err" : "msg";
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
  const resp = await webext.runtimeSendMessage({ type: "pin.verify", pin });
  if (!resp?.ok) {
    setMsg("Invalid PIN.", true);
    return;
  }
  unlockedPin = pin;
  document.getElementById("pinBox")?.classList.add("hidden");
  document.getElementById("actions")?.classList.remove("hidden");
  setMsg("");
  await refreshChannelStatus();
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

renderDetails();
renderActions();
void enrichChannel();
