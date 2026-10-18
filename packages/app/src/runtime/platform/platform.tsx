import { createSimpleContext } from "@opencode/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "@/shell/commands/desktop-menu"
import type { DraftStore } from "@/runtime/persistence/drafts"
import type { Bridge } from "@opencode/gui-extensions/sdk/bridge"

type PickerPaths = string | string[] | null

type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }

type OpenAttachmentPickerOptions = {
  title?: string
  multiple?: boolean
  accept?: string[]
  extensions?: string[]
  defaultPath?: string
}

type SaveFilePickerOptions = { title?: string; defaultPath?: string }

type PlatformName = "web" | "desktop"

type DesktopOS = "macos" | "windows" | "linux"
export type EnterpriseModelRef = { providerID: string; modelID: string }
export type EnterpriseProviderModel = { id: string; name: string }
export type EnterpriseProvider = {
  id: string
  name: string
  baseURL: string
  models: EnterpriseProviderModel[]
}
export type EnterpriseProviderCatalogView = {
  schemaVersion: 1
  default?: EnterpriseModelRef
  providers: Array<
    EnterpriseProvider & {
      credentials: {
        configured: boolean
        headerNames: string[]
        errorCode?: "credential_decryption_failed" | "credential_encryption_unavailable"
      }
    }
  >
}
export type CredentialReplacement = { apiKey?: string; headers: Record<string, string> }
export type EnterpriseProviderErrorCode =
  | "restart_failed_rolled_back"
  | "restart_failed_recovery_failed"
  | "credential_decryption_failed"
  | "credential_encryption_unavailable"
  | "credential_provider_not_configured"

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

type PlatformBase = {
  /** App version */
  version?: string

  /** Open a web or mail URL in the default system application */
  openExternal(url: string): void

  /** Open an authentication page, reporting whether the browser could be launched. */
  openBrowser?(url: string): Promise<boolean>

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Open a local file URL in its default app (desktop only) */
  openLocalFile?(url: string): void

  /** Reveal a local path in the system file manager; false when the path does not exist (desktop only) */
  revealPath?(path: string): Promise<boolean>

  /** Restart the app  */
  restart(): Promise<void>

  /** Send a system notification */
  notify(title: string, description?: string, onClick?: () => void): Promise<void>

  /** Open a native attachment picker and read selected files sequentially (desktop only) */
  openAttachmentPickerDialog?<Value>(
    opts: OpenAttachmentPickerOptions,
    onFile: (file: File) => Promise<Value>,
  ): Promise<void>

  /** Resolve the native source path for a desktop File. */
  getPathForFile?(file: File): string

  /** Observe native drag cancellation that does not reach the renderer event loop. */
  onDragCancel?(callback: () => void): () => void

  /** Open a native save file dialog and write content to the selected path (desktop only) */
  saveFile?(opts: SaveFilePickerOptions, content: string): Promise<boolean>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Prompt drafts, history, and their blobs. */
  draftStore?: DraftStore

  /** Enterprise credential management through desktop secure storage */
  enterprise?: {
    providerCatalog(): Promise<EnterpriseProviderCatalogView>
    createProvider(input: {
      provider: EnterpriseProvider
      credentials?: CredentialReplacement
    }): Promise<EnterpriseProviderCatalogView>
    updateProvider(input: {
      providerID: string
      name: string
      baseURL: string
      credentials?: CredentialReplacement
      clearCredentials?: true
    }): Promise<EnterpriseProviderCatalogView>
    deleteProvider(providerID: string): Promise<EnterpriseProviderCatalogView>
    createModel(input: {
      providerID: string
      model: EnterpriseProviderModel
    }): Promise<EnterpriseProviderCatalogView>
    updateModel(input: { providerID: string; modelID: string; name: string }): Promise<EnterpriseProviderCatalogView>
    deleteModel(input: EnterpriseModelRef): Promise<EnterpriseProviderCatalogView>
    setDefaultModel(input: EnterpriseModelRef): Promise<EnterpriseProviderCatalogView>
    replaceProviderCredentials(input: {
      providerID: string
      credentials: CredentialReplacement
    }): Promise<EnterpriseProviderCatalogView>
    clearProviderCredentials(providerID: string): Promise<EnterpriseProviderCatalogView>
    readGuide(): Promise<{ version: string; markdown: string }>
    readiness(provider?: {
      ok: boolean
      checks: {
        basic: "pass" | "fail" | "skipped"
        streaming: "pass" | "fail" | "skipped"
        toolCall: "pass" | "fail" | "skipped"
      }
      failure?: { kind: string; message: string }
    }): Promise<{
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
    }>
    stateBackups(): Promise<{ id: string; appVersion: string; createdAt: string }[]>
    restoreStateBackup(backupID: string): Promise<{ restartRequired: boolean }>
    skillPacks(): Promise<
      {
        id: string
        displayName: string
        description: string
        version: string
        repository: string
        root: string
        members: string[]
        license: string
        enabled: boolean
      }[]
    >
    setSkillPackEnabled(id: string, enabled: boolean): ReturnType<NonNullable<PlatformBase["enterprise"]>["skillPacks"]>
    openSkillPackSource(id: string): Promise<void>
  }

  /** Fetch override */
  fetch?: typeof fetch

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** Whether the native desktop window is fullscreen */
  windowFullscreen?: Accessor<boolean>

  /** Get whether native pinch/Ctrl-scroll zoom gestures are enabled (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean> | boolean

  /** Allow native pinch/Ctrl-scroll zoom gestures (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void

  /** Run a desktop-only menu action from the app chrome */
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Write text to the native clipboard (desktop only) */
  writeClipboardText?(text: string): Promise<void>

  /** Export collected diagnostic logs (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Force focus styles on interactive elements through desktop devtools (desktop only) */
  setForceFocus?(enabled: boolean): Promise<void>

  /** Record a fatal renderer error in platform logs (desktop only) */
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>

  /** GUI extension bridge to the main-process extension host (desktop only). */
  extensions?: Bridge
}

export type Platform = PlatformBase &
  (
    | { platform: "web"; os?: never; windowID?: never }
    | {
        platform: "desktop"
        os?: DesktopOS
        /** Stable platform window identity for window-scoped persistence */
        windowID: string
        openDirectoryPickerDialog(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>
      }
  )

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
