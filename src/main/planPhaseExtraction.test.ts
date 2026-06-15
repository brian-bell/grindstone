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

  it('prefers specific implementation headings over earlier generic phases sections', () => {
    expect(extractImplementationPhaseDrafts([
      '# Plan',
      '',
      '## Phases',
      '',
      '- Discovery',
      '',
      '## Implementation Phases',
      '',
      '- Build API',
      '- Render UI'
    ].join('\n'))).toEqual([
      {
        idBase: 'build-api',
        title: 'Build API',
        order: 1
      },
      {
        idBase: 'render-ui',
        title: 'Render UI',
        order: 2
      }
    ])
  })

  it('extracts numbered child headings under implementation phases sections', () => {
    expect(extractImplementationPhaseDrafts([
      '# Plan',
      '',
      '## Implementation Phases',
      '',
      '### 1. Build API',
      '',
      'Wire IPC',
      '',
      '### 2. Render UI',
      '',
      'Add controls'
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
