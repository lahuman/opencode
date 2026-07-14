import "../../app/happydom"
import "../../app/test-browser/solid-jsx"
import { mock } from "bun:test"

Object.assign(process.env, {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
})
Object.defineProperty(navigator, "userAgent", { value: "Linux", configurable: true })
document.body.innerHTML = '<div id="root"></div>'

type CapturedPlatform = {
  fetch?: typeof fetch
  openLink: (url: string) => void
}

const providedPlatform = Promise.withResolvers<CapturedPlatform>()
const openLinkCalls: string[] = []
const fetchCalls: Array<{ url: string; method: string }> = []

const solid = await import("solid-js")
// Keep startup suspended after the real index creates and provides its platform.
const resources = [
  { value: { id: "renderer-index-window" }, loading: false },
  { value: 1, loading: false },
  { value: undefined, loading: true },
  { value: "sidecar", loading: false },
  { value: undefined, loading: false },
]
let resourceIndex = 0
mock.module("solid-js", () => ({
  ...solid,
  createResource: () => {
    const resource = resources[resourceIndex++] ?? { value: undefined, loading: false }
    return [
      Object.assign(() => resource.value, { error: undefined, latest: resource.value, loading: resource.loading }),
    ]
  },
}))

mock.module("@opencode-ai/app", () => ({
  ACCEPTED_FILE_EXTENSIONS: [],
  AppBaseProviders: (props: { children?: unknown }) => props.children,
  AppInterface: (props: { children?: unknown }) => props.children,
  handleNotificationClick() {},
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
  useWslServers: () => ({ data: undefined }),
}))
mock.module("@opencode-ai/ui/logo", () => ({ Splash: () => document.createElement("span") }))
mock.module("@opencode-ai/ui/theme/context", () => ({
  useTheme: () => ({ mode: () => "light", themeId: () => "oc-2" }),
}))
mock.module("@sentry/solid", () => ({ init() {} }))
mock.module("@solidjs/router", () => ({
  createMemoryHistory: () => ({ listen: () => () => undefined, set() {} }),
  MemoryRouter: (props: { children?: unknown }) => props.children,
}))
mock.module("../src/renderer/i18n", () => ({ initI18n: async () => undefined, t: (key: string) => key }))
mock.module("../src/renderer/initialization", () => ({
  initializationData: (state: { latest?: unknown }) => state.latest,
  initializationReady: () => true,
}))
mock.module("../src/renderer/onboarding", () => ({ DesktopFirstLaunchOnboarding: () => null }))
mock.module("../src/renderer/webview-zoom", () => ({
  resetZoom() {},
  setPinchZoomEnabled: async () => undefined,
  webviewZoom: () => 1,
  zoomIn() {},
  zoomOut() {},
}))
mock.module("../src/renderer/wsl/connections", () => ({
  availableStartupServer: (value?: string | null) => value ?? "sidecar",
  readyWslConnections: () => [],
}))
mock.module("../src/renderer/styles.css", () => ({}))

const api = {
  awaitInitialization: () => new Promise(() => undefined),
  consumeInitialDeepLinks: async () => [],
  enterprise: {
    clearCredentials: async () => ({ restartRequired: true as const }),
    credentialStatus: async () => ({ configured: false }),
    readGuide: async () => ({ version: "pilot-1", markdown: "" }),
    setCredentials: async () => ({ restartRequired: true as const }),
  },
  getPinchZoomEnabled: async () => false,
  getWindowCount: async () => 1,
  getWindowID: async () => "renderer-index-window",
  onDeepLink: () => () => undefined,
  onMenuCommand() {},
  onPinchZoomEnabledChanged() {},
  onZoomFactorChanged() {},
  openLink: (url: string) => openLinkCalls.push(url),
  setBackgroundColor: async () => undefined,
  storeGet: async () => null,
  storeSet: async () => undefined,
  storeDelete: async () => undefined,
  storeClear: async () => undefined,
  storeKeys: async () => [],
  storeLength: async () => 0,
  updater: { subscribe: async () => undefined },
}
Object.assign(window, { api })

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

platform.openLink("https://opencode.ai/docs?token=renderer-index-open-secret")
platform.openLink("https://llm.corp.example/docs")

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

console.log(JSON.stringify({ openLinkCalls, fetchCalls, failures }))
