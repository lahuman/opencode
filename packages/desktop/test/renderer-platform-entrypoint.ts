import "../../app/happydom"
import { mock } from "bun:test"
import { createDraftStore } from "../../app/src/runtime/persistence/drafts"
import { createNamespaceStorage } from "../../app/src/runtime/persistence/namespace"
import { flushPersisted } from "../../app/src/runtime/persistence/persist"

mock.module("@opencode/app/desktop", () => ({ createDraftStore, createNamespaceStorage, flushPersisted }))
mock.module("../src/renderer/ipc-client", () => ({
  onBeforeDispose: () => {}, invoke: async () => {}, listen: () => () => {}, send: () => {}, cancellable: () => {},
}))

const mode = process.argv[2]
Object.assign(process.env, {
  OPENCODE_ENTERPRISE: mode === "enterprise" ? "1" : "0",
  OPENCODE_ENTERPRISE_MODELS:
    mode === "enterprise"
      ? JSON.stringify([{ id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" }])
      : "",
  OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: mode === "enterprise" ? "company-code" : "",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: mode === "enterprise" ? "pilot-1" : "",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: mode === "enterprise" ? "chai-1" : "",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: mode === "enterprise" ? "catalog-1" : "",
})

Object.defineProperty(navigator, "userAgent", { value: "Linux", configurable: true })

const openLinkCalls: string[] = []
const fetchCalls: Array<{ url: string; method: string }> = []
const restartCalls: string[] = []
const api = {
  enterprise: {
    enabled: mode === "enterprise",
    providerCatalog: async () => ({ schemaVersion: 1 as const, providers: [] }),
    createProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
    updateProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
    deleteProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
    createModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
    deleteModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
    setDefaultModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
    replaceProviderCredentials: async () => ({ schemaVersion: 1 as const, providers: [] }),
    clearProviderCredentials: async () => ({ schemaVersion: 1 as const, providers: [] }),
    readGuide: async () => ({ version: "chai-1", markdown: "" }),
  },
  getPinchZoomEnabled: async () => false,
  onPinchZoomEnabledChanged() {},
  onZoomFactorChanged() {},
  openExternal: (url: string) => openLinkCalls.push(url),
  openLocalFile: () => undefined,
  killSidecar: async () => {
    restartCalls.push("kill-sidecar")
  },
  relaunch: async () => {
    restartCalls.push("relaunch")
  },
  getZoomFactor: async () => 1,
  getWindowBootstrap: () => ({ packaged: false }),
  getWindowFullscreen: async () => false,
  onWindowFullscreenChanged: () => {},
  onStoreChanged: () => {},
}
Object.assign(window, { electron: { enterprise: api.enterprise } })
mock.module("../src/renderer/api", () => ({ api }))

const nativeFetch: typeof fetch = (input, init) => {
  fetchCalls.push({
    url: input instanceof Request ? input.url : String(input),
    method: input instanceof Request ? input.method : (init?.method ?? "GET"),
  })
  return Promise.resolve(new Response(null, { status: 204 }))
}
Object.defineProperty(globalThis, "fetch", { value: nativeFetch, configurable: true, writable: true })

const { createDesktopPlatform } = await import("../src/renderer/platform")
const platform = createDesktopPlatform(api as unknown as Parameters<typeof createDesktopPlatform>[0], { id: "test-window", version: "test" })

platform.openExternal("https://opencode.ai/docs?token=open-link-secret")
platform.openExternal("https://llm.corp.example/docs")

const rendererFetch = platform.fetch
if (!rendererFetch) throw new Error("desktop platform fetch is unavailable")
const failures = await Promise.all(
  [
    rendererFetch("https://cdn.example/data.json?token=string-secret"),
    rendererFetch(new URL("https://opencode.ai/data.json?token=url-secret")),
    rendererFetch(new Request("file:///Users/private/credential?token=request-secret")),
  ].map((promise) =>
    promise.then(() => null).catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
  ),
)

await rendererFetch(new Request("https://llm.corp.example/v1/models", { method: "POST" }))
await rendererFetch("http://localhost:4096/api", { method: "PUT" })
await platform.restart()

console.log(JSON.stringify({ mode, openLinkCalls, fetchCalls, failures, restartCalls }))
