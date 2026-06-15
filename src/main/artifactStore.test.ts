import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ArtifactStoreError,
  assertSafeArtifactId,
  ensurePrivateDirectory,
  readJsonArtifact,
  resolveArtifactRoot,
  writeJsonAtomically
} from './artifactStore'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grindstone-artifacts-'))
}

describe('artifact store helpers', () => {
  it('resolves artifact roots using CLI and wtui environment precedence before config defaults', async () => {
    const root = await makeTempDir()
    const configPath = join(root, 'grindstone.toml')
    await writeFile(configPath, `artifact_root = "${join(root, 'from-config')}"\n`)

    await expect(resolveArtifactRoot({
      stateRoot: join(root, 'explicit'),
      configPath,
      env: {
        GRINDSTONE_STATE_ROOT: join(root, 'grindstone-env'),
        WTUI_FLOW_STATE_ROOT: join(root, 'flow-env')
      }
    })).resolves.toBe(join(root, 'explicit'))

    await expect(resolveArtifactRoot({
      configPath,
      env: {
        GRINDSTONE_STATE_ROOT: join(root, 'grindstone-env'),
        WTUI_FLOW_STATE_ROOT: join(root, 'flow-env')
      }
    })).resolves.toBe(join(root, 'grindstone-env'))

    await expect(resolveArtifactRoot({
      configPath,
      env: {
        WTUI_FLOW_STATE_ROOT: join(root, 'flow-env'),
        WTUI_PLAN_STATE_ROOT: join(root, 'plan-env')
      }
    })).resolves.toBe(join(root, 'flow-env'))

    await expect(resolveArtifactRoot({ configPath, env: {} })).resolves.toBe(join(root, 'from-config'))
  })

  it('enforces safe artifact ids and private atomic writes', async () => {
    const root = await makeTempDir()
    const directory = join(root, 'flows', 'flow-1')
    const path = join(directory, 'meta.json')

    assertSafeArtifactId('Flow', 'flow-1')
    expect(() => assertSafeArtifactId('Flow', '../flow')).toThrow(ArtifactStoreError)

    await ensurePrivateDirectory(directory)
    await writeJsonAtomically(path, { ok: true })

    await expect(readJsonArtifact(path, 'flow-1', (value): value is { ok: true } =>
      typeof value === 'object' && value !== null && 'ok' in value
    )).resolves.toEqual({ ok: true })

    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })
})
