import { describe, expect, it } from 'vitest'
import type { FlowPaneState } from './workspace'
import { middlePaneManifest, resolveMiddlePaneRoute } from './middlePane'

const standaloneTerms = ['worktree', 'branch', 'session', 'plan']

describe('middle pane Flow-only surface', () => {
  it('exports only the Flow workspace surface', () => {
    expect(middlePaneManifest).toEqual([
      {
        id: 'flow-workspace',
        label: 'Flow Workspace',
        route: '/',
        scope: 'flow'
      }
    ])

    const manifestText = JSON.stringify(middlePaneManifest).toLowerCase()
    for (const term of standaloneTerms) {
      expect(manifestText).not.toContain(term)
    }
  })

  it('resolves unknown or standalone route attempts back to a Flow-scoped error', () => {
    for (const path of ['/worktrees', '/branches', '/sessions', '/plans', '/anything-else']) {
      expect(resolveMiddlePaneRoute(path)).toEqual({
        surface: middlePaneManifest[0],
        flowState: {
          status: 'error',
          message: 'Only Flow workspace routes are available in this shell.'
        }
      })
    }
  })

  it('keeps the Flow pane state union explicit', () => {
    const allowedStates: FlowPaneState[] = [
      { status: 'loading' },
      { status: 'empty', title: 'No Flow selected', description: 'No Flow is active.' },
      { status: 'error', message: 'Only Flow workspace routes are available in this shell.' }
    ]

    expect(allowedStates.map((state) => state.status)).toEqual(['loading', 'empty', 'error'])
  })
})
