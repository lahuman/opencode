import "../../app/happydom"
import "../../app/test-browser/solid-jsx"
import { mock } from "bun:test"

const mode = process.argv[2] ?? "enterprise"
const enterprise = mode === "enterprise"
Object.assign(process.env, {
  OPENCODE_ENTERPRISE: enterprise ? "1" : "0",
  OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
    { id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" },
  ]),
  OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "chai-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
})
Object.defineProperty(navigator, "userAgent", { value: "Linux", configurable: true })
document.title = "OpenCode"
document.body.innerHTML = '<div id="root"></div>'

type CapturedPlatform = {
  fetch?: typeof fetch
  openExternal: (url: string) => void
}

const providedPlatform = Promise.withResolvers<CapturedPlatform>()
const openLinkCalls: string[] = []
const fetchCalls: Array<{ url: string; method: string }> = []

mock.module("@opencode/app/desktop", () => ({
  CHAIWordmark: () => document.createElementNS("http://www.w3.org/2000/svg", "svg"),
  currentRoute: () => ({ type: "home" }),
  preloadRoute: async () => undefined,
  createNamespaceStorage: () => ({ getItem: () => null }),
  flushPersisted: () => undefined,
  AppBaseProviders: (props: { children?: unknown }) => props.children,
  AppInterface: (props: { children?: unknown }) => props.children,
  createDraftStore: () => ({}),
  loadLocaleDict: async () => undefined,
  normalizeLocale: (value: string) => value,
  PlatformProvider: (props: { value: CapturedPlatform; children?: unknown }) => {
    providedPlatform.resolve(props.value)
    return props.children
  },
  ServerConnection: {
    Key: { make: (value: string) => value },
    builtin: () => true,
  },
  useCommand: () => ({ trigger() {} }),
  useLanguage: () => ({ t: (key: string) => key }),
  useExtensionServers: () => ({ ready: () => false, list: () => [] }),
  useCurrentRoute: () => ({ type: "home" }),
  useTabs: () => ({}),
}))
mock.module("@opencode/ui/logo", () => ({ Splash: () => document.createElement("span") }))
mock.module("@opencode/ui/theme/context", () => ({
  useTheme: () => ({ mode: () => "light", themeId: () => "oc-2" }),
}))
mock.module("@sentry/solid", () => ({ init() {} }))
mock.module("@solidjs/router", () => ({
  createMemoryHistory: () => ({ listen: () => () => undefined, set() {} }),
  MemoryRouter: (props: { children?: unknown }) => props.children,
}))
mock.module("../src/renderer/onboarding", () => ({ DesktopFirstLaunchOnboarding: () => null }))
mock.module("../src/renderer/styles.css", () => ({}))

const api = {
  awaitInitialization: () => new Promise(() => undefined),
  consumeInitialDeepLinks: async () => [],
  enterprise: {
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
  getWindowFullscreen: async () => false,
  getZoomFactor: async () => 1,
  getWindowID: () => "renderer-index-window",
  getWindowBootstrap: () => ({ firstLaunchPending: false, packaged: true }),
  onStoreChanged() {},
  onDeepLink: () => () => undefined,
  onMenuCommand() {},
  onPinchZoomEnabledChanged() {},
  onWindowFullscreenChanged() {},
  onZoomFactorChanged() {},
  openExternal: (url: string) => openLinkCalls.push(url),
  openLocalFile: () => undefined,
  setBackgroundColor: async () => undefined,
  storeGet: async () => null,
  storeSet: async () => undefined,
  storeDelete: async () => undefined,
  storeClear: async () => undefined,
  storeKeys: async () => [],
  storeLength: async () => 0,
  updater: { subscribe: async () => undefined },
}
mock.module("../src/renderer/api", () => ({ api }))
Object.assign(window, { electron: { enterprise: enterprise ? api.enterprise : undefined } })

const nativeFetch: typeof fetch = (input, init) => {
  fetchCalls.push({
    url: input instanceof Request ? input.url : String(input),
    method: input instanceof Request ? input.method : (init?.method ?? "GET"),
  })
  return Promise.resolve(new Response(null, { status: 204 }))
}
Object.defineProperty(globalThis, "fetch", { value: nativeFetch, configurable: true, writable: true })

await import("../src/renderer/index")
const timeout = setTimeout(
  () => providedPlatform.reject(new Error("real renderer entrypoint did not provide a desktop platform")),
  1_000,
)
const platform = await providedPlatform.promise.finally(() => clearTimeout(timeout))

if (!enterprise) {
  console.log(JSON.stringify({ documentTitle: document.title }))
  process.exit(0)
}

platform.openExternal("https://opencode.ai/docs?token=renderer-index-open-secret")
platform.openExternal("https://llm.corp.example/docs")

const rendererFetch = platform.fetch
if (!rendererFetch) throw new Error("desktop platform fetch is unavailable")
const failures = await Promise.all(
  [
    rendererFetch("https://cdn.example/data.json?token=renderer-index-string-secret"),
    rendererFetch(new Request("file:///Users/private/credential?token=renderer-index-request-secret")),
  ].map((promise) =>
    promise.then(() => null).catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
  ),
)
await rendererFetch(new Request("https://llm.corp.example/v1/models", { method: "POST" }))

console.log(JSON.stringify({ documentTitle: document.title, openLinkCalls, fetchCalls, failures }))
