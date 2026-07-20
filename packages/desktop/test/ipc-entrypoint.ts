import { mock } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const shellOpenExternalURLs: string[] = []
let relaunchCalls = 0

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
const { createEnterpriseProviderRuntime } = await import("../src/main/enterprise-provider-runtime")
const { createUpdaterController } = await import("../src/main/updater-controller")
const directory = await mkdtemp(join(tmpdir(), "enterprise-guide-registration-"))

try {
  const path = join(directory, "company-guide.md")
  await writeFile(path, "# Registered guide\n", "utf8")
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  let runtimeCatalog = {
    schemaVersion: 1 as const,
    default: { providerID: "provider", modelID: "model" },
    providers: [
      {
        id: "provider",
        name: "Provider",
        baseURL: "https://provider.example/v1",
        models: [{ id: "model", name: "Model" }],
      },
    ],
  }
  let runtimeCredentials = { schemaVersion: 3 as const, providers: { provider: { headers: {} } } }
  const providerRuntime = createEnterpriseProviderRuntime({
    catalog: {
      read: async () => structuredClone(runtimeCatalog),
      write: async (value) => {
        runtimeCatalog = structuredClone(value)
      },
    },
    credentials: {
      read: async () => structuredClone(runtimeCredentials),
      write: async (value) => {
        runtimeCredentials = structuredClone(value)
      },
      health: async () => ({ state: "available" as const }),
    },
    restart: async () => undefined,
  })
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
      relaunch() {
        relaunchCalls++
      },
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
        providerCatalog: async () => ({
          schemaVersion: 1 as const,
          default: { providerID: "company", modelID: "company-code" },
          providers: [
            {
              id: "company",
              name: "Company",
              baseURL: "https://llm.corp.example/v1",
              models: [{ id: "company-code", name: "Company Code" }],
              credentials: { configured: true, headerNames: ["Authorization"] },
            },
          ],
        }),
        createProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
        updateProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
        deleteProvider: async () => ({ schemaVersion: 1 as const, providers: [] }),
        createModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
        updateModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
        deleteModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
        setDefaultModel: async () => ({ schemaVersion: 1 as const, providers: [] }),
        replaceProviderCredentials: (input) => providerRuntime.replaceProviderCredentials(input),
        clearProviderCredentials: async () => ({ schemaVersion: 1 as const, providers: [] }),
        readiness: async () => ({ schemaVersion: 1, generatedAt: "now", overall: "warn", checks: [] }),
        stateBackups: async () => [],
        restoreStateBackup: async () => ({ restartRequired: true }),
        skillPacks: async () => [],
        setSkillPackEnabled: async () => [],
        openSkillPackSource: async () => undefined,
        guide: { enabled: true, path, version: "2026.08" },
      },
    },
    {
      profile: parseEnterpriseProfile({
        OPENCODE_ENTERPRISE: "1",
        OPENCODE_ENTERPRISE_MODELS: JSON.stringify([
          { id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" },
        ]),
        OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID: "company-code",
        OPENCODE_ENTERPRISE_DEFAULTS_VERSION: "pilot-1",
        OPENCODE_ENTERPRISE_GUIDE_VERSION: "kernexa-1",
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
  await handlers.get("relaunch")?.()
  const credentialBypassErrors = await Promise.all(
    [
      { headers: { "   ": "secret" } },
      { headers: { "X-Token": "first", "x-token": "second" } },
    ].map((credentials) =>
      Promise.resolve(
        handlers.get("enterprise-provider-credentials-replace")?.({}, { providerID: "provider", credentials }),
      ).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    ),
  )

  console.log(
    JSON.stringify({
      registered: handlers.has("enterprise-guide-read"),
      providerCatalog: await handlers.get("enterprise-provider-catalog")?.(),
      guide: await handlers.get("enterprise-guide-read")?.(),
      credentialBypassErrors,
      relaunchCalls,
      shellOpenExternalURLs,
    }),
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
