import { mock } from "bun:test"
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mode = process.argv[2] ?? "enterprise"
const unhealthyCredentials =
  mode === "enterprise-credentials-corrupt" || mode === "enterprise-credentials-unavailable"
const enterprise = mode === "enterprise" || mode === "enterprise-provider-restart" || unhealthyCredentials
Object.assign(process.env, {
  OPENCODE_CHANNEL: "prod",
  OPENCODE_ENTERPRISE: enterprise ? "1" : "0",
  OPENCODE_ENTERPRISE_MODELS: JSON.stringify([{ id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" }]),
  OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "company-code",
  OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
  OPENCODE_ENTERPRISE_GUIDE_VERSION: "sfmi-1",
  OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
  OPENCODE_PORT: "4096",
})
Object.defineProperty(process, "resourcesPath", { value: tmpdir(), configurable: true })

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const listeners = new Map<string, (...args: unknown[]) => unknown>()
const shellOpenExternalURLs: string[] = []
const protocolClients: string[] = []
const paths = new Map<string, string>()
let rendererProtocolRegistrations = 0
let preflightCalls = 0
let statePrepared = 0
let stateHealthy = 0
let sidecarStarts = 0
let sidecarStops = 0
let relaunches = 0
const sidecarStates: {
  default?: { providerID: string; modelID: string }
  providers: string[]
  credentialProviders: string[]
}[] = []
let appName = "Electron"
let appUserModelId = ""
const appData = join(tmpdir(), "opencode-main-index-app-data")
process.env.LOCALAPPDATA = appData
const userData = join(
  appData,
  enterprise ? "com.company.sfmi" : mode === "ordinary-unpackaged" ? "ai.opencode.desktop.dev" : "ai.opencode.desktop",
)
rmSync(userData, {
  recursive: true,
  force: true,
})
const credentialFile = join(userData, "enterprise-credentials.bin")
const credentialTimestamp = new Date("2020-01-01T00:00:00.000Z")
if (unhealthyCredentials) {
  mkdirSync(userData, { recursive: true })
  if (mode === "enterprise-credentials-corrupt") {
    writeFileSync(
      join(userData, "enterprise-providers.json"),
      JSON.stringify({
        schemaVersion: 1,
        default: { providerID: "existing", modelID: "company-code" },
        providers: [
          {
            id: "existing",
            name: "Existing Provider",
            baseURL: "https://existing.example/v1",
            models: [{ id: "company-code", name: "Existing Code" }],
          },
        ],
      }),
    )
  }
  writeFileSync(
    credentialFile,
    mode === "enterprise-credentials-corrupt"
      ? "unreadable-encrypted-main-index-secret"
      : JSON.stringify({
          schemaVersion: 3,
          providers: {
            "company-llm": { apiKey: "unavailable-main-index-secret", headers: { Authorization: "secret-header" } },
          },
        }),
  )
  utimesSync(credentialFile, credentialTimestamp, credentialTimestamp)
}
const credentialBefore = unhealthyCredentials ? readFileSync(credentialFile) : undefined
const credentialModifiedBefore = unhealthyCredentials ? statSync(credentialFile).mtimeMs : undefined

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
  relaunch() {
    relaunches++
  },
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
    decryptString: (value: Buffer) => {
      if (mode === "enterprise-credentials-corrupt") throw new Error("credential decrypt failed")
      return value.toString("utf8")
    },
    encryptString: (value: string) => Buffer.from(value),
    isEncryptionAvailable: () => mode !== "enterprise-credentials-unavailable",
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
  configureEnterpriseSupport() {},
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
  initializeOldLayoutEligibility: () => false,
  isFirstLaunchOnboardingPending: () => false,
  isOldLayoutEligible: () => false,
}))
mock.module("../src/main/server", () => ({
  getDefaultServerUrl: () => null,
  preferAppEnv() {},
  setDefaultServerUrl() {},
  spawnLocalServer: async (_hostname: string, _port: number, _password: string, options: {
    catalog?: {
      default?: { providerID: string; modelID: string }
      providers: { id: string }[]
    }
    credentials?: { providers: Record<string, unknown> }
  }) => {
    sidecarStarts++
    sidecarStates.push({
      ...(options.catalog?.default ? { default: options.catalog.default } : {}),
      providers: options.catalog?.providers.map((provider) => provider.id) ?? [],
      credentialProviders: Object.keys(options.credentials?.providers ?? {}),
    })
    return {
      listener: {
        stop: async () => {
          sidecarStops++
        },
      },
      health: { wait: Promise.resolve() },
    }
  },
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
mock.module("../src/main/enterprise-preflight", () => ({
  runEnterprisePreflight: async () => {
    preflightCalls++
  },
}))
mock.module("../src/main/enterprise-adoption", () => ({ adoptEnterpriseLegacyState: async () => ({ adopted: [] }) }))
mock.module("../src/main/enterprise-state", () => ({
  EnterpriseStateError: class extends Error {
    kind = "recovery_required"
  },
  listCompatibleEnterpriseBackups: async () => [],
  prepareEnterpriseState: async () => {
    statePrepared++
    return { status: "pending" }
  },
  markEnterpriseStateHealthy: async () => {
    stateHealthy++
  },
  readEnterpriseStateMetadata: async () => ({ backups: [] }),
  restoreEnterpriseBackup: async () => undefined,
}))

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
for (let attempts = 0; attempts < 100 && enterprise && stateHealthy === 0; attempts++) await Bun.sleep(10)

if (mode === "enterprise-provider-restart") {
  const mutation = await handlers.get("enterprise-provider-credentials-replace")?.(
    {},
    {
      providerID: "company-llm",
      credentials: { apiKey: "entrypoint-secret", headers: { Authorization: "header-secret" } },
    },
  )
  console.log(JSON.stringify({ mutation, sidecarStarts, sidecarStops, relaunches, sidecarStates }))
  process.exit(0)
}

if (unhealthyCredentials) {
  const providerCatalog = await handlers.get("enterprise-provider-catalog")?.({})
  const providerID = mode === "enterprise-credentials-corrupt" ? "existing" : "company-llm"
  const mutationError = await handlers
    .get("enterprise-provider-credentials-replace")?.(
      {},
      { providerID, credentials: { apiKey: "replacement-main-index-secret", headers: {} } },
    )
    .then(
      () => undefined,
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
    )
  console.log(
    JSON.stringify({
      providerCatalog,
      mutationError,
      sidecarStarts,
      sidecarStates,
      credentialUnchanged: credentialBefore?.equals(readFileSync(credentialFile)),
      credentialTimestampUnchanged: credentialModifiedBefore === statSync(credentialFile).mtimeMs,
    }),
  )
  process.exit(0)
}

await listeners.get("open-link")?.({}, "https://opencode.ai/docs?token=main-index-secret")
await listeners.get("open-link")?.({}, "https://llm.corp.example/docs")
await listeners.get("open-link")?.({}, "https://user:secret@llm.corp.example/docs")

console.log(
  JSON.stringify({
    rendererProtocolRegistrations,
    preflightCalls,
    statePrepared,
    stateHealthy,
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
