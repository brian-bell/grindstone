import { spawn } from 'node:child_process'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  CreateRepositoryRequest,
  RepositoryCreateError,
  RepositoryRemoteRetryRecord,
  RepositoryRow,
  RepositoryScanRoot
} from '@shared/workspace'
import { isCatalogPrunedDirectoryName } from './repositoryCatalog'

export type CommandResult = {
  stdout: string
  stderr?: string
}

export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string }
) => Promise<CommandResult>

export class CommandRunError extends Error {
  constructor(
    readonly command: string,
    readonly args: string[],
    message: string
  ) {
    super(message)
    this.name = 'CommandRunError'
  }
}

export type CreateRepositoryResult =
  | {
      ok: true
      repository: RepositoryRow
      retry: RepositoryRemoteRetryRecord | null
    }
  | {
      ok: false
      error: RepositoryCreateError
    }

export type RetryRepositoryRemoteResult =
  | {
      ok: true
      retry: RepositoryRemoteRetryRecord
    }
  | {
      ok: false
      retry: RepositoryRemoteRetryRecord
    }

export async function createRepository({
  scanRoots,
  request,
  runCommand = runProcess,
  removeTarget = removeTargetPath
}: {
  scanRoots: RepositoryScanRoot[]
  request: CreateRepositoryRequest
  runCommand?: CommandRunner
  removeTarget?: (path: string) => Promise<void>
}): Promise<CreateRepositoryResult> {
  const requestError = validateCreateRepositoryRequest(request)
  if (requestError !== null) {
    return {
      ok: false,
      error: requestError
    }
  }

  const scanRoot = scanRoots.find((candidate) => candidate.id === request.scanRootId)
  if (scanRoot === undefined) {
    return createFailure('scan_root_unavailable', 'Selected scan root is unavailable.')
  }

  const nameError = validateRepositoryName(request.name)
  if (nameError !== null) {
    return createFailure('validation_error', nameError)
  }

  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(scanRoot.resolvedPath)
  } catch {
    return createFailure('scan_root_unavailable', `Scan root is unavailable: ${scanRoot.resolvedPath}`)
  }

  const targetPath = resolve(canonicalRoot, request.name)
  if (!isContainedPath(canonicalRoot, targetPath)) {
    return createFailure('validation_error', 'Repository name must stay inside the selected scan root.')
  }

  if (await pathExists(targetPath)) {
    return createFailure('target_exists', `Repository already exists: ${targetPath}`)
  }

  try {
    await mkdir(targetPath, { recursive: false })
  } catch (error) {
    return createFailure('local_creation_failed', getErrorMessage(error))
  }

  try {
    const canonicalTarget = await realpath(targetPath)
    if (!isContainedPath(canonicalRoot, canonicalTarget)) {
      await removeCreatedTarget(targetPath, removeTarget)
      return createFailure(
        'validation_error',
        'Created repository path escaped the selected scan root.'
      )
    }

    await runCommand('git', ['init'], { cwd: canonicalTarget })

    const repository: RepositoryRow = {
      id: canonicalTarget,
      name: basename(canonicalTarget),
      path: canonicalTarget,
      canonicalPath: canonicalTarget,
      sources: ['scan_root']
    }

    if (!request.github.enabled) {
      return {
        ok: true,
        repository,
        retry: null
      }
    }

    try {
      await runGitHubCreate({
        name: request.name,
        repositoryPath: canonicalTarget,
        visibility: request.github.visibility,
        runCommand
      })
      return {
        ok: true,
        repository,
        retry: null
      }
    } catch (error) {
      const expectedOriginUrl = isGitHubOriginSetupFailure(error)
        ? await getGitHubRepositoryUrl({
            name: request.name,
            repositoryPath: canonicalTarget,
            runCommand
          })
        : null

      return {
        ok: true,
        repository,
        retry: createRetryRecord({
          repository,
          githubRepositoryName: request.name,
          visibility: request.github.visibility,
          status:
            expectedOriginUrl === null
              ? 'remote_create_failed'
              : 'remote_maybe_created_origin_failed',
          lastError: getErrorMessage(error),
          expectedOriginUrl
        })
      }
    }
  } catch (error) {
    const cleanupError = await removeCreatedTarget(targetPath, removeTarget)
    const cleanupMessage =
      cleanupError === null ? '' : ` Cleanup also failed: ${cleanupError}`
    return createFailure('local_creation_failed', `${getErrorMessage(error)}${cleanupMessage}`)
  }
}

export async function retryRepositoryRemote({
  retry,
  runCommand = runProcess
}: {
  retry: RepositoryRemoteRetryRecord
  runCommand?: CommandRunner
}): Promise<RetryRepositoryRemoteResult> {
  const origin = await getOriginUrl(retry, runCommand)
  if (origin.kind === 'matches') {
    return {
      ok: true,
      retry: {
        ...retry,
        status: 'succeeded',
        lastError: ''
      }
    }
  }

  if (origin.kind === 'conflict') {
    return {
      ok: false,
      retry: {
        ...retry,
        status: 'origin_conflict',
        lastError: `Existing origin points to ${origin.url}.`
      }
    }
  }

  if (origin.kind === 'missing' && retry.expectedOriginUrl !== null) {
    return addVerifiedOrigin(retry, retry.expectedOriginUrl, runCommand)
  }

  try {
    await runGitHubCreate({
      name: retry.githubRepositoryName,
      repositoryPath: retry.repositoryPath,
      visibility: retry.visibility,
      runCommand
    })
    return {
      ok: true,
      retry: {
        ...retry,
        status: 'succeeded',
        lastError: ''
      }
    }
  } catch (error) {
    const expectedOriginUrl = isGitHubOriginSetupFailure(error)
      ? await getGitHubRepositoryUrl({
          name: retry.githubRepositoryName,
          repositoryPath: retry.repositoryPath,
          runCommand
        })
      : null
    if (expectedOriginUrl !== null) {
      return addVerifiedOrigin(
        {
          ...retry,
          expectedOriginUrl,
          status: 'remote_maybe_created_origin_failed',
          lastError: getErrorMessage(error)
        },
        expectedOriginUrl,
        runCommand
      )
    }

    return {
      ok: false,
      retry: {
        ...retry,
        status: 'remote_create_failed',
        lastError: getErrorMessage(error)
      }
    }
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: { cwd: string }
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      reject(new CommandRunError(command, args, error.message))
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }

      reject(new CommandRunError(command, args, stderr.trim() || `${command} exited ${code}`))
    })
  })
}

function validateCreateRepositoryRequest(request: CreateRepositoryRequest): RepositoryCreateError | null {
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof request.scanRootId !== 'string' ||
    typeof request.name !== 'string' ||
    typeof request.github !== 'object' ||
    request.github === null ||
    typeof request.github.enabled !== 'boolean'
  ) {
    return {
      code: 'validation_error',
      message: 'Create repository request is invalid.'
    }
  }

  if (request.github.visibility !== 'public' && request.github.visibility !== 'private') {
    return {
      code: 'validation_error',
      message: 'GitHub visibility must be public or private.'
    }
  }

  return null
}

function validateRepositoryName(name: string): string | null {
  if (name.trim() === '') {
    return 'Repository name is required.'
  }

  if (name !== name.trim()) {
    return 'Repository name cannot start or end with whitespace.'
  }

  if (name === '.' || name === '..') {
    return 'Repository name cannot be . or ...'
  }

  if (isCatalogPrunedDirectoryName(name)) {
    return 'Repository name is reserved by the catalog scanner.'
  }

  if (isAbsolute(name) || name.includes('/') || name.includes('\\') || name.includes(sep)) {
    return 'Repository name must be a single path segment.'
  }

  return null
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

function isContainedPath(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

async function removeCreatedTarget(
  path: string,
  removeTarget: (path: string) => Promise<void>
): Promise<string | null> {
  try {
    await removeTarget(path)
    return null
  } catch (error) {
    return getErrorMessage(error)
  }
}

async function removeTargetPath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

async function runGitHubCreate({
  name,
  repositoryPath,
  visibility,
  runCommand
}: {
  name: string
  repositoryPath: string
  visibility: 'public' | 'private'
  runCommand: CommandRunner
}): Promise<void> {
  await runCommand(
    'gh',
    ['repo', 'create', name, '--source', repositoryPath, '--remote', 'origin', `--${visibility}`],
    { cwd: repositoryPath }
  )
}

function isGitHubOriginSetupFailure(error: unknown): boolean {
  return /\borigin\b/i.test(getErrorMessage(error))
}

async function getGitHubRepositoryUrl({
  name,
  repositoryPath,
  runCommand
}: {
  name: string
  repositoryPath: string
  runCommand: CommandRunner
}): Promise<string | null> {
  try {
    const result = await runCommand('gh', ['repo', 'view', name, '--json', 'url', '--jq', '.url'], {
      cwd: repositoryPath
    })
    const url = result.stdout.trim()
    return url === '' ? null : url
  } catch {
    return null
  }
}

async function addVerifiedOrigin(
  retry: RepositoryRemoteRetryRecord,
  expectedOriginUrl: string,
  runCommand: CommandRunner
): Promise<RetryRepositoryRemoteResult> {
  try {
    await runCommand('git', ['remote', 'add', 'origin', expectedOriginUrl], {
      cwd: retry.repositoryPath
    })
    return {
      ok: true,
      retry: {
        ...retry,
        status: 'succeeded',
        lastError: '',
        expectedOriginUrl
      }
    }
  } catch (error) {
    return {
      ok: false,
      retry: {
        ...retry,
        status: 'origin_missing',
        lastError: getErrorMessage(error),
        expectedOriginUrl
      }
    }
  }
}

async function getOriginUrl(
  retry: RepositoryRemoteRetryRecord,
  runCommand: CommandRunner
): Promise<
  | { kind: 'missing' }
  | { kind: 'matches' }
  | {
      kind: 'conflict'
      url: string
    }
> {
  try {
    const result = await runCommand('git', ['remote', 'get-url', 'origin'], {
      cwd: retry.repositoryPath
    })
    const originUrl = result.stdout.trim()
    if (
      retry.expectedOriginUrl !== null &&
      isSameGitHubRepositoryRemote(originUrl, retry.expectedOriginUrl)
    ) {
      return { kind: 'matches' }
    }

    return {
      kind: 'conflict',
      url: originUrl
    }
  } catch {
    return { kind: 'missing' }
  }
}

function isSameGitHubRepositoryRemote(left: string, right: string): boolean {
  const normalizedLeft = normalizeGitHubRepositoryRemote(left)
  const normalizedRight = normalizeGitHubRepositoryRemote(right)

  if (normalizedLeft !== null && normalizedRight !== null) {
    return normalizedLeft === normalizedRight
  }

  return left.trim() === right.trim()
}

function normalizeGitHubRepositoryRemote(remoteUrl: string): string | null {
  const trimmedUrl = remoteUrl.trim()
  const scpLikeRemote = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmedUrl)
  if (scpLikeRemote !== null) {
    return normalizeRepositoryParts(scpLikeRemote[1], scpLikeRemote[2], scpLikeRemote[3])
  }

  try {
    const url = new URL(trimmedUrl)
    const [owner, repo] = url.pathname.replace(/^\/+/, '').split('/')
    return normalizeRepositoryParts(url.hostname, owner, repo)
  } catch {
    return null
  }
}

function normalizeRepositoryParts(
  host: string | undefined,
  owner: string | undefined,
  repo: string | undefined
): string | null {
  if (host === undefined || owner === undefined || repo === undefined) {
    return null
  }

  const normalizedRepo = repo.endsWith('.git') ? repo.slice(0, -4) : repo
  if (host === '' || owner === '' || normalizedRepo === '') {
    return null
  }

  return `${host.toLowerCase()}/${owner.toLowerCase()}/${normalizedRepo.toLowerCase()}`
}

function createRetryRecord({
  repository,
  githubRepositoryName,
  visibility,
  status,
  lastError,
  expectedOriginUrl
}: {
  repository: RepositoryRow
  githubRepositoryName: string
  visibility: 'public' | 'private'
  status: RepositoryRemoteRetryRecord['status']
  lastError: string
  expectedOriginUrl: string | null
}): RepositoryRemoteRetryRecord {
  return {
    id: `remote-retry:${repository.id}`,
    repositoryId: repository.id,
    repositoryPath: repository.path,
    githubRepositoryName,
    visibility,
    status,
    lastError,
    expectedOriginUrl
  }
}

function createFailure(
  code: RepositoryCreateError['code'],
  message: string
): CreateRepositoryResult {
  return {
    ok: false,
    error: {
      code,
      message
    }
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown error'
}
