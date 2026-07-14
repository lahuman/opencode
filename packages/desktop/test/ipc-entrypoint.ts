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
  shell: { openExternal: (url: string) => shellOpenExternalURLs.push(url), openPath: () => undefined },
}))

const { registerIpcHandlers } = await import("../src/main/ipc")
const { createUpdaterController } = await import("../src/main/updater-controller")
const directory = await mkdtemp(join(tmpdir(), "enterprise-guide-registration-"))

try {
  const path = join(directory, "company-guide.md")
  await writeFile(path, "# Registered guide\n", "utf8")
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  const openExternalURLs: string[] = []
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

  registerIpcHandlers(
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
      openExternalURL: async (url) => {
        openExternalURLs.push(url)
      },
      enterprise: {
        credentialStatus: async () => ({ configured: false }),
        setCredentials: async () => ({ restartRequired: true }),
        clearCredentials: async () => ({ restartRequired: true }),
        guide: { enabled: true, path, version: "2026.08" },
      },
    },
    {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => listeners.set(channel, handler),
    },
  )

  await listeners.get("open-link")?.({}, "https://llm.corp.example/docs")

  console.log(
    JSON.stringify({
      registered: handlers.has("enterprise-guide-read"),
      guide: await handlers.get("enterprise-guide-read")?.(),
      openExternalURLs,
      shellOpenExternalURLs,
    }),
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
