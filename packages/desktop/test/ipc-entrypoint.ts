import { mock } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const shellOpenExternalURLs: string[] = []

mock.module("electron", () => ({
  default: { app: { getPath: () => "" } },
  app: { getPath: () => "", once: () => undefined },
  BrowserWindow: class {
    static fromWebContents() {}
    static getAllWindows() {
      return []
    }
  },
  Notification: class {},
  clipboard: { readImage: () => undefined },
  crashReporter: {},
  dialog: { showOpenDialog: () => undefined, showSaveDialog: () => undefined },
  ipcMain: { handle: () => undefined, on: () => undefined },
  nativeImage: {},
  nativeTheme: { shouldUseDarkColors: false },
  net: {},
  netLog: {},
  protocol: { registerSchemesAsPrivileged: () => undefined },
  session: { fromPartition: () => ({ fetch: () => undefined }) },
  shell: { openExternal: (url: string) => shellOpenExternalURLs.push(url), openPath: () => undefined },
}))

const { registerMainIpcHandlers } = await import("../src/main/ipc")
const { parseEnterpriseProfile } = await import("../src/enterprise")
const { createUpdaterController } = await import("../src/main/updater-controller")
const directory = await mkdtemp(join(tmpdir(), "enterprise-guide-registration-"))

try {
  const path = join(directory, "company-guide.md")
  await writeFile(path, "# Registered guide\n", "utf8")
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const updater = createUpdaterController({
    enabled: false,
    currentVersion: "2026.08",
    backend: {
      checkForUpdates: async () => null,
      downloadUpdate: async () => undefined,
      quitAndInstall() {},
    },
    persistence: {
      get: async () => undefined,
      set: async () => undefined,
      clear: async () => undefined,
    },
    stop: async () => undefined,
  })

  registerMainIpcHandlers(
    {
      killSidecar() {},
      relaunch() {},
      awaitInitialization: async () => ({ url: "http://localhost", username: null, password: null }),
      consumeInitialDeepLinks: () => [],
      getDefaultServerUrl: () => null,
      setDefaultServerUrl() {},
      isFirstLaunchOnboardingPending: () => false,
      finishFirstLaunchOnboarding: () => null,
      getDisplayBackend: async () => null,
      setDisplayBackend() {},
      parseMarkdown: (markdown) => markdown,
      checkAppExists: () => false,
      resolveAppPath: async () => null,
      updater,
      showUpdater() {},
      setBackgroundColor() {},
      exportDebugLogs: async () => "logs.zip",
      recordFatalRendererError() {},
      enterprise: {
        credentialStatus: async () => ({ configured: false }),
        setCredentials: async () => ({ restartRequired: true }),
        clearCredentials: async () => ({ restartRequired: true }),
        readiness: async () => ({ schemaVersion: 1, generatedAt: "now", overall: "warn", checks: [] }),
        stateBackups: async () => [],
        restoreStateBackup: async () => ({ restartRequired: true }),
        guide: { enabled: true, path, version: "2026.08" },
      },
    },
    {
      profile: parseEnterpriseProfile({
        OPENCODE_ENTERPRISE: "1",
        OPENCODE_ENTERPRISE_MODELS: JSON.stringify([{ id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" }]),
        OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "company-code",
        OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
        OPENCODE_ENTERPRISE_GUIDE_VERSION: "pilot-1",
        OPENCODE_ENTERPRISE_CATALOG_VERSION: "catalog-1",
      }),
      openExternal: (url) => shellOpenExternalURLs.push(url),
      registry: {
        handle: (channel, handler) => handlers.set(channel, handler),
        on: (channel, handler) => listeners.set(channel, handler),
      },
    },
  )

  await listeners.get("open-link")?.({}, "https://opencode.ai/docs?token=main-secret")
  await listeners.get("open-link")?.({}, "https://llm.corp.example/docs")
  await listeners.get("open-link")?.({}, "https://user:secret@llm.corp.example/docs")

  console.log(
    JSON.stringify({
      registered: handlers.has("enterprise-guide-read"),
      guide: await handlers.get("enterprise-guide-read")?.(),
      shellOpenExternalURLs,
    }),
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
