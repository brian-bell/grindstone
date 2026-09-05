import { Maximize2, Square, X } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement
} from 'react'
import type { FlowListRow, FlowTerminalSummary, TerminalActionRequest } from '@shared/workspace'
import { getTerminalOutputAppend } from '../utils/terminalOutput'

export function FlowTerminalTabs({ flow }: { flow: FlowListRow }): ReactElement {
  const visibleTerminals = (flow.terminals ?? []).filter((terminal) => terminal.status !== 'dismissed')
  const [activeTerminalId, setActiveTerminalId] = useState(visibleTerminals[0]?.terminalId ?? '')
  const [input, setInput] = useState('')
  const [terminalSize, setTerminalSize] = useState<{ columns: number; rows: number } | null>(null)
  const activeTerminal = visibleTerminals.find((terminal) =>
    terminal.terminalId === activeTerminalId
  ) ?? visibleTerminals[0]

  useEffect(() => {
    if (!visibleTerminals.some((terminal) => terminal.terminalId === activeTerminalId)) {
      setActiveTerminalId(visibleTerminals[0]?.terminalId ?? '')
    }
  }, [activeTerminalId, visibleTerminals])

  useEffect(() => {
    setTerminalSize(null)
  }, [activeTerminal?.terminalId])

  if (activeTerminal === undefined) {
    return (
      <div className="terminal-panel" aria-label={`${flow.title} terminal sessions`}>
        <span className="terminal-empty">No visible terminal sessions</span>
      </div>
    )
  }

  const terminalRequest = {
    repositoryId: flow.repositoryId,
    flowId: flow.id,
    terminalId: activeTerminal.terminalId
  }
  const canWrite = activeTerminal.status === 'running'
  const canDismiss = ['exited', 'terminated', 'failed'].includes(activeTerminal.status)

  async function sendInput(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!canWrite || input === '') {
      return
    }

    await window.grindstone.workspace.writeTerminalInput({
      ...terminalRequest,
      data: input
    })
    setInput('')
  }

  async function requestResize(): Promise<void> {
    if (!canWrite || terminalSize === null) {
      return
    }

    await window.grindstone.workspace.resizeTerminal({
      ...terminalRequest,
      columns: terminalSize.columns,
      rows: terminalSize.rows
    })
  }

  async function requestTerminate(): Promise<void> {
    if (!canWrite || !window.confirm(`Terminate ${activeTerminal.provider} terminal?`)) {
      return
    }

    await window.grindstone.workspace.terminateTerminal(terminalRequest)
  }

  async function requestDismiss(): Promise<void> {
    if (!canDismiss) {
      return
    }

    await window.grindstone.workspace.dismissTerminal(terminalRequest)
  }

  return (
    <section className="terminal-panel" aria-label={`${flow.title} terminal sessions`}>
      <div className="terminal-tabs" role="tablist" aria-label={`${flow.title} terminals`}>
        {visibleTerminals.map((terminal) => (
          <button
            aria-label={`${terminal.phaseId} ${terminal.status}`}
            aria-selected={terminal.terminalId === activeTerminal.terminalId}
            className="terminal-tab"
            key={terminal.terminalId}
            onClick={() => setActiveTerminalId(terminal.terminalId)}
            role="tab"
            type="button"
          >
            <span>{terminal.phaseId}</span>
            <span className={`terminal-status terminal-status-${terminal.status}`}>
              {terminal.status}
            </span>
          </button>
        ))}
      </div>

      <div className="terminal-toolbar">
        <span className="terminal-command">
          {activeTerminal.provider} {activeTerminal.argv.join(' ')}
        </span>
        {activeTerminal.logPath === undefined ? null : (
          <span className="terminal-log-marker">Fallback log ready</span>
        )}
        <button
          aria-label={`Resize ${activeTerminal.phaseId} terminal`}
          className="icon-action"
          disabled={!canWrite || terminalSize === null}
          onClick={() => void requestResize()}
          title={`Resize ${activeTerminal.phaseId} terminal`}
          type="button"
        >
          <Maximize2 aria-hidden="true" size={14} />
        </button>
        <button
          aria-label={`Terminate ${activeTerminal.phaseId} terminal`}
          className="icon-action"
          disabled={!canWrite}
          onClick={() => void requestTerminate()}
          title={`Terminate ${activeTerminal.phaseId} terminal`}
          type="button"
        >
          <Square aria-hidden="true" size={14} />
        </button>
        <button
          aria-label={`Dismiss ${activeTerminal.phaseId} terminal`}
          className="icon-action"
          disabled={!canDismiss}
          onClick={() => void requestDismiss()}
          title={`Dismiss ${activeTerminal.phaseId} terminal`}
          type="button"
        >
          <X aria-hidden="true" size={14} />
        </button>
      </div>

      <TerminalOutput
        canWrite={canWrite}
        onMeasuredSize={setTerminalSize}
        terminal={activeTerminal}
        terminalRequest={terminalRequest}
      />

      <form
        aria-label={`${activeTerminal.phaseId} terminal input`}
        className="terminal-input-form"
        onSubmit={(event) => void sendInput(event)}
      >
        <input
          aria-label={`${activeTerminal.phaseId} terminal input text`}
          disabled={!canWrite}
          onChange={(event) => setInput(event.currentTarget.value)}
          value={input}
        />
        <button className="secondary-button" disabled={!canWrite || input === ''} type="submit">
          <span>Send</span>
        </button>
      </form>
    </section>
  )
}

function TerminalOutput({
  canWrite,
  onMeasuredSize,
  terminal,
  terminalRequest
}: {
  canWrite: boolean
  onMeasuredSize: (size: { columns: number; rows: number }) => void
  terminal: FlowTerminalSummary
  terminalRequest: TerminalActionRequest
}): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const xtermRef = useRef<{
    terminalId: string
    write: (data: string) => void
  } | null>(null)
  const writtenOutputRef = useRef('')
  const output = terminal.recentOutput ?? ''
  const latestOutputRef = useRef(output)
  latestOutputRef.current = output

  useEffect(() => {
    let disposed = false
    let disposeTerminal: (() => void) | undefined
    let resizeObserver: ResizeObserver | undefined

    async function sendTerminalInput(data: string): Promise<void> {
      if (!canWrite) {
        return
      }

      await window.grindstone.workspace.writeTerminalInput({
        ...terminalRequest,
        data
      })
    }

    async function mountXterm(): Promise<void> {
      if (
        containerRef.current === null ||
        (typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom'))
      ) {
        return
      }

      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit')
        ])
        if (disposed || containerRef.current === null) {
          return
        }

        const xterm = new Terminal({
          convertEol: true,
          disableStdin: !canWrite,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12,
          theme: {
            background: '#111318',
            foreground: '#e6edf3'
          }
        })
        const fit = new FitAddon()
        xterm.loadAddon(fit)
        xterm.open(containerRef.current)
        xtermRef.current = {
          terminalId: terminal.terminalId,
          write: (data) => xterm.write(data)
        }
        const mountedOutput = latestOutputRef.current
        xterm.write(mountedOutput)
        writtenOutputRef.current = mountedOutput
        const publishSize = () => {
          fit.fit()
          const dimensions = fit.proposeDimensions()
          if (dimensions !== undefined) {
            onMeasuredSize({
              columns: dimensions.cols,
              rows: dimensions.rows
            })
          }
        }
        const inputDisposable = canWrite
          ? xterm.onData((data) => {
              void sendTerminalInput(data)
            })
          : undefined
        publishSize()
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(publishSize)
          resizeObserver.observe(containerRef.current)
        }
        disposeTerminal = () => {
          inputDisposable?.dispose()
          resizeObserver?.disconnect()
          if (xtermRef.current?.terminalId === terminal.terminalId) {
            xtermRef.current = null
          }
          writtenOutputRef.current = ''
          xterm.dispose()
        }
      } catch {
        // The text fallback below remains authoritative for tests and accessibility.
      }
    }

    void mountXterm()

    return () => {
      disposed = true
      disposeTerminal?.()
    }
  }, [
    canWrite,
    onMeasuredSize,
    terminalRequest.flowId,
    terminalRequest.repositoryId,
    terminalRequest.terminalId,
    terminal.terminalId
  ])

  useEffect(() => {
    const xterm = xtermRef.current
    if (xterm === null || xterm.terminalId !== terminal.terminalId) {
      return
    }

    const nextChunk = getTerminalOutputAppend(writtenOutputRef.current, output)
    if (nextChunk !== '') {
      xterm.write(nextChunk)
    }
    writtenOutputRef.current = output
  }, [output, terminal.terminalId])

  return (
    <div className="terminal-output-wrap">
      <div ref={containerRef} className="terminal-xterm" aria-hidden="true" />
      <pre className="terminal-output" aria-label={`${terminal.phaseId} terminal output`}>
        {output === '' ? 'Terminal is waiting for output.' : output}
      </pre>
    </div>
  )
}
