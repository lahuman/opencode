import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { Agent, Config, OpencodeClient, Project, Session } from "@opencode-ai/sdk/v2/client"
import type { AgentApi, CatalogApi, CommandApi, ReferenceApi } from "@opencode-ai/client/promise"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import {
  bootstrapDirectory,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
  refreshPendingRequests,
} from "./bootstrap"
import type { State, VcsCache } from "./types"
import { createServerSession } from "../server-session"
import { parseModelSelection, resolveModelRecovery } from "../model-selection"
import { ServerScope } from "@/utils/server-scope"
import type { ServerApi } from "@/utils/server"

type ProjectApi = ServerApi["project"]

const provider = { all: new Map(), connected: [], default: {} } satisfies NormalizedProviderListResponse
const api = {
  agent: { list: async () => ({ location: {}, data: [] }) },
  provider: { list: async () => ({ location: {}, data: [] }) },
  model: {
    list: async () => ({ location: {}, data: [] }),
    default: async () => ({ location: {}, data: null }),
  },
  permission: { request: { list: async () => ({ location: {}, data: [] }) } },
  project: {
    list: async () => [],
    current: async () => ({ id: "project", directory: "/project" }),
  },
  question: { request: { list: async () => ({ location: {}, data: [] }) } },
  reference: { list: async () => ({ location: {}, data: [] }) },
  vcs: { get: async () => ({ location: {}, data: {} }) },
} as unknown as ServerApi

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
    session_message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

function sessionInfo(id: string): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/project",
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  }
}

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
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
        permission: { list: async () => ({ data: [] }) },
        question: { list: async () => ({ data: [] }) },
        v2: { reference: { list: async () => ({ data: { data: [] } }) } },
        provider: { list: () => providers.promise },
      } as unknown as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v1"),
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
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key: string) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v1" as const),
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
    queryClient.setQueryData(
      loadAgentsQuery(ServerScope.local, "/project", api.agent, {} as OpencodeClient, Promise.resolve("v1")).queryKey,
      [{ name: "stale", mode: "primary", permission: [], options: {} }],
    )

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
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient,
      protocol: Promise.resolve("v1"),
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

    expect(store.agent[0]?.name).toBe("fresh")
    expect(store.config.model).toBe("company/config")
    expect(recover()?.next).toEqual({ providerID: "company", modelID: "agent" })
  })

  test("preserves stale busy status while warming session info stalls", async () => {
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
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      v2: { reference: { list: async () => ({ data: { data: [] } }) } },
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
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      session,
      protocol: Promise.resolve("v1"),
    })
    let settled = false
    void refreshing.then(() => {
      settled = true
    })

    await waitFor(() => session.data.session_working("ses_busy"))

    expect(session.data.session_status["ses_busy"]?.type).toBe("busy")
    expect(session.data.session_status[stale.id]?.type).toBe("busy")
    expect(settled).toBe(false)
  })

  test("uses legacy MCP endpoints while refreshing a v1 directory", async () => {
    const legacyConfigReads: string[] = []
    const mcpReads: string[] = []
    const [store, setStore] = directoryState()

    const refreshing = bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: true,
      global: {
        config: {} satisfies Config,
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      sdk: {
        app: { agents: async () => ({ data: [{ name: "build", mode: "primary" }] }) },
        config: {
          get: async () => {
            legacyConfigReads.push("directory")
            return { data: {} }
          },
        },
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
        experimental: {
          resource: {
            list: async () => {
              mcpReads.push("resource")
              return { data: {} }
            },
          },
        },
        provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      } as unknown as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v1"),
    })

    expect(store.status).toBe("partial")

    await refreshing

    expect(store.status).toBe("complete")
    expect(legacyConfigReads).toEqual(["directory"])
    expect(mcpReads.sort()).toEqual(["command", "resource", "status"])
  })

  test("skips legacy config while refreshing a v2 directory", async () => {
    const [store, setStore] = directoryState()

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
        config: {
          get: async () => {
            throw new Error("legacy directory config should not be called")
          },
        },
      } as unknown as OpencodeClient,
      api,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      protocol: Promise.resolve("v2"),
    })

    expect(store.status).toBe("partial")

    await refreshing

    expect(store.status).toBe("complete")
  })
})

describe("refreshPendingRequests", () => {
  test("uses legacy pending request lists and clears stale requests", async () => {
    const [store, setStore] = directoryState()
    const permission = {
      id: "perm_v1",
      sessionID: "ses_pending",
      permission: "bash",
      patterns: ["git status"],
      always: ["git *"],
      metadata: { command: "git status" },
      tool: { messageID: "msg_v1", callID: "call_v1" },
    }
    const question = {
      id: "question_v1",
      sessionID: "ses_pending",
      questions: [{
        header: "Plan complete",
        question: "Build the approved plan?",
        options: [
          { label: "Build now", description: "Switch to Build" },
          { label: "Keep planning", description: "Stay in Plan" },
        ],
      }],
      tool: { messageID: "msg_v1", callID: "call_v1" },
    }
    let permissionCalls = 0
    let questionCalls = 0
    const client = {
      permission: { list: async () => { permissionCalls++; return { data: [permission] } } },
      question: { list: async () => { questionCalls++; return { data: [question] } } },
    } as unknown as OpencodeClient
    const session = createServerSession(client)
    session.remember(sessionInfo("ses_pending"))
    session.remember(sessionInfo("ses_stale"))
    session.set("permission", "ses_stale", [{ ...permission, id: "perm_stale", sessionID: "ses_stale" }])
    session.set("question", "ses_stale", [{ ...question, id: "question_stale", sessionID: "ses_stale" }])

    await refreshPendingRequests({
      directory: "/project",
      sdk: client,
      api: {
        permission: { request: { list: async () => Promise.reject(new Error("v2 permission list should not be called")) } },
        question: { request: { list: async () => Promise.reject(new Error("v2 question list should not be called")) } },
      } as unknown as ServerApi,
      store,
      setStore,
      session,
      protocol: Promise.resolve("v1"),
    })

    expect(permissionCalls).toBe(1)
    expect(questionCalls).toBe(1)
    expect(session.data.permission.ses_pending).toEqual([permission])
    expect(session.data.question.ses_pending).toEqual([question])
    expect(session.data.permission.ses_stale).toEqual([])
    expect(session.data.question.ses_stale).toEqual([])
  })

  test("uses location-scoped v2 pending request lists and normalizes permissions", async () => {
    const [store, setStore] = directoryState()
    const rawPermission = {
      id: "perm_v2",
      sessionID: "ses_pending",
      action: "bash",
      resources: ["git status"],
      save: ["git *"],
      metadata: { command: "git status" },
      source: { type: "tool", messageID: "msg_v2", callID: "call_v2" },
    }
    const question = {
      id: "question_v1",
      sessionID: "ses_pending",
      questions: [{
        header: "Plan complete",
        question: "Build the approved plan?",
        options: [
          { label: "Build now", description: "Switch to Build" },
          { label: "Keep planning", description: "Stay in Plan" },
        ],
      }],
      tool: { messageID: "msg_v1", callID: "call_v1" },
    }
    const permissionInputs: unknown[] = []
    const questionInputs: unknown[] = []
    const client = {
      permission: { list: async () => Promise.reject(new Error("legacy permission list should not be called")) },
      question: { list: async () => Promise.reject(new Error("legacy question list should not be called")) },
    } as unknown as OpencodeClient
    const session = createServerSession(client)
    session.remember(sessionInfo("ses_pending"))

    await refreshPendingRequests({
      directory: "/project",
      sdk: client,
      api: {
        permission: { request: { list: async (input: unknown) => { permissionInputs.push(input); return { location: {}, data: [rawPermission] } } } },
        question: { request: { list: async (input: unknown) => { questionInputs.push(input); return { location: {}, data: [question] } } } },
      } as unknown as ServerApi,
      store,
      setStore,
      session,
      protocol: Promise.resolve("v2"),
    })

    expect(permissionInputs).toEqual([{ location: { directory: "/project" } }])
    expect(questionInputs).toEqual([{ location: { directory: "/project" } }])
    expect(session.data.permission.ses_pending).toEqual([{
      id: "perm_v2",
      sessionID: "ses_pending",
      permission: "bash",
      patterns: ["git status"],
      always: ["git *"],
      metadata: { command: "git status" },
      tool: { messageID: "msg_v2", callID: "call_v2" },
    }])
    expect(session.data.question.ses_pending).toEqual([question])
  })

  test("keeps live request changes while pending request lists are in flight", async () => {
    const [store, setStore] = directoryState()
    const permissions = Promise.withResolvers<{ data: unknown[] }>()
    const questions = Promise.withResolvers<{ data: unknown[] }>()
    const question = {
      id: "question_old",
      sessionID: "ses_pending",
      questions: [],
      tool: { messageID: "msg_old", callID: "call_old" },
    }
    let permissionCalls = 0
    let questionCalls = 0
    const client = {
      permission: { list: () => { permissionCalls++; return permissions.promise } },
      question: { list: () => { questionCalls++; return questions.promise } },
    } as unknown as OpencodeClient
    const session = createServerSession(client)
    session.remember(sessionInfo("ses_pending"))
    session.set("question", "ses_pending", [question])

    const refreshing = refreshPendingRequests({
      directory: "/project",
      sdk: client,
      api: {} as ServerApi,
      store,
      setStore,
      session,
      protocol: Promise.resolve("v1"),
    })
    await waitFor(() => permissionCalls === 1 && questionCalls === 1)

    session.apply({
      type: "permission.asked",
      properties: {
        id: "perm_live",
        sessionID: "ses_pending",
        permission: "bash",
        patterns: ["git status"],
        always: [],
        metadata: {},
        tool: { messageID: "msg_live", callID: "call_live" },
      },
    })
    session.apply({ type: "question.replied", properties: { sessionID: "ses_pending", requestID: "question_old" } })
    permissions.resolve({
      data: [{
        id: "perm_old",
        sessionID: "ses_pending",
        permission: "bash",
        patterns: ["git status"],
        always: [],
        metadata: {},
        tool: { messageID: "msg_old", callID: "call_old" },
      }],
    })
    questions.resolve({ data: [question] })
    await refreshing

    expect(session.data.permission.ses_pending?.map((item) => item.id)).toEqual(["perm_live"])
    expect(session.data.question.ses_pending).toEqual([])
  })
})

describe("config queries", () => {
  test("skips legacy global config for v2 servers", async () => {
    const sdk = {
      global: {
        config: {
          get: async () => {
            throw new Error("legacy global config should not be called")
          },
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadGlobalConfigQuery(ServerScope.local, sdk, Promise.resolve("v2")),
    )

    expect(result).toEqual({})
  })

  test("loads legacy global config for v1 servers", async () => {
    const calls: string[] = []
    const config = { shell: "zsh" } satisfies Config
    const sdk = {
      global: {
        config: {
          get: async () => {
            calls.push("global")
            return { data: config }
          },
        },
      },
    } as unknown as OpencodeClient

    const result = await new QueryClient().fetchQuery(
      loadGlobalConfigQuery(ServerScope.local, sdk, Promise.resolve("v1")),
    )

    expect(result).toEqual(config)
    expect(calls).toEqual(["global"])
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
    const client = {} as Parameters<typeof loadPathQuery>[2]
    const api = {} as CatalogApi
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", client).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", client).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, api).queryKey]).toEqual(["https://debian.example", null, "providers"])
  })

  test("loads the current provider and model catalog", async () => {
    const calls: unknown[] = []
    const api = {
      provider: {
        list: async (input: unknown) => {
          calls.push(["provider", input])
          return { location: {}, data: [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai" }] }
        },
      },
      model: {
        list: async (input: unknown) => {
          calls.push(["model", input])
          return { location: {}, data: [] }
        },
        default: async (input: unknown) => {
          calls.push(["default", input])
          return { location: {}, data: null }
        },
      },
    } as unknown as CatalogApi

    const result = await new QueryClient().fetchQuery(loadProvidersQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([
      ["provider", { location: { directory: "/repo" } }],
      ["model", { location: { directory: "/repo" } }],
      ["default", { location: { directory: "/repo" } }],
    ])
    expect(result.connected).toEqual(["openai"])
  })

  test("loads agents from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [] }
      },
    } as unknown as AgentApi

    const result = await new QueryClient().fetchQuery(loadAgentsQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([])
  })

  test("loads commands from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return {
          location: {},
          data: [{ name: "review", template: "Review files" /* source: "command" as const */ }],
        }
      },
    } as unknown as CommandApi

    const result = await loadCommands("/repo", api)

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toEqual([{ name: "review", template: "Review files" /* source: "command" */ }])
  })

  test("loads projects from the current endpoint", async () => {
    const api = {
      list: async () => [
        { id: "b", worktree: "/b", time: { created: 1, updated: 1 }, sandboxes: [] },
        { id: "a", worktree: "/a", time: { created: 1, updated: 1 }, sandboxes: [] },
      ],
    } as unknown as ProjectApi

    const result = await new QueryClient().fetchQuery(loadProjectsQuery(ServerScope.local, api))

    expect(result.map((project) => project.id)).toEqual(["a", "b"])
  })

  test("loads references from the current location-scoped endpoint", async () => {
    const calls: unknown[] = []
    const api = {
      list: async (input: unknown) => {
        calls.push(input)
        return { location: {}, data: [{ name: "AGENTS.md", path: "/repo/AGENTS.md", source: "instructions" }] }
      },
    } as unknown as ReferenceApi

    const result = await new QueryClient().fetchQuery(loadReferencesQuery(ServerScope.local, "/repo", api))

    expect(calls).toEqual([{ location: { directory: "/repo" } }])
    expect(result).toHaveLength(1)
  })
})
