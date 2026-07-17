import { RECENT_TERMINAL_OUTPUT_LIMIT } from '@shared/workspace'

export function trimRecentTerminalOutput(output: string): string {
  return output.length <= RECENT_TERMINAL_OUTPUT_LIMIT
    ? output
    : output.slice(output.length - RECENT_TERMINAL_OUTPUT_LIMIT)
}

export function getTerminalOutputAppend(previousOutput: string, output: string): string {
  if (previousOutput === '' || output.startsWith(previousOutput)) {
    return output.slice(previousOutput.length)
  }
  if (output === '') {
    return ''
  }

  const prefixTable = Array<number>(output.length).fill(0)
  for (let index = 1; index < output.length; index += 1) {
    let candidateLength = prefixTable[index - 1] ?? 0
    while (candidateLength > 0 && output[index] !== output[candidateLength]) {
      candidateLength = prefixTable[candidateLength - 1] ?? 0
    }
    if (output[index] === output[candidateLength]) {
      candidateLength += 1
    }
    prefixTable[index] = candidateLength
  }

  let overlapLength = 0
  for (let index = 0; index < previousOutput.length; index += 1) {
    while (overlapLength > 0 && previousOutput[index] !== output[overlapLength]) {
      overlapLength = prefixTable[overlapLength - 1] ?? 0
    }
    if (previousOutput[index] === output[overlapLength]) {
      overlapLength += 1
    }
    if (overlapLength === output.length && index < previousOutput.length - 1) {
      overlapLength = prefixTable[overlapLength - 1] ?? 0
    }
  }

  return output.slice(overlapLength)
}
