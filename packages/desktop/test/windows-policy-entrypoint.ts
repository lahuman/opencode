import { mock } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const mode = process.argv[2] ?? "packaged"
const publicProtocol = mode === "public-protocol"
Object.assign(process.env, {
  OPENCODE_ENTERPRISE: publicProtocol ? "0" : "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_ALLOWED_ORIGINS:
    "https://telemetry.corp.example:8443/private?token=csp-origin-secret,https://*.wildcard.example/private",
})
if (mode === "dev-origin") process.env.ELECTRON_RENDERER_URL = "http://localhost:5173"
if (mode === "dev-slash") process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/"
if (mode === "dev-index") process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/index.html"
if (mode === "packaged" || publicProtocol) delete process.env.ELECTRON_RENDERER_URL

type RequestResult = { cancel: boolean }
type RequestDetails = { url: string; resourceType: string; requestHeaders?: Record<string, string> }
type RequestHandler = (details: RequestDetails, callback: (result: RequestResult) => void) => void
type WindowOpenHandler = (details: { url: string }) => { action: "allow" | "deny" }
type NavigationEvent = { preventDefault(): void }
type NavigationHandler = (event: NavigationEvent, url: string) => void
type ProtocolHandler = (request: { url: string; headers: Headers }) => Promise<Response>

const logs: Array<{
  service: string
  message: string
  metadata?: Record<string, unknown>
  level?: string
}> = []
const protocolState: { handler?: ProtocolHandler } = {}
const partitions: string[] = []
const assetFetches: string[] = []
const windows: FakeBrowserWindow[] = []
const store = new Map<string, unknown>()
const contentTypes: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".png": "image/png",
  ".woff2": "font/woff2",
}
let throwWindowLog = false
let sessionRequest: RequestHandler | undefined
let sessionRequestRegistrations = 0

const assetSession = {
  async fetch(url: string) {
    assetFetches.push(url)
    const file = fileURLToPath(url)
    if (file.endsWith("fetch-error.js")) throw new Error("raw-error-secret /Users/private/credential")
    const body = await Bun.file(file)
    if (!(await body.exists())) return new Response("Not found", { status: 404 })
    return new Response(await body.arrayBuffer(), {
      headers: { "content-type": contentTypes[extname(file)] ?? "application/octet-stream" },
    })
  },
}

const rendererSession = {
  setPermissionRequestHandler() {},
  setPermissionCheckHandler() {},
  webRequest: {
    onBeforeRequest(callback: RequestHandler) {
      sessionRequestRegistrations++
      sessionRequest = callback
    },
    onBeforeSendHeaders() {},
    onHeadersReceived() {},
  },
}

class FakeBrowserWindow {
  static getAllWindows() {
    return windows
  }

  static getFocusedWindow() {}

  callbacks: {
    request?: RequestHandler
    windowOpen?: WindowOpenHandler
    navigation?: NavigationHandler
    redirect?: NavigationHandler
  } = {}
  loadedURL = ""
  title: string | undefined
  zoom = 1
  events = new Map<string, Array<(...args: unknown[]) => void>>()
  webContents = {
    id: windows.length + 1,
    mainFrame: { collectJavaScriptCallStack: () => Promise.resolve("") },
    session: rendererSession,
    setWindowOpenHandler: (callback: WindowOpenHandler) => {
      this.callbacks.windowOpen = callback
    },
    on: (event: string, callback: NavigationHandler) => {
      if (event === "will-navigate") this.callbacks.navigation = callback
      if (event === "will-redirect") this.callbacks.redirect = callback
    },
    getURL: () => this.loadedURL,
    getZoomFactor: () => this.zoom,
    setZoomFactor: (value: number) => {
      this.zoom = value
    },
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
    send() {},
  }

  constructor(options?: { title?: string }) {
    this.title = options?.title
    windows.push(this)
  }

  on(event: string, callback: (...args: unknown[]) => void) {
    this.events.set(event, [...(this.events.get(event) ?? []), callback])
  }

  once(event: string, callback: (...args: unknown[]) => void) {
    this.on(event, callback)
  }

  loadURL(url: string) {
    this.loadedURL = url
    return Promise.resolve()
  }

  isDestroyed() {
    return false
  }

  setBackgroundColor() {}
  setTitleBarOverlay() {}
  invalidateShadow() {}
  show() {}
}

mock.module("electron-window-state", () => ({
  default: () => ({
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
    manage() {},
  }),
}))

mock.module("../src/main/store", () => ({
  getStore: () => ({
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
  }),
  removeStoreFile() {},
}))

mock.module("../src/main/logging", () => ({
  exportDebugLogs: () => Promise.resolve(""),
  write: (service: string, message: string, metadata?: Record<string, unknown>, level?: string) => {
    if (throwWindowLog && service === "window") throw new Error("logger failed")
    logs.push({ service, message, metadata, level })
  },
}))

mock.module("electron", () => ({
  default: { app: { getPath: () => tmpdir() } },
  app: {
    dock: undefined,
    exit() {},
    getName: () => "Company OpenCode Pilot",
    getPath: () => tmpdir(),
    isPackaged: false,
    quit() {},
    relaunch() {},
  },
  BrowserWindow: FakeBrowserWindow,
  crashReporter: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  nativeTheme: { shouldUseDarkColors: false },
  net: {},
  netLog: {},
  protocol: {
    handle(_scheme: string, handler: ProtocolHandler) {
      protocolState.handler = handler
    },
    isProtocolHandled: () => false,
    registerSchemesAsPrivileged() {},
  },
  session: {
    fromPartition(partition: string) {
      partitions.push(partition)
      return assetSession
    },
  },
  shell: { openExternal() {}, openPath() {} },
}))

function request(callback: RequestHandler | undefined, details: RequestDetails) {
  if (!callback) throw new Error("request boundary was not registered")
  const result: { value?: RequestResult; error?: string } = {}
  try {
    callback(details, (value) => {
      result.value = value
    })
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  return result
}

function navigate(callback: NavigationHandler | undefined, url: string) {
  if (!callback) return "missing"
  const state = { prevented: false }
  callback(
    {
      preventDefault() {
        state.prevented = true
      },
    },
    url,
  )
  return state.prevented
}

async function protocolRequest(url: string) {
  if (!protocolState.handler) throw new Error("protocol boundary was not registered")
  return protocolState.handler({ url, headers: new Headers() }).catch(() => new Response("threw", { status: 599 }))
}

async function protocolAssets(paths: string[]) {
  return Promise.all(
    paths.map(async (path) => {
      const response = await protocolRequest(`oc://renderer/${path}?token=asset-query-secret`)
      return {
        path,
        status: response.status,
        type: response.headers.get("content-type"),
        contentSecurityPolicy: response.headers.get("content-security-policy"),
        documentPolicy: response.headers.get("document-policy"),
      }
    }),
  )
}

const assetRoot = await mkdtemp(join(tmpdir(), "opencode-renderer-assets-"))
await mkdir(join(assetRoot, "assets"))
await Promise.all([
  writeFile(join(assetRoot, "index.html"), "<script src='/assets/app.js'></script>"),
  writeFile(join(assetRoot, "assets/app.js"), "export const loaded = true"),
  writeFile(join(assetRoot, "assets/app.css"), "body { color: black; }"),
  writeFile(join(assetRoot, "assets/font.woff2"), "font"),
  writeFile(join(assetRoot, "assets/icon.png"), "image"),
])

if (publicProtocol) {
  try {
    const { registerRendererProtocol } = await import("../src/main/windows")
    registerRendererProtocol({ rendererRoot: assetRoot })
    console.log(
      JSON.stringify({
        mode,
        assets: await protocolAssets(["index.html", "assets/app.js", "assets/app.css"]),
      }),
    )
  } finally {
    await rm(assetRoot, { recursive: true, force: true })
  }
  process.exit(0)
}

try {
  const { createMainWindow, installEnterpriseWindowPolicy, registerRendererProtocol } = await import(
    "../src/main/windows"
  )
  createMainWindow("security-review")
  createMainWindow("security-review-second")
  const win = windows[0]
  const second = windows[1]
  if (!win) throw new Error("production window was not created")
  if (!second) throw new Error("second production window was not created")
  registerRendererProtocol({ rendererRoot: assetRoot })

  const requests = {
    markdownImage: request(sessionRequest, {
      url: "https://cdn.example/private.png?token=renderer-secret",
      resourceType: "image",
      requestHeaders: { Authorization: "Bearer hidden" },
    }),
    providerStylesheet: request(sessionRequest, {
      url: "https://llm.corp.example/app.css",
      resourceType: "stylesheet",
    }),
    dataFont: request(sessionRequest, {
      url: "data:font/woff2;base64,AA==",
      resourceType: "font",
    }),
    publicStylesheet: request(sessionRequest, {
      url: "https://cdn.example/private.css?token=style-secret",
      resourceType: "stylesheet",
    }),
    publicFont: request(sessionRequest, {
      url: "https://fonts.example/private.woff2?token=font-secret",
      resourceType: "font",
    }),
    rawFetch: request(sessionRequest, {
      url: "https://opencode.ai/changelog.json?token=fetch-secret",
      resourceType: "xhr",
    }),
    malformed: request(sessionRequest, {
      url: "not a URL?token=malformed-secret",
      resourceType: "other",
    }),
    rendererFile: request(sessionRequest, {
      url: "file:///Users/private/credential?token=file-secret",
      resourceType: "script",
    }),
  }

  throwWindowLog = true
  const loggerFailure = request(sessionRequest, {
    url: "https://logger.example/private?token=logger-secret",
    resourceType: "xhr",
  })
  throwWindowLog = false

  const windowOpen = {
    public: win.callbacks.windowOpen?.({ url: "https://opencode.ai/docs?token=window-secret" }),
    provider: win.callbacks.windowOpen?.({ url: "https://llm.corp.example/docs" }),
  }
  const startup = win.loadedURL
  const credentialed = new URL(startup)
  credentialed.username = "user"
  credentialed.password = "navigation-credential-secret"
  const navigationURLs = {
    trusted: startup,
    trustedHash: `${startup}#workspace`,
    alternateDocument: new URL("other.html", startup).toString(),
    asset: new URL("assets/app.js", startup).toString(),
    query: `${startup}?token=navigation-query-secret`,
    credentialed: credentialed.toString(),
    packagedAlternate: "oc://renderer/alternate.html",
    provider: "https://llm.corp.example/docs?token=navigation-secret",
    loopback: "http://127.0.0.1:4096/redirect",
    external: "https://external.example/redirect",
    malformed: "not a URL?token=navigation-malformed-secret",
  }
  const navigation = Object.fromEntries(
    Object.entries(navigationURLs).map(([key, url]) => [key, navigate(win.callbacks.navigation, url)]),
  )
  const redirects = Object.fromEntries(
    Object.entries(navigationURLs).map(([key, url]) => [key, navigate(win.callbacks.redirect, url)]),
  )
  const secondWindowHandlers = {
    windowOpen: second.callbacks.windowOpen?.({ url: "https://external.example/second" }),
    navigation: navigate(second.callbacks.navigation, startup),
    redirect: navigate(second.callbacks.redirect, "https://llm.corp.example/second"),
  }

  const assets = await protocolAssets([
    "index.html",
    "assets/app.js",
    "assets/app.css",
    "assets/font.woff2",
    "assets/icon.png",
  ])
  const protocolRejections = {
    invalidURL: (await protocolRequest("not a URL?token=protocol-malformed-secret")).status,
    host: (await protocolRequest("oc://attacker/private.js?token=host-secret")).status,
    traversal: (await protocolRequest("oc://renderer/..%2F..%2FUsers%2Fprivate%2Fcredential?token=traversal-secret"))
      .status,
    malformedEncoding: (await protocolRequest("oc://renderer/%E0%A4%A?token=decode-secret")).status,
    missing: (await protocolRequest("oc://renderer/assets/missing-secret.js?token=missing-query-secret")).status,
    fetchError: (await protocolRequest("oc://renderer/assets/fetch-error.js?token=fetch-error-query-secret")).status,
  }

  const ordinary = new FakeBrowserWindow()
  Reflect.apply(installEnterpriseWindowPolicy, undefined, [ordinary, { profile: { enabled: false } }])
  const conflicting = new FakeBrowserWindow()
  const conflictingPolicyError = (() => {
    try {
      Reflect.apply(installEnterpriseWindowPolicy, undefined, [
        conflicting,
        {
          profile: {
            enabled: true,
            baseURL: "https://other.example/v1",
            modelID: "other",
            modelName: "Other",
            defaultsVersion: "other",
            guideVersion: "other",
            allowedOrigins: ["https://other.example"],
          },
        },
      ])
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })()

  console.log(
    JSON.stringify({
      productionWindow: {
        mode,
        title: win.title,
        loadedURL: win.loadedURL,
        secondTitle: second.title,
        secondLoadedURL: second.loadedURL,
        sessionRequestRegistrations,
        registrations: {
          request: Boolean(sessionRequest),
          windowOpen: Boolean(win.callbacks.windowOpen),
          navigation: Boolean(win.callbacks.navigation),
          redirect: Boolean(win.callbacks.redirect),
        },
      },
      requests,
      loggerFailure,
      windowOpen,
      navigation,
      redirects,
      secondWindowHandlers,
      protocol: {
        registered: Boolean(protocolState.handler),
        partitions,
        assetFetches,
        assets,
        rejections: protocolRejections,
      },
      logs,
      ordinaryRegistrations: {
        requestRegistrations: sessionRequestRegistrations,
        windowOpen: Boolean(ordinary.callbacks.windowOpen),
        navigation: Boolean(ordinary.callbacks.navigation),
        redirect: Boolean(ordinary.callbacks.redirect),
      },
      conflictingPolicyError,
    }),
  )
} finally {
  await rm(assetRoot, { recursive: true, force: true })
}
