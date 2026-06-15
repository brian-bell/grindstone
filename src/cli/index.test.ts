import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      metadata: {
        session_id: 'codex-session',
        attachment_status: 'attached'
      }
    })
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
