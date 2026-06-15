import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  FlowPhaseSessionReference,
  NormalizedSessionMetadata,
  NormalizedTranscriptEvent
} from '@shared/artifacts'
import {
  ArtifactStoreError,
  assertSafeArtifactId,
  ensurePrivateDirectory,
  readJsonArtifact,
  readTextArtifact,
  writeJsonAtomically,
  writeTextAtomically
} from './artifactStore'
import { createFlowOperations } from './flowOperations'

export type SessionProvider = 'codex' | 'claude'

export type SessionIngestInput = {
  provider: SessionProvider
  payload: string
  sourcePath?: string
  flowId?: string
  phaseId?: string
  launchId?: string
  repoPath?: string
  worktreePath?: string
  branch?: string
  commit?: string
  now?: string
}

export type SessionIngestResult = {
  metadata: NormalizedSessionMetadata
  events: NormalizedTranscriptEvent[]
}

const MAX_EVENT_TEXT_BYTES = 64 * 1024
const MAX_TRANSCRIPT_TEXT_BYTES = 10 * 1024 * 1024

export async function ingestSessionHook(
  options: { artifactRoot: string },
  input: SessionIngestInput
): Promise<SessionIngestResult> {
  const now = input.now ?? new Date().toISOString()
  const launchMetadata = await readLaunchMetadata(options.artifactRoot, input.launchId)
  const flowId = input.flowId ?? launchMetadata.flowId
  const phaseId = input.phaseId ?? launchMetadata.phaseId

  if (flowId === undefined || phaseId === undefined) {
    throw new ArtifactStoreError('validation_error', 'Session ingestion requires Flow and phase metadata.')
  }
  assertSafeArtifactId('Flow', flowId)
  assertSafeArtifactId('phase', phaseId)

  const normalized = input.provider === 'codex'
    ? normalizeCodex(input, flowId, phaseId)
    : await normalizeClaude(input, flowId, phaseId)
  const sessionId = normalized.sessionId
  assertSafeArtifactId('session', sessionId)

  const sessionDir = join(options.artifactRoot, 'sessions', input.provider, sessionId)
  await ensurePrivateDirectory(sessionDir)
  const metadataPath = join(sessionDir, 'meta.json')
  const transcriptPath = join(sessionDir, 'transcript.jsonl')
  const existing = await readExistingSession(metadataPath, transcriptPath, input.provider, sessionId)
  if (
    existing !== undefined &&
    (existing.metadata.flow_id !== flowId || existing.metadata.phase_id !== phaseId)
  ) {
    await writeJsonAtomically(metadataPath, {
      ...existing.metadata,
      attachment_status: 'pending',
      last_attachment_error: 'Session is already attached to a different Flow phase.',
      updated_at: now
    })
    throw new ArtifactStoreError(
      'validation_error',
      'Session is already attached to a different Flow phase.',
      sessionId
    )
  }

  const events = mergeEvents(existing?.events ?? [], normalized.events)
  const limited = enforceTranscriptLimit(events)
  const metadata: NormalizedSessionMetadata = withoutUndefined({
    schema_version: 1,
    provider: input.provider,
    session_id: sessionId,
    flow_id: flowId,
    phase_id: phaseId,
    launch_id: input.launchId ?? launchMetadata.launchId,
    repo_path: input.repoPath ?? launchMetadata.repoPath,
    worktree_path: input.worktreePath ?? launchMetadata.worktreePath,
    branch: input.branch ?? launchMetadata.branch,
    commit: input.commit ?? launchMetadata.commit,
    status: 'unknown',
    attachment_status: 'pending',
    transcript_path: transcriptPath,
    source_summary: {
      provider: input.provider,
      input_format: normalized.inputFormat,
      event_count: limited.events.length,
      warnings: limited.truncated ? ['Transcript truncated at session limit.'] : normalized.warnings
    },
    truncated: limited.truncated ? true : undefined,
    created_at: existing?.metadata.created_at ?? now,
    updated_at: now
  })

  await writeTextAtomically(transcriptPath, `${limited.events.map((event) => JSON.stringify(event)).join('\n')}\n`)
  await writeJsonAtomically(metadataPath, metadata)

  try {
    const attached = await attachSessionReference(options, metadata, limited.events, now)
    await writeJsonAtomically(metadataPath, attached)
    return { metadata: attached, events: limited.events }
  } catch (error) {
    const pending = {
      ...metadata,
      attachment_status: 'pending' as const,
      last_attachment_error: error instanceof Error ? error.message : 'Unknown attachment error'
    }
    await writeJsonAtomically(metadataPath, pending)
    throw error
  }
}

async function attachSessionReference(
  options: { artifactRoot: string },
  metadata: NormalizedSessionMetadata,
  events: NormalizedTranscriptEvent[],
  now: string
): Promise<NormalizedSessionMetadata> {
  const flows = createFlowOperations(options)
  const flow = await flows.readFlow(metadata.flow_id)
  const phases = flow.phases ?? []
  const phase = phases.find((candidate) => candidate.phase_id === metadata.phase_id)
  if (phase === undefined) {
    throw new ArtifactStoreError('validation_error', `Unknown phase: ${metadata.phase_id}`)
  }

  const reference: FlowPhaseSessionReference = withoutUndefined({
    provider: metadata.provider,
    session_id: metadata.session_id,
    launch_id: metadata.launch_id,
    status: metadata.status,
    attachment_status: 'attached',
    started_at: events[0]?.timestamp ?? metadata.created_at,
    ended_at: events.at(-1)?.timestamp,
    transcript_path: metadata.transcript_path
  })
  const sessions = [...(phase.sessions ?? [])]
  const existingIndex = sessions.findIndex((session) =>
    session.provider === reference.provider && session.session_id === reference.session_id
  )
  if (existingIndex === -1) {
    sessions.push(reference)
  } else {
    sessions[existingIndex] = reference
  }

  await flows.setPhase({
    flowId: metadata.flow_id,
    phaseId: metadata.phase_id,
    title: phase.title,
    kind: phase.kind,
    order: phase.order,
    outcome: phase.outcome,
    summary: phase.summary,
    now
  })
  const updatedFlow = await flows.readFlow(metadata.flow_id)
  const updatedPhases = [...(updatedFlow.phases ?? [])]
  const phaseIndex = updatedPhases.findIndex((candidate) => candidate.phase_id === metadata.phase_id)
  if (phaseIndex === -1) {
    throw new ArtifactStoreError('validation_error', `Unknown phase: ${metadata.phase_id}`)
  }
  updatedPhases[phaseIndex] = {
    ...updatedPhases[phaseIndex],
    sessions
  }
  await writeJsonAtomically(join(options.artifactRoot, 'flows', metadata.flow_id, 'meta.json'), {
    ...updatedFlow,
    phases: updatedPhases,
    updated_at: now
  })

  return {
    ...metadata,
    attachment_status: 'attached',
    last_attachment_error: undefined,
    updated_at: now
  }
}

function normalizeCodex(
  input: SessionIngestInput,
  flowId: string,
  phaseId: string
): { sessionId: string; events: NormalizedTranscriptEvent[]; inputFormat: string; warnings: string[] } {
  const rows = parseJsonLines(input.payload, 'codex')
  const sessionId = resolveSessionId(input.provider, input.launchId, input.sourcePath, rows)
  const events = rows.map((row, index) => normalizeEvent({
    provider: 'codex',
    row,
    index,
    sessionId,
    flowId,
    phaseId,
    input
  }))
  return { sessionId, events, inputFormat: 'codex-jsonl', warnings: [] }
}

async function normalizeClaude(
  input: SessionIngestInput,
  flowId: string,
  phaseId: string
): Promise<{ sessionId: string; events: NormalizedTranscriptEvent[]; inputFormat: string; warnings: string[] }> {
  const hook = parseJsonObject(input.payload, 'claude')
  const transcriptPath = typeof hook.transcript_path === 'string' ? hook.transcript_path : undefined
  const messages = transcriptPath === undefined
    ? Array.isArray(hook.messages) ? hook.messages : [hook]
    : parseJsonLines(await readClaudeTranscript(input, transcriptPath), 'claude transcript')
  const sessionId = resolveSessionId(input.provider, input.launchId, transcriptPath ?? input.sourcePath, [
    hook,
    ...messages
  ])
  const events = messages.map((row, index) => normalizeEvent({
    provider: 'claude',
    row,
    index,
    sessionId,
    flowId,
    phaseId,
    input
  }))
  return {
    sessionId,
    events,
    inputFormat: transcriptPath === undefined ? 'claude-hook-json' : 'claude-transcript-jsonl',
    warnings: []
  }
}

async function readClaudeTranscript(input: SessionIngestInput, transcriptPath: string): Promise<string> {
  if (input.sourcePath === undefined) {
    throw new ArtifactStoreError('validation_error', 'Claude transcript_path requires a hook file source.')
  }
  if (isAbsolute(transcriptPath)) {
    throw new ArtifactStoreError('validation_error', 'Claude transcript_path must be relative to the hook file.')
  }
  const transcriptRoot = dirname(input.sourcePath)
  const resolvedPath = resolve(transcriptRoot, transcriptPath)
  const relativePath = relative(transcriptRoot, resolvedPath)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new ArtifactStoreError('validation_error', 'Claude transcript_path must stay inside the hook directory.')
  }
  if ((await stat(resolvedPath)).size > MAX_TRANSCRIPT_TEXT_BYTES) {
    throw new ArtifactStoreError(
      'validation_error',
      `Transcript exceeds maximum size of ${MAX_TRANSCRIPT_TEXT_BYTES} bytes.`
    )
  }
  const payload = await readFile(resolvedPath, 'utf8')
  if (Buffer.byteLength(payload, 'utf8') > MAX_TRANSCRIPT_TEXT_BYTES) {
    throw new ArtifactStoreError(
      'validation_error',
      `Transcript exceeds maximum size of ${MAX_TRANSCRIPT_TEXT_BYTES} bytes.`
    )
  }
  return payload
}

function normalizeEvent({
  provider,
  row,
  index,
  sessionId,
  flowId,
  phaseId,
  input
}: {
  provider: SessionProvider
  row: unknown
  index: number
  sessionId: string
  flowId: string
  phaseId: string
  input: SessionIngestInput
}): NormalizedTranscriptEvent {
  if (!isRecord(row)) {
    throw new ArtifactStoreError('validation_error', 'Transcript events must be JSON objects.')
  }
  const textValue = firstText(row.content, row.message, row.text)
  const { text, truncated, originalBytes } = truncateUtf8(textValue ?? '')
  const timestamp = firstString(row.timestamp, row.created_at, row.time)
  const type = firstString(row.type, row.event, row.kind) ?? 'message'
  const role = firstString(row.role)
  const actor = firstString(row.actor, row.name)
  const eventId = firstString(row.id, row.event_id) ?? createEventId({
    provider,
    sessionId,
    sourcePath: input.sourcePath,
    index,
    timestamp,
    role,
    actor,
    type,
    text
  })

  return withoutUndefined({
    event_id: eventId,
    provider,
    session_id: sessionId,
    flow_id: flowId,
    phase_id: phaseId,
    launch_id: input.launchId,
    repo_path: input.repoPath,
    worktree_path: input.worktreePath,
    branch: input.branch,
    commit: input.commit,
    source_ordinal: index,
    timestamp,
    type,
    role,
    actor,
    text,
    truncated: truncated ? true : undefined,
    original_bytes: originalBytes
  })
}

function parseJsonLines(payload: string, label: string): Record<string, unknown>[] {
  return payload
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => parseJsonObject(line, label))
}

function parseJsonObject(payload: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(payload)
    if (!isRecord(value)) {
      throw new Error('expected object')
    }
    return value
  } catch (error) {
    throw new ArtifactStoreError('validation_error', `Malformed ${label} payload: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

function resolveSessionId(
  provider: SessionProvider,
  launchId: string | undefined,
  source: string | undefined,
  rows: unknown[]
): string {
  const sessionIds = new Set<string>()
  for (const row of rows) {
    if (isRecord(row)) {
      const sessionId = firstString(row.session_id, row.sessionId)
      if (sessionId !== undefined) {
        sessionIds.add(sessionId)
      }
    }
  }
  if (sessionIds.size > 1) {
    throw new ArtifactStoreError('validation_error', 'Conflicting session ids in transcript payload.')
  }
  return [...sessionIds][0] ?? deterministicSessionId(provider, launchId, source)
}

function deterministicSessionId(provider: string, launchId: string | undefined, source: string | undefined): string {
  const hash = createHash('sha256')
    .update(`${provider}\0${launchId ?? ''}\0${source ?? 'stdin'}`)
    .digest('hex')
    .slice(0, 16)
  return `${provider}-${hash}`
}

function createEventId(input: {
  provider: SessionProvider
  sessionId: string
  sourcePath?: string
  index: number
  timestamp?: string
  role?: string
  actor?: string
  type: string
  text: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 32)
}

function truncateUtf8(text: string): { text: string; truncated: boolean; originalBytes?: number } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= MAX_EVENT_TEXT_BYTES) {
    return { text, truncated: false }
  }
  return {
    text: Buffer.from(text, 'utf8').subarray(0, MAX_EVENT_TEXT_BYTES).toString('utf8'),
    truncated: true,
    originalBytes: bytes
  }
}

function enforceTranscriptLimit(events: NormalizedTranscriptEvent[]): {
  events: NormalizedTranscriptEvent[]
  truncated: boolean
} {
  let bytes = 0
  const kept: NormalizedTranscriptEvent[] = []
  for (const event of events) {
    const nextBytes = Buffer.byteLength(event.text, 'utf8')
    if (bytes + nextBytes > MAX_TRANSCRIPT_TEXT_BYTES) {
      return { events: kept, truncated: true }
    }
    bytes += nextBytes
    kept.push(event)
  }
  return { events: kept, truncated: false }
}

function mergeEvents(
  existing: NormalizedTranscriptEvent[],
  incoming: NormalizedTranscriptEvent[]
): NormalizedTranscriptEvent[] {
  const events = new Map<string, NormalizedTranscriptEvent>()
  for (const event of [...existing, ...incoming]) {
    events.set(event.event_id, event)
  }
  return [...events.values()].sort((left, right) => left.source_ordinal - right.source_ordinal)
}

async function readExistingSession(
  metadataPath: string,
  transcriptPath: string,
  provider: SessionProvider,
  sessionId: string
): Promise<SessionIngestResult | undefined> {
  let metadata: NormalizedSessionMetadata
  try {
    metadata = await readJsonArtifact(
      metadataPath,
      sessionId,
      isNormalizedSessionMetadata
    )
  } catch (error) {
    if (error instanceof ArtifactStoreError && error.code === 'not_found') {
      return undefined
    }
    throw error
  }

  if (metadata.provider !== provider || metadata.session_id !== sessionId) {
    throw new ArtifactStoreError(
      'validation_error',
      'Stored session metadata does not match its provider/session path.',
      sessionId
    )
  }

  const events = parseJsonLines(await readTextArtifact(transcriptPath, sessionId), 'stored transcript')
    .filter(isNormalizedTranscriptEvent)
  return { metadata, events }
}

async function readLaunchMetadata(
  artifactRoot: string,
  launchId: string | undefined
): Promise<{
  launchId?: string
  flowId?: string
  phaseId?: string
  repoPath?: string
  worktreePath?: string
  branch?: string
  commit?: string
}> {
  if (launchId === undefined) {
    return {}
  }
  assertSafeArtifactId('launch', launchId)
  try {
    const metadata = await readJsonArtifact(
      join(artifactRoot, 'launches', launchId, 'meta.json'),
      launchId,
      isRecord
    )
    return {
      launchId,
      flowId: firstString(metadata.flow_id, metadata.flowId),
      phaseId: firstString(metadata.phase_id, metadata.phaseId),
      repoPath: firstString(metadata.repo_path, metadata.repoPath),
      worktreePath: firstString(metadata.worktree_path, metadata.worktreePath),
      branch: firstString(metadata.branch),
      commit: firstString(metadata.commit)
    }
  } catch {
    return { launchId }
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value !== '')
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = extractText(value)
    if (text !== undefined && text !== '') {
      return text
    }
  }
  return undefined
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => extractText(item))
      .filter((text): text is string => text !== undefined && text !== '')
    return parts.length === 0 ? undefined : parts.join('\n')
  }

  if (isRecord(value)) {
    return firstText(value.text, value.content, value.message)
  }

  return undefined
}

function isNormalizedSessionMetadata(value: unknown): value is NormalizedSessionMetadata {
  return isRecord(value) &&
    value.schema_version === 1 &&
    (value.provider === 'codex' || value.provider === 'claude') &&
    typeof value.session_id === 'string' &&
    typeof value.flow_id === 'string' &&
    typeof value.phase_id === 'string' &&
    typeof value.transcript_path === 'string'
}

function isNormalizedTranscriptEvent(value: unknown): value is NormalizedTranscriptEvent {
  return isRecord(value) &&
    typeof value.event_id === 'string' &&
    typeof value.session_id === 'string' &&
    typeof value.flow_id === 'string' &&
    typeof value.phase_id === 'string' &&
    typeof value.text === 'string' &&
    typeof value.source_ordinal === 'number'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined)
  ) as T
}
