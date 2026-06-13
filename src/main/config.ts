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
}

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
  const userConfigRoot = xdgConfigHome ?? join(homeDirectory, '.config')

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

  return diagnostics
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}
