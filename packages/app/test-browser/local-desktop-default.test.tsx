import { beforeAll, expect, mock, test } from "bun:test"
import type { AsyncStorage } from "@solid-primitives/storage"
import { createComponent, createContext, createEffect, createRoot, createSignal, useContext } from "solid-js"
import { render } from "solid-js/web"

const [agents, setAgents] = createSignal<Array<{ name: string; mode: string; hidden: boolean }>>([])
const [writes, setWrites] = createSignal<Array<{ key: string; value: string }>>([])

const storage: AsyncStorage = {
  getItem: async () => null,
  setItem: async (key, value) => {
    setWrites((items) => [...items, { key, value }])
  },
  removeItem: async () => undefined,
  clear: async () => undefined,
  key: async () => null,
  getLength: async () => 0,
  length: Promise.resolve(0),
}

mock.module("@solidjs/router", () => ({
  useParams: () => ({ id: "session-delayed-agents" }),
}))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({ platform: "desktop", storage: () => storage }),
}))
mock.module("@/context/sdk", () => ({
  useSDK: () => () => ({ directory: "/repo", event: { on: () => () => {} } }),
}))
mock.module("@/context/sync", () => ({
  useSync: () => () => ({
    status: "complete",
    data: { agent: agents(), config: {}, provider_ready: true },
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

beforeAll(async () => {
  ;({ LocalProvider, useLocal } = await import("@/context/local"))
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
