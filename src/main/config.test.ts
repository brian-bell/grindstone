import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadGrindstoneConfig } from './config'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-config-'))
}

describe('Grindstone config loader', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('loads scan roots and explicit repos from an explicit config path', async () => {
    const root = await makeTempDir()
    const configDir = join(root, 'config')
    await mkdir(configDir)
    const configPath = join(configDir, 'grindstone.toml')
    await writeFile(
      configPath,
      'scan_roots = ["../projects"]\nrepos = ["/opt/explicit-repo"]\nunknown_key = true\n'
    )

    await expect(loadGrindstoneConfig({ configPath, homeDir: root })).resolves.toEqual({
      ok: true,
      configPath,
      scanRoots: [
        {
          configuredPath: '../projects',
          resolvedPath: join(root, 'projects')
        }
      ],
      repos: [
        {
          configuredPath: '/opt/explicit-repo',
          resolvedPath: '/opt/explicit-repo'
        }
      ],
      artifactRoot: {
        configuredPath: '~/.local/state/wtui/sessions/v1',
        resolvedPath: join(root, '.local', 'state', 'wtui', 'sessions', 'v1')
      },
      diagnostics: []
    })
  })

  it('resolves the default wtui artifact root when no config exists', async () => {
    const root = await makeTempDir()

    await expect(
      loadGrindstoneConfig({
        cwd: join(root, 'missing-cwd'),
        env: { XDG_CONFIG_HOME: join(root, 'missing-xdg') },
        homeDir: root
      })
    ).resolves.toMatchObject({
      ok: true,
      artifactRoot: {
        configuredPath: '~/.local/state/wtui/sessions/v1',
        resolvedPath: join(root, '.local', 'state', 'wtui', 'sessions', 'v1')
      }
    })
  })

  it('resolves the default wtui artifact root below XDG_STATE_HOME when set', async () => {
    const root = await makeTempDir()
    const stateRoot = join(root, 'state-home')

    await expect(
      loadGrindstoneConfig({
        cwd: join(root, 'missing-cwd'),
        env: {
          XDG_CONFIG_HOME: join(root, 'missing-xdg'),
          XDG_STATE_HOME: stateRoot
        },
        homeDir: root
      })
    ).resolves.toMatchObject({
      ok: true,
      artifactRoot: {
        configuredPath: join(stateRoot, 'wtui', 'sessions', 'v1'),
        resolvedPath: join(stateRoot, 'wtui', 'sessions', 'v1')
      }
    })
  })

  it('resolves configured artifact roots with the existing path rules', async () => {
    const root = await makeTempDir()
    const configDir = join(root, 'config')
    await mkdir(configDir)
    const configPath = join(configDir, 'grindstone.toml')
    await writeFile(configPath, '[artifacts]\nroot = "../wtui-state"\n')

    await expect(loadGrindstoneConfig({ configPath, homeDir: root })).resolves.toMatchObject({
      ok: true,
      artifactRoot: {
        configuredPath: '../wtui-state',
        resolvedPath: join(root, 'wtui-state')
      }
    })
  })

  it('checks cwd config before XDG config and returns empty config when none exists', async () => {
    const root = await makeTempDir()
    const cwd = join(root, 'cwd')
    const xdg = join(root, 'xdg')
    await mkdir(cwd)
    await mkdir(join(xdg, 'grindstone'), { recursive: true })
    await writeFile(join(cwd, 'grindstone.toml'), 'repos = ["./cwd-repo"]\n')
    await writeFile(join(xdg, 'grindstone', 'config.toml'), 'repos = ["./xdg-repo"]\n')

    await expect(
      loadGrindstoneConfig({ cwd, env: { XDG_CONFIG_HOME: xdg }, homeDir: root })
    ).resolves.toMatchObject({
      ok: true,
      configPath: join(cwd, 'grindstone.toml'),
      repos: [
        {
          configuredPath: './cwd-repo',
          resolvedPath: join(cwd, 'cwd-repo')
        }
      ]
    })

    await expect(
      loadGrindstoneConfig({
        cwd: join(root, 'missing-cwd'),
        env: { XDG_CONFIG_HOME: join(root, 'missing-xdg') },
        homeDir: root
      })
    ).resolves.toEqual({
      ok: true,
      configPath: undefined,
      scanRoots: [],
      repos: [],
      artifactRoot: {
        configuredPath: '~/.local/state/wtui/sessions/v1',
        resolvedPath: join(root, '.local', 'state', 'wtui', 'sessions', 'v1')
      },
      diagnostics: []
    })
  })

  it('uses ~/.config/grindstone/config.toml when XDG_CONFIG_HOME is unset', async () => {
    const root = await makeTempDir()
    const cwd = join(root, 'cwd')
    const homeDir = join(root, 'home')
    await mkdir(cwd)
    await mkdir(join(homeDir, '.config', 'grindstone'), { recursive: true })
    await writeFile(join(homeDir, '.config', 'grindstone', 'config.toml'), 'repos = ["~/repo"]\n')

    await expect(loadGrindstoneConfig({ cwd, env: {}, homeDir })).resolves.toMatchObject({
      ok: true,
      configPath: join(homeDir, '.config', 'grindstone', 'config.toml'),
      repos: [
        {
          configuredPath: '~/repo',
          resolvedPath: join(homeDir, 'repo')
        }
      ]
    })
  })

  it('treats an empty XDG_CONFIG_HOME as unset', async () => {
    const root = await makeTempDir()
    const cwd = join(root, 'cwd')
    const homeDir = join(root, 'home')
    await mkdir(cwd)
    await mkdir(join(homeDir, '.config', 'grindstone'), { recursive: true })
    await writeFile(join(homeDir, '.config', 'grindstone', 'config.toml'), 'repos = ["repo"]\n')

    await expect(loadGrindstoneConfig({ cwd, env: { XDG_CONFIG_HOME: '' }, homeDir }))
      .resolves.toMatchObject({
        ok: true,
        configPath: join(homeDir, '.config', 'grindstone', 'config.toml'),
        repos: [
          {
            configuredPath: 'repo',
            resolvedPath: join(homeDir, '.config', 'grindstone', 'repo')
          }
        ]
      })
  })

  it('returns actionable diagnostics for invalid TOML and invalid value types', async () => {
    const root = await makeTempDir()
    const invalidTomlPath = join(root, 'invalid.toml')
    const invalidTypePath = join(root, 'invalid-type.toml')
    await writeFile(invalidTomlPath, 'scan_roots = [')
    await writeFile(invalidTypePath, 'scan_roots = "not-an-array"\nrepos = [1]\n')

    await expect(loadGrindstoneConfig({ configPath: invalidTomlPath })).resolves.toMatchObject({
      ok: false,
      configPath: invalidTomlPath,
      scanRoots: [],
      repos: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'config_parse_error',
          configuredPath: invalidTomlPath,
          resolvedPath: invalidTomlPath
        }
      ]
    })

    await expect(loadGrindstoneConfig({ configPath: invalidTypePath })).resolves.toMatchObject({
      ok: false,
      configPath: invalidTypePath,
      scanRoots: [],
      repos: [],
      diagnostics: [
        {
          severity: 'error',
          code: 'config_type_error',
          configuredPath: 'scan_roots',
          resolvedPath: invalidTypePath
        },
        {
          severity: 'error',
          code: 'config_type_error',
          configuredPath: 'repos',
          resolvedPath: invalidTypePath
        }
      ]
    })
  })

  it('returns diagnostics for invalid artifact root config', async () => {
    const root = await makeTempDir()
    const invalidArtifactsPath = join(root, 'invalid-artifacts.toml')
    const missingRootPath = join(root, 'missing-artifact-root.toml')
    const invalidRootPath = join(root, 'invalid-artifact-root.toml')
    await writeFile(invalidArtifactsPath, 'artifacts = "not-a-table"\n')
    await writeFile(missingRootPath, '[artifacts]\n')
    await writeFile(invalidRootPath, '[artifacts]\nroot = 42\n')

    await expect(loadGrindstoneConfig({ configPath: invalidArtifactsPath })).resolves.toMatchObject({
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'config_type_error',
          configuredPath: 'artifacts',
          resolvedPath: invalidArtifactsPath
        }
      ]
    })

    await expect(loadGrindstoneConfig({ configPath: missingRootPath })).resolves.toMatchObject({
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'config_type_error',
          configuredPath: 'artifacts.root',
          resolvedPath: missingRootPath
        }
      ]
    })

    await expect(loadGrindstoneConfig({ configPath: invalidRootPath })).resolves.toMatchObject({
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'config_type_error',
          configuredPath: 'artifacts.root',
          resolvedPath: invalidRootPath
        }
      ]
    })
  })
})
