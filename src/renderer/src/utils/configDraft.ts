import type {
  CommonConfigUpdateInput,
  ConfigFieldError,
  EditableBootstrapHook,
  EditableConfigState
} from '@shared/config'

export type ConfigSaveResult = {
  errors: ConfigFieldError[]
  message: string | null
  canReload: boolean
}

export type ConfigDraft = {
  scan_roots: string[]
  repos: string[]
  default_agent: '' | 'codex' | 'claude'
  artifact_root: string
  bootstrap_hooks: BootstrapHookDraft[]
}

export type ConfigInputResult =
  | {
    ok: true
    input: CommonConfigUpdateInput
  }
  | {
    ok: false
    errors: ConfigFieldError[]
  }

export type BootstrapHookDraft = {
  sourceIndex?: number
  name: string
  command: string
  cwd: string
  env: string
}

export function createDraft(config: EditableConfigState | null): ConfigDraft {
  return {
    scan_roots: config?.scan_roots ?? [],
    repos: config?.repos ?? [],
    default_agent: config?.default_agent ?? '',
    artifact_root: config?.artifact_root ?? '',
    bootstrap_hooks: (config?.bootstrap_hooks ?? []).map((hook) => ({
      sourceIndex: hook.sourceIndex,
      name: hook.name ?? '',
      command: hook.command,
      cwd: hook.cwd ?? '',
      env: formatEnv(hook.env)
    }))
  }
}

export function createConfigInput(draft: ConfigDraft): ConfigInputResult {
  const errors: ConfigFieldError[] = []
  const bootstrapHooks = draft.bootstrap_hooks.map((hook, index) => {
    const nextHook: EditableBootstrapHook = {
      command: hook.command
    }

    if (hook.sourceIndex !== undefined) {
      nextHook.sourceIndex = hook.sourceIndex
    }

    if (hook.name.trim() !== '') {
      nextHook.name = hook.name
    }

    if (hook.cwd.trim() !== '') {
      nextHook.cwd = hook.cwd
    }

    const parsedEnv = parseEnv(hook.env, `bootstrap_hooks[${index}].env`)
    if (!parsedEnv.ok) {
      errors.push(...parsedEnv.errors)
    } else if (Object.keys(parsedEnv.env).length > 0) {
      nextHook.env = parsedEnv.env
    }

    return nextHook
  })

  if (errors.length > 0) {
    return {
      ok: false,
      errors
    }
  }

  return {
    ok: true,
    input: {
      scan_roots: draft.scan_roots,
      repos: draft.repos,
      default_agent: draft.default_agent === '' ? null : draft.default_agent,
      artifact_root: draft.artifact_root.trim() === '' ? null : draft.artifact_root,
      bootstrap_hooks: bootstrapHooks
    }
  }
}

export function formatEnv(env: Record<string, string> | undefined): string {
  if (env === undefined) {
    return ''
  }

  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

export function parseEnv(
  value: string,
  field: string
): { ok: true; env: Record<string, string> } | { ok: false; errors: ConfigFieldError[] } {
  const env: Record<string, string> = {}
  const errors: ConfigFieldError[] = []

  value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .forEach((line) => {
      const separatorIndex = line.indexOf('=')
      if (separatorIndex <= 0) {
        errors.push({
          field,
          message: 'Environment lines must use KEY=value.'
        })
        return
      }

      env[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1)
    })

  return errors.length === 0 ? { ok: true, env } : { ok: false, errors }
}

export function getFieldError(errorsByField: Map<string, string>, field: string): string | undefined {
  return errorsByField.get(field) ??
    [...errorsByField.entries()].find(([errorField]) => errorField.startsWith(`${field}.`))?.[1]
}
