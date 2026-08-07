/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ArgsProvider, type Args } from "../../../../src/context/args"
import { KVProvider, useKV } from "../../../../src/context/kv"
import { ProjectProvider, useProject } from "../../../../src/context/project"
import { SDKProvider } from "../../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../../src/context/sync"
import { PermissionProvider } from "../../../../src/context/permission"
import { ExitProvider } from "../../../../src/context/exit"
import { createEventSource, createFetch, type FetchHandler, directory, json } from "../../../fixture/tui-sdk"
import { TestTuiContexts } from "../../../fixture/tui-environment"
export { createEventSource, createFetch, directory, eventSource, json, worktree } from "../../../fixture/tui-sdk"

export async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Ctx = {
  kv: ReturnType<typeof useKV>
  project: ReturnType<typeof useProject>
  sync: ReturnType<typeof useSync>
}

type MountOptions = {
  args?: Args
  fetch?: FetchHandler
  state?: string
}

export async function mount(input: MountOptions | FetchHandler = {}, state?: string) {
  const options = typeof input === "function" ? { fetch: input, state } : state ? { ...input, state } : input
  const calls = createFetch(options.fetch)
  const events = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let project!: ReturnType<typeof useProject>
  let kv!: ReturnType<typeof useKV>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    const ctx: Ctx = { kv: useKV(), project: useProject(), sync: useSync() }
    onMount(() => {
      sync = ctx.sync
      project = ctx.project
      kv = ctx.kv
      done()
    })
    return <box />
  }

  const replies: { body: unknown; method: string; path: string }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (request.method === "POST" && /^\/permission\/[^/]+\/reply$/.test(url.pathname)) {
      replies.push({ body: await request.clone().json(), method: request.method, path: url.pathname })
      return (await options.fetch?.(url)) ?? json(true)
    }
    return calls.fetch(request)
  }) as typeof globalThis.fetch

  const app = await testRender(() => (
    <TestTuiContexts paths={options.state ? { state: options.state } : undefined}>
      <ArgsProvider {...options.args}>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
            <PermissionProvider>
              <ProjectProvider>
                <ExitProvider exit={() => {}}>
                  <SyncProvider>
                    <Probe />
                  </SyncProvider>
                </ExitProvider>
              </ProjectProvider>
            </PermissionProvider>
          </SDKProvider>
        </KVProvider>
      </ArgsProvider>
    </TestTuiContexts>
  ))

  await ready
  await wait(() => sync.status === "complete")
  return { app, emit: events.emit, kv, project, replies, sync, session: calls.session }
}
