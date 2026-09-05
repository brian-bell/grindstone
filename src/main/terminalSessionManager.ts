import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { chmodSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as nodePty from 'node-pty'
import { RECENT_TERMINAL_OUTPUT_LIMIT } from '@shared/workspace'
import type {
  AgentLaunchMode,
  AgentProvider,
  FlowListRow,
  FlowTerminalSummary,
  TerminalActionRequest,
  TerminalEvent,
  TerminalInputRequest,
  TerminalListRequest,
  TerminalResizeRequest
} from '@shared/workspace'
import { buildAgentLaunchCommand } from './agentLaunch'
import { writeJsonAtomically } from './artifactStore'
import { toRawTerminal, type FlowStore } from './flowStore'
import { runExclusiveFlowMutation } from './flowMutationQueue'
import { createFlowOperations } from './flowOperations'

type Disposable = {
  dispose: () => void
}

export type PtyProcess = {
  onData: (handler: (data: string) => void) => Disposable
  onExit: (handler: (event: { exitCode: number; signal?: string | number }) => void) => Disposable
  write: (data: string) => void
  resize: (columns: number, rows: number) => void
  kill: (signal?: string) => void
}

export type PtyAdapter = {
  spawn: (
    command: string,
    args: string[],
    options: {
      cwd: string
      env: Record<string, string>
      columns: number
      rows: number
    }
  ) => PtyProcess
}

export type LaunchTerminalRequest = {
  flow: FlowListRow
  provider: AgentProvider
  mode: AgentLaunchMode
  phaseId: string
  prompt: string
  launchId?: string
  sessionId?: string
}

type ManagedTerminal = {
  flow: FlowListRow
  process: PtyProcess | null
  terminal: FlowTerminalSummary
  terminateTimer: NodeJS.Timeout | null
  outputQueue: Promise<void>
}

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const requireFromHere = createRequire(import.meta.url)

export const nodePtyAdapter: PtyAdapter = {
  spawn(command, args, options) {
    ensureNodePtySpawnHelperExecutable()
    return nodePty.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      cols: options.columns,
      rows: options.rows
    })
  }
}

type NodePtySpawnHelperRepairOptions = {
  platform?: NodeJS.Platform | string
  arch?: string
  loadedNativeModulePaths?: string[]
  nodePtyLibRoot?: string
  stat?: typeof statSync
  chmod?: typeof chmodSync
  requireNative?: (nativePath: string) => unknown
}

export function ensureNodePtySpawnHelperExecutable(options: NodePtySpawnHelperRepairOptions = {}): void {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    return
  }

  const helperPath = resolveNodePtySpawnHelperPath(options)
  if (helperPath === undefined) {
    return
  }

  try {
    const stat = options.stat ?? statSync
    const chmod = options.chmod ?? chmodSync
    const mode = stat(helperPath).mode
    if ((mode & 0o111) === 0) {
      chmod(helperPath, mode | 0o111)
    }
  } catch {
    // Let node-pty surface the real spawn failure if the helper cannot be repaired.
  }
}

function resolveNodePtySpawnHelperPath(options: NodePtySpawnHelperRepairOptions): string | undefined {
  const loadedNativePath = nodePtyLoadedNativeModulePaths(options)
    .find((nativePath) => isLocalNodePtyNativePath(nativePath, options))
  if (loadedNativePath !== undefined) {
    return spawnHelperPathForNativeModule(loadedNativePath)
  }

  for (const nativePath of nodePtyNativeModuleCandidates(options)) {
    if (canLoadNativeModule(nativePath, options.requireNative)) {
      return spawnHelperPathForNativeModule(nativePath)
    }
  }

  return undefined
}

function nodePtyLoadedNativeModulePaths(options: NodePtySpawnHelperRepairOptions): string[] {
  if (options.loadedNativeModulePaths !== undefined) {
    return options.loadedNativeModulePaths
  }

  return Object.keys(requireFromHere.cache).filter(isNodePtyPtyNativePath)
}

function nodePtyNativeModuleCandidates(options: NodePtySpawnHelperRepairOptions): string[] {
  const nodePtyLibRoot = resolveNodePtyLibRoot(options)
  if (nodePtyLibRoot === undefined) {
    return []
  }

  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const dirs = [
    join('build', 'Release'),
    join('build', 'Debug'),
    join('prebuilds', `${platform}-${arch}`)
  ]
  const relativeRoots = ['..', '.']

  return [...new Set(dirs.flatMap((dir) =>
    relativeRoots.map((relativeRoot) => join(nodePtyLibRoot, relativeRoot, dir, 'pty.node'))
  ))]
}

function canLoadNativeModule(
  nativePath: string,
  requireNative: (nativePath: string) => unknown = requireFromHere
): boolean {
  try {
    requireNative(nativePath)
    return true
  } catch {
    return false
  }
}

function isNodePtyPtyNativePath(nativePath: string): boolean {
  return getNodePtyPackageRootForNativeModule(nativePath) !== undefined
}

function isLocalNodePtyNativePath(nativePath: string, options: NodePtySpawnHelperRepairOptions): boolean {
  const packageRoot = getNodePtyPackageRootForNativeModule(nativePath)
  const resolvedPackageRoot = resolveNodePtyPackageRoot(options)
  if (packageRoot === undefined || resolvedPackageRoot === undefined) {
    return false
  }

  return normalizeAsarEquivalentPath(packageRoot) === normalizeAsarEquivalentPath(resolvedPackageRoot)
}

function resolveNodePtyPackageRoot(options: NodePtySpawnHelperRepairOptions): string | undefined {
  const nodePtyLibRoot = resolveNodePtyLibRoot(options)
  return nodePtyLibRoot === undefined ? undefined : dirname(nodePtyLibRoot)
}

function resolveNodePtyLibRoot(options: NodePtySpawnHelperRepairOptions): string | undefined {
  try {
    return options.nodePtyLibRoot ?? dirname(requireFromHere.resolve('node-pty/lib/index.js'))
  } catch {
    return undefined
  }
}

function getNodePtyPackageRootForNativeModule(nativePath: string): string | undefined {
  const normalizedPath = nativePath.replaceAll('\\', '/')
  const match = normalizedPath.match(/^(.*\/node-pty)\/(?:build\/(?:Release|Debug)|prebuilds\/[^/]+)\/pty\.node$/)
  return match?.[1]
}

function spawnHelperPathForNativeModule(nativePath: string): string {
  return unpackAsarPath(join(dirname(nativePath), 'spawn-helper'))
}

function unpackAsarPath(pathValue: string): string {
  return pathValue
    .replace(/(^|[/\\])app\.asar(?=$|[/\\])/g, '$1app.asar.unpacked')
    .replace(/(^|[/\\])node_modules\.asar(?=$|[/\\])/g, '$1node_modules.asar.unpacked')
}

function normalizeAsarEquivalentPath(pathValue: string): string {
  return pathValue
    .replaceAll('\\', '/')
    .replace(/(^|\/)app\.asar\.unpacked(?=$|\/)/g, '$1app.asar')
    .replace(/(^|\/)node_modules\.asar\.unpacked(?=$|\/)/g, '$1node_modules.asar')
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, ManagedTerminal>()

  constructor(
    private readonly options: {
      artifactRoot: string
      store: FlowStore
      pty?: PtyAdapter
      now?: () => string
      idFactory?: () => string
      onEvent?: (event: TerminalEvent) => void
      env?: NodeJS.ProcessEnv
      terminateGraceMs?: number
    }
  ) {}

  async launchTerminal(request: LaunchTerminalRequest): Promise<FlowTerminalSummary> {
    const launchMetadata = resolveLaunchMetadata(request.flow)
    if (launchMetadata === undefined) {
      throw new Error('Flow start metadata is required before launching a terminal.')
    }

    const terminalId = this.createId()
    const launchId = request.launchId ?? this.createId()
    const terminalDir = join(
      this.options.artifactRoot,
      'flows',
      request.flow.id,
      'terminals',
      terminalId
    )
    const logPath = join(terminalDir, 'raw.log')
    const metaPath = join(terminalDir, 'meta.json')
    await mkdir(terminalDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })

    const launchCommand = buildAgentLaunchCommand({
      provider: request.provider,
      mode: request.mode,
      flowId: request.flow.id,
      phaseId: request.phaseId,
      planId: request.flow.planId,
      planPath: request.flow.planPath,
      sessionId: request.sessionId,
      launchId,
      prompt: request.prompt,
      repositoryPath: launchMetadata.repositoryPath,
      worktreePath: launchMetadata.worktreePath,
      branch: launchMetadata.branch,
      commit: launchMetadata.commit,
      artifactRoots: {
        flowStateRoot: this.options.artifactRoot,
        planStateRoot: this.options.artifactRoot,
        sessionStateRoot: this.options.artifactRoot
      }
    })

    const terminal: FlowTerminalSummary = {
      terminalId,
      launchId,
      provider: request.provider,
      mode: request.mode,
      flowId: request.flow.id,
      phaseId: request.phaseId,
      planId: request.flow.planId,
      sessionId: request.sessionId,
      status: 'starting',
      command: launchCommand.executable,
      argv: launchCommand.argv,
      cwd: launchCommand.cwd,
      logPath,
      startedAt: this.now(),
      recentOutput: ''
    }

    await writeFile(logPath, '', { flag: 'a', mode: PRIVATE_FILE_MODE })
    await this.writeTerminalMetadata(metaPath, terminal)

    let spawnedProcess: PtyProcess | undefined
    let managedTerminal: ManagedTerminal | undefined
    try {
      const ptyProcess = (this.options.pty ?? nodePtyAdapter).spawn(
        launchCommand.executable,
        launchCommand.argv,
        {
          cwd: launchCommand.cwd,
          env: buildTerminalSpawnEnv(this.options.env ?? process.env, launchCommand.env),
          columns: 100,
          rows: 30
        }
      )
      spawnedProcess = ptyProcess
      const managed: ManagedTerminal = {
        flow: request.flow,
        process: ptyProcess,
        terminal: {
          ...terminal,
          status: 'running'
        },
        terminateTimer: null,
        outputQueue: Promise.resolve()
      }
      managedTerminal = managed
      this.sessions.set(terminalId, managed)
      ptyProcess.onData((data) => {
        managed.outputQueue = managed.outputQueue
          .then(() => this.handleData(managed, data, metaPath))
          .catch(() => undefined)
      })
      ptyProcess.onExit((event) => {
        managed.outputQueue = managed.outputQueue
          .then(() => this.handleExit(managed, event, metaPath))
          .catch(() => undefined)
      })
      const initialPersist = managed.outputQueue.then(async () => {
        await this.writeTerminalMetadata(metaPath, managed.terminal)
        this.emitState(managed)
      })
      managed.outputQueue = initialPersist.catch(() => undefined)
      await initialPersist
      return managed.terminal
    } catch (error) {
      if (spawnedProcess !== undefined) {
        spawnedProcess.kill('SIGTERM')
      }
      if (managedTerminal !== undefined) {
        managedTerminal.process = null
        if (managedTerminal.terminateTimer !== null) {
          clearTimeout(managedTerminal.terminateTimer)
          managedTerminal.terminateTimer = null
        }
      }
      this.sessions.delete(terminalId)
      const failed = {
        ...terminal,
        status: 'failed' as const,
        endedAt: this.now()
      }
      await this.writeTerminalMetadata(metaPath, failed)
      throw error
    }
  }

  async listTerminals(request: TerminalListRequest): Promise<FlowTerminalSummary[]> {
    const flow = await this.getOwnedFlow(request.repositoryId, request.flowId)
    return this.reconcilePersistedTerminals(flow)
  }

  async writeInput(request: TerminalInputRequest): Promise<FlowTerminalSummary> {
    const managed = await this.getAttachedTerminal(request)
    if (managed.terminal.status !== 'running') {
      throw new Error(`Terminal is not running: ${request.terminalId}`)
    }

    managed.process?.write(request.data)
    return managed.terminal
  }

  async resize(request: TerminalResizeRequest): Promise<FlowTerminalSummary> {
    const managed = await this.getAttachedTerminal(request)
    if (managed.terminal.status !== 'running') {
      throw new Error(`Terminal is not running: ${request.terminalId}`)
    }
    if (!Number.isInteger(request.columns) || request.columns <= 0 || !Number.isInteger(request.rows) || request.rows <= 0) {
      throw new Error('Terminal resize dimensions must be positive integers.')
    }

    managed.process?.resize(request.columns, request.rows)
    return managed.terminal
  }

  async terminate(request: TerminalActionRequest): Promise<FlowTerminalSummary> {
    const managed = await this.getAttachedTerminal(request)
    if (managed.terminal.status !== 'running') {
      throw new Error(`Terminal is not running: ${request.terminalId}`)
    }

    managed.process?.kill('SIGTERM')
    managed.terminateTimer = setTimeout(() => {
      managed.process?.kill('SIGKILL')
    }, this.options.terminateGraceMs ?? 1_000)
    return managed.terminal
  }

  async dismiss(request: TerminalActionRequest): Promise<FlowTerminalSummary> {
    const { flow, terminal } = await this.getOwnedPersistedTerminal(request)
    if (!['exited', 'terminated', 'failed'].includes(terminal.status)) {
      throw new Error(`Only completed terminals can be dismissed: ${request.terminalId}`)
    }

    const dismissed = {
      ...terminal,
      status: 'dismissed' as const
    }
    const metaPath = this.getMetaPath(dismissed)
    await this.writeTerminalMetadata(metaPath, dismissed)

    const managed = this.sessions.get(request.terminalId)
    if (managed !== undefined && managed.terminal.flowId === flow.id) {
      managed.terminal = dismissed
      this.emitState(managed)
    } else {
      this.options.onEvent?.({
        type: 'state',
        repositoryId: flow.repositoryId,
        flowId: dismissed.flowId,
        terminal: dismissed
      })
    }

    return dismissed
  }

  private async handleData(
    managed: ManagedTerminal,
    data: string,
    metaPath: string
  ): Promise<void> {
    managed.terminal = {
      ...managed.terminal,
      recentOutput: trimRecentOutput(`${managed.terminal.recentOutput ?? ''}${data}`)
    }
    await appendFile(managed.terminal.logPath ?? '', data, 'utf8')
    await this.writeTerminalMetadata(metaPath, managed.terminal)
    this.options.onEvent?.({
      type: 'output',
      repositoryId: managed.flow.repositoryId,
      flowId: managed.terminal.flowId,
      terminalId: managed.terminal.terminalId,
      data
    })
  }

  private async handleExit(
    managed: ManagedTerminal,
    event: { exitCode: number; signal?: string | number },
    metaPath: string
  ): Promise<void> {
    if (managed.terminateTimer !== null) {
      clearTimeout(managed.terminateTimer)
      managed.terminateTimer = null
    }

    const signal = event.signal === undefined ? undefined : String(event.signal)
    managed.terminal = {
      ...managed.terminal,
      status: isTerminationSignal(signal)
        ? 'terminated'
        : event.exitCode === 0
          ? 'exited'
          : 'failed',
      endedAt: this.now(),
      exitCode: event.exitCode,
      signal
    }
    managed.process = null
    await this.writeTerminalMetadata(metaPath, managed.terminal)
    if (managed.terminal.status === 'failed' || managed.terminal.status === 'terminated') {
      await this.markUnsuccessfulPhaseNeedsAttention(managed.terminal)
    }
    this.emitState(managed)
  }

  private async markUnsuccessfulPhaseNeedsAttention(terminal: FlowTerminalSummary): Promise<void> {
    if (terminal.mode !== 'headless') {
      return
    }

    await runExclusiveFlowMutation(terminal.flowId, async () => {
      const flowOperations = createFlowOperations({ artifactRoot: this.options.artifactRoot })
      await flowOperations.needsAttentionPhaseIfCurrent(
        {
          flowId: terminal.flowId,
          phaseId: terminal.phaseId,
          launchId: terminal.launchId,
          notes: `Phase terminal failed: ${formatTerminalFailure(terminal)}.`
        },
        {
          status: 'running',
          launchId: terminal.launchId
        }
      )
    })
  }

  private async getAttachedTerminal(request: TerminalActionRequest): Promise<ManagedTerminal> {
    const flow = await this.getOwnedFlow(request.repositoryId, request.flowId)
    const managed = this.sessions.get(request.terminalId)
    if (managed === undefined || managed.terminal.flowId !== flow.id) {
      throw new Error(`Terminal is not attached to a running process: ${request.terminalId}`)
    }

    return managed
  }

  private async getOwnedPersistedTerminal(
    request: TerminalActionRequest
  ): Promise<{ flow: FlowListRow; terminal: FlowTerminalSummary }> {
    const flow = await this.getOwnedFlow(request.repositoryId, request.flowId)
    const terminal = flow.terminals?.find((candidate) =>
      candidate.terminalId === request.terminalId
    )
    if (terminal === undefined) {
      throw new Error(`Terminal not found: ${request.terminalId}`)
    }

    return { flow, terminal }
  }

  private async getOwnedFlow(repositoryId: string, flowId: string): Promise<FlowListRow> {
    const flow = await this.options.store.readFlow(flowId)
    if (flow === undefined || flow.repositoryId !== repositoryId) {
      throw new Error(`Flow not found for repository: ${flowId}`)
    }

    return flow
  }

  private async reconcilePersistedTerminals(flow: FlowListRow): Promise<FlowTerminalSummary[]> {
    const terminals = flow.terminals ?? []
    const reconciled = terminals.map((terminal) => {
      if (
        (terminal.status === 'starting' || terminal.status === 'running') &&
        !this.sessions.has(terminal.terminalId)
      ) {
        return {
          ...terminal,
          status: 'failed' as const,
          endedAt: terminal.endedAt ?? this.now()
        }
      }

      return terminal
    })

    const changedTerminals = reconciled.filter((terminal, index) => terminal !== terminals[index])
    if (changedTerminals.length > 0) {
      await Promise.all(
        changedTerminals.map((terminal) => this.writeTerminalMetadata(this.getMetaPath(terminal), terminal))
      )
      for (const terminal of changedTerminals) {
        await this.markUnsuccessfulPhaseNeedsAttention(terminal)
      }
    }

    return reconciled
  }

  private async writeTerminalMetadata(
    metaPath: string,
    terminal: FlowTerminalSummary
  ): Promise<void> {
    await mkdir(dirname(metaPath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    await writeJsonAtomically(metaPath, toRawTerminal(terminal))
  }

  private emitState(managed: ManagedTerminal): void {
    this.options.onEvent?.({
      type: 'state',
      repositoryId: managed.flow.repositoryId,
      flowId: managed.terminal.flowId,
      terminal: managed.terminal
    })
  }

  private getMetaPath(terminal: FlowTerminalSummary): string {
    return join(
      this.options.artifactRoot,
      'flows',
      terminal.flowId,
      'terminals',
      terminal.terminalId,
      'meta.json'
    )
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private createId(): string {
    return this.options.idFactory?.() ?? randomUUID()
  }
}

function processEnvToRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] =>
      entry[1] !== undefined
    )
  )
}

function buildTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  launchEnv: Record<string, string>
): Record<string, string> {
  const normalizedBaseEnv = processEnvToRecord(baseEnv)
  if (process.platform === 'win32') {
    return {
      ...normalizedBaseEnv,
      ...launchEnv
    }
  }

  return {
    ...normalizedBaseEnv,
    PATH: buildTerminalPath(normalizedBaseEnv),
    ...launchEnv
  }
}

function buildTerminalPath(env: Record<string, string>): string {
  const entries = [
    ...agentExecutablePathAdditions(env),
    ...(env.PATH ?? '').split(delimiter)
  ].filter((entry) => entry.trim() !== '')

  return [...new Set(entries)].join(delimiter)
}

function agentExecutablePathAdditions(env: Record<string, string>): string[] {
  const homeDirectory = env.HOME ?? homedir()
  if (process.platform === 'darwin') {
    return [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(homeDirectory, '.local', 'bin')
    ]
  }

  return [join(homeDirectory, '.local', 'bin')]
}

function resolveLaunchMetadata(flow: FlowListRow): {
  repositoryPath: string
  worktreePath: string
  branch: string
  commit: string
} | undefined {
  const repositoryPath = flow.start?.repositoryPath ?? flow.repositoryPath
  const worktreePath = flow.start?.worktreePath ?? flow.worktreePath
  if (isBlank(repositoryPath) || isBlank(worktreePath)) {
    return undefined
  }

  return {
    repositoryPath,
    worktreePath,
    branch: flow.start?.branch ?? flow.branch ?? '',
    commit: flow.start?.commit ?? flow.commit ?? ''
  }
}

function isBlank(value: string | undefined): value is undefined {
  return value === undefined || value.trim() === ''
}

function trimRecentOutput(output: string): string {
  return output.length <= RECENT_TERMINAL_OUTPUT_LIMIT
    ? output
    : output.slice(output.length - RECENT_TERMINAL_OUTPUT_LIMIT)
}

function isTerminationSignal(signal: string | undefined): boolean {
  return signal === 'SIGTERM' || signal === 'SIGKILL' || signal === '15' || signal === '9'
}

function formatTerminalFailure(terminal: FlowTerminalSummary): string {
  if (terminal.signal !== undefined) {
    return `${terminal.provider} exited after signal ${terminal.signal}`
  }
  if (terminal.exitCode !== undefined) {
    return `${terminal.provider} exited with status ${terminal.exitCode}`
  }
  return `${terminal.provider} exited unsuccessfully`
}
