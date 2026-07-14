import "../../app/happydom"

const mode = process.argv[2]
Object.assign(process.env, {
  OPENCODE_ENTERPRISE: mode === "enterprise" ? "1" : "0",
  OPENCODE_ENTERPRISE_BASE_URL: mode === "enterprise" ? "https://llm.corp.example/v1" : "",
  OPENCODE_ENTERPRISE_MODEL_ID: mode === "enterprise" ? "company-code" : "",
  OPENCODE_ENTERPRISE_MODEL_NAME: mode === "enterprise" ? "Company Code" : "",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: mode === "enterprise" ? "pilot-1" : "",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: mode === "enterprise" ? "pilot-1" : "",
})

Object.defineProperty(navigator, "userAgent", { value: "Linux", configurable: true })

const openLinkCalls: string[] = []
const fetchCalls: Array<{ url: string; method: string }> = []
const api = {
  enterprise: {
    enabled: mode === "enterprise",
    credentialStatus: async () => ({ configured: false }),
    setCredentials: async () => ({ restartRequired: true as const }),
    clearCredentials: async () => ({ restartRequired: true as const }),
    readGuide: async () => ({ version: "pilot-1", markdown: "" }),
  },
  getPinchZoomEnabled: async () => false,
  onPinchZoomEnabledChanged() {},
  onZoomFactorChanged() {},
  openLink: (url: string) => openLinkCalls.push(url),
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

const { createPlatform } = await import("../src/renderer/platform")
const platform = createPlatform({}, () => ({ status: "disabled" }), {
  acceptedFileExtensions: [],
  handleNotificationClick() {},
  makeServerKey: (value) => value,
})

platform.openLink("https://opencode.ai/docs?token=open-link-secret")
platform.openLink("https://llm.corp.example/docs")

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

console.log(JSON.stringify({ mode, openLinkCalls, fetchCalls, failures }))
