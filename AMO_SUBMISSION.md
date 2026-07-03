# AMO Submission Notes

## Listing

Name:

```text
ChannelGuard
```

Summary:

```text
Allow YouTube videos only from parent-approved channels.
```

Description:

```text
YouTube can quickly lead children from one safe video to unrelated recommendations, shorts, or channels that parents did not choose. ChannelGuard helps parents keep YouTube limited to trusted channels in Firefox.

By default, ChannelGuard blocks YouTube video pages. A parent unlocks with a PIN and approves a channel permanently or for one day from the toolbar popup or blocked page. Approved channels can play; other channels are redirected to a clear blocked page.

Parents can manage the whitelist in Options, export/import policy JSON, change the PIN, and review a local audit log.

ChannelGuard works on your device. It does not use accounts, cloud sync, telemetry, analytics, or remote dashboards. Whitelist, PIN, and audit data stay in Firefox extension storage.

ChannelGuard is independent and is not affiliated with YouTube or Google.

Help improve ChannelGuard or report issues here:
https://github.com/inferixon/channelguard-firefox
```

Categories:

```text
Privacy & Security
```

Tags:

```text
content blocker, privacy, security, streaming, youtube
```

Homepage:

```text
https://github.com/inferixon/channelguard-firefox
```

Support:

```text
https://github.com/inferixon/channelguard-firefox/issues
```

License:

```text
MIT
```

## Privacy

Privacy policy:

```text
ChannelGuard stores approved channel entries, channel labels, approval mode and expiration time, PIN hash and salt, and local audit entries in Firefox extension storage on the user's device.

ChannelGuard does not transmit browsing history, whitelist data, PIN data, analytics, telemetry, or personal data to the developer or any third-party server.

Policy export/import includes whitelist policy data only. PIN hash and salt are not exported.

ChannelGuard is independent and is not affiliated with YouTube or Google.
```

Data collection declaration:

```text
No data collection.
```

Manifest declaration:

```json
"data_collection_permissions": {
  "required": ["none"]
}
```

## Reviewer Notes

```text
Default PIN: 0000.

Test flow:
1. Open a YouTube video from a non-approved channel.
2. Confirm ChannelGuard blocks playback.
3. Enter PIN 0000 on the blocked page or popup.
4. Allow the channel permanently or for 1 day.
5. Confirm the video reloads and plays.
6. Open Options to manage whitelist entries, backup JSON, PIN, and audit log.
7. Export whitelist JSON and confirm PIN hash/salt are not included.

Data handling:
The extension stores whitelist entries, PIN hash/salt, and audit entries locally in browser.storage.local. It does not transmit this data to any server.

Source:
The submitted package is plain WebExtension source with no build step, bundling, minification, obfuscation, remote executable code, or third-party runtime dependency.
```

## Screenshot Checklist

Prepared screenshots:

```text
A:\PROJECTS\DINOPOLICY\INBOX\ScreenShot-001.jpg
A:\PROJECTS\DINOPOLICY\INBOX\ScreenShot-002.jpg
A:\PROJECTS\DINOPOLICY\INBOX\ScreenShot-003.jpg
```

Coverage:

- Blocked page / policy surface.
- Popup or action surface.
- Options management surface.

Captions:

```text
A blocked YouTube video shows the channel, reason, and PIN unlock prompt.
After PIN unlock, parents can allow the channel permanently or for one day.
Options lets parents manage the whitelist, backups, PIN, and local audit log.
```

## Pre-Submission Checks

- JSON parse passes.
- JS syntax check passes.
- `web-ext lint` passes with no errors or warnings.
- Manual Firefox QA passes for blocking, approval, popup states, Options, and export/import.
