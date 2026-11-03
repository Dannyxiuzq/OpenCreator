# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read AGENTS.md first

`AGENTS.md` at the repo root is the authoritative project policy and is not repeated here. It covers:

- Risk tiers (P0/P1/P2) and the **minimum sufficient validation** rule: do not escalate small Web-only changes to full builds, E2E, or Desktop packaging.
- Web/Desktop parity gates, the Host Bridge capability model, and when packaged-App validation is actually required.
- The single shared `CreatorCollaborationPanel` rule for every Creator template (differences go through a `CreatorPanelAdapter`, never a second panel).
- Language: **Git commit messages, tags, and release notes must be English**; responses and other project documents stay in Chinese. Most `docs/` are Chinese; the root `README.md` is the canonical English document and `docs/<locale>/README.md` are translations.
- The `opencreator-bug-fix` Feishu workflow is opt-in only.

`.github/pull_request_template.md` asks for the risk tier, what was actually run, and what was intentionally skipped.

## Toolchain and setup

- Node.js 22+, pnpm 9.15.0 (pinned via `packageManager`; run `corepack enable`), a Go toolchain for `runtime/krillinai`, and a Codex CLI (`codex` on PATH, `OPENCREATOR_CODEX_BIN`, or the bundled runtime that `apps/desktop/scripts/prepare-codex-runtime.mjs` places in `apps/desktop/.pack/codex-runtime`).
- `pnpm install`, then `pnpm web:dev` and open http://127.0.0.1:19861/.

## Commands

Root scripts fan out with `pnpm -r`; per-package work uses `pnpm --filter <name>`. Package names: `@opencreator/web`, `@opencreator/daemon`, `@opencreator/desktop`, `@opencreator/harness`, `@opencreator/protocol`, `@opencreator/config`, `@opencreator/skill-market`, `@opencreator/writing-templates`, `@opencreator/stickman-remotion`.

| Task | Command |
| --- | --- |
| Web + daemon dev server | `pnpm web:dev` |
| Daemon only (prints `{address, token}` JSON once) | `pnpm daemon:dev` |
| Electron dev (builds daemon + desktop, reuses a web dev server already on :19861) | `pnpm desktop:dev` |
| Typecheck all / one package | `pnpm typecheck` / `pnpm --filter @opencreator/web typecheck` |
| Tests all / one package | `pnpm test` / `pnpm --filter @opencreator/daemon test` |
| Single daemon test file | `pnpm --filter @opencreator/daemon test -- test/unit/codex-smoke.test.ts` |
| Single web test file | `pnpm --filter @opencreator/web test -- src/features/dashboard/CreatorCollaborationPanel.test.tsx` |
| Single test without the dependency prebuilds | `pnpm --filter @opencreator/web exec vitest run <path>` (after `protocol`, `config`, `skill-market`, `writing-templates` have been built once) |
| Build everything | `pnpm build` (root `prebuild` runs `krillinai:build` first) |
| Web E2E (Playwright, `apps/web/e2e`) | `pnpm e2e` · one spec: `pnpm e2e apps/web/e2e/web-desktop-parity.spec.ts --project=chromium-desktop` |
| Desktop unit / E2E / packaged smoke / real Codex | `pnpm desktop:test` · `pnpm --filter @opencreator/desktop e2e` · `… e2e:package:smoke` · `… e2e:real-codex` |
| Creation templates | `pnpm templates:validate` · `pnpm templates:compile` · `pnpm templates:ci` |
| KrillinAI Go runtime | `pnpm krillinai:build` · `pnpm krillinai:test` (`go test ./...`) · `pnpm krillinai:package` |
| Language catalog | `pnpm languages:generate` · `pnpm languages:check` |
| Codex app-server protocol types | `pnpm --filter @opencreator/daemon generate:codex-protocol` |
| Fake-Codex smoke (what CI runs) | `pnpm smoke:ci` |
| Real Codex smoke (off by default) | `OPENCREATOR_RUN_REAL_CODEX_SMOKE=1 pnpm --filter @opencreator/daemon test -- test/smoke/real-codex-smoke.test.ts` |
| Desktop packaging | `pnpm desktop:package` (dir) · `pnpm desktop:dist` (installer) · `pnpm desktop:release` · `pnpm --filter @opencreator/desktop verify:package` |
| Perf baseline | `pnpm perf:measure` · `pnpm perf:check` |

Notes:

- Every app's `pre*` hooks build `@opencreator/protocol`, `config`, `skill-market`, and `writing-templates` first, so the first `test`/`typecheck` in a package is slow. `@opencreator/protocol`'s `prebuild` runs `languages:check`.
- **The Web build fails unless `pnpm templates:compile` has produced `.runtime/generated/creator-presets/`**; Vite's `buildStart` asserts the catalog exists. CI runs `templates:ci` before E2E as well, so do the same before `pnpm e2e`.
- Web E2E (`apps/web/e2e/fixtures/runtime.ts`) needs no real Codex login: each spec runs `@opencreator/daemon predev`, then spawns its own Vite dev server and daemon on a free port with a fake Codex launcher, an isolated `OPENCREATOR_DATA_DIR`, and an isolated `CODEX_HOME`.
- Web component tests run under jsdom with the language forced to `zh-CN` (`apps/web/src/test/setup.ts`), so assertions target Chinese copy.
- Daemon Vitest: `environment: node`, `test/**/*.test.ts`, 2 workers, 10 s timeout. Tests under `test/unit`, `test/integration`, `test/acceptance`, `test/smoke`; the fake Codex lives in `test/helpers/fake-codex.ts` and `test/fixtures/fake-codex-image.mjs`.
- Root Playwright config: projects `chromium-desktop` (1440×900) and `chromium-mobile` (390×844), locale `zh-CN`, one worker.

### CI (`.github/workflows/ci.yml`)

PRs run `unit` (`pnpm audit --audit-level high`, `templates:ci`, `krillinai:test`, `pnpm test`, `release:verify-scheduled-task-upgrade`), `compile` (`typecheck`, `build`, `smoke:ci`), `web-parity` (Web build + `web-desktop-parity.spec.ts` + perf baseline), and `desktop-network-windows`. Changes touching only release tooling route to `release-checks` (actionlint + desktop release tests). A push commit containing `[package only]` skips CI.

## Architecture

OpenCreator wraps the Codex CLI agent loop with a local Runtime, one React frontend, and an Electron host. The frontend never spawns Codex and never sees raw Codex JSONL; the daemon owns process lifecycle, event normalization, persistence, approvals, schedules, and notifications. Codex stays the source of truth for the agent loop, Skills, and MCP.

```
apps/web (React 18 + Vite) ──HTTP + SSE, Bearer token──▶ apps/daemon (Fastify) ──spawn──▶ Codex CLI (app-server or exec --json)
        ▲                                                       │                        KrillinAI Go CLI · yt-dlp · FFmpeg · Remotion
apps/desktop (Electron) serves the same web/dist at             └── SQLite (better-sqlite3) + files under ~/.opencreator
opencreator-app://app and proxies /.opencreator/runtime
```

### Workspace packages and build order

`packages/protocol` (all shared types, `protocolVersion`) → `packages/config` (`~/.opencreator` paths, TOML config, integrity cache) → `packages/skill-market`, `packages/writing-templates` → `apps/daemon`, `apps/web`, `apps/desktop`, `apps/harness`. `packages/stickman-remotion` is a Remotion composition the daemon bundles and renders for stick-figure video. Anything that crosses a process boundary is typed in `@opencreator/protocol`; add fields there first.

Non-pnpm pieces: `runtime/krillinai` (Go: `cmd/cli`, `cmd/server`; `scripts/build-krillinai.mjs` builds it into `.runtime/build/krillinai/<platform>-<arch>` with a content-hash manifest and reuses the build when sources are unchanged), `template/<module>/<id>/<version>/template.json` (creation presets compiled by `apps/daemon/scripts/creator-presets.ts`), `skills/*/SKILL.md` (Codex Skills for the KrillinAI CLI), `assets/` (language catalog source, subtitle fonts with a SHA-256 manifest, preset videos), `resources/codex-runtime/<platform>` (pinned bundled Codex manifests, currently 0.166.0).

### Daemon (`apps/daemon/src`)

- `main.ts` boots: resolve paths and `CODEX_HOME`, acquire the runtime lock, probe the Codex version, collect a capability matrix (cached as `codex-capabilities.json` in the data dir), then `api/server.ts#buildServer()` listens on `127.0.0.1:0` and prints `{address, token}` to stdout (also posted over Electron `parentPort`). `startup.ts` maps `OPENCREATOR_*` env vars to server input.
- `api/server.ts` is the composition root: it wires every repository, service, executor, and `api/routes.*.ts` module. `api/auth.ts` enforces the Bearer token on everything except `GET /healthz`; `api/sse.ts` streams events.
- Codex integration (`codex/`) has two execution paths. The default is a persistent **app-server** JSON-RPC session (`app-server-client.ts`, `app-server-runtime-manager.ts`, `runs/persistent-app-server-executor-2026-07-28.ts`; disable with `OPENCREATOR_PERSISTENT_APP_SERVER=0`). The fallback is `codex exec --json` (`runner.ts`, `argv.ts`). Both feed `events/normalizer.ts`, which emits the protocol `AgentEventEnvelope` the UI consumes. Generated app-server types live in `codex/generated/v<version>/`. `codex/home.ts` resolves `$CODEX_HOME` (global by default, isolated only when requested); `codex/skills`, `codex/mcp`, `codex/profiles`, and `codex/sessions` pass through to Codex-native config and session history.
- Runtime domain: `runs/manager.ts` (state machine `queued → running → succeeded | failed | canceled`, per-thread serialization, ordered redacted logs), `threads/`, `projects/`, `approvals/`, `scheduler/` (each schedule owns a dedicated thread), `memory/`, `notifications/`, `attachments/`, `workspace-files/`, `search/`, `cleanup/`, `gateway/` (open-creator.ai account, subscriptions, official model services).
- Storage: `storage/migrations.ts` is a single idempotent `migrate()` of `CREATE … IF NOT EXISTS` statements (WAL, foreign keys on); `storage/repositories.ts` holds the SQL. Schema changes are P2 under AGENTS.md.
- Creator subsystem (`creator/`), the backend of the "Collaboration Core":
  - A **Job** runs **Stages** that produce **Artifacts**; results are snapshotted into immutable versions (`result-snapshots.ts`, `docs/creator-artifact-versions.md`).
  - `templates/registry.ts` registers each Creator template (video-translation, image-generation, video-generation, cover, stickman-video, wechat-article, xiaohongshu-post, short-video-script, smart-dubbing, auto-clip, video-download). A template declares its stages; `stage-scheduler.ts` and `stage-runner.ts` execute them through `CreatorExecutor` implementations in `creator/<domain>/executor.ts` (`krillin/` wraps the Go CLI).
  - `command-dispatcher.ts` is the single entry for workspace REST actions and Agent tool commands, so both UIs drive one state machine. `creator/agent/` (codex-adapter, event-normalizer, reconciler, context-builder) binds a Codex agent turn to a Creator job.
  - Upstream failures carry `PublicErrorFacts` (provider, HTTP status, upstream code, request id) instead of being collapsed into wrapper codes; see `docs/development/creator-error-diagnostics.md`.

### Web (`apps/web/src`)

- `app/`: `AppProviders`, `AppRouter` (hash routes in `routes.ts`), `AppController`, runtime-connection context.
- `host/`: the `HostBridge` interface (`bridge.ts`) with `browser-bridge.ts` and `desktop-bridge.ts`. Platform-only methods are optional (`selectProjectDirectory?`, `controlWindow?`, …); UI gates on their presence and never branches on `kind` for shared logic. The browser bridge reads `/.opencreator/runtime-config` from the Vite dev proxy before falling back to localStorage; the desktop bridge wraps `window.opencreatorDesktop`.
- `runtime/`: typed HTTP client, SSE subscription, frame batching, request deadlines, connection-recovery UI. `dev-proxy-target.ts` and `dev-creator-runtime.ts` are shared with `vite.config.ts`.
- `services/`: one module per Runtime domain (`run-service`, `creator-service`, `schedule-service`, …). Features call these, not `fetch`.
- `features/<domain>/`: pages and components. `features/dashboard/` holds every Creator tool workspace (`*Workspace.tsx`), the shared `CreatorCollaborationPanel.tsx`, and `creator-panel-adapters.ts` (`creatorPanelAdapterFor(templateId)` with a generic fallback adapter).
- `i18n/`: copy is written inline as `localize(chinese, english)` pairs. zh-CN and en-US come from source; the other 41 locales are JSON dictionaries in `i18n/locales/` keyed by the English string. `translated-copy.test.ts` and `client-copy-coverage.test.ts` fail on missing keys or placeholders. Arabic, Persian, Urdu, and Hebrew flip to RTL. Adding a locale touches the protocol enum, the picker, dictionary registration, and the switch tests (see `i18n/locales/README.md`).
- `styles/tokens.css` plus `docs/visual-component-guidelines.md` define the dark, orange-accent design language; use the CSS variables, not literal colors.
- `vite.config.ts` does more than bundle. In dev it spawns the daemon (`node --import tsx src/main.ts`), proxies `/.opencreator/runtime` with the injected token, restarts the daemon when `apps/daemon/src` changes, and serves compiled preset assets and subtitle fonts. In build it verifies the preset catalog and font hashes and copies them into `dist/`.

### Desktop (`apps/desktop/src`)

- `main/main.ts` → `BootstrapController` (first-run page built from `src/bootstrap` by `vite.bootstrap.config.ts`), `DaemonManager` (runs the packaged daemon as an Electron `utilityProcess`), `protocol-handler.ts` (`opencreator-app://app` serves `web/dist`, `opencreator-app://bootstrap` serves the bootstrap page, and `/.opencreator/runtime/*` is proxied to the daemon with the token), `WindowManager`, `TrayManager`, `NotificationManager`, `updater.ts` (electron-updater via GitHub), `deep-link-manager.ts` (`opencreator://`).
- `preload/index.ts` exposes `window.opencreatorDesktop` (`DesktopApi` in `shared/types.ts`, channel names in `shared/ipc.ts`). Adding a native capability means: IPC channel → main handler → preload → `desktop-bridge.ts` → optional `HostBridge` method.
- Packaging (`scripts/package-release.mjs`) stages everything into `.pack/` (daemon `dist` plus production `node_modules`, creator runtime, codex runtime, stickman assets, build profile), rebuilds Web, writes a build manifest (commit, dirty flag, web hash, platform/arch), runs electron-builder, and `verify-package.mjs` compares the embedded `web/` with `apps/web/dist`. Isolated test profiles keep unsigned builds from sharing state with an installed app.

### Data locations and environment

`packages/config#resolveOpenCreatorPaths` puts production data under `~/.opencreator/` and the development channel (`OPENCREATOR_RUNTIME_CHANNEL=development`, set by the dev scripts) under `~/.opencreator/development/`; `OPENCREATOR_HOME` and `OPENCREATOR_DATA_DIR` override this. The README's description of `.runtime/app.sqlite` at the repo root predates this. Codex sessions and config stay in `$CODEX_HOME` (default `~/.codex`). The repo-root `.runtime/` holds build outputs only (`build/krillinai`, `generated/creator-presets`, `vendor/`, `dev/creator-runtime`) and is gitignored, as are `apps/desktop/.pack` and `apps/desktop/.cache`. The README's env-var table (`OPENCREATOR_CODEX_BIN`, `CODEX_HOME`, `OPENCREATOR_GATEWAY_ORIGIN`, …) is current.

## Conventions worth knowing

- ESM with `NodeNext`: relative imports use `.js` extensions even in `.ts`/`.tsx` sources. `strict` and `noUncheckedIndexedAccess` are on, so index access yields `T | undefined`.
- Some modules carry a date suffix (`app-server-host-2026-07-28.ts`, `model-service-2026-08-05.ts`). These mark contract revisions and are referenced widely; do not rename them as cleanup.
- Generated artifacts, never hand-edited: `packages/protocol/src/creator-languages.generated.ts` (from `assets/creator-languages/catalog.json`), `packages/writing-templates/src/generated/catalog.json`, `apps/daemon/src/codex/generated/`, `.runtime/generated/creator-presets/`.
- Creation templates are immutable per version: changes go in `template/<module>/<id>/<n+1>/`, not in place. `pnpm templates:validate` must pass. Skills and templates have their own merge bars in `docs/contributing/`.
- Commit subjects follow Conventional Commits with a scope (`feat(web):`, `fix(daemon):`, `test(desktop):`, `build(codex):`), in English.
- Run logs, diagnostics, and error facts are redacted before persistence (`security/redaction.ts`); never log raw provider responses or credentials.
