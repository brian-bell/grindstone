import { CirclePlus, X } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import type {
  CreateFlowRequest,
  FlowPaneState,
  InitialWorkspaceState
} from '@shared/workspace'
import { getErrorMessage } from '../utils/errors'

export function FlowCreatePanel({
  create,
  openRequest,
  onWorkspaceUpdate
}: {
  create: NonNullable<Extract<FlowPaneState, { status: 'ready' | 'empty' }>['create']>
  openRequest: number
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const newFlowButtonRef = useRef<HTMLButtonElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const shouldRestoreFocusRef = useRef(false)
  const lastOpenRequestRef = useRef(openRequest)

  useEffect(() => {
    if (isOpen) {
      titleInputRef.current?.focus()
      return
    }

    if (shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false
      newFlowButtonRef.current?.focus()
    }
  }, [isOpen])

  useEffect(() => {
    if (openRequest === lastOpenRequestRef.current) {
      return
    }
    lastOpenRequestRef.current = openRequest
    if (create.available) {
      shouldRestoreFocusRef.current = false
      setIsOpen(true)
    }
  }, [create.available, openRequest])

  function openFlowDialog(): void {
    shouldRestoreFocusRef.current = false
    setIsOpen(true)
  }

  function closeFlowDialog(): void {
    shouldRestoreFocusRef.current = true
    setIsOpen(false)
  }

  function focusFirstDialogElement(): void {
    titleInputRef.current?.focus()
  }

  function focusLastDialogElement(): void {
    closeButtonRef.current?.focus()
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeFlowDialog()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const firstElement = titleInputRef.current
    const lastElement = closeButtonRef.current

    if (firstElement === null || lastElement === null) {
      event.preventDefault()
      return
    }

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      focusLastDialogElement()
      return
    }

    if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      focusFirstDialogElement()
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const request: CreateFlowRequest = {
      title: title.trim(),
      instructions: instructions.trim(),
      baseRef: baseRef.trim() === '' ? undefined : baseRef.trim()
    }

    if (request.title === '') {
      setLocalError('Flow title is required.')
      return
    }

    if (request.instructions === '') {
      setLocalError('Flow instructions are required.')
      return
    }

    setLocalError(null)
    setIsSubmitting(true)
    try {
      const nextWorkspace = await window.grindstone.workspace.createFlow(request)
      onWorkspaceUpdate(nextWorkspace)
      if (
        (nextWorkspace.flow.status === 'ready' || nextWorkspace.flow.status === 'empty') &&
        nextWorkspace.flow.create?.error === null
      ) {
        setTitle('')
        setInstructions('')
        setBaseRef('')
        closeFlowDialog()
      }
    } catch (error: unknown) {
      setLocalError(getErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  const errorMessage = localError ?? create.error?.message ?? null

  return (
    <div className="flow-create">
      <button
        className="primary-action"
        disabled={!create.available}
        onClick={openFlowDialog}
        ref={newFlowButtonRef}
        type="button"
      >
        <CirclePlus aria-hidden="true" size={16} />
        <span>New Flow</span>
      </button>

      {isOpen ? (
        <div className="modal-backdrop">
          <div
            aria-labelledby="flow-create-dialog-title"
            aria-modal="true"
            className="modal-dialog"
            onKeyDown={handleDialogKeyDown}
            role="dialog"
          >
            <span
              className="focus-sentinel"
              data-focus-sentinel="true"
              onFocus={focusLastDialogElement}
              tabIndex={0}
            />
            <div className="modal-header">
              <h2 id="flow-create-dialog-title">Create Flow</h2>
            </div>

            <form
              aria-label="Create Flow"
              className="flow-create-form"
              onSubmit={(event) => void handleSubmit(event)}
            >
              <label className="field">
                <span>Title</span>
                <input
                  disabled={!create.available || isSubmitting}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  placeholder="Ship workspace creation"
                  ref={titleInputRef}
                  value={title}
                />
              </label>
              <label className="field">
                <span>Instructions</span>
                <textarea
                  disabled={!create.available || isSubmitting}
                  onChange={(event) => setInstructions(event.currentTarget.value)}
                  placeholder="Describe the implementation goal"
                  value={instructions}
                />
              </label>
              <label className="field">
                <span>Base ref</span>
                <input
                  disabled={!create.available || isSubmitting}
                  onChange={(event) => setBaseRef(event.currentTarget.value)}
                  placeholder="HEAD"
                  value={baseRef}
                />
              </label>

              {errorMessage === null ? null : (
                <div
                  aria-label="Flow creation error"
                  className="create-error"
                  role="alert"
                >
                  {errorMessage}
                </div>
              )}

              <div className="form-actions">
                <button
                  className="secondary-button"
                  disabled={isSubmitting}
                  onClick={closeFlowDialog}
                  type="button"
                >
                  <X aria-hidden="true" size={16} />
                  <span>Cancel</span>
                </button>
                <button
                  className="primary-action"
                  disabled={
                    !create.available ||
                    isSubmitting ||
                    title.trim() === '' ||
                    instructions.trim() === ''
                  }
                  type="submit"
                >
                  <CirclePlus aria-hidden="true" size={16} />
                  <span>{isSubmitting ? 'Creating' : 'Create Flow'}</span>
                </button>
              </div>
            </form>
            <button
              aria-label="Close Flow creation"
              className="icon-button modal-close-button"
              disabled={isSubmitting}
              onClick={closeFlowDialog}
              ref={closeButtonRef}
              type="button"
            >
              <X aria-hidden="true" size={16} />
            </button>
            <span
              className="focus-sentinel"
              data-focus-sentinel="true"
              onFocus={focusFirstDialogElement}
              tabIndex={0}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
