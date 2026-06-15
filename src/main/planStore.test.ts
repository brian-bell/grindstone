import { mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFlowOperations } from './flowOperations'
import { createPlanStore } from './planStore'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-plan-store-'))
}

describe('plan artifact store and Flow linkage', () => {
  it('saves Markdown plans with metadata, lists by filters, and reads body exactly', async () => {
    const root = await makeTempDir()
    const store = createPlanStore({ artifactRoot: root })

    const metadata = await store.savePlan({
      planId: 'plan-one',
      title: 'Plan One',
      status: 'approved',
      repoPath: '/repo',
      branch: 'flow/one',
      body: '# Plan\n\nKeep markdown.\n',
      now: '2026-06-15T10:00:00.000Z'
    })

    expect(metadata).toMatchObject({
      plan_id: 'plan-one',
      status: 'approved',
      repo_path: '/repo',
      branch: 'flow/one'
    })
    await expect(store.readPlan('plan-one')).resolves.toMatchObject({
      metadata: expect.objectContaining({ plan_id: 'plan-one' }),
      body: '# Plan\n\nKeep markdown.\n'
    })
    await expect(store.listPlans({ repoPath: '/repo' })).resolves.toEqual([
      expect.objectContaining({ plan_id: 'plan-one' })
    ])
    await expect(store.listPlans({ repoPath: '/other' })).resolves.toEqual([])

    if (process.platform !== 'win32') {
      expect((await stat(join(root, 'plans', 'plan-one', 'meta.json'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(root, 'plans', 'plan-one', 'plan.md'))).mode & 0o777).toBe(0o600)
    }
  })

  it('links Flow and plan metadata idempotently and rejects conflicting replacements', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({
      id: 'flow-one',
      title: 'Flow One',
      repoPath: '/repo',
      now: '2026-06-15T10:00:00.000Z'
    })
    await plans.savePlan({
      planId: 'plan-one',
      title: 'Plan One',
      body: 'body',
      now: '2026-06-15T10:01:00.000Z'
    })
    await plans.savePlan({
      planId: 'plan-two',
      title: 'Plan Two',
      body: 'body',
      now: '2026-06-15T10:02:00.000Z'
    })

    await expect(flows.linkPlan({
      flowId: 'flow-one',
      planId: 'plan-one',
      now: '2026-06-15T10:03:00.000Z'
    })).resolves.toMatchObject({
      flow_id: 'flow-one',
      plan_id: 'plan-one',
      plan_path: expect.stringContaining('plan.md')
    })
    await expect(flows.linkPlan({
      flowId: 'flow-one',
      planId: 'plan-one',
      now: '2026-06-15T10:04:00.000Z'
    })).resolves.toMatchObject({ plan_id: 'plan-one' })
    await expect(plans.readPlan('plan-one')).resolves.toMatchObject({
      metadata: {
        flow_id: 'flow-one',
        flow_path: expect.stringContaining('meta.json')
      }
    })
    await expect(plans.savePlan({
      planId: 'plan-one',
      title: 'Replacement',
      body: 'replacement',
      now: '2026-06-15T10:05:00.000Z'
    })).rejects.toThrow(/already exists/)
    await expect(plans.readPlan('plan-one')).resolves.toMatchObject({
      metadata: {
        title: 'Plan One',
        flow_id: 'flow-one',
        linked_at: '2026-06-15T10:03:00.000Z'
      },
      body: 'body'
    })
    await expect(flows.linkPlan({ flowId: 'flow-one', planId: 'plan-two' }))
      .rejects.toThrow(/already links plan/)
  })

  it('rejects duplicate Flow ids without overwriting the existing artifact', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({
      id: 'flow-one',
      title: 'Flow One',
      repoPath: '/repo',
      now: '2026-06-15T10:00:00.000Z'
    })
    await flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'implementation',
      title: 'Implementation',
      status: 'running',
      order: 1,
      now: '2026-06-15T10:01:00.000Z'
    })

    await expect(flows.createFlow({
      id: 'flow-one',
      title: 'Replacement Flow',
      repoPath: '/other',
      now: '2026-06-15T10:02:00.000Z'
    })).rejects.toThrow(/already exists/)
    await expect(flows.readFlow('flow-one')).resolves.toMatchObject({
      title: 'Flow One',
      repo_path: '/repo',
      phases: [
        expect.objectContaining({
          phase_id: 'implementation',
          status: 'running'
        })
      ]
    })
  })

  it('validates agent-facing phase updates and counts Plan Review notes requirements', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({
      id: 'flow-one',
      title: 'Flow One',
      repoPath: '/repo',
      now: '2026-06-15T10:00:00.000Z'
    })

    await expect(flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'plan-review',
      title: 'Plan Review',
      kind: 'plan_review',
      status: 'completed',
      outcome: 'approved_with_concerns',
      order: 1
    })).rejects.toThrow(/requires notes/)

    await expect(flows.setPhase({
      flowId: 'flow-one',
      phaseId: '../plan-review',
      title: 'Plan Review',
      status: 'running',
      order: 1
    })).rejects.toThrow(/Unsafe phase id/)

    await expect(flows.completePhase({
      flowId: 'flow-one',
      phaseId: 'implementation',
      title: 'Implementation',
      order: 2
    })).rejects.toThrow(/Unknown phase/)

    await expect(flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'implementation',
      title: 'Implementation',
      status: 'blocked',
      order: 2
    })).rejects.toThrow(/blocked requires notes/)

    await expect(flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'implementation',
      title: 'Implementation',
      status: 'needs_attention',
      order: 2
    })).rejects.toThrow(/needs_attention requires notes/)

    await expect(flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'implementation',
      title: 'Implementation',
      status: 'completed',
      outcome: 'unsafe outcome',
      order: 2
    })).rejects.toThrow(/Invalid phase outcome/)

    await expect(flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'implementation',
      title: 'Implementation',
      status: 'completed',
      outcome: 'x'.repeat(65),
      order: 2
    })).rejects.toThrow(/Invalid phase outcome/)

    await expect(flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'plan-review',
      title: 'Plan Review',
      kind: 'plan_review',
      status: 'completed',
      outcome: 'approved_with_concerns',
      notes: 'Proceed carefully.',
      order: 1,
      now: '2026-06-15T10:05:00.000Z'
    })).resolves.toMatchObject({
      phases: [
        expect.objectContaining({
          phase_id: 'plan-review',
          status: 'completed',
          outcome: 'approved_with_concerns',
          notes: 'Proceed carefully.',
          note_history: [
            {
              created_at: '2026-06-15T10:05:00.000Z',
              note: 'Proceed carefully.',
              source: 'cli'
            }
          ]
        })
      ]
    })

    await expect(flows.restartPhase({ flowId: 'flow-one', phaseId: 'plan-review' }))
      .resolves.toMatchObject({
        phases: [
          expect.objectContaining({ status: 'running' })
        ]
      })

    await expect(flows.completePhase({ flowId: 'flow-one', phaseId: 'plan-review' }))
      .resolves.toMatchObject({
        phases: [
          expect.objectContaining({
            status: 'completed',
            outcome: 'approved_with_concerns',
            notes: 'Phase restarted for rerun.'
          })
        ]
      })
  })
})
