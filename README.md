# Inferfox ChannelGuard

Inferfox ChannelGuard helps parents keep YouTube limited to trusted channels in desktop Firefox.

YouTube can quickly lead children from one safe video to unrelated recommendations, shorts, or channels that parents did not choose. Inferfox ChannelGuard blocks YouTube video pages by default in desktop Firefox and lets a parent approve trusted channels with a PIN.

It is designed for household use: a parent approves a channel permanently or for one day, and manages the whitelist in Firefox.

Current support target: desktop Firefox 142 or newer.

Inferfox ChannelGuard is independent and is not affiliated with YouTube or Google.

## Features

- Deny-by-default YouTube video playback.
- Channel approvals by stable `handle:` or `channelId:` keys.
- Permanent and 1-day approvals.
- Disabled-channel and removal controls.
- PIN-protected popup, blocked page, and Options actions.
- Local whitelist export/import without PIN hash or salt.
- Local audit log.
- No accounts, cloud dashboard, telemetry, or remote policy service.

## Install For Local Testing

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on...**.
3. Select `manifest.json` from this folder.

Default PIN on first install:

```text
0000
```

Change it in Options after testing begins.

## Usage

- Open a YouTube video or channel page.
- Click the Inferfox ChannelGuard toolbar button and enter the PIN.
- Use default PIN `0000` on first install, then change it in Options.
- Approve the channel forever or for one day.
- Manage channels, backup JSON, PIN, and audit entries from Options.

## Data Handling

Inferfox ChannelGuard stores whitelist entries, PIN verification data, and local audit entries only in Firefox extension storage on the user's device.

It does not send data to the developer and does not use telemetry, analytics, accounts, cloud sync, tracking, or remote policy services.

To resolve the channel for the YouTube page being evaluated, Inferfox ChannelGuard may request YouTube oEmbed, channel, or video pages. This data is sent only to YouTube/Google as part of enforcing the local policy.

See [PRIVACY.md](PRIVACY.md).

## Limitations

Inferfox ChannelGuard is a browser-level household tool. It is not a device-level parental-control system.

A user who can disable extensions, use another browser or Firefox profile, change Firefox settings, or modify local profile data can bypass it.

For child devices, use Firefox Enterprise Policies or OS-level parental controls.

## Storage Migrations

Inferfox ChannelGuard keeps user policy data in `browser.storage.local` under the `ytWhitelist.*` keys. Public updates must preserve existing whitelist, PIN hash, PIN salt, and audit data.

The runtime migration point is `src/background.js -> migrateWhitelistStorageSnapshot()`. Any future storage-shape change must update that normalizer and add a fixture to `tests/storage_migration.test.js`.

Run before every public release:

```powershell
node .\tests\storage_migration.test.js
```

## Firefox Enterprise Policies

For child devices, Firefox Enterprise Policies can help lock the extension and restrict browser settings. This is optional and environment-specific.

Example policy fragment:

```json
{
  "policies": {
    "DisablePrivateBrowsing": true,
    "DisableSafeMode": true,
    "BlockAboutAddons": true,
    "BlockAboutConfig": true,
    "BlockAboutProfiles": true,
    "ExtensionSettings": {
      "channelguard-youtube-whitelist@local-first.tools": {
        "installation_mode": "force_installed"
      }
    }
  }
}
```

Adjust policies to your Firefox version and deployment model.

## Development Checks

Run for local development and home testing:

```powershell
$root = Get-Location
Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json | Out-Null
Get-Content -LiteralPath (Join-Path $root 'data\default_whitelist.json') -Raw | ConvertFrom-Json | Out-Null
Get-ChildItem -LiteralPath (Join-Path $root 'src') -Filter *.js -File | ForEach-Object {
  node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "node --check failed: $($_.FullName)" }
}
node (Join-Path $root 'tests\storage_migration.test.js')
$env:npm_config_strict_ssl='false'
npx --yes web-ext lint --source-dir $root
```

Run before an AMO upload:

```powershell
$root = Get-Location
npx --yes web-ext lint --source-dir $root --warnings-as-errors
```

## License

MIT. See [LICENSE](LICENSE).
