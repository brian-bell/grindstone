import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFlowOperations } from './flowOperations'
import { createPlanStore } from './planStore'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-flow-ops-'))
}

describe('Flow operations', () => {
  it('creates new Flows with the default Grindstone phase graph', async () => {
    const flows = createFlowOperations({ artifactRoot: await makeTempDir() })

    await expect(flows.createFlow({
      id: 'default-graph',
      title: 'Default graph',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })).resolves.toMatchObject({
      phases: [
        { phase_id: 'plan', title: 'Plan', kind: 'plan', status: 'ready', order: 1 },
        { phase_id: 'plan-review', title: 'Plan Review', kind: 'plan_review', status: 'pending', order: 2 },
        { phase_id: 'implementation', title: 'Implementation', kind: 'implementation', status: 'pending', order: 3 },
        { phase_id: 'review-loop-1', title: 'Review Loop 1', kind: 'review_loop', status: 'pending', order: 4 },
        { phase_id: 'review-loop-2', title: 'Review Loop 2', kind: 'review_loop', status: 'pending', order: 5 },
        { phase_id: 'pr-creation', title: 'PR Creation', kind: 'pr_creation', status: 'pending', order: 6 },
        { phase_id: 'human-review', title: 'Human Review', kind: 'human_review', status: 'pending', order: 7 }
      ]
    })
  })

  it('promotes Plan Review after Plan completes with a linked plan', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'linked-plan',
      title: 'Linked Plan',
      status: 'approved',
      body: '# Plan\n\n## Implementation Phases\n\n- Build the graph\n'
    })
    await flows.createFlow({
      id: 'plan-ready',
      title: 'Plan ready',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await flows.linkPlan({
      flowId: 'plan-ready',
      planId: 'linked-plan',
      now: '2026-06-15T12:01:00.000Z'
    })

    await expect(flows.completePhase({
      flowId: 'plan-ready',
      phaseId: 'plan',
      outcome: 'plan_saved',
      now: '2026-06-15T12:02:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'plan-review', status: 'ready' })
      ])
    })
  })

  it('generates editable implementation children when Plan Review is approved', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'implementation-plan',
      title: 'Implementation Plan',
      status: 'approved',
      body: [
        '# Plan',
        '',
        '## Implementation Phases',
        '',
        '- Persist graph',
        '  - Store parent metadata',
        '- Render graph'
      ].join('\n')
    })
    await flows.createFlow({
      id: 'approval-generates',
      title: 'Approval generates',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await flows.linkPlan({
      flowId: 'approval-generates',
      planId: 'implementation-plan',
      now: '2026-06-15T12:01:00.000Z'
    })
    await flows.completePhase({
      flowId: 'approval-generates',
      phaseId: 'plan',
      outcome: 'plan_saved',
      now: '2026-06-15T12:02:00.000Z'
    })

    await expect(flows.completePhase({
      flowId: 'approval-generates',
      phaseId: 'plan-review',
      outcome: 'approved',
      now: '2026-06-15T12:03:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'plan', status: 'completed' }),
        expect.objectContaining({ phase_id: 'plan-review', status: 'completed', outcome: 'approved' }),
        expect.objectContaining({ phase_id: 'implementation', status: 'ready' }),
        expect.objectContaining({
          phase_id: 'implementation-persist-graph',
          parent_phase_id: 'implementation',
          status: 'pending',
          generated: true,
          editable: true,
          source_plan_id: 'implementation-plan',
          notes: 'Store parent metadata'
        }),
        expect.objectContaining({
          phase_id: 'implementation-render-graph',
          parent_phase_id: 'implementation',
          status: 'pending',
          generated: true,
          editable: true,
          source_plan_id: 'implementation-plan'
        })
      ])
    })
  })

  it('rejects Implementation transitions before an approving Plan Review', async () => {
    const flows = createFlowOperations({ artifactRoot: await makeTempDir() })
    await flows.createFlow({
      id: 'gated-implementation',
      title: 'Gated implementation',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })

    await expect(flows.setPhase({
      flowId: 'gated-implementation',
      phaseId: 'implementation',
      status: 'running',
      now: '2026-06-15T12:01:00.000Z'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Implementation requires a completed approving Plan Review.'
    })
  })

  it('edits pending generated children and rejects locked child edits', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'editable-plan',
      title: 'Editable Plan',
      status: 'approved',
      body: '# Plan\n\n## Implementation Phases\n\n- First slice\n- Second slice\n'
    })
    await flows.createFlow({ id: 'editable-flow', title: 'Editable Flow', repoPath: '/repo' })
    await flows.linkPlan({ flowId: 'editable-flow', planId: 'editable-plan' })
    await flows.completePhase({ flowId: 'editable-flow', phaseId: 'plan', outcome: 'plan_saved' })
    await flows.completePhase({ flowId: 'editable-flow', phaseId: 'plan-review', outcome: 'approved' })

    await expect(flows.updatePhase({
      flowId: 'editable-flow',
      phaseId: 'implementation-first-slice',
      title: 'Renamed slice',
      order: 3,
      notes: 'User-edited notes',
      now: '2026-06-15T12:04:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({
          phase_id: 'implementation-first-slice',
          title: 'Renamed slice',
          order: 3,
          notes: 'User-edited notes'
        })
      ])
    })

    await flows.setPhase({
      flowId: 'editable-flow',
      phaseId: 'implementation',
      status: 'running'
    })
    await flows.setPhase({
      flowId: 'editable-flow',
      phaseId: 'implementation-first-slice',
      status: 'running'
    })

    await expect(flows.updatePhase({
      flowId: 'editable-flow',
      phaseId: 'implementation-first-slice',
      title: 'Too late'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Phase is locked: implementation-first-slice'
    })
  })

  it('re-approves generated implementation children idempotently while preserving user edits', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'idempotent-plan',
      title: 'Idempotent Plan',
      status: 'approved',
      body: '# Plan\n\n## Implementation Phases\n\n- First slice\n'
    })
    await flows.createFlow({ id: 'idempotent-flow', title: 'Idempotent Flow', repoPath: '/repo' })
    await flows.linkPlan({ flowId: 'idempotent-flow', planId: 'idempotent-plan' })
    await flows.completePhase({ flowId: 'idempotent-flow', phaseId: 'plan', outcome: 'plan_saved' })
    await flows.completePhase({ flowId: 'idempotent-flow', phaseId: 'plan-review', outcome: 'approved' })
    await flows.updatePhase({
      flowId: 'idempotent-flow',
      phaseId: 'implementation-first-slice',
      title: 'Edited first slice',
      order: 7,
      notes: 'Keep my edit.'
    })

    const approvedAgain = await flows.completePhase({
      flowId: 'idempotent-flow',
      phaseId: 'plan-review',
      outcome: 'approved'
    })

    expect(approvedAgain.phases?.filter((phase) =>
      phase.phase_id === 'implementation-first-slice'
    )).toHaveLength(1)
    expect(approvedAgain.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase_id: 'implementation-first-slice',
        title: 'Edited first slice',
        order: 7,
        notes: 'Keep my edit.',
        source_plan_id: 'idempotent-plan'
      })
    ]))
  })
})
