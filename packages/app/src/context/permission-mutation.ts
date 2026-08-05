import { createSignal } from "solid-js"

export function createPermissionMutation() {
  const [pending, setPending] = createSignal(false)
  const drafts = new Map<string, Set<() => void>>()
  let active: Promise<void> | undefined

  return {
    pending,
    async run<T>(action: () => Promise<T> | T) {
      if (active) return { status: "busy" as const }

      let release: () => void = () => {}
      active = new Promise<void>((resolve) => {
        release = resolve
      })
      setPending(true)

      try {
        return { status: "completed" as const, value: await action() }
      } finally {
        active = undefined
        setPending(false)
        release()
      }
    },
    idle() {
      return active ?? Promise.resolve()
    },
    registerDraftReset(directory: string, reset: () => void) {
      const callbacks = drafts.get(directory) ?? new Set<() => void>()
      callbacks.add(reset)
      drafts.set(directory, callbacks)
      return () => {
        callbacks.delete(reset)
        if (callbacks.size === 0) drafts.delete(directory)
      }
    },
    resetDrafts(directory: string) {
      const callbacks = drafts.get(directory)
      if (!callbacks) return
      Array.from(callbacks).forEach((reset) => reset())
    },
  }
}

export async function toggleBlindAuto(input: {
  checked: boolean
  active: boolean
  sessionID?: string
  updateToAsk: (sessionID: string) => Promise<void>
  resetDrafts: () => void
  enableSession: (sessionID: string) => void
  disableSession: (sessionID: string) => void
  enableDirectory: () => void
  disableDirectory: () => void
}) {
  if (input.checked === input.active) return
  if (input.sessionID) {
    if (!input.checked) {
      input.disableSession(input.sessionID)
      return
    }
    await input.updateToAsk(input.sessionID)
    input.enableSession(input.sessionID)
    return
  }
  if (!input.checked) {
    input.disableDirectory()
    return
  }
  input.resetDrafts()
  input.enableDirectory()
}
