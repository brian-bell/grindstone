import { describe, expect, it, vi, type Mock } from 'vitest'
import { ipcChannels } from '@shared/ipc'
import type { TerminalEvent } from '@shared/workspace'
import {
  isTerminalEventSender,
  publishTerminalEventToSubscribers,
  subscribeTerminalEventSender,
  unsubscribeTerminalEventSender,
  type TerminalEventSender
} from './terminalEventBus'

type MockSender = Omit<TerminalEventSender, 'send'> & {
  send: Mock<(channel: string, payload: unknown) => void>
}

function createSender(overrides: Partial<MockSender> = {}): MockSender {
  return {
    id: 1,
    send: vi.fn<(channel: string, payload: unknown) => void>(),
    isDestroyed: () => false,
    isCrashed: () => false,
    ...overrides
  }
}

const outputEvent: TerminalEvent = {
  type: 'output',
  repositoryId: '/repos/grindstone',
  flowId: 'flow-one',
  terminalId: 'terminal-one',
  data: 'chunk'
}

describe('terminalEventBus', () => {
  it('validates sender shape including liveness probes', () => {
    expect(isTerminalEventSender(createSender())).toBe(true)
    expect(isTerminalEventSender({ id: 1, send: () => undefined })).toBe(false)
    expect(isTerminalEventSender(null)).toBe(false)
    expect(isTerminalEventSender({})).toBe(false)
  })

  it('publishes events only to subscriptions matching repository and flow', () => {
    const matching = createSender()
    const otherFlow = createSender({ id: 2 })
    subscribeTerminalEventSender(
      { repositoryId: '/repos/grindstone', flowId: 'flow-one' },
      matching
    )
    subscribeTerminalEventSender(
      { repositoryId: '/repos/grindstone', flowId: 'flow-two' },
      otherFlow
    )

    publishTerminalEventToSubscribers(outputEvent)

    expect(matching.send).toHaveBeenCalledWith(ipcChannels.events.terminal, outputEvent)
    expect(otherFlow.send).not.toHaveBeenCalled()
  })

  it('stops publishing to a sender that stops matching after unsubscribe', () => {
    const sender = createSender()
    const { subscriptionId } = subscribeTerminalEventSender(
      { repositoryId: '/repos/grindstone', flowId: 'flow-one' },
      sender
    )

    unsubscribeTerminalEventSender(subscriptionId)
    publishTerminalEventToSubscribers(outputEvent)

    expect(sender.send).not.toHaveBeenCalled()
  })

  it('drops crashed senders instead of publishing to them repeatedly', () => {
    const crashed = createSender({ isCrashed: () => true })
    const healthy = createSender({ id: 2 })
    subscribeTerminalEventSender(
      { repositoryId: '/repos/grindstone', flowId: 'flow-one' },
      crashed
    )
    subscribeTerminalEventSender(
      { repositoryId: '/repos/grindstone', flowId: 'flow-one' },
      healthy
    )

    publishTerminalEventToSubscribers(outputEvent)
    publishTerminalEventToSubscribers(outputEvent)

    expect(crashed.send).not.toHaveBeenCalled()
    expect(healthy.send).toHaveBeenCalledTimes(2)
  })

  it('drops destroyed senders instead of publishing to them', () => {
    const destroyed = createSender({ isDestroyed: () => true })
    subscribeTerminalEventSender(
      { repositoryId: '/repos/grindstone', flowId: 'flow-one' },
      destroyed
    )

    publishTerminalEventToSubscribers(outputEvent)
    publishTerminalEventToSubscribers(outputEvent)

    expect(destroyed.send).not.toHaveBeenCalled()
  })

  it('drops senders whose send call throws', () => {
    const throwing = createSender({
      send: vi.fn(() => {
        throw new Error('disposed')
      })
    })
    subscribeTerminalEventSender(
      { repositoryId: '/repos/grindstone', flowId: 'flow-one' },
      throwing
    )

    publishTerminalEventToSubscribers(outputEvent)
    publishTerminalEventToSubscribers(outputEvent)

    expect(throwing.send).toHaveBeenCalledTimes(1)
  })
})
