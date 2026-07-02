# Contributing

Thanks for improving ChannelGuard.

## Scope

Useful contributions include:

- Firefox/WebExtension compatibility fixes
- YouTube navigation blocking edge cases
- PIN/session and whitelist-management hardening
- accessibility and keyboard-flow improvements
- AMO review-readiness improvements
- documentation fixes

## Rules

- Do not add telemetry, analytics, accounts, cloud sync, or remote executable code.
- Do not export PIN hash, PIN salt, or hidden sensitive state.
- Do not use YouTube, Google, Mozilla, or Firefox logos in assets.
- Do not treat display names as allow keys. Use stable `handle:` or `channelId:` keys.
- Keep permissions minimal and explainable.
- Avoid `innerHTML` for user-controlled content.

## Checks

Run before opening a pull request:

```powershell
$root = Get-Location
Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json | Out-Null
Get-ChildItem -LiteralPath (Join-Path $root 'src') -Filter *.js -File | ForEach-Object {
  node --check $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "node --check failed: $($_.FullName)" }
}
$env:npm_config_strict_ssl='false'
npx --yes web-ext lint --source-dir $root --self-hosted
```

Manual QA should cover:

- allowed channel video plays
- direct non-approved video blocks
- recommendation/sidebar navigation blocks
- popup action states
- blocked-page action states
- Options PIN/session/export/import flow
