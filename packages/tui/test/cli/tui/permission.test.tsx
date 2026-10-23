/** @jsxImportSource @opentui/solid */
import type { PermissionRequest } from "@opencode/client"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal, onMount } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { Keymap } from "../../../src/context/keymap"
import { LocationProvider } from "../../../src/context/location"
import { ThemeProvider } from "../../../src/context/theme"
import { PermissionPrompt } from "../../../src/routes/session/permission"
import { ToastProvider } from "../../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { createApi, createEventStream, createFetch, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

function request(input: Partial<PermissionRequest> = {}): PermissionRequest {
  return { id: "per_test", sessionID: "ses_test", action: "shell", resources: [], ...input }
}

async function mountPermission(input: {
  request: () => PermissionRequest
  state: string
  onReply?: (url: URL, decision: unknown) => void
}) {
  const ready = Promise.withResolvers<void>()
  const calls = createFetch((url, message) => {
    if (url.pathname === "/api/session/ses_test")
      return json({
        data: {
          id: "ses_test",
          parentID: "ses_parent",
          title: "Permission fixture",
          projectID: "proj_test",
          location: { directory: input.state },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (!/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(url.pathname)) return
    return message.json().then((decision) => {
      input.onReply?.(url, decision)
      return new Response(null, { status: 204 })
    })
  }, createEventStream())

  function Prompt() {
    const data = useData()
    onMount(() => void data.session.sync("ses_test").then(ready.resolve, ready.reject))
    return <PermissionPrompt request={input.request()} directory={input.state} />
  }

  const app = await testRender(
    () => (
      <TestTuiContexts directory={input.state} paths={{ home: input.state, state: input.state, worktree: input.state }}>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <Keymap.Provider>
            <ClientProvider api={createApi(calls.fetch)}>
              <DataProvider directory={input.state}>
                <LocationProvider>
                  <ThemeProvider mode="dark" source={emptyThemeSource}>
                    <ToastProvider>
                      <Prompt />
                    </ToastProvider>
                  </ThemeProvider>
                </LocationProvider>
              </DataProvider>
            </ClientProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await ready.promise
  await app.waitForFrame((frame) => frame.includes("Permission required"))
  return app
}

test("omits Always when there are no persistent patterns", async () => {
  await using tmp = await tmpdir()
  const app = await mountPermission({ state: tmp.path, request: () => request() })
  try {
    const frame = app.captureCharFrame()
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Reject")
    expect(frame).not.toContain("Always allow")
  } finally {
    app.renderer.destroy()
  }
})

test("shows Always patterns in order before approving them", async () => {
  await using tmp = await tmpdir()
  const replies: unknown[] = []
  const app = await mountPermission({
    state: tmp.path,
    request: () => request({ save: ["src/**/*.ts", "test/**/*.ts"] }),
    onReply: (_url, decision) => replies.push(decision),
  })
  try {
    app.mockInput.pressArrow("right")
    await app.waitForFrame((frame) => frame.includes("src/**/*.ts"))
    const frame = app.captureCharFrame()
    expect(frame.indexOf("src/**/*.ts")).toBeGreaterThan(-1)
    expect(frame.indexOf("test/**/*.ts")).toBeGreaterThan(frame.indexOf("src/**/*.ts"))
    expect(replies).toEqual([])
    app.mockInput.pressEnter()
    await app.waitFor(() => replies.length === 1)
    expect(replies).toEqual([{ decision: "always" }])
  } finally {
    app.renderer.destroy()
  }
})

test("resets permission choices when the request changes", async () => {
  await using tmp = await tmpdir()
  const [current, setCurrent] = createSignal(request({ id: "per_first", save: ["src/**/*.ts"] }))
  const replies: { path: string; decision: unknown }[] = []
  const app = await mountPermission({
    state: tmp.path,
    request: current,
    onReply: (url, decision) => replies.push({ path: url.pathname, decision }),
  })
  try {
    app.mockInput.pressArrow("right")
    setCurrent(request({ id: "per_second", action: "doom_loop" }))
    await app.waitForFrame((frame) => frame.includes("Continue after repeated failures"))
    expect(app.captureCharFrame()).not.toContain("Always allow")
    app.mockInput.pressEnter()
    await app.waitFor(() => replies.length === 1)
    expect(replies).toEqual([
      { path: "/api/session/ses_test/permission/per_second/reply", decision: { decision: "once" } },
    ])
  } finally {
    app.renderer.destroy()
  }
})

test("resets the rejection stage when the request changes", async () => {
  await using tmp = await tmpdir()
  const [current, setCurrent] = createSignal(request({ id: "per_first", save: ["src/**/*.ts"] }))
  const app = await mountPermission({ state: tmp.path, request: current })
  try {
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Reject permission"))
    setCurrent(request({ id: "per_second" }))
    await app.waitForFrame((frame) => frame.includes("Permission required"))
    const frame = app.captureCharFrame()
    expect(frame).toContain("Allow once")
    expect(frame).toContain("Reject")
    expect(frame).not.toContain("Always allow")
    expect(frame).not.toContain("Reject permission")
    expect(frame).not.toContain("src/**/*.ts")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps wildcard Always confirmation copy", async () => {
  await using tmp = await tmpdir()
  const app = await mountPermission({ state: tmp.path, request: () => request({ save: ["*"] }) })
  try {
    app.mockInput.pressArrow("right")
    await app.waitForFrame((frame) => frame.includes("This will always allow shell for this project."))
    expect(app.captureCharFrame()).toContain("Always allow")
  } finally {
    app.renderer.destroy()
  }
})
