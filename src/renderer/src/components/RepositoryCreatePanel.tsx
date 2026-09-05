import {
  CirclePlus,
  GitBranch,
  RotateCcw,
  X
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement
} from 'react'
import type {
  GitHubVisibility,
  InitialWorkspaceState,
  RepositoryCreateState,
  RepositoryRemoteRetryRecord
} from '@shared/workspace'
import { getErrorMessage } from '../utils/errors'

export function RepositoryCreatePanel({
  create,
  onWorkspaceUpdate
}: {
  create: RepositoryCreateState
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  const [scanRootId, setScanRootId] = useState(create.scanRoots[0]?.id ?? '')
  const [name, setName] = useState('')
  const [githubEnabled, setGithubEnabled] = useState(false)
  const [visibility, setVisibility] = useState<GitHubVisibility>('private')
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<{
    message: string
    repositoryName: string
  } | null>(null)
  const [isOpen, setIsOpen] = useState(false)
  const createButtonRef = useRef<HTMLButtonElement | null>(null)
  const scanRootSelectRef = useRef<HTMLSelectElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const shouldRestoreFocusRef = useRef(false)
  const isAvailable = create.available && create.scanRoots.length > 0

  useEffect(() => {
    if (!create.scanRoots.some((scanRoot) => scanRoot.id === scanRootId)) {
      setScanRootId(create.scanRoots[0]?.id ?? '')
    }
  }, [create.scanRoots, scanRootId])

  useEffect(() => {
    if (isOpen) {
      nameInputRef.current?.focus()
      return
    }

    if (shouldRestoreFocusRef.current) {
      shouldRestoreFocusRef.current = false
      createButtonRef.current?.focus()
    }
  }, [isOpen])

  function openCreateDialog(): void {
    if (!isAvailable) {
      return
    }

    shouldRestoreFocusRef.current = false
    setIsOpen(true)
  }

  function closeCreateDialog(): void {
    shouldRestoreFocusRef.current = true
    setName('')
    setScanRootId(create.scanRoots[0]?.id ?? '')
    setGithubEnabled(false)
    setVisibility('private')
    setLocalError(null)
    setIsOpen(false)
  }

  function focusFirstDialogElement(): void {
    scanRootSelectRef.current?.focus()
  }

  function focusLastDialogElement(): void {
    closeButtonRef.current?.focus()
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeCreateDialog()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const firstElement = scanRootSelectRef.current
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
    const trimmedName = name.trim()
    if (trimmedName === '') {
      setLocalError('Repository name is required.')
      return
    }

    setLocalError(null)
    setIsSubmitting(true)
    try {
      const nextWorkspace = await window.grindstone.workspace.createRepository({
        scanRootId,
        name: trimmedName,
        github: {
          enabled: githubEnabled,
          visibility
        }
      })
      onWorkspaceUpdate(nextWorkspace)
      if (nextWorkspace.repository.create.error === null) {
        closeCreateDialog()
      }
    } catch (error: unknown) {
      setLocalError(getErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleRetry(retry: RepositoryRemoteRetryRecord): Promise<void> {
    setRetryingId(retry.id)
    setRetryError(null)
    try {
      const nextWorkspace = await window.grindstone.workspace.retryRepositoryRemote({
        retryId: retry.id
      })
      onWorkspaceUpdate(nextWorkspace)
    } catch (error: unknown) {
      setRetryError({
        message: getErrorMessage(error),
        repositoryName: retry.githubRepositoryName
      })
    } finally {
      setRetryingId(null)
    }
  }

  const errorMessage = localError ?? create.error?.message ?? null

  return (
    <div className="repository-create">
      <button
        className="primary-action repository-create-launcher"
        disabled={!isAvailable}
        onClick={openCreateDialog}
        ref={createButtonRef}
        type="button"
      >
        <CirclePlus aria-hidden="true" size={16} />
        <span>Create repository</span>
      </button>

      {isOpen ? (
        <div className="modal-backdrop">
          <div
            aria-labelledby="repository-create-dialog-title"
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
              <h2 id="repository-create-dialog-title">Create repository</h2>
            </div>

            <form
              aria-label="Create repository"
              className="repository-create-form"
              onSubmit={(event) => void handleSubmit(event)}
            >
              <label className="field">
                <span>Scan root</span>
                <select
                  disabled={!isAvailable || isSubmitting}
                  onChange={(event) => setScanRootId(event.target.value)}
                  ref={scanRootSelectRef}
                  value={scanRootId}
                >
                  {create.scanRoots.length === 0 ? (
                    <option value="">No scan roots configured</option>
                  ) : (
                    create.scanRoots.map((scanRoot) => (
                      <option
                        key={scanRoot.id}
                        value={scanRoot.id}
                      >
                        {scanRoot.displayPath}
                      </option>
                    ))
                  )}
                </select>
              </label>

              <label className="field">
                <span>Repository name</span>
                <input
                  disabled={!isAvailable || isSubmitting}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="new-repo"
                  ref={nameInputRef}
                  type="text"
                  value={name}
                />
              </label>

              <label className="checkbox-field">
                <input
                  checked={githubEnabled}
                  disabled={!isAvailable || isSubmitting}
                  onChange={(event) => setGithubEnabled(event.target.checked)}
                  type="checkbox"
                />
                <span>Create on GitHub</span>
              </label>

              <label className="field">
                <span>GitHub visibility</span>
                <select
                  disabled={!isAvailable || !githubEnabled || isSubmitting}
                  onChange={(event) => setVisibility(event.target.value as GitHubVisibility)}
                  value={visibility}
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>

              {errorMessage !== null ? (
                <div
                  aria-label="Repository creation error"
                  className="create-error"
                  role="alert"
                >
                  {errorMessage}
                </div>
              ) : null}

              <div className="form-actions">
                <button
                  className="secondary-button"
                  disabled={isSubmitting}
                  onClick={closeCreateDialog}
                  type="button"
                >
                  <X aria-hidden="true" size={16} />
                  <span>Cancel</span>
                </button>
                <button
                  className="primary-action"
                  disabled={!isAvailable || isSubmitting || name.trim() === ''}
                  type="submit"
                >
                  <CirclePlus aria-hidden="true" size={16} />
                  <span>{isSubmitting ? 'Creating' : 'Create repository'}</span>
                </button>
              </div>
            </form>
            <button
              aria-label="Close repository creation"
              className="icon-button modal-close-button"
              disabled={isSubmitting}
              onClick={closeCreateDialog}
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

      {create.remoteRetries.length > 0 ? (
        <div
          aria-label="Repository remote retries"
          className="remote-retry-list"
        >
          {create.remoteRetries.map((retry) => (
            <RemoteRetryRow
              key={retry.id}
              retry={retry}
              isRetrying={retryingId === retry.id}
              onRetry={handleRetry}
            />
          ))}
        </div>
      ) : null}

      {retryError !== null ? (
        <div
          aria-label="Repository remote retry error"
          className="create-error"
          role="alert"
        >
          {retryError.repositoryName}: {retryError.message}
        </div>
      ) : null}
    </div>
  )
}

function RemoteRetryRow({
  retry,
  isRetrying,
  onRetry
}: {
  retry: RepositoryRemoteRetryRecord
  isRetrying: boolean
  onRetry: (retry: RepositoryRemoteRetryRecord) => Promise<void>
}): ReactElement {
  const isSucceeded = retry.status === 'succeeded'

  return (
    <div className="remote-retry-row">
      <GitBranch aria-hidden="true" size={16} />
      <span className="remote-retry-copy">
        <span className="remote-retry-name">{retry.githubRepositoryName}</span>
        <span className="remote-retry-status">
          {isSucceeded ? 'Remote setup succeeded' : retry.lastError}
        </span>
      </span>
      <button
        aria-label={`Retry remote for ${retry.githubRepositoryName}`}
        className="icon-action"
        disabled={isSucceeded || isRetrying}
        onClick={() => void onRetry(retry)}
        title={`Retry remote for ${retry.githubRepositoryName}`}
        type="button"
      >
        <RotateCcw aria-hidden="true" size={15} />
      </button>
    </div>
  )
}
