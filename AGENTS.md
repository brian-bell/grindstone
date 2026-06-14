# Grindstone App Shell Agent Notes

## Project Overview

Grindstone is currently an Electron, Vite, React, and TypeScript app shell for a
Flow-first workspace. The checked-in UI opens directly into a three-pane
workspace:

- Left pane: config-driven repository catalog with diagnostics and selection.
- Middle pane: Flow Workspace only, with explicit loading, empty, and error
  states.
- Right pane: contextual hints and disabled Flow shortcut affordances.

Real Flow persistence, terminal/session integration, settings, and Git
operations are not implemented here yet.

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
  test setup, and HTML shell.
- `electron.vite.config.ts` configures main, preload, and renderer builds plus
  the `@shared` and `@renderer` aliases.
- `vitest.config.ts` configures jsdom-based tests and the renderer test setup.

## Architecture Notes

- The renderer-facing preload API is `window.grindstone.workspace` with
  `getInitialState()` and `selectRepository()`.
- Workspace IPC channels are `workspace:getInitialState` and
  `workspace:selectRepository`.
- Add new IPC endpoints through `src/shared/ipc.ts` so request/response maps,
  typed invocation, and handler registration stay in sync.
- The main process loads TOML config, scans repositories, and keeps selection
  in memory for this shell slice.
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
