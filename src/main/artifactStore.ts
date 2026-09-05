import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadGrindstoneConfig, type LoadGrindstoneConfigOptions } from './config'

export type ArtifactErrorCode = 'not_found' | 'corrupt_artifact' | 'validation_error' | 'write_failed'

export class ArtifactStoreError extends Error {
  readonly code: ArtifactErrorCode
  readonly id?: string

  constructor(code: ArtifactErrorCode, message: string, id?: string) {
    super(message)
    this.name = 'ArtifactStoreError'
    this.code = code
    this.id = id
  }
}

export type ResolveArtifactRootOptions = LoadGrindstoneConfigOptions & {
  stateRoot?: string
  env?: Partial<NodeJS.ProcessEnv>
}

const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isSafeArtifactId(id: string): boolean {
  return SAFE_ARTIFACT_ID.test(id)
}

export function assertSafeArtifactId(kind: string, id: string): void {
  if (!isSafeArtifactId(id)) {
    throw new ArtifactStoreError('validation_error', `Unsafe ${kind} id: ${id}`, id)
  }
}

export async function resolveArtifactRoot(
  options: ResolveArtifactRootOptions = {}
): Promise<string> {
  const env = options.env ?? process.env
  const explicitRoot = options.stateRoot ?? env.GRINDSTONE_STATE_ROOT
  if (explicitRoot !== undefined && explicitRoot !== '') {
    return resolve(explicitRoot)
  }

  const config = await loadGrindstoneConfig(options)
  if (!config.ok) {
    const message = config.diagnostics[0]?.message ?? 'Unknown config validation error.'
    throw new ArtifactStoreError('validation_error', `Invalid Grindstone config: ${message}`)
  }
  return config.artifactRoot.resolvedPath
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmodBestEffort(path, 0o700)
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeTextAtomically(path: string, value: string): Promise<void> {
  await writeFileAtomically(path, value)
}

export async function readJsonArtifact<T>(
  path: string,
  id: string,
  isValid: (value: unknown) => value is T
): Promise<T> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new ArtifactStoreError('not_found', `Artifact not found: ${id}`, id)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new ArtifactStoreError('corrupt_artifact', `Artifact is corrupt: ${getErrorMessage(error)}`, id)
  }

  if (!isValid(parsed)) {
    throw new ArtifactStoreError('corrupt_artifact', `Artifact schema is invalid: ${id}`, id)
  }

  return parsed
}

export async function readTextArtifact(path: string, id: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new ArtifactStoreError('not_found', `Artifact not found: ${id}`, id)
  }
}

export async function listSafeDirectories(path: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && isSafeArtifactId(entry.name))
    .map((entry) => entry.name)
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function typedErrorPayload(error: unknown): { error: { code: string; message: string; id?: string } } {
  if (error instanceof ArtifactStoreError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        id: error.id
      }
    }
  }

  return {
    error: {
      code: 'internal_error',
      message: getErrorMessage(error)
    }
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

async function writeFileAtomically(path: string, value: string): Promise<void> {
  const directory = dirname(path)
  await ensurePrivateDirectory(directory)
  const tempPath = join(directory, `.${process.pid}.${randomUUID()}.tmp`)
  let tempFile: Awaited<ReturnType<typeof open>> | undefined

  try {
    tempFile = await open(tempPath, 'w', 0o600)
    await tempFile.writeFile(value, 'utf8')
    await tempFile.sync()
    await tempFile.close()
    tempFile = undefined
    await rename(tempPath, path)
    await chmodBestEffort(path, 0o600)
    await syncDirectoryBestEffort(directory)
  } catch (error) {
    await tempFile?.close().catch(() => undefined)
    await unlink(tempPath).catch(() => undefined)
    throw new ArtifactStoreError('write_failed', `Artifact write failed: ${getErrorMessage(error)}`)
  }
}

async function chmodBestEffort(path: string, mode: number): Promise<void> {
  try {
    const handle = await open(path, 'r')
    await handle.chmod(mode)
    await handle.close()
  } catch {
    // POSIX modes are best effort on non-POSIX file systems.
  }
}

async function syncDirectoryBestEffort(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined
  try {
    directory = await open(path, 'r')
    await directory.sync()
  } catch {
    // Directory fsync is not supported on every filesystem and commonly fails on Windows.
  } finally {
    await directory?.close().catch(() => undefined)
  }
}
