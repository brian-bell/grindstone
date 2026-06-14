import type { InitialWorkspaceState } from './workspace'

export type DefaultAgent = 'codex' | 'claude'

export type EditableBootstrapHook = {
  name?: string
  command: string
  cwd?: string
  env?: Record<string, string>
}

export type EditableConfigState = {
  configPath: string | null
  scan_roots: string[]
  repos: string[]
  default_agent: DefaultAgent | null
  artifact_root: string | null
  bootstrap_hooks: EditableBootstrapHook[]
}

export type CommonConfigUpdateInput = {
  scan_roots: string[]
  repos: string[]
  default_agent: DefaultAgent | null
  artifact_root: string | null
  bootstrap_hooks: EditableBootstrapHook[]
}

export type ConfigFieldError = {
  field: string
  message: string
}

export type ConfigUpdateResponse =
  | {
    ok: true
    workspace: InitialWorkspaceState
    config: EditableConfigState
  }
  | {
    ok: false
    kind: 'validation'
    errors: ConfigFieldError[]
  }
  | {
    ok: false
    kind: 'reload_failed'
    configPath: string
    message: string
    config?: EditableConfigState
  }
