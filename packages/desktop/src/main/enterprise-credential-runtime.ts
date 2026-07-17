import type { createEnterpriseCredentialHandlers, EnterpriseCredentials } from "./enterprise-credentials"

type Handlers = ReturnType<typeof createEnterpriseCredentialHandlers>

export class EnterpriseCredentialRuntimeError extends Error {
  constructor(readonly code: "restart_failed_rolled_back" | "restart_failed_recovery_failed") {
    super(code)
    this.name = "EnterpriseCredentialRuntimeError"
  }
}

export function createEnterpriseCredentialRuntime(input: {
  handlers: Handlers
  read: () => Promise<EnterpriseCredentials>
  write: (credentials: EnterpriseCredentials) => Promise<void>
  restart: () => Promise<void>
}) {
  let mutations: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(operation: () => Promise<T>) => {
    const result = mutations.then(operation)
    mutations = result.catch(() => undefined)
    return result
  }
  const mutate = (operation: () => Promise<unknown>) =>
    enqueue(async () => {
      const previous = await input.read()
      await operation()
      try {
        await input.restart()
        return { restartRequired: false as const }
      } catch {
        try {
          await input.write(previous)
          await input.restart()
        } catch {
          throw new EnterpriseCredentialRuntimeError("restart_failed_recovery_failed")
        }
        throw new EnterpriseCredentialRuntimeError("restart_failed_rolled_back")
      }
    })

  return {
    catalog: input.handlers.catalog,
    status: input.handlers.status,
    set: (value: Parameters<Handlers["set"]>[0]) => mutate(() => input.handlers.set(value)),
    clear: (modelID?: string) => mutate(() => input.handlers.clear(modelID)),
  }
}
