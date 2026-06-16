import { readFile, stat } from 'node:fs/promises'
import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from 'node:process'
import type { FlowHumanReviewOutcome, FlowPullRequestMetadata, FlowPullRequestStatus } from '@shared/artifacts'
import { ArtifactStoreError, resolveArtifactRoot, typedErrorPayload, getErrorMessage } from '../main/artifactStore'
import { createFlowOperations } from '../main/flowOperations'
import { createPlanStore, validatePlanStatus } from '../main/planStore'
import { ingestSessionHook, type SessionIngestResult } from '../main/sessionStore'

type CliIo = {
  stdout: Pick<NodeJS.WriteStream, 'write'>
  stderr: Pick<NodeJS.WriteStream, 'write'>
  stdin: NodeJS.ReadStream
  env: NodeJS.ProcessEnv
}

type ParsedArgs = {
  positionals: string[]
  flags: Map<string, string | true>
}

const JSON_DEFAULT_COMMANDS = new Set([
  'flow',
  'plan:list',
  'plan:link',
  'session-hook:ingest'
])
const MAX_SESSION_HOOK_INPUT_BYTES = 10 * 1024 * 1024

export async function runCli(
  argv: string[],
  io: CliIo = {
    stdout: processStdout,
    stderr: processStderr,
    stdin: processStdin,
    env: process.env
  }
): Promise<number> {
  const parsed = parseArgs(argv)
  const [group, command, subcommand] = parsed.positionals

  if (parsed.flags.has('help') || group === undefined) {
    io.stdout.write(helpText())
    return 0
  }

  try {
    const artifactRoot = await resolveArtifactRoot({
      stateRoot: optionalFlag(parsed, 'state-root'),
      configPath: optionalFlag(parsed, 'config'),
      env: io.env
    })

    if (group === 'flow') {
      const flows = createFlowOperations({ artifactRoot })
      if (command === 'create') {
        writeJson(io, await flows.createFlow({
          title: requiredFlag(parsed, 'title'),
          instructions: optionalFlag(parsed, 'instructions'),
          repoPath: metadata(parsed, io.env, 'repo-path', 'GRINDSTONE_REPO_PATH', 'WTUI_REPO_PATH'),
          worktreePath: metadataOptional(parsed, io.env, 'worktree-path', 'GRINDSTONE_WORKTREE_PATH', 'WTUI_WORKTREE_PATH'),
          branch: metadataOptional(parsed, io.env, 'branch', 'GRINDSTONE_BRANCH', 'WTUI_BRANCH'),
          commit: metadataOptional(parsed, io.env, 'commit', 'GRINDSTONE_COMMIT', 'WTUI_COMMIT')
        }))
        return 0
      }
      if (command === 'list') {
        writeJson(io, await flows.listFlows({
          repoPath: optionalFlag(parsed, 'repo-path')
        }))
        return 0
      }
      if (command === 'read') {
        writeJson(io, await flows.readFlow(flowId(parsed, io.env)))
        return 0
      }
      if (command === 'phase') {
        const phaseId = metadata(parsed, io.env, 'phase-id', 'GRINDSTONE_PHASE_ID', 'WTUI_FLOW_PHASE_ID')
        const input = {
          flowId: flowId(parsed, io.env),
          phaseId,
          outcome: optionalFlag(parsed, 'outcome'),
          summary: optionalFlag(parsed, 'summary'),
          notes: optionalFlag(parsed, 'notes'),
          title: optionalFlag(parsed, 'title'),
          kind: optionalFlag(parsed, 'kind'),
          order: optionalNumberFlag(parsed, 'order')
        }
        if (subcommand === 'set') {
          writeJson(io, await flows.setPhase({
            ...input,
            status: requiredFlag(parsed, 'status')
          }))
          return 0
        }
        if (subcommand === 'complete') {
          if (phaseId === 'pr-creation' && hasPullRequestMetadataFlags(parsed)) {
            writeJson(io, await flows.completePrCreation({
              flowId: input.flowId,
              pr: pullRequestMetadata(parsed),
              summary: input.summary
            }))
            return 0
          }
          writeJson(io, await flows.completePhase(input))
          return 0
        }
        if (subcommand === 'block') {
          writeJson(io, await flows.blockPhase(input))
          return 0
        }
        if (subcommand === 'needs-attention') {
          writeJson(io, await flows.needsAttentionPhase(input))
          return 0
        }
        if (subcommand === 'restart') {
          writeJson(io, await flows.restartPhase(input))
          return 0
        }
      }
      if (command === 'human-review' && subcommand === 'set') {
        writeJson(io, await flows.recordHumanReview({
          flowId: flowId(parsed, io.env),
          outcome: humanReviewOutcome(parsed),
          notes: optionalFlag(parsed, 'notes')
        }))
        return 0
      }
      if (command === 'merge' && subcommand === 'set') {
        writeJson(io, await flows.recordMerge(mergeMetadata(parsed, io.env)))
        return 0
      }
      if (command === 'plan' && subcommand === 'set') {
        writeJson(io, await flows.linkPlan({
          flowId: flowId(parsed, io.env),
          planId: metadata(parsed, io.env, 'plan-id', 'GRINDSTONE_PLAN_ID', 'WTUI_PLAN_ID')
        }))
        return 0
      }
    }

    if (group === 'plan') {
      const plans = createPlanStore({ artifactRoot })
      if (command === 'save') {
        const status = optionalFlag(parsed, 'status') ?? 'draft'
        validatePlanStatus(status)
        const metadata = await plans.savePlan({
          planId: optionalFlag(parsed, 'plan-id'),
          title: requiredFlag(parsed, 'title'),
          status,
          repoPath: metadataOptional(parsed, io.env, 'repo-path', 'GRINDSTONE_REPO_PATH', 'WTUI_REPO_PATH'),
          worktreePath: metadataOptional(parsed, io.env, 'worktree-path', 'GRINDSTONE_WORKTREE_PATH', 'WTUI_WORKTREE_PATH'),
          branch: metadataOptional(parsed, io.env, 'branch', 'GRINDSTONE_BRANCH', 'WTUI_BRANCH'),
          body: optionalFlag(parsed, 'file') === undefined
            ? await readStdin(io.stdin)
            : await readFile(requiredFlag(parsed, 'file'), 'utf8')
        })
        io.stdout.write(`${metadata.plan_id}\n`)
        return 0
      }
      if (command === 'list') {
        writeJson(io, await plans.listPlans({
          repoPath: optionalFlag(parsed, 'repo-path'),
          flowId: optionalFlag(parsed, 'flow-id')
        }))
        return 0
      }
      if (command === 'read') {
        const plan = await plans.readPlan(metadata(parsed, io.env, 'plan-id', 'GRINDSTONE_PLAN_ID', 'WTUI_PLAN_ID'))
        if (parsed.flags.has('json')) {
          writeJson(io, plan)
        } else {
          io.stdout.write(plan.body)
        }
        return 0
      }
      if (command === 'link') {
        const flows = createFlowOperations({ artifactRoot })
        writeJson(io, await flows.linkPlan({
          flowId: metadata(parsed, io.env, 'flow-id', 'GRINDSTONE_FLOW_ID', 'WTUI_FLOW_ID'),
          planId: metadata(parsed, io.env, 'plan-id', 'GRINDSTONE_PLAN_ID', 'WTUI_PLAN_ID')
        }))
        return 0
      }
    }

    if (group === 'session-hook' && command === 'ingest') {
      const provider = requiredFlag(parsed, 'provider')
      if (provider !== 'codex' && provider !== 'claude') {
        throw new ArtifactStoreError('validation_error', `Unsupported provider: ${provider}`)
      }
      const sourcePath = optionalFlag(parsed, 'file')
      const result = await ingestSessionHook({ artifactRoot }, {
        provider,
        payload: sourcePath === undefined
          ? await readStdin(io.stdin, MAX_SESSION_HOOK_INPUT_BYTES)
          : await readUtf8File(sourcePath, MAX_SESSION_HOOK_INPUT_BYTES),
        sourcePath,
        flowId: metadataOptional(parsed, io.env, 'flow-id', 'GRINDSTONE_FLOW_ID', 'WTUI_FLOW_ID'),
        phaseId: metadataOptional(parsed, io.env, 'phase-id', 'GRINDSTONE_PHASE_ID', 'WTUI_FLOW_PHASE_ID'),
        launchId: metadataOptional(parsed, io.env, 'launch-id', 'GRINDSTONE_LAUNCH_ID', 'WTUI_LAUNCH_ID'),
        repoPath: metadataOptional(parsed, io.env, 'repo-path', 'GRINDSTONE_REPO_PATH', 'WTUI_REPO_PATH'),
        worktreePath: metadataOptional(parsed, io.env, 'worktree-path', 'GRINDSTONE_WORKTREE_PATH', 'WTUI_WORKTREE_PATH'),
        branch: metadataOptional(parsed, io.env, 'branch', 'GRINDSTONE_BRANCH', 'WTUI_BRANCH'),
        commit: metadataOptional(parsed, io.env, 'commit', 'GRINDSTONE_COMMIT', 'WTUI_COMMIT')
      })
      writeJson(io, sessionHookOutput(result))
      return 0
    }

    throw new Error(`Unknown command: ${parsed.positionals.join(' ')}`)
  } catch (error) {
    const commandKey = group === 'flow'
      ? 'flow'
      : `${group ?? ''}:${command ?? ''}`
    if (JSON_DEFAULT_COMMANDS.has(commandKey) || parsed.flags.has('json')) {
      io.stderr.write(`${JSON.stringify(typedErrorPayload(error))}\n`)
    } else {
      io.stderr.write(`${getErrorMessage(error)}\n`)
    }
    return 1
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value.startsWith('--')) {
      const key = value.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next)
        index += 1
      } else {
        flags.set(key, true)
      }
    } else {
      positionals.push(value)
    }
  }
  return { flags, positionals }
}

function requiredFlag(parsed: ParsedArgs, name: string): string {
  const value = optionalFlag(parsed, name)
  if (value === undefined) {
    throw new Error(`Missing required flag --${name}.`)
  }
  return value
}

function optionalFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function optionalNumberFlag(parsed: ParsedArgs, name: string): number | undefined {
  const value = optionalFlag(parsed, name)
  if (value === undefined) {
    return undefined
  }
  const parsedValue = Number(value)
  if (!Number.isInteger(parsedValue)) {
    throw new Error(`--${name} must be an integer.`)
  }
  return parsedValue
}

function requiredNumberFlag(parsed: ParsedArgs, name: string): number {
  const value = optionalNumberFlag(parsed, name)
  if (value === undefined) {
    throw new Error(`Missing required flag --${name}.`)
  }
  return value
}

function hasPullRequestMetadataFlags(parsed: ParsedArgs): boolean {
  return [
    'pr-provider',
    'pr-number',
    'pr-url',
    'pr-head',
    'pr-base',
    'pr-status'
  ].some((flag) => parsed.flags.has(flag))
}

function pullRequestMetadata(parsed: ParsedArgs): FlowPullRequestMetadata {
  const provider = requiredFlag(parsed, 'pr-provider')
  if (provider !== 'github') {
    throw new ArtifactStoreError('validation_error', 'Pull request provider must be github.')
  }

  return {
    provider,
    number: requiredNumberFlag(parsed, 'pr-number'),
    url: requiredFlag(parsed, 'pr-url'),
    head: requiredFlag(parsed, 'pr-head'),
    base: requiredFlag(parsed, 'pr-base'),
    status: requiredFlag(parsed, 'pr-status') as FlowPullRequestStatus
  }
}

function humanReviewOutcome(parsed: ParsedArgs): FlowHumanReviewOutcome {
  const outcome = requiredFlag(parsed, 'outcome')
  if (outcome !== 'approved' && outcome !== 'changes_requested' && outcome !== 'blocked') {
    throw new ArtifactStoreError(
      'validation_error',
      'Human Review outcome must be approved, changes_requested, or blocked.'
    )
  }
  return outcome
}

function mergeMetadata(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv
): { flowId: string; status: 'merged'; commit: string } | { flowId: string; status: 'blocked'; notes: string } {
  const status = requiredFlag(parsed, 'status')
  const id = flowId(parsed, env)
  if (status === 'merged') {
    return {
      flowId: id,
      status,
      commit: requiredFlag(parsed, 'commit')
    }
  }
  if (status === 'blocked') {
    return {
      flowId: id,
      status,
      notes: optionalFlag(parsed, 'notes') ?? ''
    }
  }
  throw new ArtifactStoreError('validation_error', 'Merge status must be merged or blocked.')
}

function metadata(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
  flag: string,
  grindstoneName: string,
  wtuiName: string
): string {
  const value = metadataOptional(parsed, env, flag, grindstoneName, wtuiName)
  if (value === undefined) {
    throw new Error(`Missing required metadata --${flag}.`)
  }
  return value
}

function metadataOptional(
  parsed: ParsedArgs,
  env: NodeJS.ProcessEnv,
  flag: string,
  grindstoneName: string,
  wtuiName: string
): string | undefined {
  return optionalFlag(parsed, flag) ?? env[grindstoneName] ?? env[wtuiName]
}

function flowId(parsed: ParsedArgs, env: NodeJS.ProcessEnv): string {
  return metadata(parsed, env, 'flow-id', 'GRINDSTONE_FLOW_ID', 'WTUI_FLOW_ID')
}

async function readStdin(stream: NodeJS.ReadStream, maxBytes?: number): Promise<string> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    totalBytes += buffer.byteLength
    if (maxBytes !== undefined && totalBytes > maxBytes) {
      throw new ArtifactStoreError('validation_error', `Input exceeds maximum size of ${maxBytes} bytes.`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readUtf8File(path: string, maxBytes?: number): Promise<string> {
  if (maxBytes !== undefined && (await stat(path)).size > maxBytes) {
    throw new ArtifactStoreError('validation_error', `Input exceeds maximum size of ${maxBytes} bytes.`)
  }
  const value = await readFile(path, 'utf8')
  if (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new ArtifactStoreError('validation_error', `Input exceeds maximum size of ${maxBytes} bytes.`)
  }
  return value
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function sessionHookOutput(result: SessionIngestResult): Record<string, unknown> {
  return {
    metadata: result.metadata,
    event_count: result.events.length,
    warnings: result.metadata.source_summary.warnings,
    truncated: result.metadata.truncated === true ? true : undefined
  }
}

function helpText(): string {
  return `grindstone

Usage:
  grindstone flow create --title TITLE --repo-path PATH [--instructions TEXT]
  grindstone flow list [--repo-path PATH]
  grindstone flow read --flow-id ID
  grindstone flow phase set --flow-id ID --phase-id ID --status STATUS --title TITLE --order N
  grindstone flow phase complete|block|needs-attention|restart --flow-id ID --phase-id ID
  grindstone flow phase complete --flow-id ID --phase-id pr-creation --pr-provider github --pr-number N --pr-url URL --pr-head BRANCH --pr-base BRANCH --pr-status open|closed|merged
  grindstone flow human-review set --flow-id ID --outcome approved|changes_requested|blocked [--notes TEXT]
  grindstone flow merge set --flow-id ID --status merged --commit SHA
  grindstone flow merge set --flow-id ID --status blocked --notes TEXT
  grindstone flow plan set --flow-id ID --plan-id ID
  grindstone plan save --title TITLE [--plan-id ID] [--file PATH]
  grindstone plan list [--repo-path PATH] [--flow-id ID]
  grindstone plan read --plan-id ID [--json]
  grindstone plan link --plan-id ID --flow-id ID
  grindstone session-hook ingest --provider codex|claude [--file PATH]

Global flags:
  --state-root PATH
  --config PATH
  --help
`
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
