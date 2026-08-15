import { beforeAll, beforeEach, expect, mock, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createComponent, createContext, createEffect, createRoot, createSignal, useContext } from "solid-js"
import { render } from "solid-js/web"

const [agents, setAgents] = createSignal<Array<{ name: string; mode: string; hidden: boolean }>>([])
const [directory, setDirectory] = createSignal("/repo")
const [sessionID, setSessionID] = createSignal<string | undefined>("session-delayed-agents")
const [platform, setPlatform] = createSignal<"desktop" | "web">("desktop")
const [writes, setWrites] = createSignal<Array<{ key: string; value: string }>>([])
const [reads, setReads] = createSignal<string[]>([])
const [parts, setParts] = createSignal<Record<string, unknown[]>>({})
const [replyFailure, setReplyFailure] = createSignal(false)
const [replies, setReplies] = createSignal(0)

type MutationOptions = {
  mutationFn: (input: unknown) => Promise<unknown>
  onMutate?: () => void
  onSuccess?: (result: unknown, input: unknown) => void
  onError?: (error: unknown) => void
}

type Mutation = {
  options: MutationOptions
  isPending: boolean
  mutateAsync: (input: unknown) => Promise<unknown>
}
const mutations: Mutation[] = []
const values = new Map<string, string>()
const storage: AsyncStorage = {
  getItem: async (key) => {
    setReads((items) => [...items, key])
    return values.get(key) ?? null
  },
  setItem: async (key, value) => {
    values.set(key, value)
    setWrites((items) => [...items, { key, value }])
  },
  removeItem: async (key) => values.delete(key),
  clear: async () => values.clear(),
  key: async (index) => [...values.keys()][index] ?? null,
  getLength: async () => values.size,
  get length() {
    return Promise.resolve(values.size)
  },
}

mock.module("@solidjs/router", () => ({
  useParams: () => ({ id: sessionID() }),
}))
mock.module("@/context/platform", () => ({
  usePlatform: () => (platform() === "desktop" ? { platform: "desktop", storage: () => storage } : { platform: "web" }),
}))
mock.module("@/context/sdk", () => ({
  useSDK: () => () => ({
    directory: directory(),
    event: { on: () => () => {} },
    api: {
      question: {
        reply: async () => {
          setReplies((count) => count + 1)
          if (replyFailure()) throw new Error("reply failed")
        },
        reject: async () => undefined,
      },
    },
  }),
}))
mock.module("@/context/sync", () => ({
  useSync: () => () => ({
    status: "complete",
    data: { agent: agents(), config: {}, part: parts(), provider_ready: true },
  }),
}))
mock.module("@/context/server-sdk", () => ({
  useServerSDK: () => () => ({ scope: "local" }),
}))
mock.module("@/hooks/use-providers", () => ({
  useProviders: () => ({
    all: () => new Map(),
    connected: () => [],
    default: () => ({}),
  }),
}))
mock.module("@/context/models", () => ({
  useModels: () => ({
    ready: () => true,
    recent: { list: () => [], push: () => {} },
    find: () => undefined,
    list: () => [],
    visible: () => true,
    setVisibility: () => {},
    variant: { get: () => undefined, set: () => {} },
  }),
}))
mock.module("@/context/settings", () => ({
  useSettings: () => ({ visibility: { customAgents: () => false } }),
}))
mock.module("@/context/language", () => ({
  useLanguage: () => ({ t: (key: string) => key }),
}))
mock.module("@/utils/toast", () => ({
  showToast: () => undefined,
}))
mock.module("@tanstack/solid-query", () => ({
  useMutation: (factory: () => MutationOptions) => {
    const options = factory()
    const mutation: Mutation = {
      options,
      isPending: false,
      mutateAsync: async (input: unknown) => {
        options.onMutate?.()
        try {
          const result = await options.mutationFn(input)
          options.onSuccess?.(result, input)
          return result
        } catch (error) {
          options.onError?.(error)
          throw error
        }
      },
    }
    mutations.push(mutation)
    return mutation
  },
}))

mock.module("@opencode-ai/ui/context", () => ({
  createSimpleContext: (input: { init: (props: Record<string, never>) => unknown }) => {
    const context = createContext<unknown>()
    return {
      provider: (props: { children: unknown }) =>
        createComponent(context.Provider, {
          value: input.init({}),
          get children() {
            return props.children
          },
        }),
      use: () => {
        const value = useContext(context)
        if (value === undefined) throw new Error("Local context is unavailable")
        return value
      },
    }
  },
}))

let LocalProvider: typeof import("@/context/local").LocalProvider
let useLocal: typeof import("@/context/local").useLocal
let SessionQuestionDock: typeof import("@/pages/session/composer/session-question-dock").SessionQuestionDock

beforeAll(async () => {
  ;({ LocalProvider, useLocal } = await import("@/context/local"))
  ;({ SessionQuestionDock } = await import("@/pages/session/composer/session-question-dock"))
})

beforeEach(() => {
  values.clear()
  setDirectory("/repo")
  setSessionID("session-delayed-agents")
  setPlatform("desktop")
  setWrites([])
  setReads([])
  setParts({})
  setReplyFailure(false)
  setReplies(0)
  mutations.length = 0
})

function Capture(props: { onReady: (value: ReturnType<typeof useLocal>) => void }) {
  props.onReady(useLocal())
  return null
}

test("persists Build intent before the Desktop agent catalog hydrates", async () => {
  setAgents([])
  setWrites([])
  const root = document.createElement("div")
  document.body.append(root)

  await new Promise<void>((resolve, reject) => {
    let local: ReturnType<typeof useLocal> | undefined
    let dispose = () => {}
    const finish = (error?: unknown) => {
      clearTimeout(timeout)
      stop()
      dispose()
      root.remove()
      if (error) reject(error)
      else resolve()
    }
    const timeout = setTimeout(() => finish(new Error("Build intent was not persisted before agent hydration")), 1_000)
    const stop = createRoot((disposeWatch) => {
      createEffect(() => {
        const values = writes()
        const defaultSaved = values.some((item) => item.key === "agent-default" && item.value === '{"agent":"build"}')
        const sessionSaved = values.some((item) => {
          if (item.key !== "workspace:model-selection") return false
          return (JSON.parse(item.value) as { session?: Record<string, { agent?: string }> }).session?.[
            "session-delayed-agents"
          ]?.agent === "build"
        })
        if (!defaultSaved || !sessionSaved) return
        try {
          expect(local?.agent.current()?.name).toBe("build")
          finish()
        } catch (error) {
          finish(error)
        }
      })
      return disposeWatch
    })
    dispose = render(
      () =>
        createComponent(LocalProvider, {
          get children() {
            return createComponent(Capture, {
              onReady(value) {
              local = value
              value.agent.set("build")
              value.agent.setDefault("build")
              setAgents([
                { name: "plan", mode: "primary", hidden: false },
                { name: "build", mode: "primary", hidden: false },
              ])
              },
            })
          },
        }),
      root,
    )
  })
})
test("does not touch the Desktop default storage on Web", () => {
  const key = "opencode.global.dat:agent-default"
  const sentinel = "{malformed"
  const getItem = localStorage.getItem.bind(localStorage)
  const removeItem = localStorage.removeItem.bind(localStorage)
  localStorage.setItem(key, sentinel)
  let reads = 0
  let removals = 0
  localStorage.getItem = (name) => {
    if (name === key) reads++
    return getItem(name)
  }
  localStorage.removeItem = (name) => {
    if (name === key) removals++
    removeItem(name)
  }
  const root = document.createElement("div")
  document.body.append(root)
  setPlatform("web")
  const dispose = render(() => createComponent(LocalProvider, { children: null }), root)

  try {
    expect(getItem(key)).toBe(sentinel)
    expect(reads).toBe(0)
    expect(removals).toBe(0)
  } finally {
    dispose()
    root.remove()
    localStorage.getItem = getItem
    localStorage.removeItem = removeItem
    localStorage.removeItem(key)
    setPlatform("desktop")
  }
})

function resetDesktop() {
  setAgents([
    { name: "plan", mode: "primary", hidden: false },
    { name: "build", mode: "primary", hidden: false },
  ])
  setDirectory("/repo")
  setSessionID("session-plan")
  setPlatform("desktop")
  setWrites([])
  setParts({
    "message-plan": [
      {
        type: "tool",
        messageID: "message-plan",
        callID: "call-plan-exit",
        tool: "plan_exit",
      },
    ],
  })
}

function request() {
  return {
    id: "question-plan-exit",
    sessionID: "session-plan",
    tool: { messageID: "message-plan", callID: "call-plan-exit" },
    questions: [
      {
        header: "Build Agent",
        question: "The plan is ready. Would you like to switch to Build?",
        custom: false,
        multiple: false,
        options: [
          { label: "Build now", description: "Switch to Build and send an implementation request" },
          { label: "Keep planning", description: "Stay in Plan mode and refine the plan" },
        ],
      },
    ],
  }
}

async function waitFor(check: () => boolean, timeout: number = 1_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`condition did not become true within ${timeout}ms`)
}
function DockCapture(props: { onReady: (value: ReturnType<typeof useLocal>) => void }) {
  const local = useLocal()
  props.onReady(local)
  const target = globalThis as typeof globalThis & {
    React?: { createElement: (...input: unknown[]) => null }
    Fragment_8vg9x3sq?: () => null
  }
  const previousReact = target.React
  const previousFragment = target.Fragment_8vg9x3sq
  target.React = { createElement: () => null }
  target.Fragment_8vg9x3sq = () => null
  try {
    createComponent(SessionQuestionDock, { request: request(), onSubmit: () => {} })
  } finally {
    if (previousReact) target.React = previousReact
    if (!previousReact) delete target.React
    if (previousFragment) target.Fragment_8vg9x3sq = previousFragment
    if (!previousFragment) delete target.Fragment_8vg9x3sq
  }
  return null
}

test("persists a successful dock approval across a Desktop provider restart", async () => {
  resetDesktop()
  const root = document.createElement("div")
  document.body.append(root)
  let local: ReturnType<typeof useLocal> | undefined
  const dispose = render(
    () =>
      createComponent(LocalProvider, {
        get children() {
          return createComponent(DockCapture, {
            onReady(value) {
              local = value
              value.agent.set("plan")
            },
          })
        },
      }),
    root,
  )

  try {
    await waitFor(() => local?.agent.current()?.name === "plan")
    expect(mutations).toHaveLength(2)
    await mutations[0]!.mutateAsync([["Build now"]])

    await waitFor(
      () =>
        replies() === 1 &&
        local?.agent.current()?.name === "build" &&
        values.get("agent-default") === '{"agent":"build"}',
    )
    expect(values.get("agent-default")).toBe('{"agent":"build"}')
  } finally {
    dispose()
    root.remove()
  }

  setDirectory("/other")
  setSessionID(undefined)
  setReads([])
  const restarted = document.createElement("div")
  document.body.append(restarted)
  let remounted: ReturnType<typeof useLocal> | undefined
  const disposeRestarted = render(
    () =>
      createComponent(LocalProvider, {
        get children() {
          return createComponent(Capture, {
            onReady(value) {
              remounted = value
            },
          })
        },
      }),
    restarted,
  )

  try {
    await waitFor(() => reads().includes("agent-default"))
    remounted!.agent.set("plan")
    await waitFor(() => remounted?.agent.current()?.name === "plan")
    expect(remounted?.agent.current()?.name).toBe("plan")
    remounted!.session.reset()
    await waitFor(() => remounted?.agent.current()?.name === "build")
    expect(remounted?.agent.current()?.name).toBe("build")
  } finally {
    disposeRestarted()
    restarted.remove()
  }
})

test("does not persist Build when the Desktop dock reply fails", async () => {
  resetDesktop()
  setReplyFailure(true)
  const root = document.createElement("div")
  document.body.append(root)
  let local: ReturnType<typeof useLocal> | undefined
  const dispose = render(
    () =>
      createComponent(LocalProvider, {
        get children() {
          return createComponent(DockCapture, {
            onReady(value) {
              local = value
              value.agent.set("plan")
            },
          })
        },
      }),
    root,
  )

  try {
    await waitFor(() => local?.agent.current()?.name === "plan")
    expect(mutations).toHaveLength(2)
    await expect(mutations[0]!.mutateAsync([["Build now"]])).rejects.toThrow("reply failed")
    await waitFor(() => replies() === 1)
    expect(local?.agent.current()?.name).toBe("plan")
    expect(values.get("agent-default")).toBeUndefined()
  } finally {
    dispose()
    root.remove()
  }
})
