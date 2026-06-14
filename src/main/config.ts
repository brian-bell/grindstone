import { access, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'smol-toml'
import type {
  CommonConfigUpdateInput,
  ConfigFieldError,
  DefaultAgent,
  EditableBootstrapHook,
  EditableConfigState
} from '@shared/config'
import type { CatalogDiagnostic } from '@shared/workspace'

export type ConfiguredPath = {
  configuredPath: string
  resolvedPath: string
}

export type GrindstoneConfigResult = {
  ok: boolean
  configPath: string | undefined
  scanRoots: ConfiguredPath[]
  repos: ConfiguredPath[]
  diagnostics: CatalogDiagnostic[]
}

export type LoadGrindstoneConfigOptions = {
  configPath?: string
  cwd?: string
  env?: Partial<Pick<NodeJS.ProcessEnv, 'XDG_CONFIG_HOME'>>
  homeDir?: string
}

type RawConfig = {
  scan_roots?: unknown
  repos?: unknown
  default_agent?: unknown
  artifact_root?: unknown
  bootstrap_hooks?: unknown
  [key: string]: unknown
}

const EDITABLE_CONFIG_KEYS = [
  'scan_roots',
  'repos',
  'default_agent',
  'artifact_root',
  'bootstrap_hooks'
] as const

export async function loadGrindstoneConfig(
  options: LoadGrindstoneConfigOptions = {}
): Promise<GrindstoneConfigResult> {
  const configPath = await resolveConfigPath(options)

  if (configPath === undefined) {
    return emptyConfig(undefined)
  }

  let rawConfig: RawConfig
  try {
    rawConfig = parse(await readFile(configPath, 'utf8')) as RawConfig
  } catch (error) {
    return {
      ...emptyConfig(configPath),
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'config_parse_error',
          message: `Could not parse Grindstone config: ${getErrorMessage(error)}`,
          configuredPath: configPath,
          resolvedPath: configPath
        }
      ]
    }
  }

  const diagnostics = validateConfig(rawConfig, configPath)
  if (diagnostics.length > 0) {
    return {
      ...emptyConfig(configPath),
      ok: false,
      diagnostics
    }
  }

  const configDir = dirname(configPath)
  const homeDirectory = options.homeDir ?? homedir()

  return {
    ok: true,
    configPath,
    scanRoots: getConfiguredPathValues(rawConfig.scan_roots).map((path) =>
      resolveConfiguredPath(path, configDir, homeDirectory)
    ),
    repos: getConfiguredPathValues(rawConfig.repos).map((path) =>
      resolveConfiguredPath(path, configDir, homeDirectory)
    ),
    diagnostics: []
  }
}

export async function getEditableConfig(
  options: LoadGrindstoneConfigOptions = {}
): Promise<EditableConfigState> {
  const configPath = await resolveConfigPath(options)
  if (configPath === undefined) {
    return emptyEditableConfig(null)
  }

  const rawConfig = await parseConfigFile(configPath)
  const errors = validateRawConfig(rawConfig)
  if (errors.length > 0) {
    throw new Error(`Invalid Grindstone config: ${errors[0]?.field} ${errors[0]?.message}`)
  }

  return normalizeEditableConfig(rawConfig, configPath)
}

export function validateCommonConfigInput(input: unknown): ConfigFieldError[] {
  const errors: ConfigFieldError[] = []

  if (!isRecord(input)) {
    return [{ field: 'config', message: 'Common config update must be an object.' }]
  }

  validatePathArray(input.scan_roots, 'scan_roots', errors)
  validatePathArray(input.repos, 'repos', errors)
  validateDefaultAgent(input.default_agent, errors)
  validateArtifactRoot(input.artifact_root, errors)
  validateBootstrapHooks(input.bootstrap_hooks, errors)

  return errors
}

export function mergeCommonConfig(
  rawConfig: RawConfig,
  input: CommonConfigUpdateInput
): RawConfig {
  const nextConfig: RawConfig = { ...rawConfig }

  for (const key of EDITABLE_CONFIG_KEYS) {
    delete nextConfig[key]
  }

  nextConfig.scan_roots = [...input.scan_roots]
  nextConfig.repos = [...input.repos]

  if (input.default_agent !== null) {
    nextConfig.default_agent = input.default_agent
  }

  if (input.artifact_root !== null) {
    nextConfig.artifact_root = input.artifact_root
  }

  if (input.bootstrap_hooks.length > 0) {
    nextConfig.bootstrap_hooks = input.bootstrap_hooks.map((hook) => ({
      ...hook,
      env: hook.env === undefined ? undefined : { ...hook.env }
    }))
  }

  return nextConfig
}

export async function updateCommonConfigFile(
  input: CommonConfigUpdateInput,
  options: LoadGrindstoneConfigOptions = {}
): Promise<
  | { ok: true; configPath: string; config: EditableConfigState }
  | { ok: false; kind: 'validation'; errors: ConfigFieldError[] }
> {
  const errors = validateCommonConfigInput(input)
  if (errors.length > 0) {
    return { ok: false, kind: 'validation', errors }
  }

  const configPath = await resolveConfigPath(options) ?? resolveDefaultUserConfigPath(options)
  const existingConfig = await loadRawConfigForUpdate(configPath)
  const mergedConfig = mergeCommonConfig(existingConfig, input)
  const serializedConfig = stringify(mergedConfig as never)

  await writeConfigAtomically(configPath, serializedConfig)

  return {
    ok: true,
    configPath,
    config: normalizeEditableConfig(mergedConfig, configPath)
  }
}

function getConfiguredPathValues(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : []
}

async function resolveConfigPath(
  options: LoadGrindstoneConfigOptions
): Promise<string | undefined> {
  if (options.configPath !== undefined) {
    return options.configPath
  }

  const cwd = options.cwd ?? process.cwd()
  const homeDirectory = options.homeDir ?? homedir()
  const xdgConfigHome =
    options.env === undefined ? process.env.XDG_CONFIG_HOME : options.env.XDG_CONFIG_HOME
  const userConfigRoot = xdgConfigHome === undefined || xdgConfigHome === ''
    ? join(homeDirectory, '.config')
    : xdgConfigHome

  const candidates = [
    join(cwd, 'grindstone.toml'),
    join(userConfigRoot, 'grindstone', 'config.toml')
  ]

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate
    }
  }

  return undefined
}

function validateConfig(rawConfig: RawConfig, configPath: string): CatalogDiagnostic[] {
  return validateRawConfig(rawConfig).map((error) => ({
    severity: 'error',
    code: 'config_type_error',
    message: error.message,
    configuredPath: error.field,
    resolvedPath: configPath
  }))
}

function resolveConfiguredPath(
  configuredPath: string,
  configDir: string,
  homeDirectory: string
): ConfiguredPath {
  const expandedPath = configuredPath === '~' || configuredPath.startsWith('~/')
    ? join(homeDirectory, configuredPath.slice(2))
    : configuredPath

  return {
    configuredPath,
    resolvedPath: isAbsolute(expandedPath) ? expandedPath : resolve(configDir, expandedPath)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function emptyConfig(configPath: string | undefined): GrindstoneConfigResult {
  return {
    ok: true,
    configPath,
    scanRoots: [],
    repos: [],
    diagnostics: []
  }
}

function emptyEditableConfig(configPath: string | null): EditableConfigState {
  return {
    configPath,
    scan_roots: [],
    repos: [],
    default_agent: null,
    artifact_root: null,
    bootstrap_hooks: []
  }
}

async function parseConfigFile(configPath: string): Promise<RawConfig> {
  return parse(await readFile(configPath, 'utf8')) as RawConfig
}

async function loadRawConfigForUpdate(configPath: string): Promise<RawConfig> {
  if (!(await pathExists(configPath))) {
    return {}
  }

  return parseConfigFile(configPath)
}

function validateRawConfig(rawConfig: RawConfig): ConfigFieldError[] {
  const errors: ConfigFieldError[] = []
  validatePathArray(rawConfig.scan_roots, 'scan_roots', errors, true)
  validatePathArray(rawConfig.repos, 'repos', errors, true)
  validateDefaultAgent(rawConfig.default_agent, errors, true)
  validateArtifactRoot(rawConfig.artifact_root, errors, true)
  validateBootstrapHooks(rawConfig.bootstrap_hooks, errors, true)
  return errors
}

function validatePathArray(
  value: unknown,
  field: 'scan_roots' | 'repos',
  errors: ConfigFieldError[],
  allowUndefined = false
): void {
  if (value === undefined && allowUndefined) {
    return
  }

  if (!Array.isArray(value)) {
    errors.push({ field, message: `${field} must be an array of strings.` })
    return
  }

  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      errors.push({
        field: `${field}[${index}]`,
        message: `${field} entries must be non-empty strings.`
      })
    }
  })
}

function validateDefaultAgent(
  value: unknown,
  errors: ConfigFieldError[],
  allowUndefined = false
): void {
  if ((value === undefined && allowUndefined) || value === null || value === '') {
    return
  }

  if (value !== 'codex' && value !== 'claude') {
    errors.push({
      field: 'default_agent',
      message: 'default_agent must be codex, claude, or empty.'
    })
  }
}

function validateArtifactRoot(
  value: unknown,
  errors: ConfigFieldError[],
  allowUndefined = false
): void {
  if ((value === undefined && allowUndefined) || value === null) {
    return
  }

  if (typeof value !== 'string' || value.trim() === '') {
    errors.push({
      field: 'artifact_root',
      message: 'artifact_root must be a non-empty string or null.'
    })
  }
}

function validateBootstrapHooks(
  value: unknown,
  errors: ConfigFieldError[],
  allowUndefined = false
): void {
  if (value === undefined && allowUndefined) {
    return
  }

  if (!Array.isArray(value)) {
    errors.push({
      field: 'bootstrap_hooks',
      message: 'bootstrap_hooks must be an array of hook tables.'
    })
    return
  }

  value.forEach((hook, index) => {
    if (!isRecord(hook)) {
      errors.push({
        field: `bootstrap_hooks[${index}]`,
        message: 'bootstrap_hooks entries must be objects.'
      })
      return
    }

    if (typeof hook.command !== 'string' || hook.command.trim() === '') {
      errors.push({
        field: `bootstrap_hooks[${index}].command`,
        message: 'command must be a non-empty string.'
      })
    }

    for (const key of ['name', 'cwd'] as const) {
      const optionalValue = hook[key]
      if (
        optionalValue !== undefined &&
        (typeof optionalValue !== 'string' || optionalValue.trim() === '')
      ) {
        errors.push({
          field: `bootstrap_hooks[${index}].${key}`,
          message: `${key} must be a non-empty string when present.`
        })
      }
    }

    if (hook.env !== undefined) {
      if (!isRecord(hook.env)) {
        errors.push({
          field: `bootstrap_hooks[${index}].env`,
          message: 'env must be a string-to-string map.'
        })
      } else {
        for (const [envKey, envValue] of Object.entries(hook.env)) {
          if (typeof envValue !== 'string') {
            errors.push({
              field: `bootstrap_hooks[${index}].env.${envKey}`,
              message: 'env values must be strings.'
            })
          }
        }
      }
    }
  })
}

function normalizeEditableConfig(rawConfig: RawConfig, configPath: string): EditableConfigState {
  return {
    configPath,
    scan_roots: getConfiguredPathValues(rawConfig.scan_roots),
    repos: getConfiguredPathValues(rawConfig.repos),
    default_agent: normalizeDefaultAgent(rawConfig.default_agent),
    artifact_root: typeof rawConfig.artifact_root === 'string' ? rawConfig.artifact_root : null,
    bootstrap_hooks: normalizeBootstrapHooks(rawConfig.bootstrap_hooks)
  }
}

function normalizeDefaultAgent(value: unknown): DefaultAgent | null {
  return value === 'codex' || value === 'claude' ? value : null
}

function normalizeBootstrapHooks(value: unknown): EditableBootstrapHook[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter(isRecord).map((hook) => {
    const normalizedHook: EditableBootstrapHook = {
      command: typeof hook.command === 'string' ? hook.command : ''
    }

    if (typeof hook.name === 'string') {
      normalizedHook.name = hook.name
    }

    if (typeof hook.cwd === 'string') {
      normalizedHook.cwd = hook.cwd
    }

    if (isRecord(hook.env)) {
      normalizedHook.env = Object.fromEntries(
        Object.entries(hook.env).filter((entry): entry is [string, string] =>
          typeof entry[1] === 'string'
        )
      )
    }

    return normalizedHook
  })
}

function resolveDefaultUserConfigPath(options: LoadGrindstoneConfigOptions): string {
  const homeDirectory = options.homeDir ?? homedir()
  const xdgConfigHome =
    options.env === undefined ? process.env.XDG_CONFIG_HOME : options.env.XDG_CONFIG_HOME
  const userConfigRoot = xdgConfigHome === undefined || xdgConfigHome === ''
    ? join(homeDirectory, '.config')
    : xdgConfigHome

  return join(userConfigRoot, 'grindstone', 'config.toml')
}

async function writeConfigAtomically(configPath: string, contents: string): Promise<void> {
  const configDir = dirname(configPath)
  await mkdir(configDir, { recursive: true })

  const tempPath = join(configDir, `.config.toml.${process.pid}.${randomUUID()}.tmp`)
  const existingMode = await getExistingMode(configPath)
  const mode = existingMode ?? 0o600

  try {
    await writeFile(tempPath, contents, { mode })
    await chmod(tempPath, mode)
    await rename(tempPath, configPath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw error
  }
}

async function getExistingMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}
