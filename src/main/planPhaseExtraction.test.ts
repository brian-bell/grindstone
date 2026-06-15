import { describe, expect, it } from 'vitest'
import { extractImplementationPhaseDrafts } from './planPhaseExtraction'

describe('plan phase extraction', () => {
  it('extracts ordered implementation phase lists', () => {
    expect(extractImplementationPhaseDrafts([
      '# Plan',
      '',
      '## Implementation Phases',
      '',
      '1. Build API',
      '   - Wire IPC',
      '2. Render UI',
      '   1. Add controls'
    ].join('\n'))).toEqual([
      {
        idBase: 'build-api',
        title: 'Build API',
        order: 1,
        notes: 'Wire IPC'
      },
      {
        idBase: 'render-ui',
        title: 'Render UI',
        order: 2,
        notes: 'Add controls'
      }
    ])
  })
})
