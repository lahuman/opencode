import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createPermissionMutation } from "@/context/permission-mutation"

let createApprovalModeControl: typeof import("./session-composer-controls").createApprovalModeControl

type ApprovalMode = "ask" | "auto_review"

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({ useNavigate: () => undefined, useSearchParams: () => [{}, () => undefined] }))
  mock.module("@tanstack/solid-query", () => ({ createQuery: () => ({}), queryOptions: (value: unknown) => value }))
  mock.module("@/components/directory-picker", () => ({ useDirectoryPicker: () => undefined }))
  mock.module("@/context/layout", () => ({ useLayout: () => undefined }))
  mock.module("@/context/global", () => ({ useGlobal: () => undefined }))
  mock.module("@/context/local", () => ({ useLocal: () => undefined }))
  mock.module("@/context/project", () => ({ useProject: () => undefined }))
  mock.module("@/context/server", () => ({
    serverName: () => "server",
    ServerConnection: { key: () => "server" },
    useServer: () => undefined,
  }))
  mock.module("@/context/server-sdk", () => ({ useServerSDK: () => undefined }))
  mock.module("@/context/sdk", () => ({ useSDK: () => undefined }))
  mock.module("@/context/sync", () => ({ useSync: () => undefined }))
  mock.module("@/context/tabs", () => ({ useTabs: () => undefined }))
  mock.module("@/hooks/use-providers", () => ({ useProviders: () => undefined }))
  mock.module("@/context/permission", () => ({ usePermission: () => undefined }))
  mock.module("@/context/language", () => ({ useLanguage: () => undefined }))
  mock.module("@/utils/toast", () => ({ showToast: () => undefined }))
  mock.module("@/utils/server-errors", () => ({ formatServerError: () => "error" }))
  createApprovalModeControl = (await import("./session-composer-controls")).createApprovalModeControl
})

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup() {
  const [agent, setAgent] = createSignal("plan")
  const [session, setSession] = createSignal<{ id: string; approvalMode?: ApprovalMode }>()
  const [sessionKey, setSessionKey] = createSignal("draft-1")
  const [directory, setDirectory] = createSignal("/repo")
  const approvalMutation = createPermissionMutation()
  const updates: Array<{ sessionID: string; approvalMode: ApprovalMode }> = []
  const disables: Array<{ sessionID: string; directory: string }> = []
  const errors: unknown[] = []
  let update = async (input: { sessionID: string; approvalMode: ApprovalMode }) => {
    updates.push(input)
    setSession({ id: input.sessionID, approvalMode: input.approvalMode })
  }
  let disable = (sessionID: string, value: string) => {
    disables.push({ sessionID, directory: value })
  }
  const control = createApprovalModeControl({
    agent,
    session,
    sessionKey,
    directory,
    approvalMutation,
    update: (input) => update(input),
    disableAutoAccept: (sessionID, value) => disable(sessionID, value),
    onError: (error) => errors.push(error),
  })

  return {
    agent,
    setAgent,
    session,
    setSession,
    sessionKey,
    setSessionKey,
    directory,
    setDirectory,
    approvalMutation,
    updates,
    disables,
    errors,
    control,
    setUpdate: (value: typeof update) => {
      update = value
    },
    setDisable: (value: typeof disable) => {
      disable = value
    },
  }
}

describe("createApprovalModeControl", () => {
  test("is visible only for Plan", () => {
    createRoot((dispose) => {
      const state = setup()

      expect(state.control.visible()).toBe(true)
      state.setAgent("build")
      expect(state.control.visible()).toBe(false)
      state.setAgent("plan")
      expect(state.control.visible()).toBe(true)
      expect(state.control.options).toEqual(["ask", "auto_review"])
      dispose()
    })
  })

  test("keeps a new-session draft for one key and resets it for the next key", async () => {
    await createRoot(async (dispose) => {
      const state = setup()

      expect(state.control.current()).toBe("ask")
      await state.control.select("auto_review")
      expect(state.control.current()).toBe("auto_review")
      expect(state.updates).toEqual([])
      expect(state.disables).toEqual([])

      state.setSessionKey("draft-2")
      await Promise.resolve()
      expect(state.control.current()).toBe("ask")
      state.setSessionKey("draft-1")
      expect(state.control.current()).toBe("ask")
      dispose()
    })
  })

  test("uses synchronized existing-session mode as authoritative", () => {
    createRoot((dispose) => {
      const state = setup()

      state.setSession({ id: "session-1" })
      expect(state.control.current()).toBe("ask")
      state.setSession({ id: "session-1", approvalMode: "auto_review" })
      expect(state.control.current()).toBe("auto_review")
      state.setSession({ id: "session-1", approvalMode: "ask" })
      expect(state.control.current()).toBe("ask")
      dispose()
    })
  })

  test("awaits auto-review update before disabling exact blind auto", async () => {
    await createRoot(async (dispose) => {
      const state = setup()
      const hold = deferred()
      const order: string[] = []
      state.setSession({ id: "session-1", approvalMode: "ask" })
      state.setUpdate(async (input) => {
        order.push("update")
        await hold.promise
        state.setSession({ id: input.sessionID, approvalMode: input.approvalMode })
      })
      state.setDisable((sessionID, directory) => {
        order.push("disable")
        state.disables.push({ sessionID, directory })
      })

      const selection = state.control.select("auto_review")
      expect(state.control.pending()).toBe(true)
      expect(order).toEqual(["update"])
      expect(state.disables).toEqual([])

      hold.resolve()
      await selection
      expect(order).toEqual(["update", "disable"])
      expect(state.disables).toEqual([{ sessionID: "session-1", directory: "/repo" }])
      expect(state.control.current()).toBe("auto_review")
      dispose()
    })
  })

  test("reports update failure and preserves prior visible and blind-auto state", async () => {
    await createRoot(async (dispose) => {
      const state = setup()
      const error = new Error("update failed")
      state.setSession({ id: "session-1", approvalMode: "ask" })
      state.setUpdate(async () => {
        throw error
      })

      await state.control.select("auto_review")

      expect(state.control.current()).toBe("ask")
      expect(state.disables).toEqual([])
      expect(state.errors).toEqual([error])
      expect(state.control.pending()).toBe(false)
      dispose()
    })
  })

  test("updates ask without changing blind-auto state", async () => {
    await createRoot(async (dispose) => {
      const state = setup()
      state.setSession({ id: "session-1", approvalMode: "auto_review" })

      await state.control.select("ask")

      expect(state.updates).toEqual([{ sessionID: "session-1", approvalMode: "ask" }])
      expect(state.disables).toEqual([])
      expect(state.control.current()).toBe("ask")
      dispose()
    })
  })

  test("does not queue concurrent selections and accepts a retry after settlement", async () => {
    await createRoot(async (dispose) => {
      const state = setup()
      const hold = deferred()
      state.setSession({ id: "session-1", approvalMode: "ask" })
      state.setUpdate(async (input) => {
        state.updates.push(input)
        await hold.promise
        state.setSession({ id: input.sessionID, approvalMode: input.approvalMode })
      })

      const first = state.control.select("auto_review")
      await state.control.select("auto_review")
      expect(state.updates).toEqual([{ sessionID: "session-1", approvalMode: "auto_review" }])
      expect(state.disables).toEqual([])

      hold.resolve()
      await first
      await state.control.select("ask")
      expect(state.updates).toEqual([
        { sessionID: "session-1", approvalMode: "auto_review" },
        { sessionID: "session-1", approvalMode: "ask" },
      ])
      expect(state.disables).toEqual([{ sessionID: "session-1", directory: "/repo" }])
      dispose()
    })
  })

  test("shares one lock with blind-auto mutations in both directions", async () => {
    await createRoot(async (dispose) => {
      const state = setup()
      const approvalHold = deferred()
      state.setSession({ id: "session-1", approvalMode: "ask" })
      state.setUpdate(async (input) => {
        state.updates.push(input)
        await approvalHold.promise
        state.setSession({ id: input.sessionID, approvalMode: input.approvalMode })
      })
      const selection = state.control.select("auto_review")
      const blind = await state.approvalMutation.run(async () => state.disables.push({ sessionID: "blind", directory: "/repo" }))
      expect(blind).toEqual({ status: "busy" })
      expect(state.disables).toEqual([])
      approvalHold.resolve()
      await selection

      state.setSession({ id: "session-1", approvalMode: "ask" })
      const blindHold = deferred()
      const activeBlind = state.approvalMutation.run(() => blindHold.promise)
      await state.control.select("auto_review")
      expect(state.updates).toHaveLength(1)
      blindHold.resolve()
      await activeBlind
      await state.control.select("auto_review")
      expect(state.updates).toHaveLength(2)
      dispose()
    })
  })
})
