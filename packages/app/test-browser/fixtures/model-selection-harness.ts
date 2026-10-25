import { afterEach, mock } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, createRoot } from "solid-js"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import type { FormInfo, SessionFormReplyInput } from "@opencode/client/promise"
import type { Agent } from "@/runtime/server/types"
import type { ModelKey } from "@/providers/models/selection"
import { ServerScope } from "@/runtime/server/scope"

// Bun does not compile Solid JSX. Compile the real context provider with the
// same presets as Vite, along with every TSX module it loads, instead of
// replacing LocalProvider's implementation.
const require = createRequire(import.meta.url)

const solid = createRequire(require.resolve("vite-plugin-solid"))

const { transformSync } = solid("@babel/core")

Bun.plugin({
  name: "selection-solid-context",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      contents: transformSync(await Bun.file(args.path).text(), {
        filename: args.path,
        presets: [solid.resolve("babel-preset-solid"), solid.resolve("@babel/preset-typescript")],
      }).code,
      loader: "js",
    }))
  },
})

type Commit = { agent?: string; model?: { providerID: string; id: string; variant?: string } }

type Event = { data: { sessionID: string } }

type ConfigModel = string | { providerID: string; model: string; variant?: string }

export const key = (modelID: string): ModelKey => ({ providerID: "provider", modelID })

export const durable = (modelID: string, variant?: string, agent = "build"): Commit => ({
  agent,
  model: { providerID: "provider", id: modelID, variant },
})

export const agent = (name: string, model?: ModelKey, variant?: string): Agent => ({
  name,
  mode: "primary",
  permission: [],
  options: {},
  model,
  variant,
})

let active: ReturnType<typeof fixture>

mock.module("@solidjs/router", () => ({ useParams: () => active.state.route }))

mock.module("@/runtime/server/current", () => ({ useData: () => active.data }))

mock.module("@/runtime/server/client", () => ({ useServerSDK: () => active.sdk }))

mock.module("@/runtime/server/runtime", () => ({ useGlobal: () => ({ models: active.preferences }) }))

mock.module("@/workspaces/location", () => ({ useWorkspaceLocation: () => () => ({ directory: active.directory }) }))

mock.module("@/settings/model", () => ({
  useSettings: () => ({ visibility: { customAgents: () => active.state.visible }, keybinds: { get: () => undefined } }),
}))

mock.module("@/composer/persistence", () => ({ useComposerState: () => active.prompt }))

mock.module("@/shell/state/layout", () => ({ useLayout: () => undefined }))

mock.module("@/runtime/platform/platform", () => ({
  usePlatform: () => active.platform,
}))

const { LocalProvider, useLocal } = await import("@/providers/models/selection")

const { ModelsProvider } = await import("@/providers/models/models")

const { Persist } = await import("@/runtime/persistence/storage")

const { createMemoryComposerState } = await import("@/composer/state")

const { createComposerModelSelection } = await import("@/composer/selection")
const { LanguageProvider, UiI18nBridge } = await import("@/runtime/i18n/language")
const { DialogProvider } = await import("@opencode/ui/context/dialog")
const { CommandProvider } = await import("@/shell/commands/command")
const { SessionQuestionDock } = await import("@/session/requests/session-question-dock")

const cleanups: Array<() => void> = []

afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

export function fixture(
  input: {
    session?: Commit
    agents?: Agent[]
    config?: ConfigModel
    preferred?: string
    platform?: "desktop" | "web"
    storage?: Map<string, string>
    reply?: (input: SessionFormReplyInput) => Promise<void>
  } = {},
) {
  const directory = `/selection-test/${crypto.randomUUID()}`
  const values = input.storage ?? new Map<string, string>()
  const reads: string[] = []
  const replies: SessionFormReplyInput[] = []

  // SAFETY: fixture transitions clear the route as well as selecting session IDs.
  const [state, set] = createStore({
    visible: true,
    configLoaded: true,
    connection: "connected",
    route: { id: "ses_a" as string | undefined },
    agents: input.agents ?? [agent("build"), agent("plan")],
    config: input.config,
    sessions: Object.fromEntries([["ses_a", input.session]]),
    providers: [{ id: "provider", name: "Provider", package: "@ai-sdk/test", activation: "enabled" }],
    models: ["a", "b", "c"].map((id) => ({
      id,
      modelID: id,
      providerID: "provider",
      name: `Model ${id}`,
      settings: {},
      headers: {},
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: ["low", "high"].map((id) => ({ id, settings: {} })),
      time: { released: 1 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 128_000, output: 8192 },
    })),
  })

  // SAFETY: empty collections are valid preferences; tests later populate them with the declared model keys and variants.
  const [preferences, setPreferences] = createStore({
    user: [] as Array<ModelKey & { visibility: "show" | "hide" }>,
    recent: [] as ModelKey[],
    variant: (input.preferred ? { "provider/a": input.preferred } : {}) as Record<string, string>,
  })

  const events = new Map<string, Set<(event: Event) => void>>()
  const configLoads: string[] = []

  const result = {
    values,
    reads,
    replies,
    platform: {
      platform: input.platform ?? "web",
      storage: (name = "default") => ({
        getItem: async (key: string) => {
          reads.push(`${name}:${key}`)
          return values.get(`${name}:${key}`) ?? null
        },
        setItem: async (key: string, value: string) => {
          values.set(`${name}:${key}`, value)
        },
        removeItem: async (key: string) => {
          values.delete(`${name}:${key}`)
        },
      }),
      openExternal() {},
      restart: async () => {},
      notify: async () => {},
    },
    prompt: createMemoryComposerState(),
    directory,
    state,
    set,
    setPreferences,
    preferences: { store: preferences, set: setPreferences, ready: () => true, recent: () => preferences.recent },
    data: {
      session: { get: (id: string) => state.sessions[id], message: { list: () => [] } },
      location: {
        agent: { list: () => state.agents },
        config: {
          list: () => (state.configLoaded ? [{ type: "document", info: { model: state.config } }] : undefined),
          sync: async () => {
            configLoads.push(state.connection)
          },
        },
        provider: { list: () => state.providers },
        model: { list: () => state.models },
        integration: { list: () => [] },
      },
    },
    sdk: {
      scope: ServerScope.local,
      api: {
        session: {
          form: {
            reply: async (request: SessionFormReplyInput) => {
              replies.push(request)
              await input.reply?.(request)
            },
            cancel: async () => {},
          },
        },
      },
      connection: { status: () => state.connection },
      event: {
        on(type: string, handler: (event: Event) => void) {
          const handlers = events.get(type) ?? new Set()
          events.set(type, handlers)
          handlers.add(handler)

          return () => handlers.delete(handler)
        },
      },
    },
    emit(type: string, sessionID = "ses_a") {
      events.get(type)?.forEach((handler) => handler({ data: { sessionID } }))
    },
    configLoads,
    mount(draft = false, request?: FormInfo) {
      active = result
      let local!: ReturnType<typeof useLocal>
      let composer: ReturnType<typeof createComposerModelSelection> | undefined

      const element = document.createElement("div")
      const query = new QueryClient()
      const view = () =>
        createComponent(LanguageProvider, {
          locale: "en",
          get children() {
            return createComponent(ModelsProvider, {
              directory,
              get children() {
                return createComponent(LocalProvider, {
                  get children() {
                    local = useLocal()

                    if (draft) composer = createComposerModelSelection({ agent: local.agent.current })

                    if (!request) return null
                    return createComponent(QueryClientProvider, {
                      client: query,
                      get children() {
                        return createComponent(UiI18nBridge, {
                          get children() {
                            return createComponent(DialogProvider, {
                              get children() {
                                return createComponent(CommandProvider, {
                                  get children() {
                                    return createComponent(SessionQuestionDock, { request, onSubmit() {} })
                                  },
                                })
                              },
                            })
                          },
                        })
                      },
                    })
                  },
                })
              },
            })
          },
        })
      if (request) document.body.append(element)
      const dispose = request
        ? render(view, element)
        : createRoot((dispose) => {
            view()
            return dispose
          })
      const cleanup = () => {
        dispose()
        element.remove()
        query.clear()
      }
      cleanups.push(cleanup)
      return { local, composer, dispose: cleanup, element, query }
    },
  }

  const target = Persist.serverWorkspace(ServerScope.local, directory, "model-selection")
  cleanups.push(() => localStorage.removeItem(`${target.storage}:${target.key}`))

  return result
}

export function selection(local: ReturnType<typeof useLocal>) {
  return {
    agent: local.agent.current()?.name,
    model: local.model.current()?.id,
    variant: local.model.variant.current(),
  }
}
