import { Settings } from 'lucide-react'
import type { ReactElement, RefObject } from 'react'
import type {
  CatalogDiagnostic,
  InitialWorkspaceState,
  RepositoryPaneState,
  RepositoryRow
} from '@shared/workspace'
import { RepositoryCreatePanel } from './RepositoryCreatePanel'

export function RepositoryCatalogView({
  isLoading,
  repository,
  configureButtonRef,
  onSelect,
  onConfigure,
  onWorkspaceUpdate
}: {
  isLoading: boolean
  repository: RepositoryPaneState
  configureButtonRef?: RefObject<HTMLButtonElement | null>
  onSelect: (repository: RepositoryRow) => Promise<void>
  onConfigure: () => void
  onWorkspaceUpdate: (workspace: InitialWorkspaceState) => void
}): ReactElement {
  if (isLoading) {
    return (
      <div
        className="repository-summary"
        role="status"
        aria-label="Repository catalog loading"
      >
        <p className="repository-status-title">Loading repositories</p>
        <p>Reading configured scan roots and explicit repositories.</p>
      </div>
    )
  }

  return (
    <div className="repository-catalog">
      <div className="repository-summary">
        <p className="repository-status-title">{repository.title}</p>
        <p>{repository.description}</p>
        <button
          className="configure-button"
          onClick={onConfigure}
          ref={configureButtonRef}
          type="button"
        >
          <Settings aria-hidden="true" size={16} />
          <span>Configure</span>
        </button>
      </div>

      <RepositoryCreatePanel
        create={repository.create}
        onWorkspaceUpdate={onWorkspaceUpdate}
      />

      {repository.repositories.length > 0 ? (
        <div className="repository-list" aria-label="Configured repositories">
          {repository.repositories.map((row) => (
            <RepositoryRowButton
              isSelected={row.id === repository.selectedRepositoryId}
              key={row.id}
              repository={row}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}

      {repository.diagnostics.length > 0 ? (
        <div className="diagnostic-list" aria-label="Repository diagnostics">
          {repository.diagnostics.map((diagnostic) => (
            <CatalogDiagnosticRow
              diagnostic={diagnostic}
              key={`${diagnostic.code}:${diagnostic.configuredPath}:${diagnostic.resolvedPath}`}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function RepositoryRowButton({
  isSelected,
  repository,
  onSelect
}: {
  isSelected: boolean
  repository: RepositoryRow
  onSelect: (repository: RepositoryRow) => Promise<void>
}): ReactElement {
  return (
    <button
      aria-pressed={isSelected}
      className="repository-row"
      onClick={() => void onSelect(repository)}
      type="button"
    >
      <span className="repository-row-main">
        <span className="repository-name">{repository.name}</span>
        <span className="repository-path">{repository.path}</span>
      </span>
      <span className="repository-sources">{repository.sources.join(', ')}</span>
    </button>
  )
}

function CatalogDiagnosticRow({
  diagnostic
}: {
  diagnostic: CatalogDiagnostic
}): ReactElement {
  return (
    <div className="diagnostic-row" role="alert">
      <span className="diagnostic-code">{diagnostic.code}</span>
      <span className="diagnostic-message">{diagnostic.message}</span>
      <span className="diagnostic-path">{diagnostic.configuredPath}</span>
    </div>
  )
}
