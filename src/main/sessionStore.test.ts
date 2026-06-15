import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFlowOperations } from './flowOperations'
import { ingestSessionHook } from './sessionStore'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-session-store-'))
}

describe('session-hook transcript ingestion', () => {
  it('matches canonical Codex and Claude normalized transcript fixtures', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({ id: 'flow-fixture', title: 'Fixture Flow', repoPath: '/repo' })
    await flows.setPhase({
      flowId: 'flow-fixture',
      phaseId: 'implementation',
      title: 'Implementation',
      status: 'running',
      order: 1
    })

    const fixtureRoot = join(process.cwd(), 'src', 'cli', 'session-hook', '__fixtures__')
    const codex = await ingestSessionHook({ artifactRoot: root }, {
      provider: 'codex',
      flowId: 'flow-fixture',
      phaseId: 'implementation',
      payload: await readFile(join(fixtureRoot, 'codex-jsonl.input.jsonl'), 'utf8'),
      now: '2026-06-15T10:10:00.000Z'
    })
    expect(codex.events.map((event) => JSON.stringify(event)).join('\n'))
      .toBe((await readFile(join(fixtureRoot, 'codex-jsonl.expected.jsonl'), 'utf8')).trim())

    const claude = await ingestSessionHook({ artifactRoot: root }, {
      provider: 'claude',
      flowId: 'flow-fixture',
      phaseId: 'implementation',
      sourcePath: join(fixtureRoot, 'claude-hook.input.json'),
      payload: await readFile(join(fixtureRoot, 'claude-hook.input.json'), 'utf8'),
      now: '2026-06-15T10:11:00.000Z'
    })
    const expectedClaudeEvents = (await readFile(join(fixtureRoot, 'claude-hook.expected.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(claude.events).toMatchObject(expectedClaudeEvents)
  })

  it('normalizes Codex JSONL transcripts and attaches the session to a Flow phase', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({ id: 'flow-one', title: 'Flow One', repoPath: '/repo' })
    await flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'implementation',
      title: 'Implementation',
      status: 'running',
      order: 1
    })

    const result = await ingestSessionHook({ artifactRoot: root }, {
      provider: 'codex',
      flowId: 'flow-one',
      phaseId: 'implementation',
      payload: [
        JSON.stringify({
          id: 'event-1',
          session_id: 'codex-session',
          timestamp: '2026-06-15T10:00:00.000Z',
          type: 'message',
          role: 'assistant',
          content: 'Implemented the slice.'
        })
      ].join('\n'),
      now: '2026-06-15T10:01:00.000Z'
    })

    expect(result.metadata).toMatchObject({
      provider: 'codex',
      session_id: 'codex-session',
      flow_id: 'flow-one',
      phase_id: 'implementation',
      attachment_status: 'attached'
    })
    expect(result.events).toEqual([
      expect.objectContaining({
        event_id: 'event-1',
        text: 'Implemented the slice.',
        role: 'assistant'
      })
    ])
    await expect(readFile(
      join(root, 'sessions', 'codex', 'codex-session', 'transcript.jsonl'),
      'utf8'
    )).resolves.toContain('Implemented the slice.')
    await expect(flows.readFlow('flow-one')).resolves.toMatchObject({
      phases: [
        expect.objectContaining({
          phase_id: 'implementation',
          sessions: [
            expect.objectContaining({
              provider: 'codex',
              session_id: 'codex-session',
              attachment_status: 'attached'
            })
          ]
        })
      ]
    })
  })

  it('reads Claude transcript_path relative to hook file and rejects missing Flow metadata', async () => {
    const root = await makeTempDir()
    const hookDir = join(root, 'hooks')
    await mkdir(hookDir)
    await writeFile(join(hookDir, 'transcript.jsonl'), [
      JSON.stringify({
        sessionId: 'claude-session',
        timestamp: '2026-06-15T10:00:00.000Z',
        type: 'message',
        role: 'user',
        text: 'Please inspect this.'
      })
    ].join('\n'))

    await expect(ingestSessionHook({ artifactRoot: root }, {
      provider: 'claude',
      sourcePath: join(hookDir, 'hook.json'),
      payload: JSON.stringify({
        session_id: 'claude-session',
        transcript_path: 'transcript.jsonl'
      })
    })).rejects.toThrow(/requires Flow and phase/)
  })
})
