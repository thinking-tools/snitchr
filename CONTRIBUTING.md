# Contributing to snitchr

## Before you start

1. **Got an idea or hypothesis?** Open a [Discussion](https://github.com/thinking-tools/snitchr/discussions) first. This is the place to explore ideas, ask questions, and get feedback before committing to implementation work.
2. **Ready to report a bug or propose a concrete change?** Open an [Issue](https://github.com/thinking-tools/snitchr/issues). If the issue is labeled **WIP**, it's already being worked on — don't pick it up. If it's open and unassigned, comment and ask to be assigned before starting work.
3. **Want to submit code?** Make sure there's an issue for it and you're assigned. Then fork, branch off `dev`, and open a PR **targeting `dev`**. Your branch must be up to date with `dev` before merging.

## Development setup

```bash
git clone https://github.com/thinking-tools/snitchr.git
cd snitchr
npm install
```

### Run locally

**Cloudflare Workers (wrangler dev):**

```bash
npm run dev
```

**Node.js / Bun (filesystem storage, no CF account needed):**

```bash
npm run dev:node
```

The Node/Bun server auto-detects your LAN IP so install commands work from Docker containers and remote machines without manual URL editing.

### Trigger scheduled checks

The gateway checks for down machines and disk fill predictions every 5 minutes.

**Cloudflare Workers** — trigger manually during local dev:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled"
```

**Node.js / Bun** — runs automatically via an internal timer. No manual trigger needed.

### Run remotely (Cloudflare preview)

If using R2 storage, create the bucket first:

```bash
wrangler r2 bucket create snitchr-storage
npm run dev:remote
```

If you prefer S3 storage, comment out the `[[r2_buckets]]` section in `wrangler.toml` — the setup wizard will show only the S3 option.

## Testing

```bash
npm test                        # all tests (vitest)
npm run test:unit               # unit tests only (src/*.test.ts)
npm run test:integration        # integration tests (src/__tests__/integration/)
npm run test:watch              # vitest watch mode
npx vitest run src/crypto.test.ts  # single file
npm run typecheck               # TypeScript (both CF and Node configs)
```

### Agent tests (Docker)

Boots Debian + Ubuntu containers with systemd, installs the agent on both, and captures all traffic via a mock gateway.

```bash
npm run test:agent              # build, boot, install agents
npm run test:agent:logs         # tail mock gateway output
npm run test:agent:down         # tear down containers
```

### E2E tests (real gateway + Docker agent)

Runs the real gateway (not mocks) against a Docker agent. Two variants:

- **Bun** — Bun + filesystem storage (no credentials needed)
- **CF** — Cloudflare Workers (wrangler dev) + S3 storage (requires `.env` with S3 creds)

```bash
npm run test:e2e:bun            # Bun variant
npm run test:e2e:cf             # CF Workers variant
npm run test:e2e                # both sequentially
npm run test:e2e:down           # tear down containers
```

## Development workflow

### Seed local KV with sample data

Creates a config with two sample machines and a known dev password so you can work on the dashboard UI without going through setup.

```bash
npm run seed                    # seeds KV -> login with password "snitchr"
npm run dev                     # start local dev server
npm run seed:status             # send fake heartbeats for dashboard UI
```

Reset everything:

```bash
npm run clear                   # wipe KV config
```

### Interactive sandbox

Spins up a Debian container you can shell into to test the full install flow against your local dev server.

```bash
npm run dev                     # terminal 1: start local dev server
npm run sandbox                 # terminal 2: drops you into a Debian shell
```

Inside the container, use `host.docker.internal` to reach your host machine's dev server:

```bash
curl -sSL 'http://host.docker.internal:8787/agent?init=YOUR_TOKEN' | bash
```

When you exit the shell, the container stays. Re-run `npm run sandbox` to reconnect.

```bash
npm run sandbox:wipe            # remove sandbox container and data
```

### Collect sample data from test runs

```bash
npm run seed:collect            # extracts fixtures from Docker test logs to dev/fixtures/
```

### Full workflow

```bash
# 1. Seed, start dev server, populate dashboard
npm run seed                    # password: "snitchr"
npm run dev                     # start dev server (keep running)
npm run seed:status             # send fake heartbeats

# 2a. Manual testing
npm run sandbox

# 2b. Automated testing
npm run test:agent
npm run test:agent:logs
npm run seed:collect

# 2c. E2E testing
npm run test:e2e              # both
npm run test:e2e:bun
npm run test:e2e:cf

# 3. Clean up
npm run sandbox:wipe
npm run test:agent:down
npm run clear
```

## All scripts

| Script                     | Description                                                  |
| -------------------------- | ------------------------------------------------------------ |
| `npm run dev`              | Local dev server (wrangler / Cloudflare Workers)             |
| `npm run dev:node`         | Local dev server (Node.js / Bun, filesystem storage)         |
| `npm run dev:remote`       | Remote dev server (requires R2 bucket)                       |
| `npm run deploy`           | Deploy to Cloudflare Workers                                 |
| `npm run build:node`       | Build Node/Bun distributable to `dist/`                      |
| `npm run seed`             | Seed local KV with dev config (password: `snitchr`)         |
| `npm run seed:status`      | Seed fake heartbeat/event data (requires running dev server) |
| `npm run seed:collect`     | Extract fixtures from Docker test logs                       |
| `npm run clear`            | Delete local KV config                                       |
| `npm run test`             | Run unit + integration tests (vitest)                        |
| `npm run test:unit`        | Unit tests only                                              |
| `npm run test:integration` | Integration tests only                                       |
| `npm run test:agent`       | Boot Docker containers and install agents (mock gateway)     |
| `npm run test:agent:logs`  | Tail mock gateway logs                                       |
| `npm run test:agent:down`  | Stop and remove Docker containers                            |
| `npm run test:e2e`         | E2E tests: real gateway + Docker agent (both variants)       |
| `npm run test:e2e:bun`     | E2E: Bun + filesystem                                        |
| `npm run test:e2e:cf`      | E2E: CF Workers + S3                                         |
| `npm run sandbox`          | Interactive Debian shell for manual agent testing            |
| `npm run sandbox:wipe`     | Remove sandbox container and data                            |
| `npm run typecheck`        | TypeScript type checker (both CF and Node configs)           |

## Project structure

```
src/
  app.ts                 # Shared Hono app (all routes, middleware) — runtime-agnostic
  index.ts               # Cloudflare Workers entry point
  serve.ts               # Node.js / Bun entry point (@hono/node-server)
  cli.ts                 # CLI for npx/bunx snitchr
  config.ts              # Config loader, storage factory, asset serving
  crypto.ts              # PBKDF2 password hashing, HMAC sessions, CSHAKE256
  storage.ts             # Storage interface: R2, S3, filesystem, in-memory
  kv.ts                  # KVStore interface: CloudflareKV, FileKV, InMemoryKV
  assets.ts              # AssetServer interface: FileAssetServer
  layout.ts              # Shared HTML shell (wraps page fragments)
  rate-limit.ts          # Per-IP rate limiter backed by KV
  scheduled.ts           # Cron handler (heartbeat timeout, down-machine alerts)
  types.ts               # Shared types, event levels, bindings
  validators.ts          # Input validation helpers
  notifications.ts       # Notification dispatcher (ntfy, webpush)
  webpush.ts             # Web Push protocol (VAPID, encryption, delivery)
  version.ts             # Build-time version constants (generated)
  routes/
    auth.ts              # Setup wizard, login/logout, machine registration
    machines.ts          # Agent ingest endpoint, dashboard read APIs
    settings.ts          # Settings CRUD, password change, factory reset
static/
  dashboard.html         # Main dashboard (3D globe, machine cards)
  login.html             # Login form
  setup.html             # Initial setup wizard
  machine.html           # Single machine detail view
  settings.html          # Settings page
  sw.js                  # Service worker for push notifications
  app.css                # Shared styles
  scripts/
    install.sh           # Agent bootstrap installer
    snitchr-agent.sh    # Agent daemon (heartbeats, events, file integrity)
test/
  docker-compose.yml     # Debian + Ubuntu + mock gateway
  run.sh                 # Mock-based test orchestration
  scenarios/             # Test scenarios (install, heartbeat, auth, files, shutdown)
  e2e/
    run.sh               # Real gateway E2E orchestrator (Bun + CF variants)
    lib/                 # Shared helpers (api, assert, gateway, agent lifecycle)
    scenarios/           # E2E scenarios against real dashboard APIs
dev/
  build-version.mjs      # Generates src/version.ts at build time
  seed.mjs               # KV seed script
  seed-status.mjs        # Seed fake heartbeats/events via API
  collect.mjs            # Fixture collector from test logs
  sandbox.sh             # Interactive Debian sandbox
```

## Code standards

### Formatting

All code must be formatted with Prettier. The config lives in `package.json`.

```bash
npm run format          # auto-format all source files
npm run format:check    # check without writing (runs in CI)
```

CI will reject unformatted code. Run `npm run format` before committing.

### Style

- TypeScript strict mode, ES2022 target
- `const`, arrow functions, early returns, functional patterns
- No `any` — use `unknown` with type guards
- No comments unless the logic is genuinely non-obvious
- No frontend framework — vanilla JS, semantic HTML, [oat-glassed](https://cdn.jsdelivr.net/npm/oat-glassed/) CSS

### Functions

Keep functions small — **mental complexity must stay under 10 operations**. Count each of these as one: conditional, loop, assignment, function call, return, throw, ternary, nullish coalescing, logical operator, `await`. If a function exceeds 10, decompose it.

- Do one thing per function, one level of abstraction
- 3 parameters max — use an options object beyond that
- No flag arguments — split into separate functions
- No hidden side effects — name functions to signal mutation (e.g., `writeConfigToDisk`, not `updateConfig`)

### Naming

- Descriptive, unambiguous, pronounceable, searchable
- Concise in small scopes, descriptive in large ones
- Booleans read as predicates: `isValid`, `hasPermission`, `canRetry`
- Replace magic numbers/strings with named constants
- No type prefixes (`strName`, `IUser`)

### Error handling

- Never silently swallow errors or leave undefined behavior
- Consider failure modes, edge cases, and race conditions
- Prefer explicit error types over generic catches
- Use early returns for guard clauses

### Architecture

- Zero frontend frameworks — vanilla JS, Web Components only
- Minimal dependencies — justify every `npm install`
- Performance-first: runtime speed, memory efficiency, minimal bundle size
- Functional TypeScript patterns over class-based OOP
- Hide internal structure behind narrow interfaces (Law of Demeter)

### Testing

- Branch coverage must stay **above 80%** — check with `npm run test:coverage`
- Write failure cases first (red light), then success cases (green light)
- Prefer integration tests over unit tests for IO-heavy code
- One assertion per test (or one logical concept)
- Test names describe the scenario and expected outcome, not the implementation
- Test edge cases: empty inputs, max sizes, concurrent access, network failures

### Code smells to reject

- Rigidity (small change → cascade of changes)
- Fragility (change here → breaks over there)
- Needless complexity (YAGNI)
- Needless repetition (DRY, but don't over-abstract)
- Opacity (if it needs a comment to explain, rewrite it)

## Workflows

### Before implementing a feature

1. Investigate current state — read relevant code, don't assume
2. Read and comprehend necessary documentation
3. Propose a plan with tradeoffs before writing code
4. Implement incrementally, validate at each step
5. Run tests, check coverage, then commit

### When debugging

1. Reproduce first
2. Form a hypothesis before changing code
3. Verify the fix addresses root cause, not symptoms
4. Check for related issues nearby

## Commit messages

Use conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`

Keep subject line under 72 chars. Body only when the "why" isn't obvious.
