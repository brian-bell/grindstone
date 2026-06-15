import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    lib: {
      entry: resolve('src/cli/index.ts'),
      formats: ['cjs'],
      fileName: () => 'index.js'
    },
    outDir: 'out/cli',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      external: [
        'node:crypto',
        'node:fs/promises',
        'node:os',
        'node:path',
        'node:process',
        'node:stream',
        'smol-toml',
        'electron'
      ],
      output: {
        banner: '#!/usr/bin/env node'
      }
    }
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  }
})
