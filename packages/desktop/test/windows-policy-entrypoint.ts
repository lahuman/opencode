import { mock } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

Object.assign(process.env, {
  OPENCODE_ENTERPRISE: "1",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
})
delete process.env.ELECTRON_RENDERER_URL

type RequestResult = { cancel: boolean }
type RequestDetails = { url: string; resourceType: string; requestHeaders?: Record<string, string> }
type RequestHandler = (details: RequestDetails, callback: (result: RequestResult) => void) => void
type WindowOpenHandler = (details: { url: string }) => { action: "allow" | "deny" }
type NavigationEvent = { preventDefault(): void }
type NavigationHandler = (event: NavigationEvent, url: string) => void
type ProtocolHandler = (request: { url: string }) => Promise<Response>

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
  zoom = 1
  events = new Map<string, Array<(...args: unknown[]) => void>>()
  webContents = {
    id: windows.length + 1,
    mainFrame: { collectJavaScriptCallStack: () => Promise.resolve("") },
    session: {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
      webRequest: {
        onBeforeRequest: (callback: RequestHandler) => {
          this.callbacks.request = callback
        },
        onBeforeSendHeaders() {},
        onHeadersReceived() {},
      },
    },
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

  constructor() {
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
  return protocolState.handler({ url }).catch(() => new Response("threw", { status: 599 }))
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

try {
  const { createMainWindow, installEnterpriseWindowPolicy, registerRendererProtocol } = await import(
    "../src/main/windows"
  )
  createMainWindow("security-review")
  const win = windows.at(-1)
  if (!win) throw new Error("production window was not created")
  registerRendererProtocol({ rendererRoot: assetRoot })

  const requests = {
    markdownImage: request(win.callbacks.request, {
      url: "https://cdn.example/private.png?token=renderer-secret",
      resourceType: "image",
      requestHeaders: { Authorization: "Bearer hidden" },
    }),
    providerStylesheet: request(win.callbacks.request, {
      url: "https://llm.corp.example/app.css",
      resourceType: "stylesheet",
    }),
    dataFont: request(win.callbacks.request, {
      url: "data:font/woff2;base64,AA==",
      resourceType: "font",
    }),
    publicStylesheet: request(win.callbacks.request, {
      url: "https://cdn.example/private.css?token=style-secret",
      resourceType: "stylesheet",
    }),
    publicFont: request(win.callbacks.request, {
      url: "https://fonts.example/private.woff2?token=font-secret",
      resourceType: "font",
    }),
    rawFetch: request(win.callbacks.request, {
      url: "https://opencode.ai/changelog.json?token=fetch-secret",
      resourceType: "xhr",
    }),
    malformed: request(win.callbacks.request, {
      url: "not a URL?token=malformed-secret",
      resourceType: "other",
    }),
    rendererFile: request(win.callbacks.request, {
      url: "file:///Users/private/credential?token=file-secret",
      resourceType: "script",
    }),
  }

  throwWindowLog = true
  const loggerFailure = request(win.callbacks.request, {
    url: "https://logger.example/private?token=logger-secret",
    resourceType: "xhr",
  })
  throwWindowLog = false

  const windowOpen = {
    public: win.callbacks.windowOpen?.({ url: "https://opencode.ai/docs?token=window-secret" }),
    provider: win.callbacks.windowOpen?.({ url: "https://llm.corp.example/docs" }),
  }
  const navigation = {
    trusted: navigate(win.callbacks.navigation, "oc://renderer/index.html"),
    provider: navigate(win.callbacks.navigation, "https://llm.corp.example/docs?token=navigation-secret"),
    loopback: navigate(win.callbacks.navigation, "http://127.0.0.1:4096/redirect"),
    external: navigate(win.callbacks.navigation, "https://external.example/redirect"),
  }
  const redirects = {
    trusted: navigate(win.callbacks.redirect, "oc://renderer/index.html"),
    provider: navigate(win.callbacks.redirect, "https://llm.corp.example/docs?token=redirect-provider-secret"),
    loopback: navigate(win.callbacks.redirect, "http://localhost:4096/redirect?token=redirect-loopback-secret"),
    external: navigate(win.callbacks.redirect, "https://external.example/redirect?token=redirect-external-secret"),
  }

  const assets = await Promise.all(
    ["index.html", "assets/app.js", "assets/app.css", "assets/font.woff2", "assets/icon.png"].map(async (path) => {
      const response = await protocolRequest(`oc://renderer/${path}?token=asset-query-secret`)
      return { path, status: response.status, type: response.headers.get("content-type") }
    }),
  )
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

  console.log(
    JSON.stringify({
      productionWindow: {
        loadedURL: win.loadedURL,
        registrations: {
          request: Boolean(win.callbacks.request),
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
      protocol: {
        registered: Boolean(protocolState.handler),
        partitions,
        assetFetches,
        assets,
        rejections: protocolRejections,
      },
      logs,
      ordinaryRegistrations: {
        request: Boolean(ordinary.callbacks.request),
        windowOpen: Boolean(ordinary.callbacks.windowOpen),
        navigation: Boolean(ordinary.callbacks.navigation),
        redirect: Boolean(ordinary.callbacks.redirect),
      },
    }),
  )
} finally {
  await rm(assetRoot, { recursive: true, force: true })
}
