# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-04-02

Initial release of snitchr — a self-hosted server monitoring tool powered by a zero-dependency bash agent.

### Added

#### Core Monitoring
- Lightweight bash agent collecting CPU, memory, disk, load averages, process count, network I/O, and uptime
- Heartbeat-based online/offline detection with configurable timeout (30–600s)
- Process, port, mount, and TTY session tracking with baseline-driven anomaly detection
- Disk velocity prediction via OLS linear regression (trend + hours-to-threshold)
- File integrity monitoring for critical paths (`/etc/passwd`, `sshd_config`, crontabs, authorized_keys, PAM config)
- Authentication event tracking (SSH logins/failures, sudo, su)
- Resource spike alerts for CPU, memory, and disk (configurable thresholds, cooldown deduplication)

#### Dashboard
- Single-page setup wizard with password and storage backend selection
- Machine overview with online status, alert counts, disk fill predictions, and geolocation
- Machine detail view with full metrics, alert history, daily event timeline, process/port/mount/TTY info
- Settings page with notification channel config, feature toggles, password management, and version checker

#### Notifications
- **ntfy** — POST to ntfy.sh or self-hosted endpoints with configurable priority
- **Webhooks** — HTTP POST with optional HMAC-SHA-256 signing and timestamp headers
- **Slack** — formatted incoming webhooks with color-coded priority blocks
- **Web Push** — browser notifications via VAPID/RFC 8291 with AES-128-GCM encryption
- Multi-channel simultaneous delivery with transient error retry
- Test notification endpoint for verifying channel configuration

#### Security
- PBKDF2-HMAC-SHA-256 password hashing (100k iterations)
- HMAC-signed session cookies (24h TTL, httpOnly, Secure, SameSite=Strict)
- Per-machine bearer tokens (48-char hex) for agent authentication
- IP-based rate limiting on login (5 attempts / 15 minutes)
- One-time token flow for secure machine registration

#### Storage Backends
- **Cloudflare R2** — primary, via R2BucketLike interface
- **S3-compatible** — Backblaze B2, DigitalOcean Spaces, MinIO, Scaleway, Oracle
- **Filesystem** — local directory with atomic writes
- **In-memory** — ephemeral, for testing and development

#### Multi-Runtime Support
- Cloudflare Workers (primary target)
- Node.js 20+
- Bun

#### Agent
- Zero external dependencies — bash, curl, and standard Linux utilities only
- Platform-aware modules (Linux/macOS)
- One-command install via `curl | bash` with token-based registration
- Configurable heartbeat interval (default 60s)
- Exponential backoff retry on registration failure
- Graceful shutdown via SIGTERM/SIGINT with PID file tracking

#### API
- RESTful JSON API with OpenAPI 3.1.0 specification
- 8KB ingest payload limit with strict schema validation
- Paginated event logs (200 entries/page, daily partitioned)
- Capped alert history (100 per machine)
- Background scheduled jobs for offline detection and disk fill alerts
- Factory reset endpoint with password confirmation
