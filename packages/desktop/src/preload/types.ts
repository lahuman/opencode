import type { DesktopMenuAction } from "@opencode-ai/app/desktop-menu"
import type { WslServersPlatform } from "@opencode-ai/app/wsl/types"
import type { UpdaterState } from "@opencode-ai/app/updater"
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
export type EnterpriseCredentialCatalog = {
  defaultModelID: string
  models: {
    id: string
    name: string
    baseURL: string
    credentialStatus: {
      configured: boolean
      errorCode?: "credential_decryption_failed" | "credential_encryption_unavailable"
    }
  }[]
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

export type ElectronAPI = {
  killSidecar: () => Promise<void>
  installCli: () => Promise<string>
  awaitInitialization: () => Promise<ServerReadyData>
  enterprise: {
    enabled: boolean
    credentialCatalog: () => Promise<EnterpriseCredentialCatalog>
    credentialStatus: (modelID: string) => Promise<{ configured: boolean; errorCode?: string }>
    setCredentials: (input: {
      modelID: string
      apiKey?: string
      headers?: Record<string, string>
    }) => Promise<{ restartRequired: true }>
    clearCredentials: (modelID: string) => Promise<{ restartRequired: true }>
    readGuide: () => Promise<{ version: string; markdown: string }>
    readiness: (provider?: EnterpriseProviderDiagnostic) => Promise<EnterpriseReadinessReport>
    stateBackups: () => Promise<{ id: string; appVersion: string; createdAt: string }[]>
    restoreStateBackup: (backupID: string) => Promise<{ restartRequired: true }>
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
  parseMarkdownCommand: (markdown: string) => Promise<string>
  checkAppExists: (appName: string) => Promise<boolean>
  resolveAppPath: (appName: string) => Promise<string | null>
  storeGet: (name: string, key: string) => Promise<string | null>
  storeSet: (name: string, key: string, value: string) => Promise<void>
  storeDelete: (name: string, key: string) => Promise<void>
  storeClear: (name: string) => Promise<void>
  storeKeys: (name: string) => Promise<string[]>
  storeLength: (name: string) => Promise<number>

  getWindowCount: () => Promise<number>
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
  openLink: (url: string) => void
  openPath: (path: string, app?: string) => Promise<void>
  revealPath: (path: string) => Promise<boolean>
  readClipboardImage: () => Promise<{ buffer: ArrayBuffer; width: number; height: number } | null>
  showNotification: (title: string, body?: string) => void
  getWindowFocused: () => Promise<boolean>
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
  recordFatalRendererError: (error: FatalRendererError) => Promise<void>
}

export function createEnterpriseAPI(
  enabled: boolean,
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): ElectronAPI["enterprise"] {
  return {
    enabled,
    credentialCatalog: () =>
      invoke("enterprise-credential-catalog") as ReturnType<ElectronAPI["enterprise"]["credentialCatalog"]>,
    credentialStatus: (modelID) =>
      invoke("enterprise-credential-status", modelID) as ReturnType<ElectronAPI["enterprise"]["credentialStatus"]>,
    setCredentials: (input) =>
      invoke("enterprise-set-credentials", input) as ReturnType<ElectronAPI["enterprise"]["setCredentials"]>,
    clearCredentials: (modelID) =>
      invoke("enterprise-clear-credentials", modelID) as ReturnType<ElectronAPI["enterprise"]["clearCredentials"]>,
    readGuide: () => invoke("enterprise-guide-read") as ReturnType<ElectronAPI["enterprise"]["readGuide"]>,
    readiness: (provider) =>
      invoke("enterprise-readiness", provider) as ReturnType<ElectronAPI["enterprise"]["readiness"]>,
    stateBackups: () => invoke("enterprise-state-backups") as ReturnType<ElectronAPI["enterprise"]["stateBackups"]>,
    restoreStateBackup: (backupID) =>
      invoke("enterprise-state-restore", backupID) as ReturnType<ElectronAPI["enterprise"]["restoreStateBackup"]>,
  }
}

export function mapEnterpriseAPI(enterprise: ElectronAPI["enterprise"]) {
  return {
    credentialCatalog: enterprise.credentialCatalog,
    credentialStatus: enterprise.credentialStatus,
    setCredentials: enterprise.setCredentials,
    clearCredentials: enterprise.clearCredentials,
    readGuide: enterprise.readGuide,
    readiness: enterprise.readiness,
    stateBackups: enterprise.stateBackups,
    restoreStateBackup: enterprise.restoreStateBackup,
  }
}
