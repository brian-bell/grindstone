const flowMutationQueue = new Map<string, Promise<void>>()

export async function runExclusiveFlowMutation<T>(
  flowId: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = flowMutationQueue.get(flowId) ?? Promise.resolve()
  let releaseCurrent!: () => void
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  const queued = previous.then(() => current)
  flowMutationQueue.set(flowId, queued)

  await previous
  try {
    return await action()
  } finally {
    releaseCurrent()
    if (flowMutationQueue.get(flowId) === queued) {
      flowMutationQueue.delete(flowId)
    }
  }
}
