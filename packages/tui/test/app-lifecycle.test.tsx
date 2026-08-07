import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

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
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch()
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let task: Promise<void> | undefined

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
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()

    const commands = api?.keymap.getCommandEntries({ visibility: "reachable", namespace: "palette" }) ?? []
    expect(commands.find((entry) => entry.command.name === "agent.plan")?.command.slashName).toBe("plan")
    expect(commands.find((entry) => entry.command.name === "agent.build")?.command.slashName).toBe("build")

    expect(api?.keymap.dispatchCommand("agent.plan")).toEqual({ ok: true })
    expect(api?.keymap.dispatchCommand("agent.build")).toEqual({ ok: true })
  } finally {
    if (!setup.renderer.isDestroyed) api?.keymap.dispatchCommand("app.exit")
    await task?.catch(() => {})
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

const promptAgents = [
  { name: "build", mode: "primary", permission: [], options: {} },
]

const promptProvider = {
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

function promptFixture(url: URL) {
  if (url.pathname === "/agent") return json(promptAgents)
  if (url.pathname === "/config/providers") return json({ providers: [promptProvider], default: { test: "test" } })
  if (url.pathname === "/provider") return json({ all: [promptProvider], default: { test: "test" }, connected: ["test"] })
}

async function mountPromptApp(create: () => Promise<Response>) {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false, kittyKeyboard: true })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch(promptFixture)
  const requests: { method: string; path: string }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const path = new URL(request.url).pathname
    if (request.method === "POST" && path === "/session") {
      requests.push({ method: request.method, path })
      return create()
    }
    if (request.method === "POST" && /^\/session\/[^/]+\/message$/.test(path)) {
      requests.push({ method: request.method, path })
      return json({})
    }
    return calls.fetch(request)
  }) as typeof globalThis.fetch
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
      args: {},
      pluginHost: {
        async start(input) {
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
    requests,
    setup,
    async cleanup() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task.catch(() => {})
      mock.restore()
    },
  }
}

async function expectPromptToRemainAfterCreateFailure(create: () => Promise<Response>) {
  const app = await mountPromptApp(create)

  try {
    await app.setup.mockInput.typeText("retry prompt")
    app.setup.mockInput.pressEnter()
    await Bun.sleep(100)
    await app.setup.renderOnce()

    expect(app.requests.filter((request) => request.path === "/session")).toHaveLength(1)
    expect(app.requests.some((request) => request.path.endsWith("/message"))).toBe(false)
    expect(app.setup.captureCharFrame()).toContain("retry prompt")
  } finally {
    await app.cleanup()
  }
}

test("keeps the prompt after session creation rejects", async () => {
  await expectPromptToRemainAfterCreateFailure(async () => Promise.reject(new Error("create rejected")))
})

test("keeps the prompt after session creation succeeds without data", async () => {
  await expectPromptToRemainAfterCreateFailure(async () => new Response(null, { status: 200 }))
})
