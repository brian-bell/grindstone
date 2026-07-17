# Grindstone App Shell Agent Notes

## Project Overview

Grindstone is an Electron, Vite, React, and TypeScript app for a Flow-first
workspace. The UI opens directly into a two-pane master-detail workspace:

- Left sidebar: config-driven repository catalog (selection, diagnostics,
  creation with GitHub remote retry) above a glanceable Flow list with
  per-flow health, phase progress, and failure summaries.
- Main pane: the Flow Workspace surface. With no Flow selected it shows a
  repository overview (status counts, needs-attention list); with a Flow
  selected it shows the full detail view — metadata, linked plan, phase
  tree with launch/skip/complete/edit actions, PR/human-review/merge
  recording, and embedded xterm.js terminals.

Common config edits live in a modal dialog opened from the sidebar.
Repository creation, Flow persistence, phase actions, plan viewing, and
terminal sessions are implemented and wired through IPC.

## Development Workflow

- Use TDD for coding work unless there is a clear reason not to.
- Pull latest from `main` before starting changes when that ref exists. In this
  bootstrap worktree, `origin/main` may be absent.
- Never commit or push directly to `main`.
- Never ship unrelated work on an existing PR.
- After a turn that edits files, use the commit workflow unless the user asks
  not to, the repo is unavailable, or there is something the user should review
  first.

## Commands

Use npm scripts from `package.json`:

- `npm install` installs dependencies.
- `npm run dev` starts the Electron/Vite development app.
- `npm test -- --run` runs the Vitest suite once.
- `npm test` runs Vitest in watch mode.
- `npm run typecheck` runs TypeScript checks for node/preload/shared and web
  projects.
- `npm run lint` runs ESLint with zero warnings allowed.
- `npm run build` runs typecheck and then `electron-vite build`.

Generated outputs such as `node_modules/`, `out/`, `dist/`, `coverage/`, and
`*.tsbuildinfo` are ignored and should not be committed.

## Source Layout

- `src/main/` contains the Electron main process and IPC handler registration.
- `src/preload/` exposes the narrow renderer API through `contextBridge`.
- `src/shared/` contains cross-process workspace state types, IPC contracts, and
  the Flow-only middle-pane manifest/route resolver.
- `src/renderer/` contains the React renderer entry point, app shell, styles,
  test setup, and HTML shell. `src/renderer/src/App.tsx` holds only shell
  state orchestration; panes and features live in
  `src/renderer/src/components/` (one file per component), and formatters,
  validators, and request builders live in `src/renderer/src/utils/`.
- `electron.vite.config.ts` configures main, preload, and renderer builds plus
  the `@shared` and `@renderer` aliases.
- `vitest.config.ts` configures jsdom-based tests and the renderer test setup.

## Architecture Notes

- The renderer-facing preload API is `window.grindstone.workspace` (initial
  state, repository selection/creation, Flow creation, phase actions,
  PR/human-review/merge recording, plan reading, terminal I/O and events)
  plus `window.grindstone.config` (editable config read/update).
- Workspace state is server-authoritative: mutating calls return a full
  `InitialWorkspaceState` that the renderer applies; only drafts, modal
  open/close, Flow selection, and live terminal output are local state.
- Add new IPC endpoints through `src/shared/ipc.ts` so request/response maps,
  typed invocation, and handler registration stay in sync.
- The main process loads TOML config, scans repositories, persists Flow
  artifacts, and manages terminal sessions.
- The renderer must not import Electron or Node authority directly. Keep
  filesystem/process access in main/preload.
- Browser windows use `contextIsolation: true`, `nodeIntegration: false`, and
  `sandbox: true`.
- `src/renderer/index.html` defines the renderer Content Security Policy.

## Flow-Only Surface Contract

- `middlePaneManifest` currently contains exactly one surface: `flow-workspace`
  at `/`.
- Standalone worktree, branch, session, and plan middle-pane routes are out of
  scope. Unknown or standalone route attempts should resolve to a Flow-scoped
  error state.
- Keep plan/session/artifact concepts attached to Flow state until a later slice
  deliberately expands the surface model.
- Update `src/shared/middlePane.test.ts` when changing `FlowPaneState` or the
  middle-pane manifest.

## Testing Notes

- Renderer shell behavior is covered in `src/renderer/src/App.test.tsx`.
- Preload API exposure is covered in `src/preload/index.test.ts`.
- Main-process workspace handler registration is covered in
  `src/main/workspaceHandlers.test.ts`.
- IPC contract helpers are covered in `src/shared/ipc.test.ts`.
- Flow-only manifest and route behavior is covered in
  `src/shared/middlePane.test.ts`.

Prefer adding or updating targeted tests before changing shell behavior.
