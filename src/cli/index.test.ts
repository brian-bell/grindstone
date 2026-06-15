import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runCli } from './index'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-cli-'))
}

function io(input = '', env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv): {
  stdout: { value: string; write: (chunk: string | Uint8Array) => boolean }
  stderr: { value: string; write: (chunk: string | Uint8Array) => boolean }
  stdin: NodeJS.ReadStream
  env: NodeJS.ProcessEnv
} {
  const stdout = {
    value: '',
    write(chunk: string | Uint8Array) {
      this.value += String(chunk)
      return true
    }
  }
  const stderr = {
    value: '',
    write(chunk: string | Uint8Array) {
      this.value += String(chunk)
      return true
    }
  }
  return {
    stdout,
    stderr,
    stdin: Readable.from([input]) as NodeJS.ReadStream,
    env
  }
}

describe('grindstone CLI', () => {
  it('keeps CLI sources independent from Electron, preload, and renderer modules', async () => {
    const files = await listTypeScriptFiles(join(process.cwd(), 'src', 'cli'))
    const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

    expect(source).not.toMatch(/from ['"]electron['"]/)
    expect(source).not.toMatch(/src\/preload|\.\.\/preload|@renderer|src\/renderer|\.\.\/renderer/)
  })

  it('prints help and rejects unknown commands with concise stderr', async () => {
    const helpIo = io()
    await expect(runCli(['--help'], helpIo)).resolves.toBe(0)
    expect(helpIo.stdout.value).toContain('grindstone flow create')

    const badIo = io()
    await expect(runCli(['unknown'], badIo)).resolves.toBe(1)
    expect(badIo.stderr.value).toContain('Unknown command')
  })

  it('runs through the built package bin path', async () => {
    const build = spawnSync('npm', ['run', 'build:cli'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    })
    expect(build.status, build.stderr || build.stdout).toBe(0)

    const binDir = await makeTempDir()
    const grindstoneBin = join(binDir, 'grindstone')
    await symlink(resolve('out/cli/index.js'), grindstoneBin)

    const result = spawnSync(grindstoneBin, ['--help'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    })
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain('grindstone flow create')
  })

  it('reports unsupported session-hook providers as typed validation errors', async () => {
    const unsupportedIo = io('', { GRINDSTONE_STATE_ROOT: await makeTempDir() } as NodeJS.ProcessEnv)

    await expect(runCli([
      'session-hook',
      'ingest',
      '--provider',
      'unknown'
    ], unsupportedIo)).resolves.toBe(1)

    expect(JSON.parse(unsupportedIo.stderr.value)).toMatchObject({
      error: {
        code: 'validation_error',
        message: 'Unsupported provider: unknown'
      }
    })
  })

  it('rejects oversized session-hook files before ingestion', async () => {
    const root = await makeTempDir()
    const payloadPath = join(root, 'oversized.jsonl')
    await writeFile(payloadPath, 'x'.repeat((10 * 1024 * 1024) + 1))
    const oversizedIo = io('', { GRINDSTONE_STATE_ROOT: root } as NodeJS.ProcessEnv)

    await expect(runCli([
      'session-hook',
      'ingest',
      '--provider',
      'codex',
      '--file',
      payloadPath
    ], oversizedIo)).resolves.toBe(1)

    expect(JSON.parse(oversizedIo.stderr.value)).toMatchObject({
      error: {
        code: 'validation_error',
        message: expect.stringContaining('Input exceeds maximum size')
      }
    })
  })

  it('saves, links, and reads plans through the CLI contract', async () => {
    const root = await makeTempDir()
    const createIo = io('', { GRINDSTONE_STATE_ROOT: root } as NodeJS.ProcessEnv)
    await expect(runCli([
      'flow',
      'create',
      '--title',
      'Agent Flow',
      '--repo-path',
      '/repo'
    ], createIo)).resolves.toBe(0)
    const flow = JSON.parse(createIo.stdout.value) as { flow_id: string }

    const saveIo = io('# Plan\n', { GRINDSTONE_STATE_ROOT: root } as NodeJS.ProcessEnv)
    await expect(runCli([
      'plan',
      'save',
      '--title',
      'Agent Plan',
      '--plan-id',
      'agent-plan'
    ], saveIo)).resolves.toBe(0)
    expect(saveIo.stdout.value).toBe('agent-plan\n')

    const linkIo = io('', { GRINDSTONE_STATE_ROOT: root } as NodeJS.ProcessEnv)
    await expect(runCli([
      'plan',
      'link',
      '--flow-id',
      flow.flow_id,
      '--plan-id',
      'agent-plan'
    ], linkIo)).resolves.toBe(0)
    expect(JSON.parse(linkIo.stdout.value)).toMatchObject({ plan_id: 'agent-plan' })

    const readIo = io('', { GRINDSTONE_STATE_ROOT: root } as NodeJS.ProcessEnv)
    await expect(runCli(['plan', 'read', '--plan-id', 'agent-plan'], readIo)).resolves.toBe(0)
    expect(readIo.stdout.value).toBe('# Plan\n')
  })

  it('completes PR Creation with structured PR metadata flags', async () => {
    const root = await makeTempDir()
    const createIo = io('', { GRINDSTONE_STATE_ROOT: root } as NodeJS.ProcessEnv)
    await expect(runCli([
      'flow',
      'create',
      '--title',
      'PR Flow',
      '--repo-path',
      '/repo'
    ], createIo)).resolves.toBe(0)
    const flow = JSON.parse(createIo.stdout.value) as {
      flow_id: string
      phases: Array<Record<string, unknown>>
    }
    await writeFile(join(root, 'flows', flow.flow_id, 'meta.json'), JSON.stringify({
      ...flow,
      phases: flow.phases.map((phase) =>
        phase.phase_id === 'pr-creation'
          ? { ...phase, status: 'running' }
          : phase
      )
    }, null, 2))

    const completeIo = io('', { GRINDSTONE_STATE_ROOT: root } as NodeJS.ProcessEnv)
    await expect(runCli([
      'flow',
      'phase',
      'complete',
      '--flow-id',
      flow.flow_id,
      '--phase-id',
      'pr-creation',
      '--pr-provider',
      'github',
      '--pr-number',
      '31',
      '--pr-url',
      'https://github.com/acme/grindstone/pull/31',
      '--pr-head',
      'flow/cli-pr',
      '--pr-base',
      'main',
      '--pr-status',
      'open',
      '--summary',
      'Opened PR #31.'
    ], completeIo)).resolves.toBe(0)

    expect(JSON.parse(completeIo.stdout.value)).toMatchObject({
      pr: {
        provider: 'github',
        number: 31,
        url: 'https://github.com/acme/grindstone/pull/31',
        head: 'flow/cli-pr',
        base: 'main',
        status: 'open'
      },
      phases: expect.arrayContaining([
        expect.objectContaining({
          phase_id: 'pr-creation',
          status: 'completed',
          outcome: 'pr_recorded',
          summary: 'Opened PR #31.'
        }),
        expect.objectContaining({
          phase_id: 'human-review',
          status: 'ready'
        })
      ])
    })
  })

  it('ingests a Codex session-hook payload using env metadata aliases', async () => {
    const root = await makeTempDir()
    await runCli([
      'flow',
      'create',
      '--title',
      'Agent Flow',
      '--repo-path',
      '/repo'
    ], io('', { GRINDSTONE_STATE_ROOT: root } as NodeJS.ProcessEnv))
    const createIo = io('', { GRINDSTONE_STATE_ROOT: root } as NodeJS.ProcessEnv)
    await runCli(['flow', 'list'], createIo)
    const flowId = (JSON.parse(createIo.stdout.value) as Array<{ flow_id: string }>)[0]?.flow_id ?? ''
    await runCli([
      'flow',
      'phase',
      'set',
      '--flow-id',
      flowId,
      '--phase-id',
      'implementation',
      '--title',
      'Implementation',
      '--status',
      'running',
      '--order',
      '1'
    ], io('', { GRINDSTONE_STATE_ROOT: root } as NodeJS.ProcessEnv))

    const ingestIo = io(`${JSON.stringify({
      session_id: 'codex-session',
      type: 'message',
      role: 'assistant',
      content: 'done'
    })}\n`, {
      GRINDSTONE_STATE_ROOT: root,
      WTUI_FLOW_ID: flowId,
      WTUI_FLOW_PHASE_ID: 'implementation'
    } as NodeJS.ProcessEnv)
    await expect(runCli(['session-hook', 'ingest', '--provider', 'codex'], ingestIo)).resolves.toBe(0)
    expect(JSON.parse(ingestIo.stdout.value)).toMatchObject({
      event_count: 1,
      metadata: {
        session_id: 'codex-session',
        attachment_status: 'attached'
      }
    })
    expect(JSON.parse(ingestIo.stdout.value)).not.toHaveProperty('events')
    expect(ingestIo.stdout.value).not.toContain('done')
    await expect(readFile(
      join(root, 'sessions', 'codex', 'codex-session', 'transcript.jsonl'),
      'utf8'
    )).resolves.toContain('done')
  })
})

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return listTypeScriptFiles(path)
    }
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : []
  }))
  return files.flat()
}
