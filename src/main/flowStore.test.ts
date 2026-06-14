import { mkdir, stat, symlink, writeFile } from 'node:fs/promises'
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
