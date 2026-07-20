import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { basename } from "node:path"
import { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, shell } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"

import type {
  EnterpriseProviderDiagnostic,
  FatalRendererError,
  ServerReadyData,
  TitlebarTheme,
} from "../preload/types"
import { createEnterpriseURLHandler, type EnterpriseProfile } from "../enterprise"
import { runDesktopMenuAction } from "./desktop-menu-actions"
import { readEnterpriseGuide } from "./enterprise-guide"
import { parseEnterpriseProviderDiagnostic } from "./enterprise-readiness"
import { assertAttachmentBudget, createPickedFileAuthorizations } from "./attachment-picker"
import { getStore, removeStoreFileIfEmpty } from "./store"
import { getPinchZoomEnabled, getWindowID, setPinchZoomEnabled, setTitlebar, updateTitlebar } from "./windows"
import type { UpdaterController } from "./updater-controller"
import { createUpdaterSubscriptions } from "./updater-subscriptions"
import type { EnterpriseProviderAPI } from "./enterprise-provider-runtime"

const pickerFilters = (ext?: string[]) => {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}

const pickedFiles = createPickedFileAuthorizations()

type Deps = {
  killSidecar: () => Promise<void> | void
  relaunch: () => void
  awaitInitialization: () => Promise<ServerReadyData>
  consumeInitialDeepLinks: () => Promise<string[]> | string[]
  getDefaultServerUrl: () => Promise<string | null> | string | null
  setDefaultServerUrl: (url: string | null) => Promise<void> | void
  isFirstLaunchOnboardingPending: () => Promise<boolean> | boolean
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null> | string | null
  isOldLayoutEligible: () => Promise<boolean> | boolean
  getDisplayBackend: () => Promise<string | null>
  setDisplayBackend: (backend: string | null) => Promise<void> | void
  parseMarkdown: (markdown: string) => Promise<string> | string
  checkAppExists: (appName: string) => Promise<boolean> | boolean
  resolveAppPath: (appName: string) => Promise<string | null>
  updater: UpdaterController
  showUpdater: () => Promise<void> | void
  setBackgroundColor: (color: string) => void
  exportDebugLogs: () => Promise<string>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void> | void
  openExternalURL: (url: string) => Promise<void> | void
  enterprise: EnterpriseProviderAPI & {
    readiness: (provider?: EnterpriseProviderDiagnostic) => Promise<unknown>
    stateBackups: () => Promise<{ id: string; appVersion: string; createdAt: string }[]>
    restoreStateBackup: (backupID: string) => Promise<{ restartRequired: true }>
    skillPacks: () => Promise<unknown> | unknown
    setSkillPackEnabled: (id: string, enabled: boolean) => Promise<unknown>
    openSkillPackSource: (id: string) => Promise<void>
    guide: {
      enabled: boolean
      path: string
      version: string
    }
  }
}

export type IpcRegistry = Pick<typeof ipcMain, "handle" | "on">

export function registerMainIpcHandlers(
  deps: Omit<Deps, "openExternalURL">,
  input: {
    profile: EnterpriseProfile
    openExternal: (url: string) => Promise<void> | void
    registry?: IpcRegistry
  },
) {
  return registerIpcHandlers(
    {
      ...deps,
      openExternalURL: createEnterpriseURLHandler(input.profile, input.openExternal),
    },
    input.registry,
  )
}

export function registerIpcHandlers(deps: Deps, registry: IpcRegistry = ipcMain) {
  const updaterSubscriptions = createUpdaterSubscriptions()
  app.once("will-quit", updaterSubscriptions.clear)

  registry.handle("kill-sidecar", () => deps.killSidecar())
  registry.handle("await-initialization", () => deps.awaitInitialization())
  registry.handle("consume-initial-deep-links", () => deps.consumeInitialDeepLinks())
  registry.handle("get-default-server-url", () => deps.getDefaultServerUrl())
  registry.handle("set-default-server-url", (_event: IpcMainInvokeEvent, url: string | null) =>
    deps.setDefaultServerUrl(url),
  )
  registry.handle("is-first-launch-onboarding-pending", () => deps.isFirstLaunchOnboardingPending())
  registry.handle("finish-first-launch-onboarding", (_event: IpcMainInvokeEvent, createDefaultProject: boolean) =>
    deps.finishFirstLaunchOnboarding(createDefaultProject),
  )
  registry.handle("is-old-layout-eligible", () => deps.isOldLayoutEligible())
  registry.handle("get-display-backend", () => deps.getDisplayBackend())
  registry.handle("set-display-backend", (_event: IpcMainInvokeEvent, backend: string | null) =>
    deps.setDisplayBackend(backend),
  )
  registry.handle("parse-markdown", (_event: IpcMainInvokeEvent, markdown: string) => deps.parseMarkdown(markdown))
  registry.handle("check-app-exists", (_event: IpcMainInvokeEvent, appName: string) => deps.checkAppExists(appName))
  registry.handle("resolve-app-path", (_event: IpcMainInvokeEvent, appName: string) => deps.resolveAppPath(appName))
  registry.handle("updater-subscribe", (event) => {
    const id = event.sender.id
    updaterSubscriptions.set(
      id,
      deps.updater.subscribe((state) => {
        if (event.sender.isDestroyed()) return updaterSubscriptions.delete(id)
        event.sender.send("updater-state", state)
      }),
    )
    event.sender.once("destroyed", () => updaterSubscriptions.delete(id))
  })
  registry.handle("updater-unsubscribe", (event) => updaterSubscriptions.delete(event.sender.id))
  registry.handle("updater-check", () => deps.updater.check())
  registry.handle("updater-install", () => deps.updater.install())
  registry.handle("set-background-color", (_event: IpcMainInvokeEvent, color: string) => deps.setBackgroundColor(color))
  registry.handle("export-debug-logs", () => deps.exportDebugLogs())
  registry.handle("record-fatal-renderer-error", (_event: IpcMainInvokeEvent, error: FatalRendererError) =>
    deps.recordFatalRendererError(error),
  )
  registry.handle("enterprise-provider-catalog", () => deps.enterprise.providerCatalog())
  registry.handle("enterprise-provider-create", (_event: IpcMainInvokeEvent, input: unknown) =>
    deps.enterprise.createProvider(input as Parameters<EnterpriseProviderAPI["createProvider"]>[0]),
  )
  registry.handle("enterprise-provider-update", (_event: IpcMainInvokeEvent, input: unknown) =>
    deps.enterprise.updateProvider(input as Parameters<EnterpriseProviderAPI["updateProvider"]>[0]),
  )
  registry.handle("enterprise-provider-delete", (_event: IpcMainInvokeEvent, providerID: unknown) =>
    deps.enterprise.deleteProvider(providerID as string),
  )
  registry.handle("enterprise-model-create", (_event: IpcMainInvokeEvent, input: unknown) =>
    deps.enterprise.createModel(input as Parameters<EnterpriseProviderAPI["createModel"]>[0]),
  )
  registry.handle("enterprise-model-update", (_event: IpcMainInvokeEvent, input: unknown) =>
    deps.enterprise.updateModel(input as Parameters<EnterpriseProviderAPI["updateModel"]>[0]),
  )
  registry.handle("enterprise-model-delete", (_event: IpcMainInvokeEvent, input: unknown) =>
    deps.enterprise.deleteModel(input as Parameters<EnterpriseProviderAPI["deleteModel"]>[0]),
  )
  registry.handle("enterprise-model-default", (_event: IpcMainInvokeEvent, input: unknown) =>
    deps.enterprise.setDefaultModel(input as Parameters<EnterpriseProviderAPI["setDefaultModel"]>[0]),
  )
  registry.handle("enterprise-provider-credentials-replace", (_event: IpcMainInvokeEvent, input: unknown) =>
    deps.enterprise.replaceProviderCredentials(
      input as Parameters<EnterpriseProviderAPI["replaceProviderCredentials"]>[0],
    ),
  )
  registry.handle("enterprise-provider-credentials-clear", (_event: IpcMainInvokeEvent, providerID: unknown) =>
    deps.enterprise.clearProviderCredentials(providerID as string),
  )
  registry.handle("enterprise-readiness", (_event: IpcMainInvokeEvent, provider?: unknown) =>
    deps.enterprise.readiness(parseEnterpriseProviderDiagnostic(provider)),
  )
  registry.handle("enterprise-state-backups", () => deps.enterprise.stateBackups())
  registry.handle("enterprise-state-restore", (_event: IpcMainInvokeEvent, backupID: string) =>
    deps.enterprise.restoreStateBackup(backupID),
  )
  registry.handle("enterprise-skill-packs", () => deps.enterprise.skillPacks())
  registry.handle("enterprise-skill-pack-set", (_event: IpcMainInvokeEvent, id: string, enabled: boolean) =>
    deps.enterprise.setSkillPackEnabled(id, enabled),
  )
  registry.handle("enterprise-skill-pack-source", (_event: IpcMainInvokeEvent, id: string) =>
    deps.enterprise.openSkillPackSource(id),
  )
  registry.handle("enterprise-guide-read", () => readEnterpriseGuide(deps.enterprise.guide))
  registry.handle("store-get", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    try {
      const store = getStore(name)
      const value = store.get(key)
      if (value === undefined || value === null) return null
      return typeof value === "string" ? value : JSON.stringify(value)
    } catch {
      return null
    }
  })
  registry.handle("store-set", (_event: IpcMainInvokeEvent, name: string, key: string, value: string) => {
    getStore(name).set(key, value)
  })
  registry.handle("store-delete", (_event: IpcMainInvokeEvent, name: string, key: string) => {
    getStore(name).delete(key)
    void removeStoreFileIfEmpty(name)
  })
  registry.handle("store-clear", (_event: IpcMainInvokeEvent, name: string) => {
    getStore(name).clear()
    void removeStoreFileIfEmpty(name)
  })
  registry.handle("store-keys", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store)
  })
  registry.handle("store-length", (_event: IpcMainInvokeEvent, name: string) => {
    const store = getStore(name)
    return Object.keys(store.store).length
  })

  registry.handle(
    "open-directory-picker",
    async (_event: IpcMainInvokeEvent, opts?: { multiple?: boolean; title?: string; defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", ...(opts?.multiple ? ["multiSelections" as const] : []), "createDirectory"],
        title: opts?.title ?? "Choose a folder",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return opts?.multiple ? result.filePaths : result.filePaths[0]
    },
  )

  registry.handle(
    "open-file-picker",
    async (
      event: IpcMainInvokeEvent,
      opts?: { multiple?: boolean; title?: string; defaultPath?: string; extensions?: string[] },
    ) => {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", ...(opts?.multiple ? ["multiSelections" as const] : [])],
        title: opts?.title ?? "Choose a file",
        defaultPath: opts?.defaultPath,
        filters: pickerFilters(opts?.extensions),
      })
      if (result.canceled) return null
      const files = await Promise.all(
        result.filePaths.map(async (filePath) => ({
          path: filePath,
          name: basename(filePath),
          size: (await stat(filePath)).size,
        })),
      )
      assertAttachmentBudget(files)
      const token = pickedFiles.add(event.sender.id, result.filePaths)
      return { token, files }
    },
  )

  registry.handle("read-picked-file", async (event: IpcMainInvokeEvent, token: string, filePath: string) => {
    return pickedFiles.read(event.sender.id, token, filePath)
  })

  registry.handle("release-picked-files", (event: IpcMainInvokeEvent, token: string) => {
    pickedFiles.release(event.sender.id, token)
  })

  registry.handle(
    "save-file-picker",
    async (_event: IpcMainInvokeEvent, opts?: { title?: string; defaultPath?: string }) => {
      const result = await dialog.showSaveDialog({
        title: opts?.title ?? "Save file",
        defaultPath: opts?.defaultPath,
      })
      if (result.canceled) return null
      return result.filePath ?? null
    },
  )

  registry.on("open-link", (_event: IpcMainEvent, url: string) => {
    void deps.openExternalURL(url)
  })

  registry.handle("open-path", async (_event: IpcMainInvokeEvent, path: string, app?: string) => {
    if (!app) return shell.openPath(path)
    await new Promise<void>((resolve, reject) => {
      const [cmd, args] =
        process.platform === "darwin" ? (["open", ["-a", app, path]] as const) : ([app, [path]] as const)
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
  })

  registry.handle("reveal-path", async (_event: IpcMainInvokeEvent, path: string) => {
    const exists = await stat(path).then(
      () => true,
      () => false,
    )
    if (!exists) return false
    shell.showItemInFolder(path)
    return true
  })

  registry.handle("read-clipboard-image", () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    const buffer = image.toPNG().buffer
    const size = image.getSize()
    return { buffer, width: size.width, height: size.height }
  })

  registry.on("show-notification", (_event: IpcMainEvent, title: string, body?: string) => {
    new Notification({ title, body }).show()
  })

  registry.handle("get-window-count", () => BrowserWindow.getAllWindows().length)

  registry.handle("get-window-id", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error("Window not found")
    const id = getWindowID(win)
    if (!id) throw new Error("Window ID not found")
    return id
  })

  registry.handle("get-window-focused", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win?.isFocused() ?? false
  })

  registry.handle("set-window-focus", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.focus()
  })

  registry.handle("show-window", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.show()
  })

  registry.handle("relaunch", () => deps.relaunch())

  registry.handle("get-zoom-factor", (event: IpcMainInvokeEvent) => event.sender.getZoomFactor())
  registry.handle("set-zoom-factor", (event: IpcMainInvokeEvent, factor: number) => {
    event.sender.setZoomFactor(factor)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    updateTitlebar(win)
  })
  registry.handle("get-pinch-zoom-enabled", () => getPinchZoomEnabled())
  registry.handle("set-pinch-zoom-enabled", (_event: IpcMainInvokeEvent, enabled: boolean) => {
    setPinchZoomEnabled(enabled)
  })
  registry.handle("set-titlebar", (event: IpcMainInvokeEvent, theme: TitlebarTheme) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    setTitlebar(win, theme)
  })
  registry.handle("run-desktop-menu-action", (event: IpcMainInvokeEvent, action: DesktopMenuAction) => {
    runDesktopMenuAction(BrowserWindow.fromWebContents(event.sender), action, {
      checkForUpdates: () => void deps.showUpdater(),
      relaunch: deps.relaunch,
    })
  })
}

export function sendMenuCommand(win: BrowserWindow, id: string) {
  win.webContents.send("menu-command", id)
}

export function sendDeepLinks(win: BrowserWindow, urls: string[]) {
  win.webContents.send("deep-link", urls)
}
