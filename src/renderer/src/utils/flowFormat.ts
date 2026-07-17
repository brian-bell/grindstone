import type { FlowHumanReviewOutcome } from '@shared/artifacts'
import type { FlowListRow, FlowPhaseSummary } from '@shared/workspace'

export function formatFlowTooltip(flow: FlowListRow): string {
  return [
    `Repository: ${flow.repositoryPath}`,
    flow.worktreePath === undefined ? null : `Worktree: ${flow.worktreePath}`,
    flow.branch === undefined ? null : `Branch: ${flow.branch}`,
    flow.baseRef === undefined ? null : `Base ref: ${flow.baseRef}`,
    flow.commit === undefined ? null : `Commit: ${flow.commit}`,
    flow.planId === undefined ? null : `Plan: ${flow.planId}`,
    flow.planPath === undefined ? null : `Plan path: ${flow.planPath}`,
    flow.pr === undefined ? null : `PR: github#${flow.pr.number} - ${flow.pr.status} - ${flow.pr.url}`,
    flow.failure === undefined ? null : `Failure: ${flow.failure.stage} - ${flow.failure.message}`,
    flow.failure?.command === undefined ? null : `Command: ${flow.failure.command}`,
    flow.failure?.output === undefined ? null : `Output: ${flow.failure.output}`,
    ...(flow.phases ?? []).map(formatPhaseDetail)
  ].filter((line): line is string => line !== null).join('\n')
}

export function formatPhaseDetail(phase: FlowPhaseSummary): string {
  return `Phase: ${phase.title} - ${phase.status}${phase.summary === undefined ? '' : ` - ${phase.summary}`}`
}

export function formatFailureSummary(failure: NonNullable<FlowListRow['failure']>): string {
  const firstLine = failure.message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '') ?? failure.message.trim()

  return `${failure.stage}: ${truncateText(firstLine, 72)}`
}

export function formatPhaseSummary(flow: FlowListRow): string {
  if (flow.phases === undefined || flow.phases.length === 0) {
    return '-'
  }

  const doneCount = flow.phases.filter(isDonePhase).length
  const nonDoneCounts = flow.phases
    .filter((phase) => !isDonePhase(phase))
    .reduce<Record<string, number>>((counts, phase) => {
      counts[phase.status] = (counts[phase.status] ?? 0) + 1
      return counts
    }, {})

  const nonDoneSummary = Object.entries(nonDoneCounts)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ')

  return nonDoneSummary === ''
    ? `${doneCount}/${flow.phases.length} done`
    : `${doneCount}/${flow.phases.length} done, ${nonDoneSummary}`
}

export function isDonePhase(phase: FlowPhaseSummary): boolean {
  return phase.status === 'done' || phase.status === 'completed' || phase.status === 'skipped'
}

export function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`
}

export function formatHumanReviewOutcome(outcome: FlowHumanReviewOutcome): string {
  if (outcome === 'changes_requested') {
    return 'changes requested'
  }
  return outcome
}
