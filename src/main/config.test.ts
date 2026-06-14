import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getEditableConfig,
  loadGrindstoneConfig,
  mergeCommonConfig,
  updateCommonConfigFile,
  validateCommonConfigInput
} from './config'
import type { CommonConfigUpdateInput } from '@shared/config'

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
      bootstrapHooks: [],
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
      bootstrapHooks: [],
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
          configuredPath: 'repos[0]',
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
    const emptyRootPath = join(root, 'empty-artifact-root.toml')
    await writeFile(invalidArtifactsPath, 'artifacts = "not-a-table"\n')
    await writeFile(missingRootPath, '[artifacts]\n')
    await writeFile(invalidRootPath, '[artifacts]\nroot = 42\n')
    await writeFile(emptyRootPath, '[artifacts]\nroot = "  "\n')

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

    await expect(loadGrindstoneConfig({ configPath: emptyRootPath })).resolves.toMatchObject({
      ok: false,
      diagnostics: [
        {
          severity: 'error',
          code: 'config_type_error',
          configuredPath: 'artifacts.root',
          resolvedPath: emptyRootPath
        }
      ]
    })
  })

  it('keeps repository loading scoped to path fields when other editable fields are invalid', async () => {
    const root = await makeTempDir()
    const configPath = join(root, 'invalid-editor-fields.toml')
    await writeFile(
      configPath,
      [
        'repos = ["./repo"]',
        'default_agent = "unsupported"',
        'artifact_root = ""',
        '',
        '[[bootstrap_hooks]]',
        'command = ""'
      ].join('\n')
    )

    await expect(loadGrindstoneConfig({ configPath })).resolves.toMatchObject({
      ok: true,
      configPath,
      repos: [
        {
          configuredPath: './repo',
          resolvedPath: join(root, 'repo')
        }
      ],
      diagnostics: []
    })

    await expect(getEditableConfig({ configPath })).rejects.toThrow('Invalid Grindstone config')
  })
})

describe('editable Grindstone config', () => {
  it('normalizes common settings from TOML and keeps bootstrap hooks editable', async () => {
    const root = await makeTempDir()
    const configPath = join(root, 'grindstone.toml')
    await writeFile(
      configPath,
      [
        'scan_roots = ["../projects"]',
        'repos = ["~/repo"]',
        'default_agent = "codex"',
        'artifact_root = "./artifacts"',
        '',
        '[[bootstrap_hooks]]',
        'name = "Install"',
        'command = "npm install"',
        'cwd = "./app"',
        '[bootstrap_hooks.env]',
        'NODE_ENV = "test"'
      ].join('\n')
    )

    await expect(getEditableConfig({ configPath })).resolves.toEqual({
      configPath,
      scan_roots: ['../projects'],
      repos: ['~/repo'],
      default_agent: 'codex',
      artifact_root: './artifacts',
      bootstrap_hooks: [
        {
          sourceIndex: 0,
          name: 'Install',
          command: 'npm install',
          cwd: './app',
          env: {
            NODE_ENV: 'test'
          }
        }
      ]
    })
  })

  it('validates common setting updates with field-addressable errors', () => {
    expect(
      validateCommonConfigInput({
        scan_roots: ['  '],
        repos: [42],
        default_agent: 'gpt',
        artifact_root: '',
        bootstrap_hooks: [
          {
            command: '',
            cwd: '',
            env: {
              GOOD: 'value',
              BAD: 7
            }
          }
        ]
      })
    ).toEqual([
      {
        field: 'scan_roots[0]',
        message: 'scan_roots entries must be non-empty strings.'
      },
      {
        field: 'repos[0]',
        message: 'repos entries must be non-empty strings.'
      },
      {
        field: 'default_agent',
        message: 'default_agent must be codex, claude, or empty.'
      },
      {
        field: 'artifact_root',
        message: 'artifact_root must be a non-empty string or null.'
      },
      {
        field: 'bootstrap_hooks[0].command',
        message: 'command must be a non-empty string.'
      },
      {
        field: 'bootstrap_hooks[0].cwd',
        message: 'cwd must be a non-empty string when present.'
      },
      {
        field: 'bootstrap_hooks[0].env.BAD',
        message: 'env values must be strings.'
      }
    ])
  })

  it('updates only editor-owned keys while preserving advanced TOML data', async () => {
    const root = await makeTempDir()
    const configPath = join(root, 'grindstone.toml')
    await writeFile(
      configPath,
      [
        'scan_roots = ["old-root"]',
        'repos = ["old-repo"]',
        'unknown_scalar = 42',
        '',
        '[prompts.review]',
        'template = "Keep me"',
        '',
        '[[templates]]',
        'name = "standup"',
        'body = "Preserve arrays of tables"',
        '',
        '[[bootstrap_hooks]]',
        'command = "before"',
        'timeout = 30',
        'shell = "zsh"',
        '',
        '[unknown.nested]',
        'enabled = true'
      ].join('\n')
    )

    const input: CommonConfigUpdateInput = {
      scan_roots: ['new-root'],
      repos: ['new-repo'],
      default_agent: 'claude',
      artifact_root: 'artifacts',
      bootstrap_hooks: [
        {
          sourceIndex: 0,
          command: 'npm test',
          name: 'Tests'
        }
      ]
    }

    await expect(updateCommonConfigFile(input, { configPath })).resolves.toMatchObject({
      ok: true,
      configPath,
      config: input
    })

    const parsed = parse(await readFile(configPath, 'utf8'))
    expect(parsed).toMatchObject({
      scan_roots: ['new-root'],
      repos: ['new-repo'],
      default_agent: 'claude',
      artifact_root: 'artifacts',
      bootstrap_hooks: [
        {
          command: 'npm test',
          name: 'Tests',
          timeout: 30,
          shell: 'zsh'
        }
      ],
      unknown_scalar: 42,
      prompts: {
        review: {
          template: 'Keep me'
        }
      },
      templates: [
        {
          name: 'standup',
          body: 'Preserve arrays of tables'
        }
      ],
      unknown: {
        nested: {
          enabled: true
        }
      }
    })
  })

  it('does not write invalid edits', async () => {
    const root = await makeTempDir()
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, 'repos = ["before"]\n')

    await expect(
      updateCommonConfigFile(
        {
          scan_roots: [],
          repos: [''],
          default_agent: null,
          artifact_root: null,
          bootstrap_hooks: []
        },
        { configPath }
      )
    ).resolves.toEqual({
      ok: false,
      kind: 'validation',
      errors: [
        {
          field: 'repos[0]',
          message: 'repos entries must be non-empty strings.'
        }
      ]
    })

    await expect(readFile(configPath, 'utf8')).resolves.toBe('repos = ["before"]\n')
  })

  it('preserves unknown bootstrap hook fields by source index instead of draft position', async () => {
    const root = await makeTempDir()
    const configPath = join(root, 'grindstone.toml')
    await writeFile(
      configPath,
      [
        '[[bootstrap_hooks]]',
        'command = "first"',
        'timeout = 10',
        '',
        '[[bootstrap_hooks]]',
        'command = "second"',
        'shell = "zsh"'
      ].join('\n')
    )

    await updateCommonConfigFile(
      {
        scan_roots: [],
        repos: [],
        default_agent: null,
        artifact_root: null,
        bootstrap_hooks: [
          {
            sourceIndex: 1,
            command: 'second edited'
          }
        ]
      },
      { configPath }
    )

    expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({
      bootstrap_hooks: [
        {
          command: 'second edited',
          shell: 'zsh'
        }
      ]
    })
  })

  it('creates a missing default user config under XDG_CONFIG_HOME', async () => {
    const root = await makeTempDir()
    const cwd = join(root, 'cwd')
    const xdg = join(root, 'xdg')
    await mkdir(cwd)

    const result = await updateCommonConfigFile(
      {
        scan_roots: ['projects'],
        repos: ['~/repo'],
        default_agent: null,
        artifact_root: null,
        bootstrap_hooks: []
      },
      { cwd, env: { XDG_CONFIG_HOME: xdg }, homeDir: root }
    )

    const configPath = join(xdg, 'grindstone', 'config.toml')
    expect(result).toEqual({
      ok: true,
      configPath,
      config: {
        configPath,
        scan_roots: ['projects'],
        repos: ['~/repo'],
        default_agent: null,
        artifact_root: null,
        bootstrap_hooks: []
      }
    })
    await expect(readFile(configPath, 'utf8')).resolves.toContain('scan_roots')
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  })

  it('preserves file mode when replacing an existing config file', async () => {
    const root = await makeTempDir()
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, 'repos = ["before"]\n', { mode: 0o640 })

    await updateCommonConfigFile(
      {
        scan_roots: [],
        repos: ['after'],
        default_agent: null,
        artifact_root: null,
        bootstrap_hooks: []
      },
      { configPath }
    )

    expect((await stat(configPath)).mode & 0o777).toBe(0o640)
  })

  it('resolves relative and home paths after saved edits', async () => {
    const root = await makeTempDir()
    const configDir = join(root, 'config')
    const homeDir = join(root, 'home')
    await mkdir(configDir)
    const configPath = join(configDir, 'grindstone.toml')

    await updateCommonConfigFile(
      {
        scan_roots: ['../projects'],
        repos: ['~/repo'],
        default_agent: null,
        artifact_root: null,
        bootstrap_hooks: []
      },
      { configPath, homeDir }
    )

    await expect(loadGrindstoneConfig({ configPath, homeDir })).resolves.toMatchObject({
      scanRoots: [
        {
          configuredPath: '../projects',
          resolvedPath: join(root, 'projects')
        }
      ],
      repos: [
        {
          configuredPath: '~/repo',
          resolvedPath: join(homeDir, 'repo')
        }
      ]
    })
  })

  it('merges common config without mutating the parsed source object', () => {
    const raw = {
      repos: ['old'],
      prompts: {
        review: {
          template: 'Keep me'
        }
      }
    }

    const merged = mergeCommonConfig(raw, {
      scan_roots: ['new-root'],
      repos: ['new-repo'],
      default_agent: null,
      artifact_root: null,
      bootstrap_hooks: []
    })

    expect(raw).toEqual({
      repos: ['old'],
      prompts: {
        review: {
          template: 'Keep me'
        }
      }
    })
    expect(merged).toMatchObject({
      scan_roots: ['new-root'],
      repos: ['new-repo'],
      prompts: {
        review: {
          template: 'Keep me'
        }
      }
    })
  })
})
