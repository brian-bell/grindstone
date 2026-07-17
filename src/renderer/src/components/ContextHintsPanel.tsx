import {
  CirclePlus,
  PanelRightClose,
  RotateCcw,
  Sparkles
} from 'lucide-react'
import type { ReactElement, RefObject } from 'react'
import type { InitialWorkspaceState } from '@shared/workspace'
import { RIGHT_PANE_CONTENT_ID } from '../constants'

export function ContextHintsPanel({
  collapseButtonRef,
  workspace,
  onCollapse,
  onNewFlow
}: {
  collapseButtonRef: RefObject<HTMLButtonElement | null>
  workspace: InitialWorkspaceState
  onCollapse: () => void
  onNewFlow: () => void
}): ReactElement {
  return (
    <>
      <div className="pane-header">
        <Sparkles aria-hidden="true" size={18} />
        <h2 id="context-pane-title">Contextual Hints</h2>
        <button
          aria-controls={RIGHT_PANE_CONTENT_ID}
          aria-expanded="true"
          aria-label="Collapse right pane"
          className="icon-button context-toggle-button"
          ref={collapseButtonRef}
          title="Collapse right pane"
          type="button"
          onClick={onCollapse}
        >
          <PanelRightClose aria-hidden="true" size={16} />
        </button>
      </div>

      <div className="hint-list">
        {workspace.hints.map((hint) => (
          <article className="hint-row" key={hint.id}>
            <h3>{hint.title}</h3>
            <p>{hint.description}</p>
          </article>
        ))}
      </div>

      <div className="shortcut-list" aria-label="Flow shortcuts">
        {workspace.shortcuts.map((shortcut) => (
          <button
            className="shortcut-button"
            disabled={shortcut.disabled}
            key={shortcut.id}
            onClick={shortcut.id === 'new-flow' ? onNewFlow : undefined}
            title={shortcut.description}
            type="button"
          >
            {shortcut.id === 'new-flow' ? (
              <CirclePlus aria-hidden="true" size={16} />
            ) : (
              <RotateCcw aria-hidden="true" size={16} />
            )}
            <span>{shortcut.label}</span>
          </button>
        ))}
      </div>
    </>
  )
}
