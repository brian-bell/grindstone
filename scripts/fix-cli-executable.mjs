import { chmod, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const cliPath = resolve('out/cli/index.js')
const text = await readFile(cliPath, 'utf8')

if (!text.startsWith('#!/usr/bin/env node')) {
  throw new Error('CLI build is missing the node shebang.')
}

if (process.platform !== 'win32') {
  await chmod(cliPath, 0o755)
}
