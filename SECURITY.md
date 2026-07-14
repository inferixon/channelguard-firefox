# Security Policy

## Supported Versions

Security fixes target the latest public AMO version of Inferfox ChannelGuard.

Older versions may receive fixes only when the issue affects an update path from that version to the latest public release.

## Reporting A Vulnerability

Please report security issues privately when possible:

- GitHub Security Advisories for this repository, if available.
- GitHub Issues only for non-sensitive reports that do not expose an exploit path.

Do not include real child data, private browsing data, PIN hashes, PIN salts, exported household policy files, or screenshots containing personal information in a public issue.

## What To Report

Useful security reports include:

- bypasses that allow non-approved YouTube videos or channels to play;
- approval, PIN, admin-session, or lockout failures;
- export/import behavior that leaks PIN verification data;
- storage migration bugs that lose or corrupt whitelist, PIN, or audit data;
- remote-code, dependency, permission, or content-script risks.

## Product Boundaries

Inferfox ChannelGuard is a browser-level household tool. It is not a device-level parental-control system.

A user who can disable extensions, use another browser or Firefox profile, change Firefox settings, or modify local profile data can bypass it.

For child devices, use Firefox Enterprise Policies or OS-level parental controls.

## Data Handling

Inferfox ChannelGuard stores whitelist entries, PIN verification data, and local audit entries in Firefox extension storage on the user's device.

It does not send data to the developer and does not use telemetry, analytics, accounts, cloud sync, tracking, or remote policy services.

To resolve the channel for the YouTube page being evaluated, Inferfox ChannelGuard may request YouTube oEmbed, channel, or video pages. This data is sent only to YouTube/Google as part of enforcing the local policy.
