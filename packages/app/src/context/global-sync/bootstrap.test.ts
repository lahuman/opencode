import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Agent, Config, OpencodeClient, Project, Session } from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { bootstrapDirectory, loadAgentsQuery, loadPathQuery, loadProvidersQuery } from "./bootstrap"
import type { State, VcsCache } from "./types"
import { createServerSession } from "../server-session"
import { ServerScope } from "@/utils/server-scope"
import { parseModelSelection, resolveModelRecovery } from "../model-selection"

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const [store, setStore] = directoryState()
    const providers = Promise.withResolvers<{
      data: { all: []; connected: string[]; default: Record<string, string> }
    }>()

    const refreshing = bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: { get: async () => ({ data: {} }) },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        command: {
          list: async () => {
            mcpReads.push("command")
            return { data: [] }
          },
        },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: { reference: { list: async () => ({ data: { data: [] } }) } },
        mcp: {
          status: async () => {
            mcpReads.push("status")
            return { data: {} }
          },
        },
        provider: { list: () => providers.promise },
      } as unknown as OpencodeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })
    let settled = false
    void refreshing.then(() => {
      settled = true
    })

    expect(store.status).toBe("partial")
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    providers.resolve({ data: { all: [], connected: [], default: {} } })
    await refreshing

    expect(store.status).toBe("complete")
    expect(mcpReads).toEqual([])
  })

  test("finishes one directory refresh before a sequential refresh can write", async () => {
    const [store, setStore] = directoryState()
    const firstConfig = Promise.withResolvers<{ data: Config }>()
    let configReads = 0
    const sdk = {
      app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
      config: {
        get: () => {
          configReads++
          if (configReads === 1) return firstConfig.promise
          return Promise.resolve({ data: { model: "company/second" } })
        },
      },
      session: { status: async () => ({ data: {} }) },
      vcs: { get: async () => ({ data: undefined }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      v2: { reference: { list: async () => ({ data: { data: [] } }) } },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as unknown as OpencodeClient
    const input = {
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key: string) => key,
      queryClient: new QueryClient(),
    }

    const first = bootstrapDirectory(input)
    const sequential = first.then(() => bootstrapDirectory(input))
    await waitFor(() => configReads > 0)

    expect(configReads).toBe(1)

    firstConfig.resolve({ data: { model: "company/first" } })
    await sequential

    expect(configReads).toBe(2)
    expect(store.config.model).toBe("company/second")
    expect(store.status).toBe("complete")
  })

  test("keeps a cached directory partial until refreshed agents, config, and providers all arrive", async () => {
    const [store, setStore] = directoryState()
    setStore("status", "complete")
    setStore("agent", [{ name: "stale", mode: "primary", permission: [], options: {} }])
    setStore("config", { model: "stale/model" })
    const agents = Promise.withResolvers<{ data: Agent[] }>()
    const config = Promise.withResolvers<{ data: Config }>()
    const providers = Promise.withResolvers<{
      data: { all: []; connected: string[]; default: Record<string, string> }
    }>()
    const queryClient = new QueryClient()
    queryClient.setQueryData(loadAgentsQuery(ServerScope.local, "/project", {} as OpencodeClient).queryKey, [
      { name: "stale", mode: "primary", permission: [], options: {} },
    ])

    const refreshing = bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: () => agents.promise },
        config: { get: () => config.promise },
        session: { status: async () => ({ data: {} }) },
        vcs: { get: async () => ({ data: undefined }) },
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: { reference: { list: async () => ({ data: { data: [] } }) } },
        provider: { list: () => providers.promise },
      } as unknown as OpencodeClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient,
    })
    const recover = () =>
      resolveModelRecovery({
        ready: store.status === "complete",
        previous: { providerID: "deleted", modelID: "old" },
        candidates: [store.agent[0]?.model, parseModelSelection(store.config.model)],
        valid: (model) => model.providerID === "company",
      })

    expect(store.status).toBe("partial")
    expect(recover()).toBeUndefined()
    await waitFor(() => queryClient.isFetching() === 2)
    expect(store.agent[0]?.name).toBe("stale")
    expect(store.config.model).toBe("stale/model")

    agents.resolve({
      data: [
        {
          name: "fresh",
          mode: "primary",
          model: { providerID: "company", modelID: "agent" },
          permission: [],
          options: {},
        },
      ],
    })
    config.resolve({ data: { model: "company/config" } })
    await Promise.resolve()
    expect(store.status).toBe("partial")
    expect(recover()).toBeUndefined()

    providers.resolve({ data: { all: [], connected: [], default: {} } })
    await refreshing
    await waitFor(() => store.status === "complete")

    expect(store.status).toBe("complete")
    expect(store.agent[0]?.name).toBe("fresh")
    expect(store.config.model).toBe("company/config")
    expect(recover()?.next).toEqual({ providerID: "company", modelID: "agent" })
  })

  test("seeds session status even while warming session info stalls", async () => {
    const [store, setStore] = directoryState()
    const stalled = Promise.withResolvers<never>()
    const client = {
      app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
      config: { get: async () => ({ data: {} }) },
      session: {
        status: async () => ({ data: { ses_busy: { type: "busy" } } }),
        get: () => stalled.promise,
      },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      v2: { reference: { list: async () => ({ data: { data: [] } }) } },
      mcp: { status: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as unknown as OpencodeClient
    const session = createServerSession(client)
    const stale: Session = {
      id: "ses_stale",
      slug: "ses_stale",
      projectID: "project",
      directory: "/project",
      title: "stale",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    session.remember(stale)
    session.set("session_status", stale.id, { type: "busy" })

    const refreshing = bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: client,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      session,
    })
    let settled = false
    void refreshing.then(() => {
      settled = true
    })

    const deadline = Date.now() + 500
    while (!session.data.session_working("ses_busy") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(session.data.session_status["ses_busy"]?.type).toBe("busy")
    expect(session.data.session_status[stale.id]).toBeUndefined()
    expect(settled).toBe(false)
  })
})

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for bootstrap queries")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const client = {} as OpencodeClient
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, client).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
  })
})
