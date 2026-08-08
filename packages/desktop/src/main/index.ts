import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { Event } from "electron"
import { app, BrowserWindow, safeStorage, shell } from "electron"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import type { EnterpriseProviderDiagnostic, ServerReadyData } from "../preload/types"
import { ENTERPRISE_ENABLED, ENTERPRISE_PROFILE, enterpriseEnvironment } from "../enterprise"
import { checkAppExists, resolveAppPath } from "./apps"
import { CHANNEL, desktopIdentity, RUNTIME_FEATURES } from "./constants"
import { registerMainIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import {
  configureEnterpriseSupport,
  exportDebugLogs,
  initCrashReporter,
  initLogging,
  startNetLog,
  write as writeLog,
} from "./logging"
import { createMenu } from "./menu"
import {
  finishFirstLaunchOnboarding,
  initializeOldLayoutEligibility,
  isFirstLaunchOnboardingPending,
  isOldLayoutEligible,
} from "./onboarding"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { cleanupStoreFiles } from "./store-cleanup"
import { getStore } from "./store"
import { ENTERPRISE_SKILL_PACKS_KEY } from "./store-keys"
import { resolveDesktopUserDataPath } from "./user-data"
import { createEnterpriseCredentialStore, enterpriseSidecarEnvironment } from "./enterprise-credentials"
import type { EnterpriseProviderCredentials } from "./enterprise-credentials"
import {
  createEnterpriseProviderRuntime,
  createEnterpriseSidecarTransitionQueue,
  initializeEnterpriseProviderStores,
  type EnterpriseProviderAPI,
} from "./enterprise-provider-runtime"
import { createEnterpriseProviderStore, type EnterpriseProviderCatalog } from "./enterprise-providers"
import { runEnterprisePreflight } from "./enterprise-preflight"
import {
  createEnterpriseSkillPackController,
  openEnterpriseSkillPackSource,
  resolveEnterpriseSkillPackState,
  type VerifiedEnterpriseSkillPack,
} from "./enterprise-skill-packs"
import {
  EnterpriseStateError,
  listCompatibleEnterpriseBackups,
  markEnterpriseStateHealthy,
  prepareEnterpriseState,
  restoreEnterpriseBackup,
} from "./enterprise-state"
import { adoptEnterpriseLegacyState } from "./enterprise-adoption"
import {
  checkEnterpriseAppData,
  createEnterpriseReadinessReport,
  findEnterpriseExecutable,
} from "./enterprise-readiness"
import { setNativeTranslations } from "./native-translations"

const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let server: SidecarListener | null = null

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, urls)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function unavailableEnterpriseProviderAPI(): EnterpriseProviderAPI {
  const unavailable = async () => {
    throw new Error("Enterprise provider management is unavailable")
  }
  return {
    providerCatalog: async () => ({ schemaVersion: 1, providers: [] }),
    createProvider: unavailable,
    updateProvider: unavailable,
    deleteProvider: unavailable,
    createModel: unavailable,
    updateModel: unavailable,
    deleteModel: unavailable,
    setDefaultModel: unavailable,
    replaceProviderCredentials: unavailable,
    clearProviderCredentials: unavailable,
  }
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const identity = desktopIdentity({
    channel: app.isPackaged ? CHANNEL : "dev",
    enterprise: ENTERPRISE_ENABLED,
  })
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(identity.name)
  app.setAppUserModelId(identity.appId)
  app.setPath(
    "userData",
    onboardingTestRoot
      ? join(onboardingTestRoot, "desktop")
      : resolveDesktopUserDataPath({
          platform: process.platform,
          enterprise: ENTERPRISE_ENABLED,
          appId: identity.appId,
          localAppData: process.env.LOCALAPPDATA,
          appData: () => app.getPath("appData"),
        }),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  const enterpriseDir = app.isPackaged
    ? join(process.resourcesPath, "enterprise")
    : join(import.meta.dirname, "../../resources/enterprise")
  const enterpriseGuide = join(enterpriseDir, "company-guide.md")
  let verifiedSkillPacks: VerifiedEnterpriseSkillPack[] = []
  const enterpriseStartupFailure = yield* Effect.promise(async () => {
    try {
      const preflight = await runEnterprisePreflight({
        profile: ENTERPRISE_PROFILE,
        appVersion: app.getVersion(),
        enterpriseDir,
      })
      verifiedSkillPacks = preflight?.skillPacks.packs ?? []
      await adoptEnterpriseLegacyState({
        enabled: ENTERPRISE_ENABLED,
        userData: app.getPath("userData"),
        sources: {
          data: process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
          config: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
          state: process.env.XDG_STATE_HOME ?? app.getPath("userData"),
        },
      })
      await prepareEnterpriseState({
        enabled: ENTERPRISE_ENABLED,
        userData: app.getPath("userData"),
        appVersion: app.getVersion(),
      })
      return undefined
    } catch (error) {
      return error
    }
  })
  if (!enterpriseStartupFailure) initializeOldLayoutEligibility(app.getPath("userData"))
  logger = initLogging({ persistent: !enterpriseStartupFailure })
  if (!enterpriseStartupFailure) initCrashReporter()
  if (enterpriseStartupFailure) {
    logger.error("enterprise startup verification failed", {
      kind:
        typeof enterpriseStartupFailure === "object" &&
        enterpriseStartupFailure !== null &&
        "kind" in enterpriseStartupFailure
          ? enterpriseStartupFailure.kind
          : "unknown",
    })
  }

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  const stopSidecars = async () => {
    await killSidecar()
    wslServers.stopAll()
  }
  const relaunch = () => {
    setAppQuitting()
    void stopSidecars().finally(() => {
      app.relaunch()
      app.quit()
    })
  }
  const enabledSkillPackPaths = () => {
    const state = resolveEnterpriseSkillPackState(verifiedSkillPacks, getStore().get(ENTERPRISE_SKILL_PACKS_KEY))
    return verifiedSkillPacks.flatMap((pack) => (state[pack.id] ? [pack.root] : []))
  }

  // Electron's Node exposes this newer API; defer resolution so other runtimes can load the entrypoint.
  const { getCACertificates, setDefaultCACertificates } = yield* Effect.promise(() => import("node:tls"))
  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })
  if (ENTERPRISE_PROFILE.enabled) {
    logger.log("enterprise profile", {
      defaultsVersion: ENTERPRISE_PROFILE.defaultsVersion,
      guideVersion: ENTERPRISE_PROFILE.guideVersion,
    })
  }

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  preferAppEnv(
    app.getPath("userData"),
    enterpriseEnvironment(ENTERPRISE_PROFILE, {
      defaults: join(enterpriseDir, "opencode.jsonc"),
      guide: enterpriseGuide,
      ripgrep: app.isPackaged ? join(enterpriseDir, "ripgrep", "rg.exe") : undefined,
      userData: app.getPath("userData"),
      skillPacks: enabledSkillPackPaths(),
    }),
  )

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("will-quit", () => {
    setAppQuitting()
    void stopSidecars()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      setAppQuitting()
      void stopSidecars().finally(() => app.quit())
    })
  }

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()

  yield* Effect.promise(() => app.whenReady())

  const enterpriseCredentials = createEnterpriseCredentialStore({
    file: join(app.getPath("userData"), "enterprise-credentials.bin"),
    modelIDs: ENTERPRISE_PROFILE.enabled ? ENTERPRISE_PROFILE.models.map((model) => model.id) : [],
    defaultModelID: ENTERPRISE_PROFILE.enabled ? ENTERPRISE_PROFILE.defaultModelID : undefined,
    encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
  })
  const enterpriseProviders = createEnterpriseProviderStore({
    file: join(app.getPath("userData"), "enterprise-providers.json"),
  })
  const readEnterpriseProviderCredentials = async () => {
    const health = await enterpriseCredentials.health()
    if (health.state === "corrupt" || health.state === "encryption-unavailable") {
      return { schemaVersion: 3 as const, providers: {} }
    }
    return enterpriseCredentials.read()
  }
  if (ENTERPRISE_PROFILE.enabled && !enterpriseStartupFailure) {
    const profile = ENTERPRISE_PROFILE
    yield* Effect.promise(async () => {
      const health = await enterpriseCredentials.health()
      if (health.state === "corrupt" || health.state === "encryption-unavailable") {
        await enterpriseProviders.initialize(profile)
        return
      }
      await initializeEnterpriseProviderStores({
        catalog: enterpriseProviders,
        credentials: enterpriseCredentials,
        profile,
      })
    })
  }
  let restartEnterpriseSidecar: (
    paths: string[],
    catalog?: EnterpriseProviderCatalog,
    credentials?: EnterpriseProviderCredentials,
  ) => Promise<void> = async () => {
    throw new Error("Enterprise sidecar is not ready")
  }
  const enqueueEnterpriseSidecarTransition = createEnterpriseSidecarTransitionQueue()
  const enterpriseProviderRuntime: EnterpriseProviderAPI =
    ENTERPRISE_ENABLED && !enterpriseStartupFailure
      ? createEnterpriseProviderRuntime({
          catalog: {
            read: async () => (await enterpriseProviders.read()) ?? { schemaVersion: 1, providers: [] },
            write: enterpriseProviders.write,
          },
          credentials: {
            read: enterpriseCredentials.read,
            write: enterpriseCredentials.write,
            health: enterpriseCredentials.health,
          },
          restart: (catalog, credentials) =>
            enqueueEnterpriseSidecarTransition(() =>
              restartEnterpriseSidecar(enabledSkillPackPaths(), catalog, credentials),
            ),
        })
      : unavailableEnterpriseProviderAPI()
  const enterpriseSkillPacks = createEnterpriseSkillPackController({
    packs: verifiedSkillPacks,
    read: () => getStore().get(ENTERPRISE_SKILL_PACKS_KEY),
    write: (value) => getStore().set(ENTERPRISE_SKILL_PACKS_KEY, value),
    restart: (paths) => enqueueEnterpriseSidecarTransition(() => restartEnterpriseSidecar(paths)),
  })
  const enterpriseRecoveryAllowed =
    enterpriseStartupFailure instanceof EnterpriseStateError &&
    (enterpriseStartupFailure.kind === "recovery_required" || enterpriseStartupFailure.kind === "downgrade")

  let lastEnterpriseProviderDiagnostic: EnterpriseProviderDiagnostic | undefined
  const enterpriseReadiness = async (provider?: EnterpriseProviderDiagnostic) => {
    if (provider) lastEnterpriseProviderDiagnostic = provider
    const catalog = await enterpriseProviders.read()
    const health = await enterpriseCredentials.health()
    const credentials =
      health.state === "corrupt" || health.state === "encryption-unavailable"
        ? { schemaVersion: 3 as const, providers: {} }
        : await enterpriseCredentials.read()
    const defaultProvider = catalog?.default ? credentials.providers[catalog.default.providerID] : undefined
    const credentialError =
      health.state === "corrupt"
        ? ("credential_decryption_failed" as const)
        : health.state === "encryption-unavailable"
          ? ("credential_encryption_unavailable" as const)
          : undefined
    return createEnterpriseReadinessReport({
      packageVerified: !enterpriseStartupFailure,
      appDataWritable: () => checkEnterpriseAppData(app.getPath("userData")),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      credentialConfigured: Boolean(
        !credentialError && (defaultProvider?.apiKey || Object.keys(defaultProvider?.headers ?? {}).length),
      ),
      credentialError,
      findExecutable: findEnterpriseExecutable,
      provider: provider ?? lastEnterpriseProviderDiagnostic,
    })
  }
  configureEnterpriseSupport(async () => {
    const credentials = await readEnterpriseProviderCredentials()
    return {
      readiness: await enterpriseReadiness(),
      secrets: Object.values(credentials.providers).flatMap((credential) => [
        ...(credential.apiKey ? [credential.apiKey] : []),
        ...Object.values(credential.headers),
      ]),
    }
  })
  if (!enterpriseStartupFailure && !TEST_ONBOARDING) migrate()
  if (!enterpriseStartupFailure) {
    yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          if (result.deleted.length === 0) return
          logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          logger.warn("failed to clean scoped store files", error)
        }),
      ),
    )
  }
  if (!ENTERPRISE_ENABLED) app.setAsDefaultProtocolClient("opencode")
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(stopSidecars)
  const menuDeps = {
    edition: ENTERPRISE_ENABLED ? ("enterprise" as const) : ("public" as const),
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => void showUpdaterDialog(updater, true),
    relaunch,
  }
  registerMainIpcHandlers(
    {
      killSidecar: () => killSidecar(),
      relaunch,
      awaitInitialization: Effect.fnUntraced(
        function* () {
          logger.log("awaiting server ready")
          const res = yield* Deferred.await(serverReady)
          logger.log("server ready", { url: res.url })
          return res
        },
        (e) => Effect.runPromise(e),
      ),
      consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
      getDefaultServerUrl: () => getDefaultServerUrl(),
      setDefaultServerUrl: (url) => setDefaultServerUrl(url),
      isFirstLaunchOnboardingPending,
      finishFirstLaunchOnboarding,
      isOldLayoutEligible,
      getDisplayBackend: async () => null,
      setDisplayBackend: async () => undefined,
      checkAppExists: (appName) => checkAppExists(appName),
      resolveAppPath: async (appName) => resolveAppPath(appName),
      updater,
      showUpdater: () => showUpdaterDialog(updater, true),
      setBackgroundColor: (color) => setBackgroundColor(color),
      exportDebugLogs: () => exportDebugLogs(),
      recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
      setNativeTranslations: (bundle) => {
        if (setNativeTranslations(bundle)) createMenu(menuDeps)
      },
      enterprise: {
        ...enterpriseProviderRuntime,
        readiness: enterpriseReadiness,
        stateBackups: () =>
          enterpriseRecoveryAllowed
            ? listCompatibleEnterpriseBackups(app.getPath("userData"), app.getVersion())
            : Promise.resolve([]),
        restoreStateBackup: async (backupID: string) => {
          if (!enterpriseRecoveryAllowed) throw new Error("Enterprise state recovery is unavailable")
          const compatible = await listCompatibleEnterpriseBackups(app.getPath("userData"), app.getVersion())
          if (!compatible.some((backup) => backup.id === backupID)) {
            throw new Error("Enterprise state backup is incompatible")
          }
          await stopSidecars()
          await restoreEnterpriseBackup({ userData: app.getPath("userData"), backupID })
          relaunch()
          return { restartRequired: true as const }
        },
        skillPacks: enterpriseSkillPacks.list,
        setSkillPackEnabled: enterpriseSkillPacks.setEnabled,
        openSkillPackSource: (id) => openEnterpriseSkillPackSource(verifiedSkillPacks, id, shell.openExternal),
        guide: {
          enabled: ENTERPRISE_PROFILE.enabled,
          path: enterpriseGuide,
          version: ENTERPRISE_PROFILE.enabled ? ENTERPRISE_PROFILE.guideVersion : "",
        },
      },
    },
    {
      profile: ENTERPRISE_PROFILE,
      openExternal: (url) => shell.openExternal(url),
    },
  )
  registerWslIpcHandlers(wslServers, RUNTIME_FEATURES.wsl)
  if (RUNTIME_FEATURES.updater) {
    void updater.start()
    const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
    updateTimer.unref()
    app.once("will-quit", () => clearInterval(updateTimer))
  }
  if (!enterpriseStartupFailure) {
    yield* Effect.promise(() => startNetLog()).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          logger.warn("failed to start net log", error)
        }),
      ),
    )
  }

  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.OPENCODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const spawnSidecar = async (
    skillPacks: string[],
    catalog?: EnterpriseProviderCatalog,
    credentials?: EnterpriseProviderCredentials,
  ) => {
    const state = ENTERPRISE_ENABLED
      ? {
          catalog: catalog ?? (await enterpriseProviders.read()) ?? { schemaVersion: 1 as const, providers: [] },
          credentials: credentials ?? (await readEnterpriseProviderCredentials()),
        }
      : undefined
    const result = await spawnLocalServer(hostname, port, password, {
      userDataPath: app.getPath("userData"),
      env: ENTERPRISE_ENABLED
        ? {
            ...enterpriseSidecarEnvironment(),
            OPENCODE_ENTERPRISE_SKILL_PATHS: JSON.stringify(skillPacks),
          }
        : undefined,
      catalog: state?.catalog,
      credentials: state?.credentials,
      onStdout: (message) => writeLog("server", "stdout", { message }),
      onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
      onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
    })
    server = result.listener
    return result
  }
  restartEnterpriseSidecar = async (skillPacks, catalog, credentials) => {
    await killSidecar()
    const result = await spawnSidecar(skillPacks, catalog, credentials)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Enterprise sidecar restart timed out")), 30_000)
      void result.health.wait.then(
        () => {
          clearTimeout(timeout)
          resolve()
        },
        (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      )
    })
  }

  const loadingTask = yield* Effect.gen(function* () {
    if (enterpriseStartupFailure) return yield* Effect.fail(enterpriseStartupFailure)
    logger.log("sidecar connection started", { url })
    if (!app.isPackaged) {
      // Write server info to app/.env.local so the Vite dev server picks it up automatically.
      const authToken = Buffer.from(`opencode:${password}`).toString("base64")
      const envLocal = join(import.meta.dirname, "../../../app/.env.local")
      writeFileSync(
        envLocal,
        `VITE_OPENCODE_SERVER_HOST=127.0.0.1\nVITE_OPENCODE_SERVER_PORT=${port}\nVITE_OPENCODE_AUTH_TOKEN=${authToken}\n`,
      )
      logger.log("wrote dev env", { path: envLocal })
    }

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    const { health } = yield* Effect.promise(() => spawnSidecar(enabledSkillPackPaths()))
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    if (process.platform === "win32" && RUNTIME_FEATURES.wsl) {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    const healthy = yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.as(true),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
          return false
        }),
      ),
    )
    if (healthy) {
      yield* Effect.promise(() =>
        markEnterpriseStateHealthy({
          enabled: ENTERPRISE_ENABLED,
          userData: app.getPath("userData"),
          appVersion: app.getVersion(),
        }),
      )
    }

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return
    app.quit()
  })
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length > 0) return
    restoreMainWindows()
  })

  const windows = restoreMainWindows()
  if (windows.length) createMenu(menuDeps)
})

Effect.runFork(main)
