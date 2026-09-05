import { randomUUID } from 'node:crypto'
import { ipcChannels } from '@shared/ipc'
import type {
  TerminalEvent,
  TerminalEventSubscriptionRequest
} from '@shared/workspace'

export type TerminalEventSender = {
  id: number
  send: (channel: string, payload: unknown) => void
  isDestroyed: () => boolean
  isCrashed: () => boolean
}

type TerminalEventSubscription = TerminalEventSubscriptionRequest & {
  sender: TerminalEventSender
}

const subscriptions = new Map<string, TerminalEventSubscription>()

export function isTerminalEventSender(value: unknown): value is TerminalEventSender {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'send' in value &&
    typeof value.send === 'function' &&
    'isDestroyed' in value &&
    typeof value.isDestroyed === 'function' &&
    'isCrashed' in value &&
    typeof value.isCrashed === 'function'
  )
}

export function subscribeTerminalEventSender(
  request: TerminalEventSubscriptionRequest,
  sender: TerminalEventSender
): { subscriptionId: string } {
  const subscriptionId = randomUUID()
  subscriptions.set(subscriptionId, {
    repositoryId: request.repositoryId,
    flowId: request.flowId,
    sender
  })
  return { subscriptionId }
}

export function unsubscribeTerminalEventSender(subscriptionId: string): void {
  subscriptions.delete(subscriptionId)
}

export function publishTerminalEventToSubscribers(event: TerminalEvent): void {
  for (const [subscriptionId, subscription] of subscriptions) {
    // WebContents.send on a disposed or crashed frame only logs internally and
    // does not throw, so liveness has to be checked explicitly or the error
    // re-fires for every terminal chunk forever.
    if (subscription.sender.isDestroyed() || subscription.sender.isCrashed()) {
      subscriptions.delete(subscriptionId)
      continue
    }

    if (
      subscription.repositoryId !== event.repositoryId ||
      subscription.flowId !== event.flowId
    ) {
      continue
    }

    try {
      subscription.sender.send(ipcChannels.events.terminal, event)
    } catch {
      subscriptions.delete(subscriptionId)
    }
  }
}
