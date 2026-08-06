/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { expect, test } from "bun:test"
import path from "node:path"
import { createSignal, onCleanup, Show } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function request(input: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "per_test",
    sessionID: "ses_test",
    permission: "bash",
    patterns: [],
    metadata: {},
    always: [],
    ...input,
  }
}

async function mountPermission(input: {
  request: () => PermissionRequest
  state: string
  onReply?: (url: URL) => void
}) {
  const calls = createFetch((url) => {
    if (!/^\/permission\/[^/]+\/reply$/.test(url.pathname)) return
    input.onReply?.(url)
    return json(true)
  })
  const events = createEventSource()

  function PromptWhenReady() {
    const sync = useSync()
    return (
      <Show when={sync.status === "complete"}>
        <PermissionPrompt request={input.request()} directory={directory} />
      </Show>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <TestTuiContexts paths={{ state: input.state }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <ArgsProvider>
            <KVProvider>
              <TuiConfigProvider config={config}>
                <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                  <PermissionProvider>
                    <ProjectProvider>
                      <ExitProvider exit={() => {}}>
                        <SyncProvider>
                          <ThemeProvider mode="dark">
                            <LocationProvider location={{ directory }}>
                              <PromptWhenReady />
                            </LocationProvider>
                          </ThemeProvider>
                        </SyncProvider>
                      </ExitProvider>
                    </ProjectProvider>
                  </PermissionProvider>
                </SDKProvider>
              </TuiConfigProvider>
            </KVProvider>
          </ArgsProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 30, kittyKeyboard: true })
  await wait(() => app.captureCharFrame().includes("Permission required"))
  return app
}

test("shows typed review risk and reason", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const app = await mountPermission({
    state: tmp.path,
    request: () => request({ review: { risk: "medium", reason: "This request needs manual review." } }),
  })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("medium")
    expect(frame).toContain("This request needs manual review.")
  } finally {
    app.renderer.destroy()
  }
})

test("omits Always when there are no persistent patterns", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const app = await mountPermission({ state: tmp.path, request: () => request() })

  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Reject")
    expect(frame).not.toContain("Allow always")
    expect(frame).not.toContain("Always allow")
  } finally {
    app.renderer.destroy()
  }
})

test("removes review context without leaving an empty section", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const [current, setCurrent] = createSignal(
    request({
      id: "per_reviewed",
      review: { risk: "medium", reason: "This request needs manual review." },
    }),
  )
  const app = await mountPermission({ state: tmp.path, request: current })

  try {
    await wait(() => app.captureCharFrame().includes("This request needs manual review."))
    setCurrent(request({ id: "per_plain", permission: "doom_loop" }))
    await wait(() => app.captureCharFrame().includes("Continue after repeated failures"))

    const frame = app.captureCharFrame()
    const lines = frame.split("\n")
    const detail = lines.findIndex((line) => line.includes("This keeps the session running despite repeated failures."))
    const controls = lines.findIndex((line) => line.includes("Allow once"))
    expect(detail).toBeGreaterThan(-1)
    expect(controls - detail).toBe(3)
    expect(frame).not.toContain("medium")
    expect(frame).not.toContain("undefined")
    expect(frame).not.toContain("This request needs manual review.")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps nested Always pattern confirmation in order", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const app = await mountPermission({
    state: tmp.path,
    request: () => request({ always: ["src/**/*.ts", "test/**/*.ts"] }),
  })

  try {
    expect(app.captureCharFrame()).toContain("Allow always")
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    await wait(() => app.captureCharFrame().includes("Always allow"))

    const frame = app.captureCharFrame()
    expect(frame).toContain("Always allow")
    expect(frame).toContain("Confirm")
    expect(frame).toContain("Cancel")
    expect(frame.indexOf("src/**/*.ts")).toBeGreaterThan(-1)
    expect(frame.indexOf("test/**/*.ts")).toBeGreaterThan(frame.indexOf("src/**/*.ts"))
  } finally {
    app.renderer.destroy()
  }
})

test("resets permission choices when the request changes", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const [current, setCurrent] = createSignal(request({ id: "per_first", always: ["src/**/*.ts"] }))
  const replies: URL[] = []
  const app = await mountPermission({
    state: tmp.path,
    request: current,
    onReply: (url) => replies.push(url),
  })

  try {
    app.mockInput.pressArrow("right")
    setCurrent(request({ id: "per_second", permission: "doom_loop" }))
    await wait(() => app.captureCharFrame().includes("Continue after repeated failures"))

    const frame = app.captureCharFrame()
    expect(frame).not.toContain("Allow always")
    app.mockInput.pressEnter()
    await wait(() => replies.length === 1)
    expect(replies.map((url) => url.pathname)).toEqual(["/permission/per_second/reply"])
    expect(app.captureCharFrame()).toContain("Permission required")
    expect(app.captureCharFrame()).not.toContain("Always allow")
  } finally {
    app.renderer.destroy()
  }
})

test("resets the nested Always stage when the request changes", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const [current, setCurrent] = createSignal(request({ id: "per_first", always: ["src/**/*.ts", "test/**/*.ts"] }))
  const app = await mountPermission({ state: tmp.path, request: current })

  try {
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    await wait(() => app.captureCharFrame().includes("Always allow"))

    setCurrent(request({ id: "per_second" }))
    await wait(() => app.captureCharFrame().includes("Permission required"))

    const frame = app.captureCharFrame()
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Reject")
    expect(frame).not.toContain("Allow always")
    expect(frame).not.toContain("Always allow")
    expect(frame).not.toContain("Confirm")
    expect(frame).not.toContain("Cancel")
    expect(frame).not.toContain("src/**/*.ts")
    expect(frame).not.toContain("test/**/*.ts")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps wildcard Always confirmation copy", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  const app = await mountPermission({ state: tmp.path, request: () => request({ always: ["*"] }) })

  try {
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    await wait(() => app.captureCharFrame().includes("Always allow"))

    const frame = app.captureCharFrame()
    expect(frame).toContain("This will allow bash until OpenCode is restarted.")
    expect(frame).toContain("Confirm")
    expect(frame).toContain("Cancel")
  } finally {
    app.renderer.destroy()
  }
})
