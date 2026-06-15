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

  it.each(['done', 'active'] as const)(
    'attaches sessions to existing legacy %s Flow phases',
    async (status) => {
      const root = await makeTempDir()
      const flows = createFlowOperations({ artifactRoot: root })
      await flows.createFlow({
        id: `flow-legacy-${status}`,
        title: 'Legacy Flow',
        repoPath: '/repo',
        now: '2026-06-15T09:00:00.000Z'
      })
      await writeFile(join(root, 'flows', `flow-legacy-${status}`, 'meta.json'), JSON.stringify({
        schema_version: 1,
        flow_id: `flow-legacy-${status}`,
        title: 'Legacy Flow',
        status: 'active',
        repo_path: '/repo',
        phases: [
          {
            phase_id: 'implementation',
            title: 'Implementation',
            status,
            order: 1,
            created_at: '2026-06-15T09:00:00.000Z',
            updated_at: '2026-06-15T09:00:00.000Z'
          }
        ],
        created_at: '2026-06-15T09:00:00.000Z',
        updated_at: '2026-06-15T09:00:00.000Z'
      }))

      await expect(ingestSessionHook({ artifactRoot: root }, {
        provider: 'codex',
        flowId: `flow-legacy-${status}`,
        phaseId: 'implementation',
        payload: `${JSON.stringify({
          id: `event-${status}`,
          session_id: `codex-${status}-session`,
          type: 'message',
          content: `attached to ${status}`
        })}\n`,
        now: '2026-06-15T10:01:00.000Z'
      })).resolves.toMatchObject({
        metadata: {
          attachment_status: 'attached',
          phase_id: 'implementation'
        }
      })
      await expect(flows.readFlow(`flow-legacy-${status}`)).resolves.toMatchObject({
        phases: [
          expect.objectContaining({
            phase_id: 'implementation',
            status,
            sessions: [
              expect.objectContaining({
                session_id: `codex-${status}-session`,
                attachment_status: 'attached'
              })
            ]
          })
        ]
      })
    }
  )

  it('extracts text from structured Codex and Claude content without storing raw payloads', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({ id: 'flow-structured', title: 'Structured Flow', repoPath: '/repo' })
    await flows.setPhase({
      flowId: 'flow-structured',
      phaseId: 'implementation',
      title: 'Implementation',
      status: 'running',
      order: 1
    })

    const codex = await ingestSessionHook({ artifactRoot: root }, {
      provider: 'codex',
      flowId: 'flow-structured',
      phaseId: 'implementation',
      payload: `${JSON.stringify({
        id: 'codex-structured',
        session_id: 'codex-structured-session',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'First structured part.' },
          { type: 'output_text', text: 'Second structured part.' }
        ]
      })}\n`,
      now: '2026-06-15T10:02:00.000Z'
    })
    expect(codex.events[0]?.text).toBe('First structured part.\nSecond structured part.')

    const claude = await ingestSessionHook({ artifactRoot: root }, {
      provider: 'claude',
      flowId: 'flow-structured',
      phaseId: 'implementation',
      payload: JSON.stringify({
        session_id: 'claude-structured-session',
        messages: [
          {
            type: 'message',
            role: 'assistant',
            message: {
              content: [
                { type: 'text', text: 'Nested Claude text.' }
              ]
            }
          }
        ]
      }),
      now: '2026-06-15T10:03:00.000Z'
    })
    expect(claude.events[0]?.text).toBe('Nested Claude text.')

    const transcript = await readFile(
      join(root, 'sessions', 'codex', 'codex-structured-session', 'transcript.jsonl'),
      'utf8'
    )
    expect(transcript).toContain('First structured part.')
    expect(transcript).not.toContain('output_text')
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

  it('rejects oversized Claude transcript_path files before parsing', async () => {
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
    const hookDir = join(root, 'hooks')
    await mkdir(hookDir)
    await writeFile(join(hookDir, 'transcript.jsonl'), 'x'.repeat((10 * 1024 * 1024) + 1))

    await expect(ingestSessionHook({ artifactRoot: root }, {
      provider: 'claude',
      flowId: 'flow-one',
      phaseId: 'implementation',
      sourcePath: join(hookDir, 'hook.json'),
      payload: JSON.stringify({
        session_id: 'claude-session',
        transcript_path: 'transcript.jsonl'
      })
    })).rejects.toThrow(/Transcript exceeds maximum size/)
  })

  it('preserves original session metadata when reattachment targets another Flow phase', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({ id: 'flow-one', title: 'Flow One', repoPath: '/repo' })
    await flows.createFlow({ id: 'flow-two', title: 'Flow Two', repoPath: '/repo' })
    await flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'implementation',
      title: 'Implementation',
      status: 'running',
      order: 1
    })
    await flows.setPhase({
      flowId: 'flow-two',
      phaseId: 'review-loop',
      title: 'Review loop',
      status: 'running',
      order: 1
    })

    await ingestSessionHook({ artifactRoot: root }, {
      provider: 'codex',
      flowId: 'flow-one',
      phaseId: 'implementation',
      payload: `${JSON.stringify({
        id: 'event-1',
        session_id: 'codex-session',
        type: 'message',
        content: 'original'
      })}\n`,
      now: '2026-06-15T10:01:00.000Z'
    })

    await expect(ingestSessionHook({ artifactRoot: root }, {
      provider: 'codex',
      flowId: 'flow-two',
      phaseId: 'review-loop',
      payload: `${JSON.stringify({
        id: 'event-2',
        session_id: 'codex-session',
        type: 'message',
        content: 'conflict'
      })}\n`,
      now: '2026-06-15T10:02:00.000Z'
    })).rejects.toThrow(/different Flow phase/)

    await expect(readFile(
      join(root, 'sessions', 'codex', 'codex-session', 'meta.json'),
      'utf8'
    ).then((text) => JSON.parse(text) as Record<string, unknown>)).resolves.toMatchObject({
      flow_id: 'flow-one',
      phase_id: 'implementation',
      attachment_status: 'pending',
      last_attachment_error: 'Session is already attached to a different Flow phase.'
    })
  })

  it('rejects mixed provider session IDs before merging transcript events', async () => {
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

    await expect(ingestSessionHook({ artifactRoot: root }, {
      provider: 'codex',
      flowId: 'flow-one',
      phaseId: 'implementation',
      payload: [
        JSON.stringify({ session_id: 'codex-one', content: 'first' }),
        JSON.stringify({ session_id: 'codex-two', content: 'second' })
      ].join('\n')
    })).rejects.toThrow(/Conflicting session ids/)

    const hookDir = join(root, 'hooks')
    await mkdir(hookDir)
    await writeFile(join(hookDir, 'transcript.jsonl'), [
      JSON.stringify({ sessionId: 'claude-transcript', text: 'transcript' })
    ].join('\n'))

    await expect(ingestSessionHook({ artifactRoot: root }, {
      provider: 'claude',
      flowId: 'flow-one',
      phaseId: 'implementation',
      sourcePath: join(hookDir, 'hook.json'),
      payload: JSON.stringify({
        session_id: 'claude-hook',
        transcript_path: 'transcript.jsonl'
      })
    })).rejects.toThrow(/Conflicting session ids/)
  })

  it('rejects existing session metadata that does not match its provider path', async () => {
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
    const sessionDir = join(root, 'sessions', 'codex', 'codex-session')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'meta.json'), JSON.stringify({
      schema_version: 1,
      provider: 'codex',
      session_id: 'other-session',
      flow_id: 'flow-one',
      phase_id: 'implementation',
      status: 'unknown',
      attachment_status: 'attached',
      transcript_path: join(sessionDir, 'transcript.jsonl'),
      source_summary: {
        provider: 'codex',
        input_format: 'codex-jsonl',
        event_count: 0,
        warnings: []
      },
      created_at: '2026-06-15T10:00:00.000Z',
      updated_at: '2026-06-15T10:00:00.000Z'
    }))
    await writeFile(join(sessionDir, 'transcript.jsonl'), '')

    await expect(ingestSessionHook({ artifactRoot: root }, {
      provider: 'codex',
      flowId: 'flow-one',
      phaseId: 'implementation',
      payload: `${JSON.stringify({
        session_id: 'codex-session',
        content: 'new'
      })}\n`
    })).rejects.toThrow(/Stored session metadata does not match/)
  })
})
