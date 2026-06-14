import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse } from 'smol-toml'
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
  artifactRoot: ConfiguredPath
  diagnostics: CatalogDiagnostic[]
}

export type LoadGrindstoneConfigOptions = {
  artifactRoot?: string
  configPath?: string
  cwd?: string
  env?: Partial<Pick<NodeJS.ProcessEnv, 'XDG_CONFIG_HOME'>>
  homeDir?: string
}

type RawConfig = {
  artifacts?: unknown
  scan_roots?: unknown
  repos?: unknown
}

const DEFAULT_ARTIFACT_ROOT = '~/.local/state/wtui/sessions/v1'

export async function loadGrindstoneConfig(
  options: LoadGrindstoneConfigOptions = {}
): Promise<GrindstoneConfigResult> {
  const configPath = await resolveConfigPath(options)

  if (configPath === undefined) {
    return emptyConfig(undefined, options)
  }

  let rawConfig: RawConfig
  try {
    rawConfig = parse(await readFile(configPath, 'utf8')) as RawConfig
  } catch (error) {
    return {
      ...emptyConfig(configPath, options),
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
      ...emptyConfig(configPath, options),
      ok: false,
      diagnostics
    }
  }

  const configDir = dirname(configPath)
  const homeDirectory = options.homeDir ?? homedir()
  const artifactRoot = resolveConfiguredPath(
    options.artifactRoot ?? getConfiguredArtifactRoot(rawConfig) ?? DEFAULT_ARTIFACT_ROOT,
    configDir,
    homeDirectory
  )

  return {
    ok: true,
    configPath,
    scanRoots: getConfiguredPathValues(rawConfig.scan_roots).map((path) =>
      resolveConfiguredPath(path, configDir, homeDirectory)
    ),
    repos: getConfiguredPathValues(rawConfig.repos).map((path) =>
      resolveConfiguredPath(path, configDir, homeDirectory)
    ),
    artifactRoot,
    diagnostics: []
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
  const diagnostics: CatalogDiagnostic[] = []

  for (const key of ['scan_roots', 'repos'] as const) {
    const value = rawConfig[key]
    if (value === undefined) {
      continue
    }

    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      diagnostics.push({
        severity: 'error',
        code: 'config_type_error',
        message: `${key} must be an array of strings.`,
        configuredPath: key,
        resolvedPath: configPath
      })
    }
  }

  if (rawConfig.artifacts !== undefined) {
    if (!isPlainObject(rawConfig.artifacts)) {
      diagnostics.push({
        severity: 'error',
        code: 'config_type_error',
        message: 'artifacts must be a table.',
        configuredPath: 'artifacts',
        resolvedPath: configPath
      })
    } else if (typeof rawConfig.artifacts.root !== 'string') {
      diagnostics.push({
        severity: 'error',
        code: 'config_type_error',
        message: 'artifacts.root must be a string.',
        configuredPath: 'artifacts.root',
        resolvedPath: configPath
      })
    }
  }

  return diagnostics
}

function getConfiguredArtifactRoot(rawConfig: RawConfig): string | undefined {
  if (!isPlainObject(rawConfig.artifacts)) {
    return undefined
  }

  return typeof rawConfig.artifacts.root === 'string' ? rawConfig.artifacts.root : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function emptyConfig(
  configPath: string | undefined,
  options: LoadGrindstoneConfigOptions = {}
): GrindstoneConfigResult {
  const homeDirectory = options.homeDir ?? homedir()
  const configDir = configPath === undefined ? options.cwd ?? process.cwd() : dirname(configPath)

  return {
    ok: true,
    configPath,
    scanRoots: [],
    repos: [],
    artifactRoot: resolveConfiguredPath(
      options.artifactRoot ?? DEFAULT_ARTIFACT_ROOT,
      configDir,
      homeDirectory
    ),
    diagnostics: []
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}
