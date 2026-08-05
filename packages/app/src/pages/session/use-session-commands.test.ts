import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import type { PromptInputControls } from "@/components/prompt-input/contracts"
import { createPermissionMutation } from "@/context/permission-mutation"

let useSessionCommands: typeof import("./use-session-commands").useSessionCommands

type Command = {
  id: string
  disabled?: boolean
  onSelect?: () => void | Promise<void>
}

const params: { id?: string; dir?: string } = { dir: "repo" }
const updates: Array<{ directory: string; sessionID: string; approvalMode: "ask" }> = []
const toasts: Array<{ title?: string; description?: string; variant?: string }> = []
const order: string[] = []

let directory = "/repo"
let sessionActive = false
let directoryActive = false
let updateFailure: Error | undefined
let updateWait: Promise<void> | undefined
let options: (() => Command[]) | undefined
let permissionMutation = createPermissionMutation()
let dispose: (() => void) | undefined

const permissionState = () => ({
  approvalMutation: permissionMutation,
  isAutoAccepting: () => sessionActive,
  isAutoAcceptingDirectory: () => directoryActive,
  enableAutoAccept: (sessionID: string, value: string) => {
    order.push(`enable-session:${sessionID}:${value}`)
    sessionActive = true
  },
  disableAutoAccept: (sessionID: string, value: string) => {
    order.push(`disable-session:${sessionID}:${value}`)
    sessionActive = false
  },
  enableAutoAcceptDirectory: (value: string) => {
    order.push(`enable-directory:${value}`)
    directoryActive = true
  },
  disableAutoAcceptDirectory: (value: string) => {
    order.push(`disable-directory:${value}`)
    directoryActive = false
  },
})

const approval = (): PromptInputControls["approval"] => ({
  visible: () => true,
  current: () => "ask",
  options: ["ask", "auto_review"],
  pending: permissionMutation.pending,
  select: async () => undefined,
  run: permissionMutation.run,
  resetDraft: () => undefined,
})

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({ useNavigate: () => () => undefined }))
  mock.module("@opencode-ai/ui/context/dialog", () => ({
    useDialog: () => ({ active: false, show: () => undefined }),
  }))
  mock.module("@/context/command", () => ({
    useCommand: () => ({
      register: (_key: string, value: () => Command[]) => {
        options = value
      },
      trigger: () => undefined,
    }),
  }))
  mock.module("@/context/file", () => ({
    useFile: () => ({
      tab: (value: string) => value,
      pathFromTab: () => undefined,
      selectedLines: () => undefined,
      get: () => undefined,
    }),
    selectionFromLines: (value: unknown) => value,
  }))
  mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      fileTree: { tab: () => "all", setTab: () => undefined, toggle: () => undefined },
    }),
  }))
  mock.module("@/context/permission", () => ({
    usePermission: () => ({
      currentServerState: permissionState,
      isAutoAccepting: () => sessionActive,
      isAutoAcceptingDirectory: () => directoryActive,
    }),
  }))
  mock.module("@/context/prompt", () => ({
    usePrompt: () => ({
      context: { add: () => undefined },
      capture: () => ({ reset: () => undefined, set: () => undefined }),
    }),
  }))
  mock.module("@/context/sdk", () => ({
    useSDK: () => () => ({
      directory,
      client: {
        session: {
          update: async (input: { sessionID: string; approvalMode: "ask" }) => {
            order.push(`update:${input.sessionID}:${directory}`)
            updates.push({ directory, ...input })
            await updateWait
            if (updateFailure) throw updateFailure
            return { data: { id: input.sessionID, approvalMode: "ask" } }
          },
        },
      },
    }),
  }))
  mock.module("@/context/settings", () => ({
    useSettings: () => ({
      general: { newLayoutDesigns: () => false },
      visibility: { fileTree: () => false },
    }),
  }))
  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      session: { get: (id: string) => ({ id }) },
      data: { config: { share: "disabled" }, message: {} },
    }),
  }))
  mock.module("@/context/terminal", () => ({
    useTerminal: () => ({
      all: () => [],
      active: () => undefined,
      new: () => undefined,
      close: () => undefined,
      requestFocus: () => undefined,
      cancelFocus: () => undefined,
    }),
  }))
  mock.module("@/context/local", () => ({
    useLocal: () => ({ model: { current: () => undefined } }),
  }))
  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({ interrupt: async () => undefined }),
  }))
  mock.module("@/pages/session/session-layout", () => ({
    useSessionLayout: () => ({
      params,
      sessionKey: () => `${directory}/${params.id ?? ""}`,
      tabs: () => ({ active: () => undefined, all: () => [], close: () => undefined }),
      view: () => ({
        terminal: { opened: () => false, open: () => undefined, close: () => undefined },
        reviewPanel: { toggle: () => undefined },
      }),
    }),
  }))
  mock.module("@/utils/toast", () => ({
    showToast: (toast: { title?: string; description?: string; variant?: string }) => toasts.push(toast),
  }))

  useSessionCommands = (await import("./use-session-commands")).useSessionCommands
})

beforeEach(() => {
  dispose?.()
  params.id = "session-1"
  directory = "/repo"
  sessionActive = false
  directoryActive = false
  updateFailure = undefined
  updateWait = undefined
  options = undefined
  permissionMutation = createPermissionMutation()
  updates.length = 0
  toasts.length = 0
  order.length = 0

  dispose = createRoot((cleanup) => {
    useSessionCommands({
      approval: approval(),
      navigateMessageByOffset: () => undefined,
      setActiveMessage: () => undefined,
      focusInput: () => undefined,
    })
    return cleanup
  })
})

afterEach(() => {
  dispose?.()
  dispose = undefined
})

const autoAcceptCommand = () => {
  const command = options?.().find((item) => item.id === "permissions.autoaccept")
  if (!command) throw new Error("Auto-accept command was not registered")
  return command
}

describe("useSessionCommands auto-accept command", () => {
  test("updates the current session to ask before enabling exact blind auto", async () => {
    let release: () => void = () => {}
    updateWait = new Promise<void>((resolve) => {
      release = resolve
    })

    const selected = autoAcceptCommand().onSelect?.()
    await Promise.resolve()

    expect(updates).toEqual([{ directory: "/repo", sessionID: "session-1", approvalMode: "ask" }])
    expect(order).toEqual(["update:session-1:/repo"])
    expect(toasts).toEqual([])

    release()
    await selected

    expect(order).toEqual(["update:session-1:/repo", "enable-session:session-1:/repo"])
    expect(toasts).toEqual([
      {
        title: "toast.permissions.autoaccept.on.title",
        description: "toast.permissions.autoaccept.on.description",
      },
    ])
  })

  test("reports one error without local enable or a false success toast when the update fails", async () => {
    updateFailure = new Error("update failed")

    await autoAcceptCommand().onSelect?.()

    expect(updates).toEqual([{ directory: "/repo", sessionID: "session-1", approvalMode: "ask" }])
    expect(sessionActive).toBeFalse()
    expect(order).toEqual(["update:session-1:/repo"])
    expect(toasts).toEqual([{ title: "common.requestFailed", variant: "error" }])
  })

  test("is disabled and remains a no-op while the shared approval mutation is pending", async () => {
    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const active = permissionMutation.run(() => wait)

    expect(autoAcceptCommand().disabled).toBeTrue()
    await autoAcceptCommand().onSelect?.()
    expect(updates).toEqual([])
    expect(order).toEqual([])
    expect(toasts).toEqual([])

    release()
    await active
  })

  test("resets matching drafts before enabling directory blind auto for a new session", async () => {
    params.id = undefined
    permissionMutation.registerDraftReset("/repo", () => order.push("reset-draft:/repo"))

    await autoAcceptCommand().onSelect?.()

    expect(updates).toEqual([])
    expect(order).toEqual(["reset-draft:/repo", "enable-directory:/repo"])
    expect(toasts).toEqual([
      {
        title: "toast.permissions.autoaccept.on.title",
        description: "toast.permissions.autoaccept.on.description",
      },
    ])
  })
})
