import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')

describe('renderer layout styles', () => {
  it('keeps the desktop repository pane 20% narrower', () => {
    const appShellRule = styles.match(/\.app-shell\s*\{(?<body>[^}]+)\}/)

    expect(appShellRule?.groups?.body).toContain(
      'grid-template-columns: minmax(192px, 0.624fr) minmax(360px, 1.45fr) var(--right-pane-column);'
    )
  })
})
