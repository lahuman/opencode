import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { GlobalEvent, PermissionRequest, Session } from "@opencode-ai/sdk/v2"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"
import type { Args } from "../src/context/args"

const agent = [
  { name: "build", mode: "primary", permission: [], options: {} },
  { name: "plan", mode: "primary", permission: [], options: {} },
]

const provider = {
  id: "test",
  name: "Test",
  source: "api",
  env: [],
  options: {},
  models: {
    test: {
      id: "test",
      providerID: "test",
      api: { id: "test", url: "http://test", npm: "test" },
      name: "Test",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 1_000, output: 1_000 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

function appFixture(url: URL) {
  if (url.pathname === "/agent") return json(agent)
  if (url.pathname === "/config/providers") return json({ providers: [provider], default: { test: "test" } })
  if (url.pathname === "/provider") return json({ all: [provider], default: { test: "test" }, connected: ["test"] })
}

function sessionFixture(approvalMode: "ask" | "auto_review" = "ask", id = "ses_test"): Session {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory,
    title: "Approval session",
    approvalMode,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
}

function permissionEvent(id: string, sessionID: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_${id}`,
      type: "permission.asked",
      properties: {
        id,
        sessionID,
        permission: "edit",
        patterns: [],
        metadata: {},
        always: [],
      } satisfies PermissionRequest,
    },
  }
}

function permissionReplied(id: string, sessionID: string): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_${id}_replied`,
      type: "permission.replied",
      properties: { requestID: id, sessionID, reply: "once" },
    },
  }
}

function sessionUpdated(info: Session): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_${info.id}_${info.approvalMode}`,
      type: "session.updated",
      properties: { sessionID: info.id, info },
    },
  }
}

async function waitFor(fn: () => boolean, timeout = 2_000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountApprovalApp(
  options: {
    args?: Args
    session?: Session
    request?: (request: Request, body: unknown) => Response | Promise<Response> | undefined
  } = {},
) {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false, kittyKeyboard: true })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const requests: { body: unknown; method: string; path: string }[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json(options.session ? [options.session] : [])
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(options.session ?? sessionFixture())
    if (/^\/session\/[^/]+\/(message|todo|diff|children|permission|question)$/.test(url.pathname)) return json([])
    return appFixture(url)
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "GET") return calls.fetch(request)
    const body = await request
      .clone()
      .json()
      .catch(() => undefined)
    requests.push({ body, method: request.method, path: new URL(request.url).pathname })
    const response = await options.request?.(request, body)
    if (response) return response
    const path = new URL(request.url).pathname
    if (/^\/permission\/[^/]+\/reply$/.test(path)) return json(true)
    if (request.method === "PATCH" && /^\/session\/[^/]+$/.test(path)) {
      const update = body && typeof body === "object" ? body : {}
      return json({ ...(options.session ?? sessionFixture()), ...update })
    }
    if (request.method === "POST" && path === "/session") {
      const create = body && typeof body === "object" ? body : {}
      return json({ ...sessionFixture("ask", "ses_created"), ...create })
    }
    if (request.method === "POST" && /^\/session\/[^/]+\/message$/.test(path)) return json({})
    return calls.fetch(request)
  }) as typeof globalThis.fetch
  let api!: TuiPluginApi
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposeSlots = () => {}
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch,
      events: events.source,
      args: options.args ?? {},
      pluginHost: {
        async start(input) {
          api = input.api
          disposeSlots = input.runtime.setupSlots(input.api).dispose
          started()
        },
        async dispose() {
          disposeSlots()
        },
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )
  await ready
  await Bun.sleep(50)
  await setup.renderOnce()

  return {
    api,
    emit: events.emit,
    requests,
    setup,
    command(name: string) {
      return api.keymap
        .getCommandEntries({ visibility: "reachable", namespace: "palette" })
        .find((entry) => entry.command.name === name)?.command
    },
    async cleanup() {
      if (!setup.renderer.isDestroyed) api.keymap.dispatchCommand("app.exit")
      await task.catch(() => {})
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      mock.restore()
    },
  }
}

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("registers plan and build commands", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false, kittyKeyboard: true })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch(appFixture)
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let task: Promise<void> | undefined
  let disposeSlots = () => {}

  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            disposeSlots = input.runtime.setupSlots(input.api).dispose
            started()
          },
          async dispose() {
            disposeSlots()
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await Bun.sleep(50)
    await setup.renderOnce()

    const commands = api?.keymap.getCommandEntries({ visibility: "reachable", namespace: "palette" }) ?? []
    expect(commands.find((entry) => entry.command.name === "agent.plan")?.command.slashName).toBe("plan")
    expect(commands.find((entry) => entry.command.name === "agent.build")?.command.slashName).toBe("build")
    expect(commands.find((entry) => entry.command.name === "permission.approval_mode")?.command.hidden).toBe(true)
    expect(setup.captureCharFrame()).not.toContain("Ask for approval")

    expect(api?.keymap.dispatchCommand("agent.plan")).toEqual({ ok: true })
    await setup.renderOnce()
    const planFrame = setup.captureCharFrame()
    expect(planFrame).toContain("Ask for approval")

    const row = planFrame.split("\n").findIndex((line) => line.includes("Ask for approval"))
    const column = planFrame.split("\n")[row].indexOf("Ask for approval")
    await setup.mockMouse.click(column + 1, row)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Ask for approval")
    expect(setup.captureCharFrame()).toContain("Approve for me")
    await setup.mockMouse.click(1, 1)
    await setup.renderOnce()

    const planCommands = api?.keymap.getCommandEntries({ visibility: "reachable", namespace: "palette" }) ?? []
    expect(planCommands.find((entry) => entry.command.name === "permission.approval_mode")?.command.hidden).toBe(false)
    expect(api?.keymap.dispatchCommand("permission.approval_mode")).toEqual({ ok: true })
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Ask for approval")
    expect(setup.captureCharFrame()).toContain("Approve for me")
    await setup.mockMouse.click(1, 1)
    await setup.renderOnce()

    setup.mockInput.pressKey("!")
    await Bun.sleep(10)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).toContain("Shell")
    expect(setup.captureCharFrame()).not.toContain("Ask for approval")
    setup.mockInput.pressEscape()
    await Bun.sleep(10)
    await setup.renderOnce()

    expect(api?.keymap.dispatchCommand("agent.build")).toEqual({ ok: true })
  } finally {
    if (!setup.renderer.isDestroyed) api?.keymap.dispatchCommand("app.exit")
    await task?.catch(() => {})
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("persists current-session approval mode through the shared gate", async () => {
  const session = sessionFixture()
  let resolveUpdate!: (response: Response) => void
  const firstUpdate = new Promise<Response>((resolve) => {
    resolveUpdate = resolve
  })
  let resolveAsk!: (response: Response) => void
  const askUpdate = new Promise<Response>((resolve) => {
    resolveAsk = resolve
  })
  let updates = 0
  const app = await mountApprovalApp({
    args: { sessionID: session.id, auto: true },
    session,
    request(request) {
      if (request.method !== "PATCH") return undefined
      updates++
      if (updates === 1) return firstUpdate
      if (updates === 2) return askUpdate
      return json(sessionFixture("ask"))
    },
  })

  try {
    expect(app.api.keymap.dispatchCommand("agent.plan")).toEqual({ ok: true })
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("Ask for approval")

    expect(app.api.keymap.dispatchCommand("permission.approval_mode")).toEqual({ ok: true })
    await app.setup.renderOnce()
    app.setup.mockInput.pressArrow("down")
    app.setup.mockInput.pressEnter()
    await waitFor(() => app.requests.filter((request) => request.method === "PATCH").length === 1)

    expect(app.requests.filter((request) => request.method === "PATCH")[0]).toEqual({
      method: "PATCH",
      path: `/session/${session.id}`,
      body: { approvalMode: "auto_review" },
    })

    app.setup.mockInput.pressArrow("up")
    app.setup.mockInput.pressEnter()
    expect(app.api.keymap.dispatchCommand("permission.mode")).toEqual({ ok: true })
    app.emit(permissionEvent("permission_during_update", session.id))
    app.emit(permissionEvent("permission_during_update", session.id))
    await Bun.sleep(30)

    expect(app.requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
    expect(app.requests.filter((request) => request.path.includes("/permission/"))).toEqual([])
    expect(app.command("permission.mode")?.title).toBe("Disable auto-approve permissions")

    resolveUpdate(json(sessionFixture("auto_review")))
    await waitFor(() => app.command("permission.mode")?.title === "Enable auto-approve permissions")
    await Bun.sleep(30)
    expect(app.requests.filter((request) => request.path.includes("/permission/"))).toEqual([])

    app.emit(sessionUpdated(sessionFixture("auto_review")))
    await Bun.sleep(10)
    app.api.keymap.dispatchCommand("permission.approval_mode")
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toMatch(/[^\s] Approve for me/)
    await app.setup.mockMouse.click(1, 1)
    await app.setup.renderOnce()
    app.emit(permissionReplied("permission_during_update", session.id))

    expect(app.api.keymap.dispatchCommand("permission.mode")).toEqual({ ok: true })
    await waitFor(() => app.requests.filter((request) => request.method === "PATCH").length === 2)
    app.emit(permissionEvent("permission_during_ask", session.id))
    app.emit(permissionEvent("permission_during_ask", session.id))
    await Bun.sleep(20)
    expect(app.requests.filter((request) => request.path.includes("/permission/"))).toEqual([])
    resolveAsk(json(sessionFixture("ask")))
    expect(app.requests.filter((request) => request.method === "PATCH")[1].body).toEqual({ approvalMode: "ask" })
    await waitFor(() => app.command("permission.mode")?.title === "Disable auto-approve permissions")
    await waitFor(() => app.requests.filter((request) => request.path.includes("/permission/")).length === 1)
  } finally {
    await app.cleanup()
  }
})

test("retains blind auto across rejected and data-less approval updates", async () => {
  const session = sessionFixture()
  let rejectUpdate!: (error: Error) => void
  const rejected = new Promise<Response>((_, reject) => {
    rejectUpdate = reject
  })
  let updates = 0
  let permissionReplies = 0
  const app = await mountApprovalApp({
    args: { sessionID: session.id, auto: true },
    session,
    request(request) {
      if (/^\/permission\/[^/]+\/reply$/.test(new URL(request.url).pathname)) {
        permissionReplies++
        if (permissionReplies === 1) throw new Error("reply failed")
        return json(true)
      }
      if (request.method !== "PATCH") return undefined
      updates++
      if (updates === 1) return rejected
      return new Response(null, { status: 200 })
    },
  })

  try {
    app.api.keymap.dispatchCommand("agent.plan")
    app.api.keymap.dispatchCommand("permission.approval_mode")
    await app.setup.renderOnce()
    app.setup.mockInput.pressArrow("down")
    app.setup.mockInput.pressEnter()
    await waitFor(() => updates === 1)

    app.emit(permissionEvent("permission_failed_update", session.id))
    app.emit(permissionEvent("permission_failed_update", session.id))
    rejectUpdate(new Error("update rejected"))
    await waitFor(() => app.requests.filter((request) => request.path.includes("/permission/")).length === 1)
    await Bun.sleep(30)
    app.emit(permissionEvent("permission_failed_update", session.id))
    await waitFor(() => app.requests.filter((request) => request.path.includes("/permission/")).length === 2)

    expect(app.command("permission.mode")?.title).toBe("Disable auto-approve permissions")
    expect(permissionReplies).toBe(2)
    app.emit(permissionReplied("permission_failed_update", session.id))
    await Bun.sleep(20)
    await app.setup.mockMouse.click(1, 1)
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("Ask for approval")
    await Bun.sleep(20)

    expect(app.api.keymap.dispatchCommand("permission.approval_mode")).toEqual({ ok: true })
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("Approval mode")
    app.setup.mockInput.pressArrow("down")
    app.setup.mockInput.pressEnter()
    await waitFor(() => updates === 2)
    await Bun.sleep(20)

    expect(app.command("permission.mode")?.title).toBe("Disable auto-approve permissions")
    expect(app.requests.filter((request) => request.method === "PATCH").map((request) => request.body)).toEqual([
      { approvalMode: "auto_review" },
      { approvalMode: "auto_review" },
    ])
    await app.setup.mockMouse.click(1, 1)
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("Ask for approval")
  } finally {
    await app.cleanup()
  }
})

test("serializes draft approval mode with Plan session creation", async () => {
  let resolveCreate!: (response: Response) => void
  const pendingCreate = new Promise<Response>((resolve) => {
    resolveCreate = resolve
  })
  let creates = 0
  const app = await mountApprovalApp({
    request(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/session") return undefined
      creates++
      if (creates === 1) return pendingCreate
      if (creates === 2) return new Response(null, { status: 200 })
      if (creates === 3) throw new Error("create rejected")
      return json(sessionFixture("ask", `ses_created_${creates}`))
    },
  })

  try {
    app.api.keymap.dispatchCommand("agent.plan")
    await app.setup.renderOnce()

    expect(app.api.keymap.dispatchCommand("permission.approval_mode")).toEqual({ ok: true })
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("Approval mode")
    app.setup.mockInput.pressArrow("down")
    app.setup.mockInput.pressEnter()
    await Bun.sleep(20)
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).not.toContain("Approval mode")
    expect(app.setup.captureCharFrame()).toContain("Approve for me")
    expect(app.command("permission.mode")?.title).toBe("Enable auto-approve permissions")

    app.api.keymap.dispatchCommand("permission.mode")
    await waitFor(() => app.command("permission.mode")?.title === "Disable auto-approve permissions")
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("Ask for approval")
    expect(app.requests.filter((request) => request.method === "PATCH")).toEqual([])

    app.api.keymap.dispatchCommand("permission.mode")
    await waitFor(() => app.command("permission.mode")?.title === "Enable auto-approve permissions")
    await Bun.sleep(20)
    app.api.keymap.dispatchCommand("permission.approval_mode")
    await app.setup.renderOnce()
    app.setup.mockInput.pressArrow("down")
    app.setup.mockInput.pressEnter()
    await Bun.sleep(20)
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).not.toContain("Approval mode")
    expect(app.setup.captureCharFrame()).toContain("Approve for me")

    await app.setup.mockInput.typeText("first prompt")
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("first prompt")
    app.setup.mockInput.pressEnter()
    await waitFor(() => creates === 1)

    expect(
      app.requests.filter((request) => request.method === "POST" && request.path === "/session")[0]?.body,
    ).toMatchObject({
      agent: "plan",
      approvalMode: "auto_review",
    })

    app.setup.mockInput.pressEnter()
    app.api.keymap.dispatchCommand("permission.mode")
    app.api.keymap.dispatchCommand("permission.approval_mode")
    await app.setup.renderOnce()
    app.setup.mockInput.pressArrow("up")
    app.setup.mockInput.pressEnter()
    await app.setup.mockMouse.click(1, 1)
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("Approve for me")
    expect(app.setup.captureCharFrame()).toContain("first prompt")
    app.emit(permissionEvent("permission_during_create", "ses_pending"))
    app.emit(permissionEvent("permission_during_create", "ses_pending"))
    await Bun.sleep(30)

    expect(creates).toBe(1)
    expect(app.requests.filter((request) => request.method === "PATCH")).toEqual([])
    expect(app.requests.filter((request) => request.path.includes("/permission/"))).toEqual([])
    expect(app.command("permission.mode")?.title).toBe("Enable auto-approve permissions")

    resolveCreate(json(sessionFixture("auto_review", "ses_created")))
    await waitFor(() => app.requests.some((request) => request.path === "/session/ses_created/message"))
    await Bun.sleep(80)
    await app.setup.renderOnce()

    app.api.keymap.dispatchCommand("session.new")
    await Bun.sleep(20)
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("Ask for approval")
    expect(app.setup.captureCharFrame()).not.toContain("first prompt")

    expect(app.api.keymap.dispatchCommand("permission.approval_mode")).toEqual({ ok: true })
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("Approval mode")
    app.setup.mockInput.pressArrow("down")
    app.setup.mockInput.pressEnter()
    await Bun.sleep(20)
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).not.toContain("Approval mode")
    expect(app.setup.captureCharFrame()).toContain("Approve for me")
    await app.setup.mockInput.typeText("retry prompt")
    app.setup.mockInput.pressEnter()
    await waitFor(() => creates === 2)
    await app.setup.renderOnce()

    expect(app.setup.captureCharFrame()).toContain("retry prompt")
    expect(app.setup.captureCharFrame()).toContain("Approve for me")
    expect(app.command("permission.mode")?.title).toBe("Enable auto-approve permissions")

    app.setup.mockInput.pressEnter()
    await waitFor(() => creates === 3)
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("retry prompt")
    expect(app.setup.captureCharFrame()).toContain("Approve for me")

    app.api.keymap.dispatchCommand("permission.mode")
    await waitFor(() => app.command("permission.mode")?.title === "Disable auto-approve permissions")
    await app.setup.renderOnce()
    expect(app.setup.captureCharFrame()).toContain("Ask for approval")
  } finally {
    await app.cleanup()
  }
})
