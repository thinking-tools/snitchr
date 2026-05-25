<h1>⚠️ Moved to Codeberg: https://codeberg.org/thinking_tools/snitchr </h1>

<p align="center">
  <img src="static/web-app-manifest-512x512.png" alt="snitchr" width="120" />
</p>

<h1 align="center"><a href="https://snitchr.sh">snitchr</a></h1>

<p align="center">
  <em>Self-hosted server monitoring powered by a zero-dependency bash agent.</em>
</p>

<p align="center">
  Your servers report to your gateway. Your data never leaves your infrastructure.<br>
  MIT. Zero telemetry. Deploys in under 60 seconds. Free.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/snitchr"><img src="https://img.shields.io/npm/v/snitchr?color=cb0000&label=npm" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-blue" alt="TypeScript strict" /></a>
  <a href="https://www.npmjs.com/package/snitchr"><img src="https://img.shields.io/npm/unpacked-size/snitchr" alt="npm unpacked size" /></a>
  <a href="https://www.npmjs.com/package/snitchr"><img src="https://img.shields.io/npm/dw/snitchr" alt="npm downloads" /></a>
</p>

<p align="center">
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs Welcome" /></a>
  <a href="https://github.com/thinking-tools/snitchr/discussions"><img src="https://img.shields.io/github/discussions/thinking-tools/snitchr" alt="GitHub Discussions" /></a>
  <a href="https://github.com/thinking-tools/snitchr/wiki"><img src="https://img.shields.io/badge/docs-wiki-blueviolet" alt="Wiki" /></a>
  <a href="https://github.com/thinking-tools/snitchr/pulse"><img src="https://img.shields.io/github/commit-activity/w/thinking-tools/snitchr" alt="Commits per week" /></a>
</p>

<p align="center">
  <img src="screenshot.png" alt="Dashboard screenshot" width="720" />
</p>

---

## Features

- 📦 **Zero dependencies:** the agent needs nothing but `bash` and `curl`. No runtime, no container, no package manager.
- ⚖️ **MIT licensed:** no paid tier, no enterprise edition, no "contact sales." Fork it, modify it, ship it. [This will never change.](LICENSE)
- 🔇 **Zero telemetry:** your data flows from your servers to your gateway. No third parties. No phone-home. No analytics.
- 🌐 **Multi-runtime:** the gateway runs on Cloudflare Workers (free tier), Node.js 20+, or Bun. Pick what fits your stack.
- 🔍 **Auditable:** the entire agent is a single bash script. Read it end-to-end before you deploy it. We expect you to.
- 🔐 **Simple security:** Single user, PBKDF2-HMAC-SHA-256 password hashing, HMAC-signed sessions, per-machine bearer tokens, one-time registration flow. No hassle.
- 🗄️ **Flexible storage:** local filesystem, Cloudflare R2 (free), or bring your own S3-compatible bucket — Backblaze B2, DigitalOcean Spaces, MinIO, Scaleway, Oracle, and more.
- 🪶 **Resource-light:** the agent runs in single-digit MB of RAM. The gateway runs on Cloudflare's free tier or a $5 VPS.
- 🔔 **Multi-channel alerts:** [ntfy](https://ntfy.sh), webhooks with HMAC signing, Slack, and browser push notifications via Web Push (VAPID). All configurable from the dashboard. [See all channels.](#notification-channels)
- ✅ **Tested:** unit, integration, property-based, fuzz, and end-to-end tests. Static analysis via CodeQL and SonarCloud. OpenSSF Scorecard tracked.

<p align="center">
  <a href="https://github.com/thinking-tools/snitchr/actions/workflows/pipeline.yml"><img src="https://github.com/thinking-tools/snitchr/actions/workflows/pipeline.yml/badge.svg" alt="Pipeline" /></a>
  <a href="https://github.com/thinking-tools/snitchr/actions/workflows/codeql.yml"><img src="https://github.com/thinking-tools/snitchr/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <a href="https://securityscorecards.dev/viewer/?uri=github.com/thinking-tools/snitchr"><img src="https://api.securityscorecards.dev/projects/github.com/thinking-tools/snitchr/badge" alt="OpenSSF Scorecard" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=thinking-tools_snitchr"><img src="https://sonarcloud.io/api/project_badges/measure?project=thinking-tools_snitchr&metric=alert_status" alt="Quality Gate Status" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=thinking-tools_snitchr"><img src="https://sonarcloud.io/api/project_badges/measure?project=thinking-tools_snitchr&metric=reliability_rating" alt="Reliability Rating" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=thinking-tools_snitchr"><img src="https://sonarcloud.io/api/project_badges/measure?project=thinking-tools_snitchr&metric=security_rating" alt="Security Rating" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=thinking-tools_snitchr"><img src="https://sonarcloud.io/api/project_badges/measure?project=thinking-tools_snitchr&metric=sqale_rating" alt="Maintainability Rating" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=thinking-tools_snitchr"><img src="https://sonarcloud.io/api/project_badges/measure?project=thinking-tools_snitchr&metric=coverage" alt="Coverage" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=thinking-tools_snitchr"><img src="https://sonarcloud.io/api/project_badges/measure?project=thinking-tools_snitchr&metric=vulnerabilities" alt="Vulnerabilities" /></a>
</p>

## What snitchr snitches on

- **Heartbeat:** alive and online
- **Auth monitoring:** SSH logins, sudo events, authentication failures
- **File integrity:** /etc/passwd, sshd_config, crontabs, authorized_keys, PAM config, logging config (Linux); /etc/sudoers, LaunchDaemons, PAM config, logging config (macOS)
- **Process detection:** new processes vs captured baseline
- **Port detection:** new listening ports vs captured baseline
- **CPU spike alerts:** alert when CPU usage exceeds 90%
- **Memory spike alerts:** alert when memory usage exceeds 90%
- **Disk space alerts:** alert when disk usage exceeds 90% + trend of filling
- **Mount detection:** new filesystems mounted or existing ones removed vs baseline

## What snitchr doesn't do

snitchr monitors what matters on individual machines. It doesn't try to be everything.

- **Not an APM** — no distributed tracing, no request-level instrumentation, no flame graphs
- **Not a log aggregator** — no Elasticsearch, no Loki, no "ship all your logs somewhere"
- **Not a metrics pipeline** — no Prometheus scraping, no Grafana dashboards, no PromQL
- **Not an agent framework** — no plugins, no extensions, no scripting engine

If you need to trace requests across 200 microservices, use something else. If you want to know whether your servers are alive, secure, and behaving — snitchr.

## Notification channels

- **[ntfy](https://ntfy.sh):** push to any ntfy topic (self-hosted or ntfy.sh)
- **Webhooks:** POST JSON to any URL, with optional HMAC signing
- **Slack:** incoming webhook integration
- **Web Push:** browser notifications via the dashboard (VAPID/RFC 8292)

All channels are configured in the settings page. Multiple channels can be active simultaneously.

## Quick start

### Option A: Cloudflare Workers

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/thinking-tools/snitchr">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers" />
  </a>
</p>

Click **Deploy**, set a password in the setup wizard, and copy the install command to your server.

> **Note:** If deploy fails with an authentication error, enable your `*.workers.dev` subdomain first (CF dashboard → Compute → Workers & Pages → Subdomain), or add a [custom domain route](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) in `wrangler.toml`.

### Option B: Self-hosted (Node.js / Bun)

```bash
npx snitchr --port 8787
# or
bunx snitchr --port 8787
```

Open `http://localhost:8787`, set a password, choose your storage (filesystem or S3), and copy the install command.

### Install the agent

On each machine you want to monitor, paste the install command from the dashboard. It's a one-liner — registers the machine, builds a file integrity baseline, and starts the agent as a service:

```bash
# Linux or macOS — same command
sudo bash -c "$(curl -sSL 'https://your-gateway/agent?init=TOKEN')"
```

The installer auto-detects your OS — sets up a **systemd** service on Linux or a **launchd** daemon on macOS. That's it. Snitchr takes it from here.

## How it works

```
┌──────────────┐     heartbeats      ┌───────────────────┐     alerts    ┌──────────┐
│ Linux / macOS│────────────────────▶│  snitchr gateway  │──────────────▶│ ntfy /   │
│ (bash agent) │  security events    │  (CF / Node / Bun)│               │ web push │
└──────────────┘                     └────────┬──────────┘               └──────────┘
                                              │
                                      ┌───────┴───────┐
                                      │   Dashboard   │
                                      │  (browser UI) │
                                      └───────────────┘
```

- **Agent:** a bash script with platform modules for Linux (systemd, `/proc`, journalctl) and macOS (launchd, `sysctl`/`vm_stat`, Unified Logging). No runtime dependencies beyond bash and curl.
- **Gateway:** a Hono app that stores data in R2/S3/filesystem, serves the dashboard, and pushes alerts. Runs on Cloudflare Workers free tier, Node.js 18+, or Bun.
- **Dashboard:** static HTML served by the gateway. Machine overview, event timeline, alert history. No frontend framework.

## Supported platforms

| Platform              | Service manager | Auth log source                  | File watcher       | Tested on                 |
| --------------------- | --------------- | -------------------------------- | ------------------ | ------------------------- |
| Linux (Debian/Ubuntu) | systemd         | journalctl                       | inotifywait        | Ubuntu 22.04+, Debian 12+ |
| macOS                 | launchd         | Unified Logging (`/usr/bin/log`) | fswatch (optional) | macOS 13+                 |

## Why a bash agent?

Because `bash` is already on every Linux server and every Mac you'll ever touch. No runtime to install. No container to pull. No 400 MB binary just to check if a file changed.

Just `#!/usr/bin/env bash`, a platform module, and the quiet confidence of a grandmother who has seen it all.

## Documentation

Full docs live in the **[Wiki](https://github.com/thinking-tools/snitchr/wiki)** — installation guides, configuration reference, update instructions, and more.

| Topic                | Link                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| Installation & setup | [Wiki: Getting Started](https://github.com/thinking-tools/snitchr/wiki/Getting-Started) |
| Configuration        | [Wiki: Configuration](https://github.com/thinking-tools/snitchr/wiki/Configuration)     |
| Updating             | [Wiki: Updating](https://github.com/thinking-tools/snitchr/wiki/Updating)               |
| Agent reference      | [Wiki: Agent](https://github.com/thinking-tools/snitchr/wiki/Agent)                     |
| API reference        | [Wiki: API](https://github.com/thinking-tools/snitchr/wiki/API)                         |

## Security

- Agent auth: per-machine bearer token (random 24-byte hex), one-time registration flow
- Password hashing: PBKDF2-HMAC-SHA-256 with 100k iterations (max CF limit)
- Sessions: HMAC-signed expiry timestamps in httpOnly cookies (24h TTL)
- All data stays on your infrastructure: no telemetry, no phoning home

Found a vulnerability? Please follow the [SECURITY.md](SECURITY.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture overview, and testing guide.

```bash
git clone https://github.com/thinking-tools/snitchr.git
cd snitchr && npm install
npm run dev          # Cloudflare Workers (wrangler)
npm run dev:node     # Node.js (filesystem storage)
npm test             # vitest (unit + integration)
```

## License

[MIT](LICENSE) · Use at your own risk
