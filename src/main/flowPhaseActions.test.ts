import { mkdir, readFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createFlowPhaseLaunchRecord,
  resolveFlowReviewBehavior
} from './flowPhaseActions'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-flow-actions-'))
}

describe('Flow phase actions', () => {
  it('resolves review behavior by phase id, then phase kind, then generic default', () => {
    expect(resolveFlowReviewBehavior({
      phaseId: 'review-loop-2',
      phaseKind: 'review_loop',
      behaviors: {
        byPhaseId: {
          'review-loop-2': {
            id: 'second-review',
            prompt: 'Run the independent second review.'
          }
        },
        byKind: {
          review_loop: {
            id: 'kind-review',
            prompt: 'Run the review loop.'
          }
        }
      }
    })).toEqual({
      id: 'second-review',
      prompt: 'Run the independent second review.'
    })

    expect(resolveFlowReviewBehavior({
      phaseId: 'review-loop-1',
      phaseKind: 'review_loop',
      behaviors: {
        byKind: {
          review_loop: {
            id: 'kind-review',
            prompt: 'Run the review loop.'
          }
        }
      }
    })).toEqual({
      id: 'kind-review',
      prompt: 'Run the review loop.'
    })

    expect(resolveFlowReviewBehavior({
      phaseId: 'review-loop-unknown',
      phaseKind: 'review_loop'
    })).toMatchObject({
      id: 'generic-review',
      prompt: expect.not.stringMatching(/autoreview|skill/i)
    })
  })

  it('persists resolved review behavior in launch records', async () => {
    const root = await makeTempDir()
    await mkdir(join(root, 'launches'), { recursive: true })

    await createFlowPhaseLaunchRecord({
      artifactRoot: root,
      launchId: 'launch-review-two',
      flowId: 'flow-one',
      phaseId: 'review-loop-2',
      phaseTitle: 'Review Loop 2',
      phaseKind: 'review_loop',
      repositoryPath: '/repo',
      reviewBehavior: {
        id: 'second-review',
        prompt: 'Review the branch without skill-specific coupling.',
        runnerHint: 'generic'
      }
    }, '2026-06-15T12:00:00.000Z')

    await expect(
      readFile(join(root, 'launches', 'launch-review-two', 'meta.json'), 'utf8')
    ).resolves.toContain('"review_behavior"')
    const metadata = JSON.parse(
      await readFile(join(root, 'launches', 'launch-review-two', 'meta.json'), 'utf8')
    ) as Record<string, unknown>
    expect(metadata).toMatchObject({
      review_behavior: {
        id: 'second-review',
        prompt: 'Review the branch without skill-specific coupling.',
        runner_hint: 'generic'
      }
    })
  })
})
