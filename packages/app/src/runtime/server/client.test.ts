import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import type { OpenCodeEvent } from "@opencode/client/promise"
import { createRoot } from "solid-js"
import { createOpenCodeEventSource, createServerTransport } from "./client"

const permission = {
  id: "evt_permission",
  created: 1,
  type: "permission.asked",
  location: { directory: "/repo", workspaceID: "workspace_1" },
  data: {
    id: "perm_1",
    sessionID: "ses_1",
    action: "read",
    resources: ["src/**"],
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  },
} satisfies Extract<OpenCodeEvent, { type: "permission.asked" }>

function setup() {
  return createRoot((dispose) => ({ ...createOpenCodeEventSource(), dispose }))
}

describe("server event stream", () => {
  test("publishes the original current event with exact data", () => {
    const server = setup()
    const received: OpenCodeEvent[] = []
    let requestID: string | undefined

    server.event.on("permission.asked", (event) => {
      requestID = event.data.id
    })
    server.event.listen((event) => received.push(event))
    server.publish(permission)

    expect(requestID).toBe("perm_1")
    expect(received).toEqual([permission])
    expect(received[0]).toBe(permission)
    server.dispose()
  })

  test("filters locations without changing workspace identity", () => {
    const server = setup()
    const repo: OpenCodeEvent[] = []
    const other: OpenCodeEvent[] = []
    const all: OpenCodeEvent[] = []
    let workspaceID: string | undefined

    const global = {
      id: "evt_connected",
      type: "server.connected",
      data: {},
    } satisfies Extract<OpenCodeEvent, { type: "server.connected" }>

    const repoEvents = server.event.location("/repo")
    repoEvents.on("permission.asked", (event) => {
      workspaceID = event.location?.workspaceID
    })
    repoEvents.listen((event) => repo.push(event))
    server.event.location("/other").listen((event) => other.push(event))
    server.event.listen((event) => all.push(event))
    server.publish(permission)
    server.publish(global)

    expect(repo).toEqual([permission])
    expect(workspaceID).toBe("workspace_1")
    expect(other).toEqual([])
    expect(all).toEqual([permission, global])
    server.dispose()
  })

  test("isolates servers and clears subscriptions with their owner", () => {
    const first = setup()
    const second = setup()
    const received = { first: 0, second: 0 }

    first.event.listen(() => received.first++)
    second.event.listen(() => received.second++)
    first.publish(permission)
    first.dispose()
    first.publish(permission)
    second.publish(permission)

    expect(received).toEqual({ first: 1, second: 1 })
    second.dispose()
  })
})

test("rotates HTTP and PTY clients together", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = []

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push({ url: request.url, authorization: request.headers.get("authorization") })

    return Response.json({
      version: "2.0.0-test",
      pid: 1,
      urls: [request.url],
      paths: { tmp: "/tmp/opencode" },
    })
  }) as typeof globalThis.fetch

  const transport = createServerTransport({
    http: { url: "http://127.0.0.1:4100", password: "first" },
    fetch,
  })

  const initialPty = transport.pty

  await transport.api.server.info()

  const replacement = transport.update({
    url: "http://127.0.0.1:4200",
    password: "second",
  })

  await transport.api.server.info()

  expect(replacement).toBe(transport.api)
  expect(transport.pty).not.toBe(initialPty)
  expect(transport.url).toBe("http://127.0.0.1:4200")
  expect(requests).toEqual([
    {
      url: "http://127.0.0.1:4100/api/info",
      authorization: `Basic ${btoa("opencode:first")}`,
    },
    {
      url: "http://127.0.0.1:4200/api/info",
      authorization: `Basic ${btoa("opencode:second")}`,
    },
  ])
})

test("enterprise reads wait for the replacement endpoint even when an old client dispatches them", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.setHeader("access-control-allow-origin", "*")
    response.end(JSON.stringify({ version: "replacement", pid: 2, urls: [], paths: { tmp: "/tmp" } }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test server address")
  const url = `http://127.0.0.1:${address.port}`
  const ready = Promise.withResolvers<{ url: string }>()
  const requested = Promise.withResolvers<void>()
  const transport = createServerTransport({
    http: { url: "http://127.0.0.1:1" },
    resolve: () => {
      requested.resolve()
      return ready.promise
    },
  })
  try {
    const previous = transport.api
    const response = previous.server.info()
    await requested.promise
    transport.update({ url })
    ready.resolve({ url })
    expect((await response).version).toBe("replacement")
    expect((await previous.server.info()).pid).toBe(2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test.each([
  ["GET", false, 2],
  ["POST", false, 1],
  ["GET", true, 1],
] as const)("enterprise disconnect recovery for %s, aborted=%s", async (method, aborted, expected) => {
  const requests: Request[] = []
  const controller = new AbortController()
  const transport = createServerTransport({
    http: { url: "http://127.0.0.1:4100" },
    resolve: async () => ({ url: `http://127.0.0.1:${requests.length ? 4200 : 4100}` }),
    fetch: Object.assign(async (resource: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(resource, init))
      if (requests.length === 1) {
        if (aborted) controller.abort()
        throw new TypeError("Failed to fetch")
      }
      return Response.json({})
    }, { preconnect: () => {} }),
  })
  const request = method === "POST"
    ? transport.api.location.reload({ signal: controller.signal })
    : transport.api.server.info({ signal: controller.signal })
  if (expected === 1) await expect(request).rejects.toThrow()
  if (expected === 2) await request
  expect(requests.map((request) => new URL(request.url).port)).toEqual(expected === 2 ? ["4100", "4200"] : ["4100"])
})
