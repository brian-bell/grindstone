import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve('src/renderer/src/styles.css'), 'utf8')

describe('renderer layout styles', () => {
  it('lays out a fixed-width sidebar next to a flexible main pane', () => {
    const appShellRule = styles.match(/\.app-shell\s*\{(?<body>[^}]+)\}/)

    expect(appShellRule?.groups?.body).toContain(
      'grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);'
    )
  })
})
