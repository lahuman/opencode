import "@/index.css"
import { type BaseRouterProps, MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { useDialog } from "@opencode/ui/context/dialog"
import {
  type Component,
  createSignal,
  ErrorBoundary,
  type JSX,
  Match,
  onMount,
  type ParentProps,
  Switch,
  untrack,
} from "solid-js"
import { render } from "solid-js/web"
import { ServerConnection, ServersProvider, useServers } from "@/runtime/server/registry"
import { ServerProvider, useServer } from "@/runtime/server/current"
import { DialogServer } from "@/servers/connect/dialog"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { createStore } from "solid-js/store"
import { AppBaseProviders, AppInterface } from "@/app"
import { useLanguage } from "@/runtime/i18n/language"
import { NewSessionWordmark } from "@/new-session/wordmark"
import { DialogCompanyProvider, useCompanyProviderSettingsState } from "@/components/dialog-company-provider"
import { DialogConnectProvider } from "@/providers/connect/dialog"
import { SettingsProviders } from "@/settings/providers/providers"
import { WindowsAppMenu } from "@/shell/titlebar/windows-menu"
import { CommandProvider, useCommand } from "@/shell/commands/command"
import { DesktopCommands } from "@/shell/commands/desktop"
import { GlobalProvider, useGlobal } from "@/runtime/server/runtime"
import {
  type EnterpriseProviderCatalogView,
  type Platform,
  PlatformProvider,
  usePlatform,
} from "@/runtime/platform/platform"
import { SettingsProvider } from "@/settings/model"
import { TabsProvider } from "@/shell/tabs/tabs"
import { ToastRegion } from "@/shell/notifications/toast"

const DIAGNOSTIC_SUCCESS = {
  ok: true,
  checks: { basic: "pass", streaming: "pass", toolCall: "pass" },
} as const
const DIAGNOSTIC_FAILURE = {
  ok: false,
  checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
  failure: { kind: "connection", message: "Install the Company TLS CA certificate and try again." },
} as const
const GUIDE_MARKDOWN = [
  "# CHAI AI 사용 가이드",
  "",
  "Use only company-approved data and systems.",
  "",
  ...Array.from({ length: 24 }, (_, index) => `${index + 1}. Review generated output before using it in company work.`),
  "",
  "## Escalation",
  "",
  "Stop work and follow the company security reporting process when sensitive data may be involved.",
].join("\n")

type RequestRecord = {
  origin: string
  host: string
  method: string
  path: string
  query: string
  body?: unknown
}
type CredentialInput = {
  providerID: string
  hasApiKey: boolean
  headerNames: string[]
}
type ProviderUpdateInput = CredentialInput & { baseURL: string; clearCredentials: boolean }
type CredentialMode = "restart" | "no-restart" | "error" | "recovery" | "pending"
type DiagnosticOutcome = "success" | "failure" | "network-error"

function createHarness(scenario?: string | null) {
  const sidecar: ServerConnection.Sidecar = {
    type: "sidecar",
    variant: "base",
    displayName: "Company sidecar",
    http: { url: "http://127.0.0.1:5199" },
  }
  const remote: ServerConnection.Http = {
    type: "http",
    displayName: "Persisted remote",
    http: { url: "https://remote.example.test" },
  }
  const stores = new Map<string, Map<string, string>>([
    [
      "opencode.global.dat",
      new Map([["server", JSON.stringify({ list: [remote], projects: {}, lastProject: {}, recentlyClosed: {} })]]),
    ],
  ])
  const [observations, setObservations] = createStore({
    requests: [] as RequestRecord[],
    storageWrites: [] as Array<{ name: string; key: string; value: string | null }>,
    credentialInputs: [] as CredentialInput[],
    providerUpdateInputs: [] as ProviderUpdateInput[],
    standaloneCredentialInputs: [] as CredentialInput[],
    credentialStatusInputs: [] as string[],
    credentialClearInputs: [] as string[],
    credentialCatalogCalls: 0,
    defaultWrites: [] as Array<ServerConnection.Key | null>,
    restartSnapshots: [] as string[][],
    externalLinks: [] as string[],
  })
  const [diagnosticPending, setDiagnosticPending] = createSignal(false)
  const [credentialPending, setCredentialPending] = createSignal(false)
  const [providerPending, setProviderPending] = createSignal(0)
  const providerResponses = {
    deferred: false,
    empty: false,
    pending: [] as Array<(response: Response) => void>,
  }
  const behavior = {
    credentialMode: "restart" as CredentialMode,
    diagnosticOutcome: "success" as DiagnosticOutcome,
  }
  const catalogState: { value: EnterpriseProviderCatalogView } = {
    value: scenario?.startsWith("settings")
      ? {
          schemaVersion: 1,
          default: { providerID: "company-llm", modelID: "company-code" },
          providers: [
            {
              id: "company-llm",
              baseURL: "https://llm.company.test/v1",
              models: [{ id: "company-code" }],
              credentials: { configured: false, headerNames: [] },
            },
          ],
        }
      : { schemaVersion: 1, providers: [] },
  }
  const diagnostic = { resolve: undefined as ((value: unknown) => void) | undefined }
  const credential = { resolve: undefined as (() => void) | undefined }
  const globalEvent = {
    resolve: undefined as ((response: Response) => void) | undefined,
    connected: false,
  }
  const history = createMemoryHistory()
  history.set({
    value: scenario?.startsWith("composer") ? "/new-session?draftId=company-composer" : "/",
    scroll: false,
    replace: true,
  })
  if (scenario?.startsWith("composer")) {
    stores.set(
      "opencode.window.company-llm-enterprise-fixture.dat",
      new Map([
        [
          "tabs",
          JSON.stringify([
            {
              type: "draft",
              draftID: "company-composer",
              server: ServerConnection.key(sidecar),
              directory: "/repo",
            },
          ]),
        ],
      ]),
    )
  }

  const storage = (name = "default.dat") => {
    const values = stores.get(name) ?? new Map<string, string>()
    stores.set(name, values)
    return {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value)
        setObservations(
          "storageWrites",
          untrack(() => observations.storageWrites.length),
          { name, key, value },
        )
      },
      removeItem: async (key: string) => {
        values.delete(key)
        setObservations(
          "storageWrites",
          untrack(() => observations.storageWrites.length),
          { name, key, value: null },
        )
      },
    }
  }

  const credentialTransition = async () => {
    if (behavior.credentialMode === "error") throw new Error("secure storage failed")
    if (behavior.credentialMode === "recovery") {
      throw Object.assign(new Error("restart_failed_recovery_failed"), { code: "restart_failed_recovery_failed" })
    }
    if (behavior.credentialMode !== "pending") return
    await new Promise<void>((resolve) => {
      credential.resolve = resolve
      setCredentialPending(true)
    })
    credential.resolve = undefined
    setCredentialPending(false)
  }

  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
  const connectedEvent = () =>
    new Response(
      `data: ${JSON.stringify({
        id: "fixture-connected",
        created: Date.now(),
        type: "server.connected",
        data: {},
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )
  const fetch = (async (source: RequestInfo | URL, init?: RequestInit) => {
    const request = source instanceof Request ? source : new Request(source, init)
    const url = new URL(request.url)
    const body =
      request.method === "GET"
        ? undefined
        : await request
            .clone()
            .json()
            .then(
              (value) => value as unknown,
              () => undefined,
            )
    setObservations("requests", observations.requests.length, {
      origin: url.origin,
      host: url.host,
      method: request.method,
      path: url.pathname,
      query: url.search,
      body,
    })

    const location = { directory: url.searchParams.get("location[directory]") ?? "/repo" }
    const response = (data: unknown) => json({ location, data })
    if (url.pathname === "/api/info")
      return json({ version: "2.0.30", pid: 1, urls: [sidecar.http.url], paths: { tmp: "/tmp" } })
    if (url.pathname === "/api/location")
      return json({ ...location, project: { id: "proj_fixture", directory: "/repo", canonical: "/repo" } })
    if (url.pathname === "/api/provider" || url.pathname === "/api/model") {
      if (scenario === "composer-enterprise-empty" && providerResponses.empty) return response([])
      if (scenario === "composer-enterprise-empty" && providerResponses.deferred) {
        return new Promise<Response>((resolve) => {
          providerResponses.pending.push(resolve)
          setProviderPending(providerResponses.pending.length)
        })
      }
      const providers =
        scenario === "composer-enterprise-empty"
          ? [{ id: "company-llm", name: "Company LLM", models: [{ id: "company-code", name: "Company Code" }] }]
          : catalogState.value.providers
      return response(
        url.pathname === "/api/provider"
          ? providers.map((provider) => ({
              ...Provider.Info.empty(Provider.ID.make(provider.id)),
              name: provider.id,
            }))
          : providers.flatMap((provider) =>
              provider.models.map((model) => ({
                ...Model.Info.default(Provider.ID.make(provider.id), Model.ID.make(model.id)),
                name: model.id,
              })),
            ),
      )
    }
    if (url.pathname === "/api/agent")
      return response(
        ["build", "plan"].map((name) => ({
          id: name,
          name,
          mode: "primary",
          hidden: false,
          request: { settings: {}, headers: {}, body: {} },
          permissions: [],
          model: catalogState.value.default && {
            providerID: catalogState.value.default.providerID,
            id: catalogState.value.default.modelID,
          },
        })),
      )
    if (url.pathname === "/api/config")
      return json([
        {
          type: "document",
          path: "/config/opencode.jsonc",
          info: {
            model: catalogState.value.default && {
              providerID: catalogState.value.default.providerID,
              model: catalogState.value.default.modelID,
            },
          },
        },
      ])
    if (url.pathname === "/api/session/active") return json({})
    if (url.pathname === "/api/project" || url.pathname === "/api/worktree") return json([])
    if (
      [
        "/api/session",
        "/api/integration",
        "/api/command",
        "/api/reference",
        "/api/permission/request",
        "/api/permission/saved",
        "/api/form",
        "/api/shell",
      ].includes(url.pathname)
    )
      return response([])
    if (url.pathname === "/api/vcs") return response(null)
    if (/^\/api\/provider\/[^/]+\/diagnose$/.test(url.pathname)) {
      if (behavior.diagnosticOutcome === "network-error") throw new Error("transport failure with private detail")
      const value = await new Promise<unknown>((resolve) => {
        diagnostic.resolve = resolve
        setDiagnosticPending(true)
      })
      diagnostic.resolve = undefined
      setDiagnosticPending(false)
      return response(value)
    }
    if (url.pathname === "/api/event") {
      if (globalEvent.connected) {
        globalEvent.connected = false
        return connectedEvent()
      }
      return new Promise<Response>((resolve, reject) => {
        globalEvent.resolve = resolve
        const abort = () => reject(new DOMException("Aborted", "AbortError"))
        if (request.signal.aborted) {
          abort()
          return
        }
        request.signal.addEventListener("abort", abort, { once: true })
      })
    }
    return json({})
  }) as typeof globalThis.fetch
  globalThis.fetch = fetch

  const inputValue = (label: string) =>
    [...document.querySelectorAll<HTMLElement>("[data-component=input]")]
      .find((field) => field.querySelector("[data-slot=input-label]")?.textContent === label)
      ?.querySelector<HTMLInputElement>("[data-slot=input-input]")?.value ?? ""

  const platform: Platform = {
    platform: "desktop",
    os: "macos",
    windowID: "company-llm-enterprise-fixture",
    storage,
    fetch,
    openExternal(url) {
      setObservations("externalLinks", observations.externalLinks.length, url)
    },
    async restart() {
      setObservations("restartSnapshots", observations.restartSnapshots.length, [
        inputValue("API key"),
        inputValue("Secret header"),
        inputValue("Secret value"),
      ])
    },
    async notify() {},
    async openDirectoryPickerDialog() {
      return null
    },
    enterprise: {
      async providerCatalog() {
        setObservations("credentialCatalogCalls", (value) => value + 1)
        return structuredClone(catalogState.value)
      },
      async createProvider(input) {
        catalogState.value.providers.push({
          ...input.provider,
          models: input.provider.models.map((model) => ({ ...model })),
          credentials: {
            configured: Boolean(input.credentials?.apiKey || Object.keys(input.credentials?.headers ?? {}).length),
            headerNames: Object.keys(input.credentials?.headers ?? {}),
          },
        })
        return this.providerCatalog()
      },
      async updateProvider(input) {
        setObservations("providerUpdateInputs", observations.providerUpdateInputs.length, {
          providerID: input.providerID,
          baseURL: input.baseURL,
          hasApiKey: Boolean(input.credentials?.apiKey),
          headerNames: Object.keys(input.credentials?.headers ?? {}),
          clearCredentials: Boolean(input.clearCredentials),
        })
        if (input.credentials || input.clearCredentials) {
          setObservations("credentialInputs", observations.credentialInputs.length, {
            providerID: input.providerID,
            hasApiKey: Boolean(input.credentials?.apiKey),
            headerNames: Object.keys(input.credentials?.headers ?? {}),
          })
          await credentialTransition()
        }
        catalogState.value.providers = catalogState.value.providers.map((provider) =>
          provider.id === input.providerID
            ? {
                ...provider,
                baseURL: input.baseURL,
                ...(input.credentials || input.clearCredentials
                  ? {
                      credentials: {
                        configured: Boolean(
                          input.credentials?.apiKey || Object.keys(input.credentials?.headers ?? {}).length,
                        ),
                        headerNames: Object.keys(input.credentials?.headers ?? {}),
                      },
                    }
                  : {}),
              }
            : provider,
        )
        return this.providerCatalog()
      },
      async deleteProvider(providerID) {
        catalogState.value.providers = catalogState.value.providers.filter((provider) => provider.id !== providerID)
        if (catalogState.value.default?.providerID === providerID) {
          const provider = catalogState.value.providers.find((item) => item.models.length)
          catalogState.value.default = provider
            ? { providerID: provider.id, modelID: provider.models[0].id }
            : undefined
        }
        return this.providerCatalog()
      },
      async createModel(input) {
        const provider = catalogState.value.providers.find((item) => item.id === input.providerID)
        provider?.models.push({ ...input.model })
        return this.providerCatalog()
      },
      async deleteModel(input) {
        const provider = catalogState.value.providers.find((item) => item.id === input.providerID)
        if (provider) provider.models = provider.models.filter((model) => model.id !== input.modelID)
        if (
          catalogState.value.default?.providerID === input.providerID &&
          catalogState.value.default.modelID === input.modelID
        ) {
          const fallback = provider?.models[0]
          const other = catalogState.value.providers.find((item) => item.models.length)
          catalogState.value.default = fallback
            ? { providerID: input.providerID, modelID: fallback.id }
            : other
              ? { providerID: other.id, modelID: other.models[0].id }
              : undefined
        }
        return this.providerCatalog()
      },
      async setDefaultModel(input) {
        catalogState.value.default = { ...input }
        return this.providerCatalog()
      },
      async replaceProviderCredentials(input) {
        setObservations("standaloneCredentialInputs", observations.standaloneCredentialInputs.length, {
          providerID: input.providerID,
          hasApiKey: Boolean(input.credentials.apiKey),
          headerNames: Object.keys(input.credentials.headers),
        })
        setObservations("credentialInputs", observations.credentialInputs.length, {
          providerID: input.providerID,
          hasApiKey: Boolean(input.credentials.apiKey),
          headerNames: Object.keys(input.credentials.headers),
        })
        await credentialTransition()
        const provider = catalogState.value.providers.find((item) => item.id === input.providerID)
        if (provider)
          provider.credentials = {
            configured: Boolean(input.credentials.apiKey || Object.keys(input.credentials.headers).length),
            headerNames: Object.keys(input.credentials.headers),
          }
        return this.providerCatalog()
      },
      async clearProviderCredentials(providerID) {
        setObservations("credentialClearInputs", observations.credentialClearInputs.length, providerID)
        await credentialTransition()
        const provider = catalogState.value.providers.find((item) => item.id === providerID)
        if (provider) provider.credentials = { configured: false, headerNames: [] }
        return this.providerCatalog()
      },
      async readGuide() {
        return { version: "chai-1", markdown: GUIDE_MARKDOWN }
      },
      async readiness() {
        return { schemaVersion: 1 as const, generatedAt: "now", overall: "warn" as const, checks: [] }
      },
      async stateBackups() {
        return []
      },
      async restoreStateBackup() {
        return { restartRequired: true as const }
      },
      async skillPacks() {
        return []
      },
      async setSkillPackEnabled() {
        return []
      },
      async openSkillPackSource() {},
    },
  }

  return {
    behavior,
    credentialPending,
    providerPending,
    diagnosticPending,
    history,
    observations,
    platform,
    remote,
    resolveDiagnostic() {
      diagnostic.resolve?.(behavior.diagnosticOutcome === "success" ? DIAGNOSTIC_SUCCESS : DIAGNOSTIC_FAILURE)
    },
    resolveCredential() {
      credential.resolve?.()
    },
    resolveProviders() {
      providerResponses.deferred = false
      providerResponses.empty = true
      const response = json({ location: { directory: "/repo" }, data: [] })
      providerResponses.pending.splice(0).forEach((resolve) => resolve(response.clone()))
      setProviderPending(0)
    },
    refreshProviders() {
      providerResponses.deferred = true
      setTimeout(() => {
        const resolve = globalEvent.resolve
        globalEvent.resolve = undefined
        if (resolve) {
          resolve(connectedEvent())
          return
        }
        globalEvent.connected = true
      }, 1_600)
    },
    sidecar,
    persistedServers() {
      observations.storageWrites.length
      const value = stores.get("opencode.global.dat")?.get("server")
      if (!value) return []
      return (JSON.parse(value) as { list?: unknown[] }).list ?? []
    },
  }
}

type Harness = ReturnType<typeof createHarness>

function ServerTree(props: ParentProps<{ harness: Harness; platform?: Platform }>) {
  return (
    <PlatformProvider value={props.platform ?? props.harness.platform}>
      <AppBaseProviders locale="en">
        <ServersProvider
          canonicalLocalServer={ServerConnection.key(props.harness.sidecar)}
          servers={[props.harness.sidecar, props.harness.remote]}
        >
          <SettingsProvider>
            <MemoryRouter history={props.harness.history}>
              <Route
                path="*"
                component={() => (
                  <TabsProvider>
                    <GlobalProvider>
                      <ServerProvider conn={props.harness.sidecar}>{props.children}</ServerProvider>
                    </GlobalProvider>
                  </TabsProvider>
                )}
              />
            </MemoryRouter>
          </SettingsProvider>
        </ServersProvider>
      </AppBaseProviders>
    </PlatformProvider>
  )
}

function DialogTree(props: ParentProps<{ harness: Harness }>) {
  return <ServerTree harness={props.harness}>{props.children}</ServerTree>
}

function Observations(props: { harness: Harness }) {
  return (
    <div class="sr-only" aria-hidden="true">
      <output data-testid="requests">{JSON.stringify(props.harness.observations.requests)}</output>
      <output data-testid="storage-writes">{JSON.stringify(props.harness.observations.storageWrites)}</output>
      <output data-testid="credential-inputs">{JSON.stringify(props.harness.observations.credentialInputs)}</output>
      <output data-testid="provider-update-inputs">
        {JSON.stringify(props.harness.observations.providerUpdateInputs)}
      </output>
      <output data-testid="standalone-credential-inputs">
        {JSON.stringify(props.harness.observations.standaloneCredentialInputs)}
      </output>
      <output data-testid="credential-status-inputs">
        {JSON.stringify(props.harness.observations.credentialStatusInputs)}
      </output>
      <output data-testid="credential-clear-inputs">
        {JSON.stringify(props.harness.observations.credentialClearInputs)}
      </output>
      <output data-testid="credential-catalog-calls">{props.harness.observations.credentialCatalogCalls}</output>
      <output data-testid="default-writes">{JSON.stringify(props.harness.observations.defaultWrites)}</output>
      <output data-testid="restart-snapshots">{JSON.stringify(props.harness.observations.restartSnapshots)}</output>
      <output data-testid="external-links">{JSON.stringify(props.harness.observations.externalLinks)}</output>
      <output data-testid="persisted-servers">{JSON.stringify(props.harness.persistedServers())}</output>
    </div>
  )
}

function HealthConsumer(props: { harness: Harness }) {
  const servers = useServers()
  const server = useServer()
  return (
    <>
      <output data-testid="server-list">{servers.list.map((conn) => ServerConnection.key(conn)).join(",")}</output>
      <output data-testid="active-server">{server.key}</output>
      <Observations harness={props.harness} />
    </>
  )
}

function ServerScenario(props: { harness: Harness }) {
  return (
    <ServerTree harness={props.harness}>
      <HealthConsumer harness={props.harness} />
    </ServerTree>
  )
}

function ControllerScenario(props: { harness: Harness }) {
  return (
    <ServerTree harness={props.harness}>
      <OpenDialog component={() => <DialogServer mode="add" />} />
      <Observations harness={props.harness} />
    </ServerTree>
  )
}

function OpenDialog(props: { component: () => JSX.Element }) {
  const dialog = useDialog()
  onMount(() => void dialog.show(props.component))
  return null
}

function ConnectScenario(props: { harness: Harness }) {
  return (
    <>
      <DialogTree harness={props.harness}>
        <OpenDialog component={() => <DialogConnectProvider />} />
      </DialogTree>
      <Observations harness={props.harness} />
    </>
  )
}

function CompanyControls(props: { harness: Harness }) {
  return (
    <>
      <div class="fixed bottom-2 left-2 z-50 flex gap-1" data-testid="company-controls">
        <button type="button" onClick={() => (props.harness.behavior.credentialMode = "restart")}>
          Credentials restart
        </button>
        <button type="button" onClick={() => (props.harness.behavior.credentialMode = "no-restart")}>
          Credentials no restart
        </button>
        <button type="button" onClick={() => (props.harness.behavior.credentialMode = "error")}>
          Credentials error
        </button>
        <button type="button" onClick={() => (props.harness.behavior.credentialMode = "recovery")}>
          Credentials recovery failure
        </button>
        <button type="button" onClick={() => (props.harness.behavior.credentialMode = "pending")}>
          Credentials pending
        </button>
        <button type="button" disabled={!props.harness.credentialPending()} onClick={props.harness.resolveCredential}>
          Resolve credentials
        </button>
        <button type="button" onClick={() => (props.harness.behavior.diagnosticOutcome = "success")}>
          Diagnostic success
        </button>
        <button type="button" onClick={() => (props.harness.behavior.diagnosticOutcome = "failure")}>
          Diagnostic failure
        </button>
        <button type="button" onClick={() => (props.harness.behavior.diagnosticOutcome = "network-error")}>
          Diagnostic network error
        </button>
        <button type="button" disabled={!props.harness.diagnosticPending()} onClick={props.harness.resolveDiagnostic}>
          Resolve diagnostic
        </button>
      </div>
      <Observations harness={props.harness} />
    </>
  )
}

function CompanyScenario(props: { harness: Harness }) {
  return (
    <>
      <DialogTree harness={props.harness}>
        <OpenDialog component={() => <DialogCompanyProvider />} />
      </DialogTree>
      <CompanyControls harness={props.harness} />
    </>
  )
}

function GuideScenario(props: { harness: Harness }) {
  return (
    <>
      <CompanyGuideTree harness={props.harness}>
        <GuideMenu />
      </CompanyGuideTree>
      <Observations harness={props.harness} />
    </>
  )
}

function GuideMenu() {
  const command = useCommand()
  const platform = usePlatform()
  return (
    <div class="fixed left-2 top-2">
      <WindowsAppMenu command={command} platform={platform} />
    </div>
  )
}

function CompanyGuideTree(props: ParentProps<{ harness: Harness; platform?: Platform }>) {
  return (
    <ServerTree harness={props.harness} platform={props.platform}>
      <CommandProvider>
        <DesktopCommands />
        {props.children}
      </CommandProvider>
    </ServerTree>
  )
}

function ErrorScenario(props: { harness: Harness; enterprise: boolean }) {
  const platform = props.enterprise ? props.harness.platform : { ...props.harness.platform, enterprise: undefined }
  return (
    <>
      <PlatformProvider value={platform}>
        <AppBaseProviders locale="en">
          <TopLevelFailure />
        </AppBaseProviders>
      </PlatformProvider>
      <Observations harness={props.harness} />
    </>
  )
}

function TopLevelFailure(): JSX.Element {
  throw new Error("Fixture top-level failure")
}

function SettingsDiagnosticConsumer() {
  const company = useCompanyProviderSettingsState()
  return (
    <>
      <button type="button" disabled={company.checking()} onClick={company.testConnection}>
        {company.checking() ? "Testing settings connection" : "Settings test connection"}
      </button>
      <output data-testid="settings-credential-status">{company.status()}</output>
      <ToastRegion />
    </>
  )
}

function SettingsScenario(props: { harness: Harness }) {
  return (
    <>
      <DialogTree harness={props.harness}>
        <SettingsDiagnosticConsumer />
      </DialogTree>
      <CompanyControls harness={props.harness} />
    </>
  )
}

function SettingsLayoutScenario(props: { harness: Harness; v2?: boolean }) {
  return (
    <DialogTree harness={props.harness}>
      <SettingsProviders directory={undefined} />
    </DialogTree>
  )
}

function ComposerScenario(props: { harness: Harness; enterprise: boolean; web?: boolean; branding?: boolean }) {
  const Router: Component<BaseRouterProps> = (routerProps) => (
    <MemoryRouter history={props.harness.history} root={routerProps.root} base={routerProps.base}>
      {routerProps.children}
    </MemoryRouter>
  )
  const platform = props.web
    ? { ...props.harness.platform, platform: "web" as const, enterprise: undefined }
    : props.enterprise
      ? props.harness.platform
      : { ...props.harness.platform, enterprise: undefined }
  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale="en">
        <Show
          when={!props.branding}
          fallback={
            <>
              <NewSessionWordmark chai={!props.web} />
              <BrandingConsumer />
            </>
          }
        >
          <AppInterface
            router={Router}
            canonicalLocalServer={ServerConnection.key(props.harness.sidecar)}
            servers={[props.harness.sidecar]}
          >
            <ComposerControls harness={props.harness} />
            <BrandingConsumer />
          </AppInterface>
        </Show>
        <Observations harness={props.harness} />
      </AppBaseProviders>
    </PlatformProvider>
  )
}

function BrandingConsumer() {
  const language = useLanguage()
  return (
    <div style={{ position: "fixed", bottom: "24px", left: "8px", "z-index": 10000, "font-size": "10px" }}>
      <output data-testid="app-brand">{language.t("desktop.menu.app")}</output>
      <output data-testid="brand-description">{language.t("settings.general.row.language.description")}</output>
      <output data-testid="brand-provider">
        {language.t("provider.connect.apiKey.description", { provider: "OpenCode Gateway" })}
      </output>
      <button type="button" onClick={() => language.setLocale("ko")}>
        Korean branding
      </button>
    </div>
  )
}

function ComposerControls(props: { harness: Harness }) {
  const global = useGlobal()
  return (
    <div style={{ position: "fixed", bottom: "2px", right: "2px", "z-index": 10000 }}>
      <button
        type="button"
        onClick={() => {
          props.harness.refreshProviders()
          const data = global.ensureServerCtx(props.harness.sidecar).data
          const location = { directory: "/repo" }
          data.location.provider.invalidate(location)
          data.location.model.invalidate(location)
          void Promise.all([data.location.provider.sync(location), data.location.model.sync(location)])
        }}
      >
        Refresh providers
      </button>
      <button type="button" disabled={props.harness.providerPending() < 2} onClick={props.harness.resolveProviders}>
        Resolve providers
      </button>
    </div>
  )
}

function Fixture() {
  const scenario = new URLSearchParams(window.location.search).get("scenario")
  const harness = createHarness(scenario)
  return (
    <Switch fallback={<p>Unknown scenario</p>}>
      <Match when={scenario === "server"}>
        <ServerScenario harness={harness} />
      </Match>
      <Match when={scenario === "controller"}>
        <ControllerScenario harness={harness} />
      </Match>
      <Match when={scenario === "connect"}>
        <ConnectScenario harness={harness} />
      </Match>
      <Match when={scenario === "company"}>
        <CompanyScenario harness={harness} />
      </Match>
      <Match when={scenario === "company-mismatch"}>
        <CompanyScenario harness={harness} />
      </Match>
      <Match when={scenario === "settings"}>
        <SettingsScenario harness={harness} />
      </Match>
      <Match when={scenario === "settings-layout"}>
        <SettingsLayoutScenario harness={harness} />
      </Match>
      <Match when={scenario === "settings-v2-layout"}>
        <SettingsLayoutScenario harness={harness} v2 />
      </Match>
      <Match when={scenario === "composer-enterprise-empty"}>
        <ComposerScenario harness={harness} enterprise />
      </Match>
      <Match when={scenario === "composer-ordinary-empty"}>
        <ComposerScenario harness={harness} enterprise={false} />
      </Match>
      <Match when={scenario === "composer-web-empty"}>
        <ComposerScenario harness={harness} enterprise={false} web branding />
      </Match>
      <Match when={scenario === "branding-desktop"}>
        <ComposerScenario harness={harness} enterprise={false} branding />
      </Match>
      <Match when={scenario === "guide"}>
        <GuideScenario harness={harness} />
      </Match>
      <Match when={scenario === "error-enterprise"}>
        <ErrorScenario harness={harness} enterprise />
      </Match>
      <Match when={scenario === "error-public"}>
        <ErrorScenario harness={harness} enterprise={false} />
      </Match>
    </Switch>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing fixture root")
render(
  () => (
    <ErrorBoundary fallback={(error) => <pre data-testid="fixture-error">{String(error)}</pre>}>
      <Fixture />
    </ErrorBoundary>
  ),
  root,
)
