import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  McpListInput,
  McpResourceCatalogInput,
  SessionApi,
  SessionInfo,
  SessionListInput,
} from "@opencode-ai/client/promise"
import { QueryClient } from "@tanstack/solid-query"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadRootSessions } from "./global-sync/session-load"
import {
  loadActiveSessionsQuery,
  activeCheckAccepted,
  hydrateRecoveredSessions,
  loadMcpQuery,
  loadMcpResourcesQuery,
  reconcileActiveSessionStatuses,
  staleBusySessionIDs,
} from "./server-sync"
import { ServerScope } from "@/utils/server-scope"
import { createServerSession } from "./server-session"
import type { ServerApi } from "@/utils/server"

type McpApi = ServerApi["mcp"]

describe("MCP queries", () => {
  test("loads current servers for the requested location", async () => {
    const calls: unknown[] = []
    const queryClient = new QueryClient()
    const result = await queryClient.fetchQuery(
      loadMcpQuery(ServerScope.local, "/project", {
        list: async (input: McpListInput = {}) => {
          calls.push(input)
          return {
            location: { directory: "/project", project: { id: "project", directory: "/project" } },
            data: [
              { name: "docs", status: { status: "connected" } },
              { name: "search", status: { status: "pending" } },
            ],
          }
        },
      } as unknown as McpApi),
    )

    expect(calls).toEqual([{ location: { directory: "/project" } }])
    expect(result).toEqual({ docs: { status: "connected" }, search: { status: "pending" } })
  })

  test("loads and keys the current resource catalog", async () => {
    const calls: unknown[] = []
    const queryClient = new QueryClient()
    const result = await queryClient.fetchQuery(
      loadMcpResourcesQuery(ServerScope.local, "/project", {
        resource: {
          catalog: async (input: McpResourceCatalogInput = {}) => {
            calls.push(input)
            return {
              location: { directory: "/project", project: { id: "project", directory: "/project" } },
              data: {
                resources: [{ server: "docs", name: "Guide", uri: "docs://guide" }],
                templates: [],
              },
            }
          },
        },
      } as unknown as McpApi),
    )

    expect(calls).toEqual([{ location: { directory: "/project" } }])
    expect(result).toEqual({ "docs:docs://guide": { server: "docs", name: "Guide", uri: "docs://guide" } })
  })
})

describe("active session query", () => {
  test("loads active sessions immediately and once per server cache", async () => {
    let calls = 0
    const queryClient = new QueryClient()
    const options = loadActiveSessionsQuery(ServerScope.local, {
      active: async () => {
        calls++
        return { ses_running: { type: "running" } }
      },
    })

    expect(await queryClient.fetchQuery(options)).toEqual({ ses_running: { type: "running" } })
    expect(await queryClient.fetchQuery(options)).toEqual({ ses_running: { type: "running" } })
    expect(calls).toBe(1)
    expect(options.enabled).toBe(true)
    expect([...options.queryKey]).toEqual([ServerScope.local, "activeSessions"])
  })

  test("finds stale busy sessions without clearing them before hydration", () => {
    const session = createServerSession({} as OpencodeClient)
    session.status.set("ses_stale", { type: "busy" })
    const observed = new Map([["ses_stale", session.status.revision("ses_stale")]])

    expect(reconcileActiveSessionStatuses(session, {}, observed)).toEqual(["ses_stale"])
    expect(session.data.session_status.ses_stale).toEqual({ type: "busy" })
  })

  test("selects busy sessions stale for ten seconds regardless of pending requests", () => {
    const session = createServerSession({} as OpencodeClient)
    session.status.set("ses_busy", { type: "busy", since: 1_000 })
    session.set("session_activity", "ses_busy", 1_000)
    session.status.set("ses_idle", { type: "idle" })
    session.set("permission", "ses_busy", [{ id: "permission" }] as never)
    session.set("question", "ses_busy", [{ id: "question" }] as never)
    expect(staleBusySessionIDs(session, 10_999)).toEqual([])
    expect(staleBusySessionIDs(session, 11_000)).toEqual(["ses_busy"])
  })

  test("accepts an earlier active result until a newer one applies", () => {
    expect(activeCheckAccepted(1, 0)).toBe(true)
    expect(activeCheckAccepted(1, 1)).toBe(true)
    expect(activeCheckAccepted(1, 2)).toBe(false)
  })

  test("hydrates independent inactive sessions without waiting for a blocked session", async () => {
    const blocked = Promise.withResolvers<void>()
    const fast = Promise.withResolvers<void>()
    const session = createServerSession({} as OpencodeClient)
    const recovery = new Map()
    session.status.set("ses_blocked", { type: "busy" })
    session.status.set("ses_fast", { type: "busy" })
    const observed = new Map([
      ["ses_blocked", session.status.revision("ses_blocked")],
      ["ses_fast", session.status.revision("ses_fast")],
    ])
    hydrateRecoveredSessions({
      session: {
        status: session.status,
        sync: (id, options) => {
          expect(options).toEqual({ force: true })
          return id === "ses_blocked" ? blocked.promise : fast.promise
        },
      },
      active: {},
      sessionIDs: ["ses_blocked", "ses_fast"],
      observed,
      recovery,
    })
    fast.resolve()
    await fast.promise
    await Promise.resolve()
    expect(session.data.session_status.ses_blocked?.type).toBe("busy")
    expect(session.data.session_status.ses_fast?.type).toBe("idle")
  })

  test("keeps a status revision received during recovery", async () => {
    const deferred = Promise.withResolvers<void>()
    const session = createServerSession({} as OpencodeClient)
    const recovery = new Map()
    session.status.set("ses_recover", { type: "busy", phase: "preparing", since: 1 })
    const observed = new Map([["ses_recover", session.status.revision("ses_recover")]])
    let calls = 0

    hydrateRecoveredSessions({
      session: {
        status: session.status,
        sync: () => {
          calls++
          return deferred.promise
        },
      },
      active: {},
      sessionIDs: ["ses_recover"],
      observed,
      recovery,
    })
    session.status.set("ses_recover", { type: "busy", phase: "waiting_model", since: 2 })
    deferred.resolve()
    await deferred.promise
    await Promise.resolve()

    expect(calls).toBe(1)
    expect(session.data.session_status.ses_recover).toEqual({
      type: "busy",
      phase: "waiting_model",
      since: 2,
    })
  })

  test("coalesces identical inactive recovery while its sync is inflight", async () => {
    const session = createServerSession({} as OpencodeClient)
    const deferred = Promise.withResolvers<void>()
    const recovery = new Map()
    session.status.set("ses_recover", { type: "busy" })
    const observed = new Map([["ses_recover", session.status.revision("ses_recover")]])
    let calls = 0
    const input = {
      session: {
        status: session.status,
        sync: () => {
          calls++
          return deferred.promise
        },
      },
      active: {},
      sessionIDs: ["ses_recover"],
      observed,
      recovery,
    }
    hydrateRecoveredSessions(input)
    hydrateRecoveredSessions(input)
    deferred.resolve()
    await deferred.promise
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(session.data.session_status.ses_recover?.type).toBe("idle")
  })

  test("force-syncs a stale active target and keeps it busy", async () => {
    const deferred = Promise.withResolvers<void>()
    const session = createServerSession({} as OpencodeClient)
    const recovery = new Map()
    session.status.set("ses_recover", { type: "busy" })
    const observed = new Map([["ses_recover", session.status.revision("ses_recover")]])
    let calls = 0

    hydrateRecoveredSessions({
      session: {
        status: session.status,
        sync: (_sessionID, options) => {
          calls++
          expect(options).toEqual({ force: true })
          return deferred.promise
        },
      },
      active: { ses_recover: { type: "running" } },
      sessionIDs: ["ses_recover"],
      observed,
      recovery,
    })
    deferred.resolve()
    await deferred.promise
    await Promise.resolve()

    expect(calls).toBe(1)
    expect(session.data.session_status.ses_recover?.type).toBe("busy")
  })

  test("keeps a recovered session busy when a later result marks it active", async () => {
    const session = createServerSession({} as OpencodeClient)
    const deferred = Promise.withResolvers<void>()
    const recovery = new Map()
    session.status.set("ses_recover", { type: "busy" })
    const observed = new Map([["ses_recover", session.status.revision("ses_recover")]])
    const sync = () => deferred.promise
    hydrateRecoveredSessions({
      session: { status: session.status, sync },
      active: {},
      sessionIDs: ["ses_recover"],
      observed,
      recovery,
    })
    hydrateRecoveredSessions({
      session: { status: session.status, sync },
      active: { ses_recover: { type: "running" } },
      sessionIDs: [],
      observed,
      recovery,
    })
    deferred.resolve()
    await deferred.promise
    await Promise.resolve()
    expect(session.data.session_status.ses_recover?.type).toBe("busy")
  })

  test("runs one trailing recovery after active state or revision changes", async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const session = createServerSession({} as OpencodeClient)
    const recovery = new Map()
    session.status.set("ses_recover", { type: "busy" })
    const initial = new Map([["ses_recover", session.status.revision("ses_recover")]])
    let calls = 0
    const sync = () => {
      calls++
      return calls === 1 ? first.promise : second.promise
    }
    hydrateRecoveredSessions({
      session: { status: session.status, sync },
      active: {},
      sessionIDs: ["ses_recover"],
      observed: initial,
      recovery,
    })
    hydrateRecoveredSessions({
      session: { status: session.status, sync },
      active: { ses_recover: { type: "running" } },
      sessionIDs: [],
      observed: initial,
      recovery,
    })
    session.status.set("ses_recover", { type: "busy", phase: "waiting_model" })
    const changed = new Map([["ses_recover", session.status.revision("ses_recover")]])
    hydrateRecoveredSessions({
      session: { status: session.status, sync },
      active: {},
      sessionIDs: [],
      observed: changed,
      recovery,
    })
    first.resolve()
    await first.promise
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(session.data.session_status.ses_recover?.type).toBe("busy")
    second.resolve()
    await second.promise
    await Promise.resolve()
    expect(session.data.session_status.ses_recover?.type).toBe("idle")
  })

  test("cleans up a rejected recovery and deduplicates its targets", async () => {
    const failed = Promise.withResolvers<void>()
    const session = createServerSession({} as OpencodeClient)
    const recovery = new Map()
    session.status.set("ses_recover", { type: "busy" })
    const observed = new Map([["ses_recover", session.status.revision("ses_recover")]])
    let calls = 0
    hydrateRecoveredSessions({
      session: {
        status: session.status,
        sync: () => {
          calls++
          return failed.promise
        },
      },
      active: {},
      sessionIDs: ["ses_recover", "ses_recover"],
      observed,
      recovery,
    })
    failed.reject(new Error("failed"))
    await failed.promise.catch(() => undefined)
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(recovery.has("ses_recover")).toBe(false)
    expect(session.data.session_status.ses_recover?.type).toBe("busy")
  })

  test("lets a status event received during the active request win", () => {
    const session = createServerSession({} as OpencodeClient)
    session.status.set("ses_running", { type: "busy", phase: "preparing", since: 1 })
    const observed = new Map([["ses_running", session.status.revision("ses_running")]])
    session.status.set("ses_running", { type: "busy", phase: "waiting_model", since: 2 })

    expect(reconcileActiveSessionStatuses(session, {}, observed)).toEqual([])
    expect(session.data.session_status.ses_running).toEqual({
      type: "busy",
      phase: "waiting_model",
      since: 2,
    })
  })

  test("preserves retry and seeds active sessions missing locally", () => {
    const session = createServerSession({} as OpencodeClient)
    session.status.set("ses_retry", { type: "retry", attempt: 2, message: "retrying", next: 10 })
    const observed = new Map([
      ["ses_retry", session.status.revision("ses_retry")],
      ["ses_missing", session.status.revision("ses_missing")],
    ])

    expect(
      reconcileActiveSessionStatuses(
        session,
        { ses_retry: { type: "running" }, ses_missing: { type: "running" } },
        observed,
      ),
    ).toEqual([])
    expect(session.data.session_status.ses_retry?.type).toBe("retry")
    expect(session.data.session_status.ses_missing).toEqual({ type: "busy" })
  })

  test("recovers a missed V1 retry status without overwriting same-type live detail", () => {
    const session = createServerSession({} as OpencodeClient)
    session.status.set("ses_retry", { type: "busy", phase: "waiting_model", since: 1 })
    session.status.set("ses_busy", { type: "busy", phase: "waiting_model", since: 2 })
    const observed = new Map([
      ["ses_retry", session.status.revision("ses_retry")],
      ["ses_busy", session.status.revision("ses_busy")],
    ])

    reconcileActiveSessionStatuses(
      session,
      { ses_retry: { type: "running" }, ses_busy: { type: "running" } },
      observed,
      {
        ses_retry: { type: "retry", attempt: 1, message: "rate limited", next: 10 },
        ses_busy: { type: "busy", phase: "preparing", since: 3 },
      },
    )

    expect(session.data.session_status.ses_retry?.type).toBe("retry")
    expect(session.data.session_status.ses_busy).toEqual({ type: "busy", phase: "waiting_model", since: 2 })
  })
})

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessions", () => {
  test("loads and normalizes a limited page of root sessions", async () => {
    const calls: SessionListInput[] = []

    const result = await loadRootSessions({
      api: {
        list: async (query = {}) => {
          calls.push(query)
          return { data: [sessionInfo("session-1")], cursor: {} }
        },
      } satisfies Pick<SessionApi, "list">,
      directory: "dir",
      limit: 10,
    })

    expect(result.data).toEqual([
      expect.objectContaining({ id: "session-1", directory: "dir", slug: "session-1", version: "" }),
    ])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", parentID: null, limit: 10, order: "desc" }])
  })

  test("propagates list failures", () => {
    expect(
      loadRootSessions({
        api: {
          list: async () => {
            throw new Error("failed")
          },
        } satisfies Pick<SessionApi, "list">,
        directory: "dir",
        limit: 25,
      }),
    ).rejects.toThrow("failed")
  })
})

function sessionInfo(id: string) {
  return {
    id,
    projectID: "project-1",
    agent: "build",
    model: { id: "model-1", providerID: "provider-1" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: id,
    location: { directory: "dir" },
  } as SessionInfo
}

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
