import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
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

  it('promotes Plan Review when a plan is linked after Plan already completed', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'late-linked-plan',
      title: 'Late Linked Plan',
      status: 'approved',
      body: '# Plan\n\n## Implementation Phases\n\n- Build the graph\n'
    })
    await flows.createFlow({
      id: 'late-plan-ready',
      title: 'Late plan ready',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await flows.completePhase({
      flowId: 'late-plan-ready',
      phaseId: 'plan',
      outcome: 'plan_saved',
      now: '2026-06-15T12:01:00.000Z'
    })

    await expect(flows.linkPlan({
      flowId: 'late-plan-ready',
      planId: 'late-linked-plan',
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
          kind: 'implementation_child',
          status: 'pending',
          generated: true,
          editable: true,
          source_plan_id: 'implementation-plan',
          notes: 'Store parent metadata'
        }),
        expect.objectContaining({
          phase_id: 'implementation-render-graph',
          parent_phase_id: 'implementation',
          kind: 'implementation_child',
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

  it('rejects Implementation transitions when a default graph is missing Plan Review', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({
      id: 'missing-plan-review',
      title: 'Missing Plan Review',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await rewriteFlow(root, 'missing-plan-review', (flow) => ({
      ...flow,
      phases: Array.isArray(flow.phases)
        ? flow.phases.filter((phase) =>
            isRawPhase(phase) && phase.phase_id !== 'plan-review'
          ).map((phase) =>
            isRawPhase(phase) && phase.phase_id === 'implementation'
              ? { ...phase, status: 'ready' }
              : phase
          )
        : flow.phases
    }))

    await expect(flows.setPhase({
      flowId: 'missing-plan-review',
      phaseId: 'implementation',
      status: 'running',
      now: '2026-06-15T12:01:00.000Z'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Implementation requires a completed approving Plan Review.'
    })
  })

  it('treats legacy generated implementation rows as children when Implementation starts', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({
      id: 'legacy-generated-children',
      title: 'Legacy generated children',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await rewriteFlow(root, 'legacy-generated-children', (flow) => ({
      ...flow,
      phases: [
        {
          phase_id: 'plan-review',
          title: 'Plan Review',
          kind: 'plan_review',
          status: 'completed',
          outcome: 'approved',
          order: 2
        },
        {
          phase_id: 'implementation',
          title: 'Implementation',
          kind: 'implementation',
          status: 'ready',
          order: 3
        },
        {
          phase_id: 'implementation-legacy-child',
          title: 'Legacy child',
          kind: 'implementation',
          status: 'pending',
          order: 1,
          parent_phase_id: 'implementation',
          generated: true,
          editable: true,
          source_plan_id: 'legacy-plan'
        },
        {
          phase_id: 'implementation-not-generated',
          title: 'Not generated',
          kind: 'implementation',
          status: 'pending',
          order: 2,
          parent_phase_id: 'implementation'
        }
      ]
    }))

    await expect(flows.setPhase({
      flowId: 'legacy-generated-children',
      phaseId: 'implementation',
      status: 'running',
      now: '2026-06-15T12:01:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({
          phase_id: 'implementation-legacy-child',
          kind: 'implementation_child',
          status: 'ready'
        }),
        expect.objectContaining({
          phase_id: 'implementation-not-generated',
          kind: 'implementation',
          status: 'pending'
        })
      ])
    })
  })

  it('promotes downstream default phases as predecessors complete', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'downstream-plan',
      title: 'Downstream Plan',
      status: 'approved',
      body: '# Plan\n\n## Implementation Phases\n\n- Build the graph\n'
    })
    await flows.createFlow({
      id: 'downstream-flow',
      title: 'Downstream Flow',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await flows.linkPlan({
      flowId: 'downstream-flow',
      planId: 'downstream-plan',
      now: '2026-06-15T12:01:00.000Z'
    })
    await flows.completePhase({
      flowId: 'downstream-flow',
      phaseId: 'plan',
      outcome: 'plan_saved',
      now: '2026-06-15T12:02:00.000Z'
    })
    await flows.completePhase({
      flowId: 'downstream-flow',
      phaseId: 'plan-review',
      outcome: 'approved',
      now: '2026-06-15T12:03:00.000Z'
    })
    await flows.setPhase({
      flowId: 'downstream-flow',
      phaseId: 'implementation',
      status: 'running',
      now: '2026-06-15T12:04:00.000Z'
    })

    await expect(flows.completePhase({
      flowId: 'downstream-flow',
      phaseId: 'implementation',
      outcome: 'implemented',
      now: '2026-06-15T12:05:00.000Z'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Implementation cannot complete until all generated implementation children are completed or skipped with notes.'
    })

    await flows.setPhase({
      flowId: 'downstream-flow',
      phaseId: 'implementation-build-the-graph',
      status: 'running',
      now: '2026-06-15T12:05:00.000Z'
    })
    await flows.completePhase({
      flowId: 'downstream-flow',
      phaseId: 'implementation-build-the-graph',
      outcome: 'implemented',
      now: '2026-06-15T12:06:00.000Z'
    })
    await expect(flows.completePhase({
      flowId: 'downstream-flow',
      phaseId: 'implementation',
      outcome: 'implemented',
      now: '2026-06-15T12:07:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'review-loop-1', status: 'ready' })
      ])
    })

    await flows.setPhase({
      flowId: 'downstream-flow',
      phaseId: 'review-loop-1',
      status: 'running',
      now: '2026-06-15T12:08:00.000Z'
    })
    await expect(flows.completePhase({
      flowId: 'downstream-flow',
      phaseId: 'review-loop-1',
      outcome: 'review_completed',
      now: '2026-06-15T12:09:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'review-loop-2', status: 'ready' })
      ])
    })

    await flows.setPhase({
      flowId: 'downstream-flow',
      phaseId: 'review-loop-2',
      status: 'running',
      now: '2026-06-15T12:10:00.000Z'
    })
    await expect(flows.completePhase({
      flowId: 'downstream-flow',
      phaseId: 'review-loop-2',
      outcome: 'review_completed',
      now: '2026-06-15T12:11:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'pr-creation', status: 'ready' })
      ])
    })

    await flows.setPhase({
      flowId: 'downstream-flow',
      phaseId: 'pr-creation',
      status: 'running',
      now: '2026-06-15T12:12:00.000Z'
    })
    await expect(flows.completePhase({
      flowId: 'downstream-flow',
      phaseId: 'pr-creation',
      now: '2026-06-15T12:13:00.000Z'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'PR Creation can only complete with valid pull request metadata.'
    })
    await expect(flows.completePrCreation({
      flowId: 'downstream-flow',
      pr: {
        provider: 'github',
        number: 12,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: 'flow/downstream',
        base: 'main',
        status: 'open'
      },
      summary: 'Opened PR #12.',
      now: '2026-06-15T12:13:00.000Z'
    })).resolves.toMatchObject({
      pr: {
        provider: 'github',
        number: 12,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: 'flow/downstream',
        base: 'main',
        status: 'open'
      },
      phases: expect.arrayContaining([
        expect.objectContaining({
          phase_id: 'pr-creation',
          status: 'completed',
          outcome: 'pr_recorded',
          summary: 'Opened PR #12.'
        }),
        expect.objectContaining({ phase_id: 'human-review', status: 'ready' })
      ])
    })
  })

  it('rejects direct PR Creation completion and leaves Human Review pending', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({
      id: 'guard-pr-creation',
      title: 'Guard PR Creation',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await rewriteFlow(root, 'guard-pr-creation', (flow) => ({
      ...flow,
      phases: [
        {
          phase_id: 'pr-creation',
          title: 'PR Creation',
          kind: 'pr_creation',
          status: 'running',
          order: 6
        },
        {
          phase_id: 'human-review',
          title: 'Human Review',
          kind: 'human_review',
          status: 'pending',
          order: 7
        }
      ]
    }))

    await expect(flows.completePhase({
      flowId: 'guard-pr-creation',
      phaseId: 'pr-creation'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'PR Creation can only complete with valid pull request metadata.'
    })
    await expect(flows.setPhase({
      flowId: 'guard-pr-creation',
      phaseId: 'pr-creation',
      status: 'completed'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'PR Creation can only complete with valid pull request metadata.'
    })
    await rewriteFlow(root, 'guard-pr-creation', (flow) => ({
      ...flow,
      phases: [
        ...(Array.isArray(flow.phases) ? flow.phases : []),
        {
          phase_id: 'custom-pr-gate',
          title: 'Custom PR Gate',
          status: 'ready',
          order: 8
        }
      ]
    }))
    await expect(flows.setPhase({
      flowId: 'guard-pr-creation',
      phaseId: 'custom-pr-gate',
      kind: 'pr_creation',
      status: 'completed'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'PR Creation can only complete with valid pull request metadata.'
    })
    await expect(flows.setPhase({
      flowId: 'guard-pr-creation',
      phaseId: 'new-pr-gate',
      title: 'New PR Gate',
      order: 9,
      kind: 'pr_creation',
      status: 'completed'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'PR Creation can only complete with valid pull request metadata.'
    })
    const guardedFlow = await flows.readFlow('guard-pr-creation')
    expect(guardedFlow.pr).toBeUndefined()
    expect(guardedFlow).toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'pr-creation', status: 'running' }),
        expect.objectContaining({ phase_id: 'human-review', status: 'pending' }),
        expect.objectContaining({ phase_id: 'custom-pr-gate', status: 'ready' })
      ])
    })
  })

  it('validates structured PR metadata before completing PR Creation', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({
      id: 'validate-pr-metadata',
      title: 'Validate PR metadata',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await rewriteFlow(root, 'validate-pr-metadata', (flow) => ({
      ...flow,
      phases: [
        {
          phase_id: 'pr-creation',
          title: 'PR Creation',
          kind: 'pr_creation',
          status: 'ready',
          order: 6
        },
        {
          phase_id: 'human-review',
          title: 'Human Review',
          kind: 'human_review',
          status: 'pending',
          order: 7
        }
      ]
    }))

    await expect(flows.completePrCreation({
      flowId: 'validate-pr-metadata',
      pr: {
        provider: 'github',
        number: 0,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: 'flow/pr',
        base: 'main',
        status: 'open'
      }
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Pull request number must be a positive integer.'
    })
    await expect(flows.completePrCreation({
      flowId: 'validate-pr-metadata',
      pr: {
        provider: 'github',
        number: 12,
        url: 'http://github.com/acme/grindstone/pull/12',
        head: 'flow/pr',
        base: 'main',
        status: 'open'
      }
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Pull request URL must be a valid HTTPS URL.'
    })
    await expect(flows.completePrCreation({
      flowId: 'validate-pr-metadata',
      pr: {
        provider: 'github',
        number: 12,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: '',
        base: 'main',
        status: 'open'
      }
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Pull request head branch is required.'
    })
    await expect(flows.completePrCreation({
      flowId: 'validate-pr-metadata',
      pr: {
        provider: 'github',
        number: 12,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: 'flow/pr',
        base: '',
        status: 'open'
      }
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Pull request base branch is required.'
    })
    await expect(flows.completePrCreation({
      flowId: 'validate-pr-metadata',
      pr: {
        provider: 'github',
        number: 12,
        url: 'https://github.com/acme/grindstone/pull/12',
        head: 'flow/pr',
        base: 'main',
        status: 'draft' as never
      }
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Pull request status must be open, closed, or merged.'
    })

    const unchangedFlow = await flows.readFlow('validate-pr-metadata')
    expect(unchangedFlow.pr).toBeUndefined()
    expect(unchangedFlow).toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'pr-creation', status: 'ready' }),
        expect.objectContaining({ phase_id: 'human-review', status: 'pending' })
      ])
    })
  })

  it('locks legacy PR-dependent phases when persisted PR metadata is malformed', async () => {
    const root = await makeTempDir()
    const flows = createFlowOperations({ artifactRoot: root })
    await flows.createFlow({
      id: 'malformed-pr-gate',
      title: 'Malformed PR gate',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await rewriteFlow(root, 'malformed-pr-gate', (flow) => ({
      ...flow,
      pr: {
        provider: 'github',
        number: '12',
        url: 'http://github.com/acme/grindstone/pull/12',
        head: '',
        base: 'main',
        status: 'open'
      },
      phases: [
        {
          phase_id: 'review-loop-2',
          title: 'Review Loop 2',
          kind: 'review_loop',
          status: 'ready',
          order: 5
        },
        {
          phase_id: 'pr-creation',
          title: 'PR Creation',
          kind: 'pr_creation',
          status: 'completed',
          outcome: 'pr_recorded',
          summary: 'Opened malformed PR.',
          order: 6
        },
        {
          phase_id: 'human-review',
          title: 'Human Review',
          kind: 'human_review',
          status: 'active',
          order: 7
        }
      ]
    }))

    const lockedFlow = await flows.readFlow('malformed-pr-gate')
    expect(lockedFlow.pr).toBeUndefined()
    expect(lockedFlow.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase_id: 'pr-creation', status: 'ready' }),
      expect.objectContaining({ phase_id: 'human-review', status: 'pending' })
    ]))
    expect(lockedFlow.phases?.find((phase) => phase.phase_id === 'pr-creation')?.outcome)
      .toBeUndefined()
    expect(lockedFlow.phases?.find((phase) => phase.phase_id === 'pr-creation')?.summary)
      .toBeUndefined()

    await flows.setPhase({
      flowId: 'malformed-pr-gate',
      phaseId: 'review-loop-2',
      status: 'running'
    })
    const rawFlow = JSON.parse(
      await readFile(join(root, 'flows', 'malformed-pr-gate', 'meta.json'), 'utf8')
    ) as Record<string, unknown>
    expect(rawFlow.pr).toBeUndefined()
    expect(rawFlow.phases).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase_id: 'pr-creation', status: 'ready' }),
      expect.objectContaining({ phase_id: 'human-review', status: 'pending' })
    ]))
  })

  it('only promotes implementation-child rows when Implementation starts', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'child-promotion-plan',
      title: 'Child Promotion Plan',
      status: 'approved',
      body: '# Plan\n\n## Implementation Phases\n\n- Build API\n'
    })
    await flows.createFlow({
      id: 'child-promotion-flow',
      title: 'Child promotion Flow',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await flows.linkPlan({
      flowId: 'child-promotion-flow',
      planId: 'child-promotion-plan',
      now: '2026-06-15T12:01:00.000Z'
    })
    await flows.completePhase({
      flowId: 'child-promotion-flow',
      phaseId: 'plan',
      outcome: 'plan_saved',
      now: '2026-06-15T12:02:00.000Z'
    })
    await flows.completePhase({
      flowId: 'child-promotion-flow',
      phaseId: 'plan-review',
      outcome: 'approved',
      now: '2026-06-15T12:03:00.000Z'
    })
    await rewriteFlow(root, 'child-promotion-flow', (flow) => ({
      ...flow,
      phases: [
        ...(Array.isArray(flow.phases) ? flow.phases : []),
        {
          phase_id: 'implementation-legacy',
          title: 'Legacy row',
          kind: 'implementation',
          status: 'pending',
          order: 2,
          parent_phase_id: 'implementation',
          created_at: '2026-06-15T12:03:00.000Z',
          updated_at: '2026-06-15T12:03:00.000Z'
        }
      ]
    }))

    await expect(flows.setPhase({
      flowId: 'child-promotion-flow',
      phaseId: 'implementation',
      status: 'running',
      now: '2026-06-15T12:04:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'implementation-build-api', status: 'ready' }),
        expect.objectContaining({ phase_id: 'implementation-legacy', status: 'pending' })
      ])
    })
  })

  it('does not promote review loop from settled children before Implementation starts', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'prestart-skip-plan',
      title: 'Prestart Skip Plan',
      status: 'approved',
      body: '# Plan\n\n## Implementation Phases\n\n- Build API\n'
    })
    await flows.createFlow({
      id: 'prestart-skip-flow',
      title: 'Prestart skip Flow',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await flows.linkPlan({
      flowId: 'prestart-skip-flow',
      planId: 'prestart-skip-plan',
      now: '2026-06-15T12:01:00.000Z'
    })
    await flows.completePhase({
      flowId: 'prestart-skip-flow',
      phaseId: 'plan',
      outcome: 'plan_saved',
      now: '2026-06-15T12:02:00.000Z'
    })
    await flows.completePhase({
      flowId: 'prestart-skip-flow',
      phaseId: 'plan-review',
      outcome: 'approved',
      now: '2026-06-15T12:03:00.000Z'
    })

    await expect(flows.setPhase({
      flowId: 'prestart-skip-flow',
      phaseId: 'implementation-build-api',
      status: 'skipped',
      notes: 'Covered elsewhere.',
      now: '2026-06-15T12:04:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'implementation', status: 'ready' }),
        expect.objectContaining({ phase_id: 'review-loop-1', status: 'pending' })
      ])
    })

    await expect(flows.setPhase({
      flowId: 'prestart-skip-flow',
      phaseId: 'implementation',
      status: 'running',
      now: '2026-06-15T12:05:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'review-loop-1', status: 'ready' })
      ])
    })
  })

  it('promotes Review Loop 1 after every implementation child is completed or skipped', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'child-readiness-plan',
      title: 'Child Readiness Plan',
      status: 'approved',
      body: '# Plan\n\n## Implementation Phases\n\n- Build API\n- Render UI\n'
    })
    await flows.createFlow({
      id: 'child-readiness-flow',
      title: 'Child readiness Flow',
      repoPath: '/repo',
      now: '2026-06-15T12:00:00.000Z'
    })
    await flows.linkPlan({
      flowId: 'child-readiness-flow',
      planId: 'child-readiness-plan',
      now: '2026-06-15T12:01:00.000Z'
    })
    await flows.completePhase({
      flowId: 'child-readiness-flow',
      phaseId: 'plan',
      outcome: 'plan_saved',
      now: '2026-06-15T12:02:00.000Z'
    })
    await flows.completePhase({
      flowId: 'child-readiness-flow',
      phaseId: 'plan-review',
      outcome: 'approved',
      now: '2026-06-15T12:03:00.000Z'
    })
    await flows.setPhase({
      flowId: 'child-readiness-flow',
      phaseId: 'implementation',
      status: 'running',
      now: '2026-06-15T12:04:00.000Z'
    })
    await flows.setPhase({
      flowId: 'child-readiness-flow',
      phaseId: 'implementation-build-api',
      status: 'running',
      now: '2026-06-15T12:05:00.000Z'
    })
    await flows.completePhase({
      flowId: 'child-readiness-flow',
      phaseId: 'implementation-build-api',
      outcome: 'implemented',
      now: '2026-06-15T12:06:00.000Z'
    })
    await flows.setPhase({
      flowId: 'child-readiness-flow',
      phaseId: 'implementation-render-ui',
      status: 'running',
      now: '2026-06-15T12:07:00.000Z'
    })

    await expect(flows.setPhase({
      flowId: 'child-readiness-flow',
      phaseId: 'implementation-render-ui',
      status: 'skipped',
      notes: 'Covered by the API slice.',
      now: '2026-06-15T12:08:00.000Z'
    })).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'implementation', status: 'running' }),
        expect.objectContaining({ phase_id: 'review-loop-1', status: 'ready' })
      ])
    })
  })

  it('keeps Plan Review unapproved when linked plan phase extraction fails', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'unsupported-plan',
      title: 'Unsupported Plan',
      status: 'approved',
      body: '# Plan\n\nThis plan has no supported implementation phase section.\n'
    })
    await flows.createFlow({ id: 'unsupported-flow', title: 'Unsupported Flow', repoPath: '/repo' })
    await flows.linkPlan({ flowId: 'unsupported-flow', planId: 'unsupported-plan' })
    await flows.completePhase({ flowId: 'unsupported-flow', phaseId: 'plan', outcome: 'plan_saved' })

    await expect(flows.completePhase({
      flowId: 'unsupported-flow',
      phaseId: 'plan-review',
      outcome: 'approved'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Linked plan does not contain supported implementation phases.'
    })

    await expect(flows.readFlow('unsupported-flow')).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'plan-review', status: 'ready' }),
        expect.objectContaining({ phase_id: 'implementation', status: 'pending' })
      ])
    })
  })

  it('rejects Plan Review approval when linked Flow and plan paths disagree', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'path-plan',
      title: 'Path Plan',
      status: 'approved',
      body: '# Plan\n\n## Implementation Phases\n\n- Build path checks\n'
    })
    await flows.createFlow({ id: 'path-flow', title: 'Path Flow', repoPath: '/repo' })
    await flows.linkPlan({ flowId: 'path-flow', planId: 'path-plan' })
    await flows.completePhase({ flowId: 'path-flow', phaseId: 'plan', outcome: 'plan_saved' })
    await rewriteFlow(root, 'path-flow', (flow) => ({
      ...flow,
      plan_path: '/unexpected/path.md'
    }))

    await expect(flows.completePhase({
      flowId: 'path-flow',
      phaseId: 'plan-review',
      outcome: 'approved'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Linked plan path mismatch for path-plan.'
    })

    await expect(flows.readFlow('path-flow')).resolves.toMatchObject({
      phases: expect.arrayContaining([
        expect.objectContaining({ phase_id: 'plan-review', status: 'ready' }),
        expect.objectContaining({ phase_id: 'implementation', status: 'pending' })
      ])
    })
  })

  it('rejects generated child phase id collisions with non-generated phases', async () => {
    const root = await makeTempDir()
    const plans = createPlanStore({ artifactRoot: root })
    const flows = createFlowOperations({ artifactRoot: root })
    await plans.savePlan({
      planId: 'collision-plan',
      title: 'Collision Plan',
      status: 'approved',
      body: '# Plan\n\n## Implementation Phases\n\n- First slice\n'
    })
    await flows.createFlow({ id: 'collision-flow', title: 'Collision Flow', repoPath: '/repo' })
    await rewriteFlow(root, 'collision-flow', (flow) => ({
      ...flow,
      phases: [
        ...(Array.isArray(flow.phases) ? flow.phases : []),
        {
          phase_id: 'implementation-first-slice',
          title: 'Existing custom phase',
          kind: 'implementation',
          status: 'ready',
          order: 99,
          created_at: '2026-06-15T12:00:00.000Z',
          updated_at: '2026-06-15T12:00:00.000Z'
        }
      ]
    }))
    await flows.linkPlan({ flowId: 'collision-flow', planId: 'collision-plan' })
    await flows.completePhase({ flowId: 'collision-flow', phaseId: 'plan', outcome: 'plan_saved' })

    await expect(flows.completePhase({
      flowId: 'collision-flow',
      phaseId: 'plan-review',
      outcome: 'approved'
    })).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Generated implementation phase id conflicts with existing phase: implementation-first-slice'
    })

    const collisionFlow = await flows.readFlow('collision-flow')
    const existingPhase = collisionFlow.phases?.find((phase) =>
      phase.phase_id === 'implementation-first-slice'
    )
    expect(existingPhase).toEqual(expect.objectContaining({
      phase_id: 'implementation-first-slice',
      title: 'Existing custom phase'
    }))
    expect(existingPhase).not.toHaveProperty('generated')
    expect(existingPhase).not.toHaveProperty('editable')
    expect(existingPhase).not.toHaveProperty('parent_phase_id')
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
    await rewriteFlow(root, 'idempotent-flow', (flow) => ({
      ...flow,
      phases: Array.isArray(flow.phases)
        ? flow.phases.map((phase) =>
            isRawPhase(phase) && phase.phase_id === 'implementation-first-slice'
              ? { ...phase, kind: 'implementation' }
              : phase
          )
        : flow.phases
    }))

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
        kind: 'implementation_child',
        order: 7,
        notes: 'Keep my edit.',
        source_plan_id: 'idempotent-plan'
      })
    ]))
  })
})

async function rewriteFlow(
  artifactRoot: string,
  flowId: string,
  update: (flow: Record<string, unknown>) => Record<string, unknown>
): Promise<void> {
  const path = join(artifactRoot, 'flows', flowId, 'meta.json')
  const flow = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, JSON.stringify(update(flow), null, 2))
}

function isRawPhase(value: unknown): value is { phase_id?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
