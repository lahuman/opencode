import type { Platform, ServerConnection } from "@opencode-ai/app"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { AsyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import pkg from "../../package.json"
import {
  createEnterpriseRendererNetwork,
  desktopNotificationOptions,
  ENTERPRISE_ENABLED,
  ENTERPRISE_PROFILE,
} from "../enterprise"
import { mapEnterpriseAPI } from "../preload/types"
import { t } from "./i18n"
import { resetZoom, setPinchZoomEnabled, webviewZoom, zoomIn, zoomOut } from "./webview-zoom"

export type DesktopWindowState = {
  id?: string
}

export function createPlatform(
  windowState: DesktopWindowState,
  updaterState: Accessor<UpdaterState>,
  runtime: {
    acceptedFileExtensions: string[]
    handleNotificationClick: (href?: string) => void
    makeServerKey: (value: string) => ServerConnection.Key
  },
): Platform {
  const attachmentPaths = new WeakMap<File, string>()
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const runDesktopMenuAction: Platform["runDesktopMenuAction"] = (action) => {
    switch (action) {
      case "view.resetZoom":
        resetZoom()
        return
      case "view.zoomIn":
        zoomIn()
        return
      case "view.zoomOut":
        zoomOut()
        return
    }

    return window.api.runDesktopMenuAction(action)
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  const wslServersApi = os === "windows" && !ENTERPRISE_ENABLED ? window.api.wslServers : undefined
  const network = createEnterpriseRendererNetwork(ENTERPRISE_PROFILE, {
    openLink: (url) => window.api.openLink(url),
    fetch: fetch.bind(globalThis),
  })

  return {
    platform: "desktop",
    os,
    version: pkg.version,
    windowID: windowState.id,
    ...(ENTERPRISE_ENABLED
      ? {
          enterprise: mapEnterpriseAPI(window.api.enterprise),
        }
      : {}),

    async openDirectoryPickerDialog(opts) {
      return window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
      })
    },

    async openAttachmentPickerDialog(opts, onFile) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        defaultPath: opts?.defaultPath,
        extensions: opts?.extensions ?? runtime.acceptedFileExtensions,
      })
      if (!result) return
      try {
        for (const file of result.files) {
          const selected = new File([await window.api.readPickedFile(result.token, file.path)], file.name)
          attachmentPaths.set(selected, file.path)
          await onFile(selected)
        }
      } finally {
        await window.api.releasePickedFiles(result.token)
      }
    },

    getPathForFile(file) {
      return attachmentPaths.get(file) ?? window.api.getPathForFile(file)
    },

    async saveFilePickerDialog(opts) {
      return window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
    },

    openLink: network.openLink,
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        return window.api.openPath(path, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage,

    updater: {
      state: updaterState,
      check: () => window.api.updater.check(),
      install: () => window.api.updater.install(),
    },

    exportDebugLogs: () => window.api.exportDebugLogs(),

    recordFatalRendererError: (error) => window.api.recordFatalRendererError(error),

    restart: () => window.api.relaunch(),

    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      const notification = new Notification(
        title,
        desktopNotificationOptions(ENTERPRISE_PROFILE, description ?? "", window.location.href),
      )
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        runtime.handleNotificationClick(href)
        notification.close()
      }
    },

    fetch: network.fetch,

    getDefaultServer: async () => {
      if (ENTERPRISE_ENABLED) return runtime.makeServerKey("sidecar")
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return runtime.makeServerKey(url)
    },

    setDefaultServer: async (url: string | null) => {
      if (ENTERPRISE_ENABLED) throw new Error("Remote servers are disabled in this build")
      await window.api.setDefaultServerUrl(url)
    },

    wslServers: wslServersApi,

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,

    getPinchZoomEnabled: () => window.api.getPinchZoomEnabled(),

    setPinchZoomEnabled,

    runDesktopMenuAction,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
  }
}
