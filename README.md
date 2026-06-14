# Grindstone

Grindstone is an Electron app shell for a Flow-first workspace. It opens into a
three-pane workspace, loads a configured repository catalog in the left pane,
and keeps the middle pane scoped to the Flow workspace surface.

## Current Features

- Electron + Vite + React + TypeScript application shell.
- Three-pane first screen:
  - repository catalog loaded from configured scan roots and explicit repos,
  - Flow Workspace middle pane with repo-scoped loading, empty, error, and
    artifact-backed list states,
  - contextual hints and disabled Flow shortcut affordances.
- Typed preload API at `window.grindstone.workspace`.
- Shared IPC contracts for `workspace:getInitialState` and
  `workspace:selectRepository`.
- Flow-only middle-pane manifest and route guard.
- Renderer security defaults: context isolation, no node integration, sandboxing,
  and a renderer Content Security Policy.

## Repository Config

Grindstone reads the first config file found at:

1. `${process.cwd()}/grindstone.toml`
2. `${XDG_CONFIG_HOME:-~/.config}/grindstone/config.toml`

If neither file exists, the repository catalog starts empty and Flow artifacts
default to the wtui state root at `~/.local/state/wtui/sessions/v1`. Supported
repository TOML keys are top-level arrays of strings:

```toml
scan_roots = ["~/dev", "../workspace"]
repos = ["/opt/projects/example"]
```

Relative paths resolve from the directory containing the config file. Leading
`~` expands to the user home directory. Scan roots are walked recursively for
Git repositories, while explicit repos are evaluated directly. Generated
`grindstone-worktrees` directories are pruned during scan-root discovery, but
explicit repos under those directories can still be selected.

Flow list records are read from `<artifact-root>/flows/<flow-id>/meta.json`.
Configure the artifact root with:

```toml
[artifacts]
root = "~/.local/state/wtui/sessions/v1"
```

The artifact root is the wtui state root, so `flows/` and `plans/` are siblings
below it. Relative artifact roots use the same config-file-relative resolution
rules as repository paths.

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

This scaffold can list existing wtui Flow metadata for the selected repository,
but it does not yet create or edit Flows, inspect plans or transcripts,
launch terminals/sessions, manage settings, or run PR workflows.
