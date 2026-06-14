import { spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { CreateFlowRequest, FlowCreateError, FlowFailureSummary, FlowListRow, RepositoryRow } from '@shared/workspace'
import type { RuntimeBootstrapHook } from './config'
import type { CommandResult } from './repositoryCreation'
import type { FlowStore } from './flowStore'

export type FlowCommandRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    shell?: boolean
    timeoutMs?: number
  }
) => Promise<CommandResult>

export type LaunchPreparer = (flow: FlowListRow) => Promise<void>

export type CreateFlowResult =
  | {
      ok: true
      flow: FlowListRow
    }
  | {
      ok: false
      error: FlowCreateError
      flow?: FlowListRow
    }

export async function createFlow({
  repository,
  artifactRoot,
  bootstrapHooks,
  request,
  store,
  runCommand = runFlowProcess,
  prepareLaunch = defaultPrepareLaunch,
  now = () => new Date().toISOString()
}: {
  repository: RepositoryRow
  artifactRoot: string | undefined
  bootstrapHooks: RuntimeBootstrapHook[]
  request: CreateFlowRequest
  store: FlowStore
  runCommand?: FlowCommandRunner
  prepareLaunch?: LaunchPreparer
  now?: () => string
}): Promise<CreateFlowResult> {
  const validationError = validateCreateFlowRequest(request)
  if (validationError !== null) {
    return { ok: false, error: validationError }
  }

  if (artifactRoot === undefined || artifactRoot.trim() === '') {
    return createFailure('artifact_root_unavailable', 'Flow artifact root is not configured.')
  }

  let repositoryPath: string
  try {
    repositoryPath = await realpath(repository.path)
  } catch {
    return createFailure('repository_unavailable', `Repository is unavailable: ${repository.path}`)
  }

  const title = request.title.trim()
  const instructions = request.instructions.trim()
  const baseRef = normalizeBaseRef(request.baseRef)
  const allocation = await allocateFlowResources({
    repositoryPath,
    title,
    store,
    runCommand
  })
  const createdAt = now()
  let flow = await store.createFlowRecord({
    id: allocation.flowId,
    title,
    instructions,
    status: 'creating',
    repositoryPath,
    branch: allocation.branch,
    worktreePath: allocation.worktreePath,
    baseRef,
    createdAt,
    updatedAt: createdAt
  })

  let commit: string
  try {
    commit = (await runCommand('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], {
      cwd: repositoryPath
    })).stdout.trim()
    if (commit === '') {
      throw new Error(`Base ref did not resolve to a commit: ${baseRef}`)
    }

    await runCommand('git', ['branch', allocation.branch, commit], { cwd: repositoryPath })
    await runCommand('git', ['worktree', 'add', allocation.worktreePath, allocation.branch], {
      cwd: repositoryPath
    })
  } catch (error) {
    flow = await markFlowFailed({
      store,
      flowId: allocation.flowId,
      stage: 'worktree',
      code: 'worktree_creation_failed',
      message: getErrorMessage(error),
      updatedAt: now()
    })
    return { ok: false, error: { code: 'worktree_creation_failed', message: flow.failure?.message ?? 'Worktree creation failed.' }, flow }
  }

  const start = {
    repositoryPath,
    worktreePath: allocation.worktreePath,
    branch: allocation.branch,
    baseRef,
    commit
  }
  flow = await store.updateFlowRecord(allocation.flowId, {
    commit,
    start,
    updatedAt: now()
  })

  for (const hook of bootstrapHooks) {
    const hookCwd = resolveHookCwd(allocation.worktreePath, hook.cwd)
    if (hookCwd === null) {
      flow = await markFlowFailed({
        store,
        flowId: allocation.flowId,
        stage: 'bootstrap',
        code: 'bootstrap_failed',
        message: `Bootstrap hook cwd escapes the worktree: ${hook.cwd}`,
        command: hook.command,
        updatedAt: now()
      })
      return { ok: false, error: { code: 'bootstrap_failed', message: flow.failure?.message ?? 'Bootstrap failed.' }, flow }
    }

    try {
      await runCommand(hook.command, [], {
        cwd: hookCwd,
        shell: true,
        timeoutMs: 120_000,
        env: {
          ...process.env,
          ...hook.env
        }
      })
    } catch (error) {
      flow = await markFlowFailed({
        store,
        flowId: allocation.flowId,
        stage: 'bootstrap',
        code: 'bootstrap_failed',
        message: getErrorMessage(error),
        command: hook.command,
        output: getErrorOutput(error),
        updatedAt: now()
      })
      return { ok: false, error: { code: 'bootstrap_failed', message: flow.failure?.message ?? 'Bootstrap failed.' }, flow }
    }
  }

  try {
    await prepareLaunch(flow)
  } catch (error) {
    flow = await markFlowFailed({
      store,
      flowId: allocation.flowId,
      stage: 'launch_prep',
      code: 'launch_prep_failed',
      message: getErrorMessage(error),
      updatedAt: now()
    })
    return { ok: false, error: { code: 'launch_prep_failed', message: flow.failure?.message ?? 'Launch preparation failed.' }, flow }
  }

  flow = await store.updateFlowRecord(allocation.flowId, {
    status: 'active',
    failure: undefined,
    updatedAt: now()
  })

  return { ok: true, flow }
}

async function allocateFlowResources({
  repositoryPath,
  title,
  store,
  runCommand
}: {
  repositoryPath: string
  title: string
  store: FlowStore
  runCommand: FlowCommandRunner
}): Promise<{
  flowId: string
  branch: string
  worktreePath: string
}> {
  const baseSlug = slugifyTitle(title)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`
    const branch = `flow/${slug}`
    const worktreePath = join(`${repositoryPath}-worktrees`, `flow-${slug}`)
    const [existingFlow, branchExists, worktreeExists] = await Promise.all([
      store.readFlow(slug),
      gitBranchExists(repositoryPath, branch, runCommand),
      pathExists(worktreePath)
    ])

    if (existingFlow === undefined && !branchExists && !worktreeExists) {
      return {
        flowId: slug,
        branch,
        worktreePath
      }
    }
  }

  throw new Error(`Could not allocate a collision-free Flow for ${title}.`)
}

function validateCreateFlowRequest(request: CreateFlowRequest): FlowCreateError | null {
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof request.title !== 'string' ||
    typeof request.instructions !== 'string'
  ) {
    return {
      code: 'validation_error',
      message: 'Create Flow request is invalid.'
    }
  }

  if (request.title.trim() === '') {
    return {
      code: 'validation_error',
      message: 'Flow title is required.'
    }
  }

  if (request.instructions.trim() === '') {
    return {
      code: 'validation_error',
      message: 'Flow instructions are required.'
    }
  }

  if (!isSafeBaseRef(normalizeBaseRef(request.baseRef))) {
    return {
      code: 'validation_error',
      message: 'Base ref is not safe to resolve.'
    }
  }

  return null
}

function normalizeBaseRef(baseRef: string | undefined): string {
  const trimmedBaseRef = baseRef?.trim()
  return trimmedBaseRef === undefined || trimmedBaseRef === '' ? 'HEAD' : trimmedBaseRef
}

function isSafeBaseRef(baseRef: string): boolean {
  return baseRef !== '' &&
    !baseRef.startsWith('-') &&
    !baseRef.includes('..') &&
    !baseRef.includes('@{') &&
    !baseRef.includes('//') &&
    !/[\s~^:?*[\\]/.test(baseRef) &&
    !hasControlCharacter(baseRef) &&
    !baseRef.endsWith('/') &&
    !baseRef.endsWith('.')
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function slugifyTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return slug === '' ? 'flow' : slug
}

async function gitBranchExists(
  repositoryPath: string,
  branch: string,
  runCommand: FlowCommandRunner
): Promise<boolean> {
  try {
    await runCommand('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: repositoryPath
    })
    return true
  } catch {
    return false
  }
}

function resolveHookCwd(worktreePath: string, configuredCwd: string | undefined): string | null {
  const target = configuredCwd === undefined
    ? worktreePath
    : isAbsolute(configuredCwd)
      ? configuredCwd
      : resolve(worktreePath, configuredCwd)
  const relativePath = relative(worktreePath, target)
  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return target
  }

  return null
}

async function markFlowFailed({
  store,
  flowId,
  stage,
  message,
  command,
  output,
  updatedAt
}: {
  store: FlowStore
  flowId: string
  stage: FlowFailureSummary['stage']
  code: FlowCreateError['code']
  message: string
  command?: string
  output?: string
  updatedAt: string
}): Promise<FlowListRow> {
  return store.updateFlowRecord(flowId, {
    status: 'failed',
    failure: {
      stage,
      message: truncate(message),
      command,
      output: output === undefined ? undefined : truncate(output)
    },
    updatedAt
  })
}

export function runFlowProcess(
  command: string,
  args: string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    shell?: boolean
    timeoutMs?: number
  }
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          settled = true
          child.kill()
          reject(new FlowCommandRunError(command, args, 'Command timed out.', stdout, stderr))
        }, options.timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = truncate(stdout + chunk.toString('utf8'))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = truncate(stderr + chunk.toString('utf8'))
    })
    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
      reject(new FlowCommandRunError(command, args, error.message, stdout, stderr))
    })
    child.on('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }

      reject(new FlowCommandRunError(
        command,
        args,
        stderr.trim() || `${command} exited ${code}`,
        stdout,
        stderr
      ))
    })
  })
}

export class FlowCommandRunError extends Error {
  constructor(
    readonly command: string,
    readonly args: string[],
    message: string,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message)
    this.name = 'FlowCommandRunError'
  }
}

async function defaultPrepareLaunch(): Promise<void> {
  return undefined
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

function truncate(value: string): string {
  return value.length > 4000 ? value.slice(0, 4000) : value
}

function getErrorOutput(error: unknown): string | undefined {
  if (error instanceof FlowCommandRunError) {
    const output = [error.stdout, error.stderr].filter((value) => value.trim() !== '').join('\n')
    return output === '' ? undefined : output
  }

  return undefined
}

function createFailure(code: FlowCreateError['code'], message: string): CreateFlowResult {
  return {
    ok: false,
    error: {
      code,
      message
    }
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}
