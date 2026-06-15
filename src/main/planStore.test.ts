import { mkdtemp, stat, writeFile } from 'node:fs/promises'
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

  it('reads plan bodies from the artifact directory instead of trusting persisted plan_path', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const metadata = await plans.savePlan({
      planId: 'plan-one',
      title: 'Plan One',
      body: 'safe body',
      now: '2026-06-15T10:00:00.000Z'
    })
    const outsidePath = join(root, 'outside.md')
    await writeFile(outsidePath, 'outside body')
    await writeFile(join(root, 'plans', 'plan-one', 'meta.json'), JSON.stringify({
      ...metadata,
      plan_path: outsidePath
    }))

    await expect(plans.readPlan('plan-one')).resolves.toMatchObject({
      metadata: {
        plan_path: join(root, 'plans', 'plan-one', 'plan.md')
      },
      body: 'safe body'
    })
  })

  it('rejects mismatched artifact ids before returning Flow or plan records', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({
      id: 'flow-one',
      title: 'Flow One',
      repoPath: '/repo',
      now: '2026-06-15T10:00:00.000Z'
    })
    await writeFile(join(root, 'flows', 'flow-one', 'meta.json'), JSON.stringify({
      schema_version: 1,
      flow_id: 'flow-two',
      title: 'Wrong Flow',
      status: 'active',
      repo_path: '/repo',
      created_at: '2026-06-15T10:00:00.000Z',
      updated_at: '2026-06-15T10:00:00.000Z'
    }))
    await plans.savePlan({
      planId: 'plan-one',
      title: 'Plan One',
      body: 'body',
      now: '2026-06-15T10:01:00.000Z'
    })
    await writeFile(join(root, 'plans', 'plan-one', 'meta.json'), JSON.stringify({
      schema_version: 1,
      plan_id: 'plan-two',
      title: 'Wrong Plan',
      status: 'approved',
      created_at: '2026-06-15T10:01:00.000Z',
      updated_at: '2026-06-15T10:01:00.000Z'
    }))

    await expect(flows.readFlow('flow-one')).rejects.toThrow(/Flow id mismatch/)
    await expect(flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'implementation',
      title: 'Implementation',
      status: 'running',
      order: 1
    })).rejects.toThrow(/Flow id mismatch/)
    await expect(plans.readPlan('plan-one')).rejects.toThrow(/Plan id mismatch/)
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

    await flows.setPhase({
      flowId: 'flow-one',
      phaseId: 'autoreview',
      title: 'Autoreview',
      status: 'running',
      order: 3
    })
    await flows.needsAttentionPhase({
      flowId: 'flow-one',
      phaseId: 'autoreview',
      notes: 'Follow-up findings remain.'
    })
    await expect(flows.completePhase({
      flowId: 'flow-one',
      phaseId: 'autoreview',
      outcome: 'passed'
    })).rejects.toThrow(/invalid phase transition needs_attention -> completed/i)
    await expect(flows.restartPhase({
      flowId: 'flow-one',
      phaseId: 'autoreview',
      notes: 'Rerunning after fixes.'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({
          phase_id: 'autoreview',
          status: 'running',
          notes: 'Rerunning after fixes.'
        })
      ])
    })
    await expect(flows.completePhase({
      flowId: 'flow-one',
      phaseId: 'autoreview',
      outcome: 'passed'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({
          phase_id: 'autoreview',
          status: 'completed',
          outcome: 'passed'
        })
      ])
    })
  })
})
