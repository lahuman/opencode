import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
import type { DesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"
import type { EnterpriseProviderAPI } from "../main/enterprise-provider-runtime"
export type {
  CredentialReplacement,
  EnterpriseProviderAPI,
  EnterpriseProviderCatalogView,
  EnterpriseProviderErrorCode,
} from "../main/enterprise-provider-runtime"
export type {
  EnterpriseModelRef,
  EnterpriseProvider,
  EnterpriseProviderCatalog,
  EnterpriseProviderModel,
} from "../main/enterprise-providers"
export type {
  WslDistroProbe,
  WslInstalledDistro,
  WslJob,
  WslOnlineDistro,
  WslOpencodeCheck,
  WslRuntimeCheck,
  WslServerConfig,
  WslServerItem,
  WslServerRuntime,
  WslServersEvent,
  WslServersState,
} from "@opencode-ai/app/wsl/types"

export type ServerReadyData = {
  url: string
  username: string | null
  password: string | null
}

export type WslServersAPI = WslServersPlatform
export type UpdaterAPI = {
  subscribe: (cb: (state: UpdaterState) => void) => Promise<() => void>
  check: () => Promise<UpdaterState>
  install: () => Promise<void>
}

export type LinuxDisplayBackend = "wayland" | "auto"
export type TitlebarTheme = {
  mode: "light" | "dark"
  scheme?: "system" | "light" | "dark"
}
export type FatalRendererError = {
  error: string
  url: string
  version?: string
  platform: string
  os?: string
}

export type EnterpriseProviderDiagnostic = {
  ok: boolean
  checks: {
    basic: "pass" | "fail" | "skipped"
    streaming: "pass" | "fail" | "skipped"
    toolCall: "pass" | "fail" | "skipped"
  }
  failure?: { kind: string; message: string }
}
export type EnterpriseReadinessReport = {
  schemaVersion: 1
  generatedAt: string
  overall: "pass" | "warn" | "fail"
  checks: {
    id: string
    status: "pass" | "warn" | "fail"
    code: string
    message: string
    detail?: string
  }[]
}
export type EnterpriseSkillPackInfo = {
  id: string
  displayName: string
  description: string
  version: string
  repository: string
  root: string
  members: string[]
  license: string
  enabled: boolean
}

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: () => Promise<ServerReadyData>
  enterprise: EnterpriseProviderAPI & {
    enabled: boolean
    readGuide: () => Promise<{ version: string; markdown: string }>
    readiness: (provider?: EnterpriseProviderDiagnostic) => Promise<EnterpriseReadinessReport>
    stateBackups: () => Promise<{ id: string; appVersion: string; createdAt: string }[]>
    restoreStateBackup: (backupID: string) => Promise<{ restartRequired: true }>
    skillPacks: () => Promise<EnterpriseSkillPackInfo[]>
    setSkillPackEnabled: (id: string, enabled: boolean) => Promise<EnterpriseSkillPackInfo[]>
    openSkillPackSource: (id: string) => Promise<void>
  }
  wslServers: WslServersAPI
  updater: UpdaterAPI
  consumeInitialDeepLinks: () => Promise<string[]>
  getDefaultServerUrl: () => Promise<string | null>
  setDefaultServerUrl: (url: string | null) => Promise<void>
  isFirstLaunchOnboardingPending: () => Promise<boolean>
  finishFirstLaunchOnboarding: (createDefaultProject: boolean) => Promise<string | null>
  isOldLayoutEligible: () => Promise<boolean>
  getDisplayBackend: () => Promise<LinuxDisplayBackend | null>
  setDisplayBackend: (backend: LinuxDisplayBackend | null) => Promise<void>
  checkAppExists: (appName: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>
  draftGet: (key: string) => Promise<string | null>
  draftSet: (key: string, value: string) => Promise<void>
  draftDelete: (key: string) => Promise<void>
  draftBlobPut: (data: ArrayBuffer) => Promise<string>
  draftBlobGet: (id: string) => Promise<ArrayBuffer | null>

  getWindowID: () => Promise<string>
  onMenuCommand: (cb: (id: string) => void) => () => void
  onDeepLink: (cb: (urls: string[]) => void) => () => void

  openDirectoryPicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
  }) => Promise<string | string[] | null>
  openFilePicker: (opts?: {
    multiple?: boolean
    title?: string
    defaultPath?: string
    extensions?: string[]
  }) => Promise<{ token: string; files: { path: string; name: string; size: number }[] } | null>
  readPickedFile: (token: string, path: string) => Promise<ArrayBuffer>
  releasePickedFiles: (token: string) => Promise<void>
  getPathForFile: (file: File) => string
  saveFilePicker: (opts?: { title?: string; defaultPath?: string }) => Promise<string | null>
  openExternal: (url: string) => void
  openLocalFile: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  revealPath: (path: string) => Promise<boolean>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  getWindowFocused: () => Promise<boolean>
  getWindowFullscreen: () => Promise<boolean>
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  setWindowFocus: () => Promise<void>
  showWindow: () => Promise<void>
  relaunch: () => Promise<void>
  getZoomFactor: () => Promise<number>
  setZoomFactor: (factor: number) => Promise<void>
  getPinchZoomEnabled: () => Promise<boolean>
  setPinchZoomEnabled: (enabled: boolean) => Promise<void>
  onPinchZoomEnabledChanged: (cb: (enabled: boolean) => void) => () => void
  onZoomFactorChanged: (cb: (factor: number) => void) => () => void
  setTitlebar: (theme: TitlebarTheme) => Promise<void>
  runDesktopMenuAction: (action: DesktopMenuAction) => Promise<void>
  setBackgroundColor: (color: string) => Promise<void>
  exportDebugLogs: () => Promise<string>
  setForceFocus: (enabled: boolean) => Promise<void>
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
  setNativeTranslations: (bundle: DesktopNativeBundle) => Promise<void>
}

export function createEnterpriseAPI(
  enabled: boolean,
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): ElectronAPI["enterprise"] {
  const provider = <T>(channel: string, ...args: unknown[]) =>
    invoke(channel, ...args).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const code = (
        [
          "restart_failed_rolled_back",
          "restart_failed_recovery_failed",
          "credential_decryption_failed",
          "credential_encryption_unavailable",
          "credential_provider_not_configured",
        ] as const
      ).find((item) => message.includes(item))
      if (!code) throw error
      throw Object.assign(new Error(code), { code })
    }) as Promise<T>
  return {
    enabled,
    providerCatalog: () =>
      provider("enterprise-provider-catalog") as ReturnType<ElectronAPI["enterprise"]["providerCatalog"]>,
    createProvider: (input) =>
      provider("enterprise-provider-create", input) as ReturnType<ElectronAPI["enterprise"]["createProvider"]>,
    updateProvider: (input) =>
      provider("enterprise-provider-update", input) as ReturnType<ElectronAPI["enterprise"]["updateProvider"]>,
    deleteProvider: (providerID) =>
      provider("enterprise-provider-delete", providerID) as ReturnType<ElectronAPI["enterprise"]["deleteProvider"]>,
    createModel: (input) =>
      provider("enterprise-model-create", input) as ReturnType<ElectronAPI["enterprise"]["createModel"]>,
    updateModel: (input) =>
      provider("enterprise-model-update", input) as ReturnType<ElectronAPI["enterprise"]["updateModel"]>,
    deleteModel: (input) =>
      provider("enterprise-model-delete", input) as ReturnType<ElectronAPI["enterprise"]["deleteModel"]>,
    setDefaultModel: (input) =>
      provider("enterprise-model-default", input) as ReturnType<ElectronAPI["enterprise"]["setDefaultModel"]>,
    replaceProviderCredentials: (input) =>
      provider("enterprise-provider-credentials-replace", input) as ReturnType<
        ElectronAPI["enterprise"]["replaceProviderCredentials"]
      >,
    clearProviderCredentials: (providerID) =>
      provider("enterprise-provider-credentials-clear", providerID) as ReturnType<
        ElectronAPI["enterprise"]["clearProviderCredentials"]
      >,
    readGuide: () => invoke("enterprise-guide-read") as ReturnType<ElectronAPI["enterprise"]["readGuide"]>,
    readiness: (provider) =>
      invoke("enterprise-readiness", provider) as ReturnType<ElectronAPI["enterprise"]["readiness"]>,
    stateBackups: () => invoke("enterprise-state-backups") as ReturnType<ElectronAPI["enterprise"]["stateBackups"]>,
    restoreStateBackup: (backupID) =>
      invoke("enterprise-state-restore", backupID) as ReturnType<ElectronAPI["enterprise"]["restoreStateBackup"]>,
    skillPacks: () => invoke("enterprise-skill-packs") as ReturnType<ElectronAPI["enterprise"]["skillPacks"]>,
    setSkillPackEnabled: (id, enabled) =>
      invoke("enterprise-skill-pack-set", id, enabled) as ReturnType<ElectronAPI["enterprise"]["setSkillPackEnabled"]>,
    openSkillPackSource: (id) =>
      invoke("enterprise-skill-pack-source", id) as ReturnType<ElectronAPI["enterprise"]["openSkillPackSource"]>,
  }
}

export function mapEnterpriseAPI(enterprise: ElectronAPI["enterprise"]) {
  return {
    providerCatalog: enterprise.providerCatalog,
    createProvider: enterprise.createProvider,
    updateProvider: enterprise.updateProvider,
    deleteProvider: enterprise.deleteProvider,
    createModel: enterprise.createModel,
    updateModel: enterprise.updateModel,
    deleteModel: enterprise.deleteModel,
    setDefaultModel: enterprise.setDefaultModel,
    replaceProviderCredentials: enterprise.replaceProviderCredentials,
    clearProviderCredentials: enterprise.clearProviderCredentials,
    readGuide: enterprise.readGuide,
    readiness: enterprise.readiness,
    stateBackups: enterprise.stateBackups,
    restoreStateBackup: enterprise.restoreStateBackup,
    skillPacks: enterprise.skillPacks,
    setSkillPackEnabled: enterprise.setSkillPackEnabled,
    openSkillPackSource: enterprise.openSkillPackSource,
  }
}
