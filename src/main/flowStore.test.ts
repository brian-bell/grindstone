import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RepositoryRow } from '@shared/workspace'
import { createFlowStore } from './flowStore'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-flow-store-'))
}

async function makeRepository(root: string, name: string): Promise<RepositoryRow> {
  const repositoryPath = join(root, name)
  await mkdir(repositoryPath, { recursive: true })
  const canonicalPath = await realpath(repositoryPath)

  return {
    id: canonicalPath,
    name,
    path: repositoryPath,
    canonicalPath,
    sources: ['explicit']
  }
}

async function writeFlowMeta(
  artifactRoot: string,
  flowId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  const flowDir = join(artifactRoot, 'flows', flowId)
  await mkdir(flowDir, { recursive: true })
  await writeFile(join(flowDir, 'meta.json'), JSON.stringify(metadata, null, 2))
}

function flowMeta(
  flowId: string,
  repositoryPath: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema_version: 1,
    flow_id: flowId,
    title: `Flow ${flowId}`,
    status: 'active',
    repo_path: repositoryPath,
    created_at: '2026-06-10T10:00:00.000Z',
    updated_at: '2026-06-10T10:00:00.000Z',
    ...overrides
  }
}

describe('Flow artifact store', () => {
  it('initializes the flows collection below the artifact root and lists an empty repository', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const repository = await makeRepository(root, 'repo-empty')

    const store = await createFlowStore({ artifactRoot })

    await expect(stat(join(artifactRoot, 'flows'))).resolves.toMatchObject({})
    await expect(store.listFlowsForRepository(repository)).resolves.toEqual([])
  })

  it('lists only records for the selected repository sorted by updated time', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const selectedRepository = await makeRepository(root, 'repo-selected')
    const otherRepository = await makeRepository(root, 'repo-other')

    await writeFlowMeta(
      artifactRoot,
      'older-flow',
      flowMeta('older-flow', selectedRepository.path, {
        title: 'Older selected Flow',
        branch: 'flow/older',
        plan_id: 'plan-older',
        updated_at: '2026-06-10T10:00:00.000Z',
        phases: [
          {
            phase_id: 'phase-build',
            title: 'Build list',
            status: 'done',
            order: 2,
            kind: 'implementation',
            summary: 'List rendered',
            launch_ids: ['wtui-launch-one'],
            sessions: [
              {
                provider: 'codex',
                session_id: 'codex-session-one',
                launch_id: 'wtui-launch-two',
                status: 'unknown',
                attachment_status: 'attached',
                started_at: '2026-06-10T10:31:00.000Z',
                transcript_path: join(artifactRoot, 'sessions', 'codex', 'codex-session-one', 'transcript.jsonl')
              }
            ],
            updated_at: '2026-06-10T10:30:00.000Z'
          }
        ]
      })
    )
    await writeFlowMeta(
      artifactRoot,
      'newer-flow',
      flowMeta('newer-flow', selectedRepository.path, {
        title: 'Newer selected Flow',
        updated_at: '2026-06-11T10:00:00.000Z'
      })
    )
    await writeFlowMeta(
      artifactRoot,
      'other-flow',
      flowMeta('other-flow', otherRepository.path, {
        title: 'Other repository Flow',
        updated_at: '2026-06-12T10:00:00.000Z'
      })
    )
    await writeFlowMeta(
      join(artifactRoot, 'plans'),
      'plan-looking-flow',
      flowMeta('plan-looking-flow', selectedRepository.path)
    )

    const store = await createFlowStore({ artifactRoot })

    await expect(store.listFlowsForRepository(selectedRepository)).resolves.toEqual([
      expect.objectContaining({
        id: 'newer-flow',
        title: 'Newer selected Flow',
        repositoryId: selectedRepository.id,
        repositoryPath: selectedRepository.id,
        updatedAt: '2026-06-11T10:00:00.000Z'
      }),
      expect.objectContaining({
        id: 'older-flow',
        title: 'Older selected Flow',
        branch: 'flow/older',
        planId: 'plan-older',
        phases: [
          {
            id: 'phase-build',
            title: 'Build list',
            status: 'done',
            order: 2,
            kind: 'implementation',
            summary: 'List rendered',
            launchIds: ['wtui-launch-one', 'wtui-launch-two'],
            updatedAt: '2026-06-10T10:30:00.000Z'
          }
        ]
      })
    ])
  })

  it('sorts flows by parsed updated time when RFC3339 precisions differ', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const selectedRepository = await makeRepository(root, 'repo-precision')

    await writeFlowMeta(
      artifactRoot,
      'whole-second-flow',
      flowMeta('whole-second-flow', selectedRepository.path, {
        updated_at: '2026-06-14T03:00:00Z'
      })
    )
    await writeFlowMeta(
      artifactRoot,
      'fractional-flow',
      flowMeta('fractional-flow', selectedRepository.path, {
        updated_at: '2026-06-14T03:00:00.5Z'
      })
    )

    const store = await createFlowStore({ artifactRoot })

    await expect(store.listFlowsForRepository(selectedRepository)).resolves.toEqual([
      expect.objectContaining({ id: 'fractional-flow' }),
      expect.objectContaining({ id: 'whole-second-flow' })
    ])
  })

  it('matches worktree-scoped flows when the selected repository is the worktree', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const baseRepository = await makeRepository(root, 'repo-base')
    const worktreeRepository = await makeRepository(root, 'repo-worktree')

    await writeFlowMeta(
      artifactRoot,
      'worktree-flow',
      flowMeta('worktree-flow', baseRepository.path, {
        worktree_path: worktreeRepository.path
      })
    )

    const store = await createFlowStore({ artifactRoot })

    await expect(store.listFlowsForRepository(worktreeRepository)).resolves.toEqual([
      expect.objectContaining({
        id: 'worktree-flow',
        repositoryId: baseRepository.id,
        worktreePath: worktreeRepository.path
      })
    ])
  })

  it('exposes the canonical repository path when metadata uses a symlinked repo path', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const selectedRepository = await makeRepository(root, 'repo-canonical')
    const symlinkedRepositoryPath = join(root, 'repo-link')
    await symlink(selectedRepository.path, symlinkedRepositoryPath)
    await writeFlowMeta(
      artifactRoot,
      'symlinked-flow',
      flowMeta('symlinked-flow', symlinkedRepositoryPath)
    )

    const store = await createFlowStore({ artifactRoot })

    await expect(store.listFlowsForRepository(selectedRepository)).resolves.toEqual([
      expect.objectContaining({
        id: 'symlinked-flow',
        repositoryId: selectedRepository.id,
        repositoryPath: selectedRepository.id
      })
    ])
  })

  it('skips corrupt records during listing and supports store-level read by id', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const repository = await makeRepository(root, 'repo-tolerant')
    await writeFlowMeta(artifactRoot, 'valid-flow', flowMeta('valid-flow', repository.path))
    await writeFlowMeta(artifactRoot, 'wrong-schema', flowMeta('wrong-schema', repository.path, {
      schema_version: 2
    }))
    await writeFlowMeta(artifactRoot, 'mismatched-id', flowMeta('different-id', repository.path))
    await writeFlowMeta(artifactRoot, '!unsafe', flowMeta('!unsafe', repository.path))
    await writeFlowMeta(artifactRoot, 'missing-repo-path', {
      ...flowMeta('missing-repo-path', repository.path),
      repo_path: 42
    })
    await writeFlowMeta(artifactRoot, 'missing-repo-realpath', flowMeta(
      'missing-repo-realpath',
      join(root, 'missing-repo')
    ))
    await mkdir(join(artifactRoot, 'flows', 'missing-meta'), { recursive: true })
    await mkdir(join(artifactRoot, 'flows', '.locks'), { recursive: true })
    await writeFile(join(artifactRoot, 'flows', '.update.lock'), '')
    await mkdir(join(artifactRoot, 'flows', 'bad-json'), { recursive: true })
    await writeFile(join(artifactRoot, 'flows', 'bad-json', 'meta.json'), '{')
    await mkdir(join(artifactRoot, 'flows', 'null-json'), { recursive: true })
    await writeFile(join(artifactRoot, 'flows', 'null-json', 'meta.json'), 'null')

    const store = await createFlowStore({ artifactRoot })

    await expect(store.listFlowsForRepository(repository)).resolves.toEqual([
      expect.objectContaining({ id: 'valid-flow' })
    ])
    await expect(store.readFlow('valid-flow')).resolves.toEqual(
      expect.objectContaining({ id: 'valid-flow' })
    )
    await expect(store.readFlow('missing-flow')).resolves.toBeUndefined()
    await expect(store.readFlow('../unsafe')).resolves.toBeUndefined()
    await expect(store.flowArtifactExists('valid-flow')).resolves.toBe(true)
    await expect(store.flowArtifactExists('missing-meta')).resolves.toBe(true)
    await expect(store.flowArtifactExists('missing-flow')).resolves.toBe(false)
    await expect(store.flowArtifactExists('../unsafe')).resolves.toBe(false)
  })

  it('exposes valid PR metadata and omits malformed legacy PR metadata', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const repository = await makeRepository(root, 'repo-pr-metadata')
    await writeFlowMeta(
      artifactRoot,
      'without-pr',
      flowMeta('without-pr', repository.path, {
        updated_at: '2026-06-10T10:02:00.000Z',
        phases: [
          {
            phase_id: 'pr-creation',
            title: 'PR Creation',
            kind: 'pr_creation',
            status: 'completed',
            outcome: 'pr_recorded',
            summary: 'Opened PR before metadata existed.',
            order: 6
          },
          {
            phase_id: 'human-review',
            title: 'Human Review',
            kind: 'human_review',
            status: 'blocked',
            outcome: 'blocked',
            notes: 'Blocked before structured PR metadata existed.',
            order: 7
          }
        ]
      })
    )
    await writeFlowMeta(
      artifactRoot,
      'with-pr',
      flowMeta('with-pr', repository.path, {
        pr: {
          provider: 'github',
          number: 42,
          url: 'https://github.com/acme/grindstone/pull/42',
          head: 'flow/with-pr',
          base: 'main',
          status: 'open'
        },
        human_review: {
          outcome: 'approved',
          reviewed_at: '2026-06-10T10:02:00.000Z',
          notes: 'Approved by reviewer.'
        },
        merge: {
          status: 'blocked',
          notes: 'Waiting on required checks.',
          updated_at: '2026-06-10T10:03:00.000Z'
        }
      })
    )
    await writeFlowMeta(
      artifactRoot,
      'malformed-pr',
      flowMeta('malformed-pr', repository.path, {
        updated_at: '2026-06-10T10:01:00.000Z',
        pr: {
          provider: 'github',
          number: '42',
          url: 'http://github.com/acme/grindstone/pull/42',
          head: '',
          base: 'main',
          status: 'open'
        },
        phases: [
          {
            phase_id: 'pr-creation',
            title: 'PR Creation',
            kind: 'pr_creation',
            status: 'completed',
            outcome: 'pr_recorded',
            summary: 'Opened PR with malformed metadata.',
            order: 6
          },
          {
            phase_id: 'human-review',
            title: 'Human Review',
            kind: 'human_review',
            status: 'done',
            order: 7
          }
        ]
      })
    )

    const store = await createFlowStore({ artifactRoot })

    await expect(store.listFlowsForRepository(repository)).resolves.toEqual([
      expect.objectContaining({
        id: 'without-pr',
        pr: undefined,
        phases: expect.arrayContaining([
          expect.objectContaining({
            id: 'pr-creation',
            status: 'ready'
          }),
          expect.objectContaining({
            id: 'human-review',
            status: 'pending'
          })
        ])
      }),
      expect.objectContaining({
        id: 'malformed-pr',
        pr: undefined,
        phases: expect.arrayContaining([
          expect.objectContaining({
            id: 'pr-creation',
            status: 'ready'
          }),
          expect.objectContaining({
            id: 'human-review',
            status: 'pending'
          })
        ])
      }),
      expect.objectContaining({
        id: 'with-pr',
        pr: {
          provider: 'github',
          number: 42,
          url: 'https://github.com/acme/grindstone/pull/42',
          head: 'flow/with-pr',
          base: 'main',
          status: 'open'
        },
        humanReview: {
          outcome: 'approved',
          reviewed_at: '2026-06-10T10:02:00.000Z',
          notes: 'Approved by reviewer.'
        },
        merge: {
          status: 'blocked',
          notes: 'Waiting on required checks.',
          updated_at: '2026-06-10T10:03:00.000Z'
        }
      })
    ])

    await store.updateFlowRecord('malformed-pr', {
      updatedAt: '2026-06-10T10:02:00.000Z'
    })
    const rawFlow = JSON.parse(
      await readFile(join(artifactRoot, 'flows', 'malformed-pr', 'meta.json'), 'utf8')
    ) as Record<string, unknown>
    expect(rawFlow.pr).toBeUndefined()
    expect(rawFlow.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase_id: 'pr-creation', status: 'ready' }),
      expect.objectContaining({ phase_id: 'human-review', status: 'pending' })
    ]))

    await store.updateFlowRecord('without-pr', {
      updatedAt: '2026-06-10T10:03:00.000Z'
    })
    const rawLegacyFlow = JSON.parse(
      await readFile(join(artifactRoot, 'flows', 'without-pr', 'meta.json'), 'utf8')
    ) as Record<string, unknown>
    expect(rawLegacyFlow.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase_id: 'pr-creation', status: 'ready' }),
      expect.objectContaining({ phase_id: 'human-review', status: 'pending' })
    ]))
  })

  it('does not expose merged status without valid merged metadata', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const repository = await makeRepository(root, 'repo-invalid-merge-status')
    await writeFlowMeta(
      artifactRoot,
      'invalid-merge-status',
      flowMeta('invalid-merge-status', repository.path, {
        status: 'merged',
        merge: {
          status: 'merged',
          commit: 'short',
          merged_at: 'not-a-date'
        }
      })
    )
    const store = await createFlowStore({ artifactRoot })

    await expect(store.readFlow('invalid-merge-status')).resolves.toMatchObject({
      id: 'invalid-merge-status',
      status: 'active',
      merge: { status: 'pending' }
    })
    await expect(store.listFlowsForRepository(repository)).resolves.toEqual([
      expect.objectContaining({
        id: 'invalid-merge-status',
        status: 'active',
        merge: { status: 'pending' }
      })
    ])
  })

  it('does not expose merged metadata without approved Human Review', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const repository = await makeRepository(root, 'repo-merged-without-review')
    const mergedMetadata = {
      status: 'merged',
      commit: 'abcdef1234567890abcdef1234567890abcdef12',
      merged_at: '2026-06-10T10:05:00.000Z'
    }
    await writeFlowMeta(
      artifactRoot,
      'merged-with-changes-requested',
      flowMeta('merged-with-changes-requested', repository.path, {
        status: 'merged',
        pr: {
          provider: 'github',
          number: 46,
          url: 'https://github.com/acme/grindstone/pull/46',
          head: 'flow/changes-requested',
          base: 'main',
          status: 'open'
        },
        human_review: {
          outcome: 'changes_requested',
          reviewed_at: '2026-06-10T10:04:00.000Z',
          notes: 'Needs changes.'
        },
        merge: mergedMetadata
      })
    )
    await writeFlowMeta(
      artifactRoot,
      'merged-with-approval',
      flowMeta('merged-with-approval', repository.path, {
        status: 'merged',
        updated_at: '2026-06-10T10:06:00.000Z',
        pr: {
          provider: 'github',
          number: 47,
          url: 'https://github.com/acme/grindstone/pull/47',
          head: 'flow/approved',
          base: 'main',
          status: 'merged'
        },
        human_review: {
          outcome: 'approved',
          reviewed_at: '2026-06-10T10:04:00.000Z'
        },
        merge: mergedMetadata
      })
    )
    const store = await createFlowStore({ artifactRoot })

    await expect(store.readFlow('merged-with-changes-requested')).resolves.toMatchObject({
      id: 'merged-with-changes-requested',
      status: 'needs_attention',
      humanReview: {
        outcome: 'changes_requested',
        notes: 'Needs changes.'
      },
      merge: { status: 'pending' }
    })
    await expect(store.readFlow('merged-with-approval')).resolves.toMatchObject({
      id: 'merged-with-approval',
      status: 'merged',
      humanReview: { outcome: 'approved' },
      merge: mergedMetadata
    })
  })

  it('does not let stale blocked merge metadata override a later non-approved Human Review', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const repository = await makeRepository(root, 'repo-stale-blocked-merge')
    await writeFlowMeta(
      artifactRoot,
      'stale-blocked-merge',
      flowMeta('stale-blocked-merge', repository.path, {
        status: 'blocked',
        pr: {
          provider: 'github',
          number: 45,
          url: 'https://github.com/acme/grindstone/pull/45',
          head: 'flow/stale-merge',
          base: 'main',
          status: 'open'
        },
        human_review: {
          outcome: 'changes_requested',
          reviewed_at: '2026-06-10T10:04:00.000Z',
          notes: 'Review changed after blocked merge.'
        },
        merge: {
          status: 'blocked',
          notes: 'Older merge block.',
          updated_at: '2026-06-10T10:03:00.000Z'
        }
      })
    )
    const store = await createFlowStore({ artifactRoot })

    await expect(store.readFlow('stale-blocked-merge')).resolves.toMatchObject({
      id: 'stale-blocked-merge',
      status: 'needs_attention',
      humanReview: {
        outcome: 'changes_requested',
        notes: 'Review changed after blocked merge.'
      },
      merge: { status: 'pending' }
    })
  })

  it('creates and updates Flow records under the artifact root', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const repository = await makeRepository(root, 'repo-created-flow')
    const store = await createFlowStore({ artifactRoot })

    await expect(store.createFlowRecord({
      id: 'created-flow',
      title: 'Created Flow',
      instructions: 'Build the feature',
      status: 'creating',
      repositoryPath: repository.path,
      branch: 'flow/created-flow',
      worktreePath: join(root, 'repo-created-flow-worktrees', 'flow-created-flow'),
      baseRef: 'main',
      createdAt: '2026-06-14T10:00:00.000Z',
      updatedAt: '2026-06-14T10:00:00.000Z'
    })).resolves.toMatchObject({
      id: 'created-flow',
      title: 'Created Flow',
      instructions: 'Build the feature',
      status: 'creating',
      branch: 'flow/created-flow',
      baseRef: 'main'
    })

    await expect(store.updateFlowRecord('created-flow', {
      status: 'failed',
      commit: 'abc123',
      start: {
        repositoryPath: repository.id,
        worktreePath: join(root, 'repo-created-flow-worktrees', 'flow-created-flow'),
        branch: 'flow/created-flow',
        baseRef: 'main',
        commit: 'abc123'
      },
      failure: {
        stage: 'bootstrap',
        message: 'npm install failed',
        command: 'npm install',
        output: 'missing package'
      },
      updatedAt: '2026-06-14T10:02:00.000Z'
    })).resolves.toMatchObject({
      id: 'created-flow',
      status: 'failed',
      commit: 'abc123',
      start: {
        branch: 'flow/created-flow',
        baseRef: 'main',
        commit: 'abc123'
      },
      failure: {
        stage: 'bootstrap',
        message: 'npm install failed',
        command: 'npm install',
        output: 'missing package'
      },
      updatedAt: '2026-06-14T10:02:00.000Z'
    })

    await expect(store.listFlowsForRepository(repository)).resolves.toEqual([
      expect.objectContaining({
        id: 'created-flow',
        failure: expect.objectContaining({
          stage: 'bootstrap'
        })
      })
    ])
  })

  it('clears failure metadata when a Flow record update sets failure to null', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const repository = await makeRepository(root, 'repo-clear-failure')
    const store = await createFlowStore({ artifactRoot })

    await store.createFlowRecord({
      id: 'recovering-flow',
      title: 'Recovering Flow',
      instructions: 'Clear stale failure metadata.',
      status: 'failed',
      repositoryPath: repository.path,
      failure: {
        stage: 'launch_prep',
        message: 'launch failed'
      },
      createdAt: '2026-06-14T10:00:00.000Z',
      updatedAt: '2026-06-14T10:00:00.000Z'
    })

    await expect(store.updateFlowRecord('recovering-flow', {
      status: 'active',
      failure: null,
      updatedAt: '2026-06-14T10:01:00.000Z'
    })).resolves.toMatchObject({
      id: 'recovering-flow',
      status: 'active',
      failure: undefined
    })
    await expect(store.readFlow('recovering-flow')).resolves.toMatchObject({
      id: 'recovering-flow',
      status: 'active',
      failure: undefined
    })
  })

  it('skips persisted terminal records with unsafe identifiers', async () => {
    const root = await makeTempDir()
    const artifactRoot = join(root, 'artifacts')
    const repository = await makeRepository(root, 'repo-terminal-ids')
    await writeFlowMeta(artifactRoot, 'terminal-id-flow', flowMeta('terminal-id-flow', repository.path, {
      terminals: [
        {
          terminal_id: '../escape',
          launch_id: 'launch-unsafe-terminal',
          provider: 'codex',
          mode: 'interactive',
          flow_id: 'terminal-id-flow',
          phase_id: 'plan',
          status: 'failed',
          command: 'codex',
          argv: [],
          cwd: repository.path,
          started_at: '2026-06-14T10:00:00.000Z'
        },
        {
          terminal_id: 'terminal-unsafe-flow',
          launch_id: 'launch-unsafe-flow',
          provider: 'codex',
          mode: 'interactive',
          flow_id: '../escape',
          phase_id: 'plan',
          status: 'failed',
          command: 'codex',
          argv: [],
          cwd: repository.path,
          started_at: '2026-06-14T10:00:00.000Z'
        },
        {
          terminal_id: 'terminal-cross-flow',
          launch_id: 'launch-cross-flow',
          provider: 'codex',
          mode: 'interactive',
          flow_id: 'other-flow',
          phase_id: 'plan',
          status: 'failed',
          command: 'codex',
          argv: [],
          cwd: repository.path,
          started_at: '2026-06-14T10:00:00.000Z'
        },
        {
          terminal_id: 'terminal-safe',
          launch_id: 'launch-safe',
          provider: 'claude',
          mode: 'interactive',
          flow_id: 'terminal-id-flow',
          phase_id: 'review',
          status: 'running',
          command: 'claude',
          argv: ['review'],
          cwd: repository.path,
          started_at: '2026-06-14T10:01:00.000Z',
          recent_output: 'ready\n'
        }
      ]
    }))

    const store = await createFlowStore({ artifactRoot })

    await expect(store.readFlow('terminal-id-flow')).resolves.toMatchObject({
      terminals: [
        {
          terminalId: 'terminal-safe',
          flowId: 'terminal-id-flow',
          recentOutput: 'ready\n'
        }
      ]
    })
  })

  it('treats artifact root and flows collection access failures as fatal', async () => {
    const root = await makeTempDir()
    const artifactRootFile = join(root, 'artifact-root-file')
    await writeFile(artifactRootFile, '')

    await expect(createFlowStore({ artifactRoot: artifactRootFile })).rejects.toThrow(
      /Flow artifact store unavailable/
    )

    const artifactRoot = join(root, 'artifact-root')
    await mkdir(artifactRoot)
    await writeFile(join(artifactRoot, 'flows'), '')

    await expect(createFlowStore({ artifactRoot })).rejects.toThrow(
      /Flow artifact store unavailable/
    )
  })
})
