import { mock } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mode = process.argv[2] ?? "enterprise"
const enterprise = mode === "enterprise"
Object.assign(process.env, {
  OPENCODE_CHANNEL: "prod",
  OPENCODE_ENTERPRISE: enterprise ? "1" : "0",
  OPENCODE_ENTERPRISE_BASE_URL: "https://llm.corp.example/v1",
  OPENCODE_ENTERPRISE_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_MODEL_NAME: "Company Code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
  OPENCODE_PORT: "4096",
})
Object.defineProperty(process, "resourcesPath", { value: tmpdir(), configurable: true })

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const listeners = new Map<string, (...args: unknown[]) => unknown>()
const shellOpenExternalURLs: string[] = []
const protocolClients: string[] = []
const paths = new Map<string, string>()
let rendererProtocolRegistrations = 0
let appName = "Electron"
let appUserModelId = ""
const appData = join(tmpdir(), "opencode-main-index-app-data")

const app = {
  commandLine: {
    appendSwitch() {},
    getSwitchValue: () => "",
  },
  dock: undefined,
  exit() {},
  getName: () => appName,
  getPath: (name: string) => (name === "appData" ? appData : (paths.get(name) ?? tmpdir())),
  getVersion: () => "2.0.0",
  isPackaged: mode !== "ordinary-unpackaged",
  on() {},
  once() {},
  quit() {},
  relaunch() {},
  requestSingleInstanceLock: () => true,
  setAppUserModelId(value: string) {
    appUserModelId = value
  },
  setAsDefaultProtocolClient(value: string) {
    protocolClients.push(value)
  },
  setName(value: string) {
    appName = value
  },
  setPath(name: string, value: string) {
    paths.set(name, value)
  },
  whenReady: () => Promise.resolve(),
}

mock.module("node:tls", () => ({ getCACertificates: () => [], setDefaultCACertificates() {} }))
mock.module("electron", () => ({
  default: { app },
  app,
  BrowserWindow: {
    fromWebContents() {},
    getAllWindows() {
      return []
    },
    getFocusedWindow() {},
  },
  Notification: class {
    show() {}
  },
  clipboard: { readImage: () => ({ isEmpty: () => true }) },
  crashReporter: {},
  dialog: { showOpenDialog: () => undefined, showSaveDialog: () => undefined },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) => listeners.set(channel, handler),
  },
  nativeImage: {},
  nativeTheme: { shouldUseDarkColors: false },
  net: {},
  netLog: {},
  protocol: { registerSchemesAsPrivileged() {} },
  safeStorage: {
    decryptString: () => "{}",
    encryptString: (value: string) => Buffer.from(value),
    isEncryptionAvailable: () => true,
  },
  session: { fromPartition: () => ({ fetch: () => undefined }) },
  shell: {
    openExternal: (url: string) => {
      shellOpenExternalURLs.push(url)
    },
    openPath: () => undefined,
  },
}))

mock.module("electron-context-menu", () => ({ default() {} }))
mock.module("../src/main/apps", () => ({ checkAppExists: () => false, resolveAppPath: async () => null }))
mock.module("../src/main/logging", () => ({
  exportDebugLogs: async () => "logs.zip",
  initCrashReporter() {},
  initLogging: () => ({ error() {}, log() {}, warn() {} }),
  startNetLog: async () => undefined,
  write() {},
}))
mock.module("../src/main/markdown", () => ({ parseMarkdown: async (value: string) => value }))
mock.module("../src/main/menu", () => ({ createMenu() {} }))
mock.module("../src/main/onboarding", () => ({
  finishFirstLaunchOnboarding: () => null,
  isFirstLaunchOnboardingPending: () => false,
}))
mock.module("../src/main/server", () => ({
  getDefaultServerUrl: () => null,
  preferAppEnv() {},
  setDefaultServerUrl() {},
  spawnLocalServer: async () => ({
    listener: { stop: async () => undefined },
    health: { wait: Promise.resolve() },
  }),
}))
mock.module("../src/main/store", () => ({
  getStore: () => ({
    clear() {},
    delete() {},
    get: () => undefined,
    set() {},
    store: {},
  }),
  removeStoreFileIfEmpty: async () => undefined,
}))
mock.module("../src/main/store-cleanup", () => ({ cleanupStoreFiles: async () => ({ deleted: [], scanned: 0 }) }))
mock.module("../src/main/migrate", () => ({ migrate() {} }))

const updater = {
  check: async () => undefined,
  install: async () => undefined,
  start: async () => undefined,
  subscribe: () => () => undefined,
}
mock.module("../src/main/updater", () => ({
  setupAutoUpdater: () => updater,
  showUpdaterDialog: async () => undefined,
}))
mock.module("../src/main/windows", () => ({
  createMainWindow: () => undefined,
  exportDebugLogs: async () => "logs.zip",
  getLastFocusedWindow: () => null,
  getPinchZoomEnabled: () => false,
  getWindowID: () => "window",
  registerRendererProtocol: () => {
    rendererProtocolRegistrations++
  },
  restoreMainWindows: () => [],
  setAppQuitting() {},
  setBackgroundColor() {},
  setDockIcon() {},
  setPinchZoomEnabled() {},
  setRelaunchHandler() {},
  setTitlebar() {},
  updateTitlebar() {},
}))
mock.module("../src/main/wsl/servers", () => ({
  createWslServersController: () => ({ initialize: async () => undefined, stopAll() {} }),
}))
mock.module("../src/main/wsl/ipc", () => ({ registerWslIpcHandlers() {} }))
mock.module("../src/main/wsl/sidecar", () => ({ spawnWslSidecar: async () => undefined }))

if (mode === "identity") {
  const { desktopIdentity } = await import("../src/main/constants")
  console.log(
    JSON.stringify({
      enterpriseProd: desktopIdentity({ channel: "prod", enterprise: true }),
      enterpriseDev: desktopIdentity({ channel: "dev", enterprise: true }),
      dev: desktopIdentity({ channel: "dev", enterprise: false }),
      beta: desktopIdentity({ channel: "beta", enterprise: false }),
      prod: desktopIdentity({ channel: "prod", enterprise: false }),
    }),
  )
  process.exit(0)
}

await import("../src/main/index")

for (let attempts = 0; attempts < 100 && !listeners.has("open-link"); attempts++) await Bun.sleep(10)

await listeners.get("open-link")?.({}, "https://opencode.ai/docs?token=main-index-secret")
await listeners.get("open-link")?.({}, "https://llm.corp.example/docs")
await listeners.get("open-link")?.({}, "https://user:secret@llm.corp.example/docs")

console.log(
  JSON.stringify({
    rendererProtocolRegistrations,
    ipcRegistered: handlers.has("enterprise-guide-read") && listeners.has("open-link"),
    shellOpenExternalURLs,
    identity: {
      appId: appUserModelId,
      name: appName,
      userData: paths.get("userData"),
    },
    protocolClients,
  }),
)
