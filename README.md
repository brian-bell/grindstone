# Grindstone

Grindstone is an Electron app shell for a Flow-first workspace. The current
implementation is a static scaffold: it opens into a three-pane workspace and
pins the process boundaries, IPC contract, and Flow-only middle pane that later
features will build on.

## Current Features

- Electron + Vite + React + TypeScript application shell.
- Three-pane first screen:
  - repository area with an empty/default state,
  - Flow Workspace middle pane with loading, empty, and error states,
  - contextual hints and disabled Flow shortcut affordances.
- Typed preload API at `window.grindstone.workspace.getInitialState()`.
- Shared IPC contract for `workspace:getInitialState`.
- Flow-only middle-pane manifest and route guard.
- Renderer security defaults: context isolation, no node integration, sandboxing,
  and a renderer Content Security Policy.

## Requirements

- Node.js and npm.

The project is private and uses the lockfile checked in as `package-lock.json`.

## Getting Started

Install dependencies:

```bash
npm install
```

Start the Electron development app:

```bash
npm run dev
```

Build the app outputs:

```bash
npm run build
```

## Verification

Run the full local verification set:

```bash
npm test -- --run
npm run typecheck
npm run lint
npm run build
```

`npm test` runs Vitest in watch mode.

## Project Structure

```text
src/main/       Electron main process and workspace IPC handlers
src/preload/    Safe preload bridge exposed to the renderer
src/shared/     Shared workspace state, IPC contract, and Flow surface model
src/renderer/   React app shell, styles, tests, and HTML entry
```

Main, preload, and renderer builds are configured in
`electron.vite.config.ts`. TypeScript is split across `tsconfig.node.json` and
`tsconfig.web.json`, with `tsconfig.json` holding project references.

## Current Scope

This scaffold does not yet implement repository scanning, real Flow persistence,
terminal/session management, settings, PR workflows, or merge behavior. The
default workspace state is static and exists to shape the future data path.
