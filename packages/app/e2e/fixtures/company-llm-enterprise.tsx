import "@/index.css"
import { type BaseRouterProps, MemoryRouter, Route, createMemoryHistory, useLocation } from "@solidjs/router"
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/solid-query"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import {
  type Component,
  createSignal,
  ErrorBoundary,
  type JSX,
  Match,
  onMount,
  type ParentProps,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { AppBaseProviders, AppInterface } from "@/app"
import { DialogCompanyProvider, useCompanyProviderSettingsState } from "@/components/dialog-company-provider"
import { DialogConnectProvider } from "@/components/dialog-connect-provider"
import { useServerManagementController } from "@/components/dialog-select-server"
import { SettingsProviders } from "@/components/settings-providers"
import { SettingsProvidersV2 } from "@/components/settings-v2/providers"
import { WindowsAppMenu } from "@/components/windows-app-menu"
import { CommandProvider, useCommand } from "@/context/command"
import { DesktopCommands } from "@/desktop-commands"
import { GlobalProvider } from "@/context/global"
import { LanguageProvider } from "@/context/language"
import { type EnterpriseProviderCatalogView, type Platform, PlatformProvider, usePlatform } from "@/context/platform"
import { ServerConnection, ServerProvider, useServer } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TabsProvider, useTabs } from "@/context/tabs"
import { setV2Toast, ToastRegion } from "@/utils/toast"
import { useServerHealth } from "@/utils/server-health"

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
  "# Kernexa AI 사용 가이드",
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
type ProviderUpdateInput = CredentialInput & { name: string; clearCredentials: boolean }
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
              name: "Company LLM",
              baseURL: "https://llm.company.test/v1",
              models: [{ id: "company-code", name: "Company Code" }],
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
        setObservations(
          "storageWrites",
          untrack(() => observations.storageWrites.length),
          { name, key, value },
        )
        values.set(key, value)
      },
      removeItem: async (key: string) => {
        setObservations(
          "storageWrites",
          untrack(() => observations.storageWrites.length),
          { name, key, value: null },
        )
        values.delete(key)
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
        directory: "global",
        payload: { id: "fixture-connected", type: "server.connected", properties: {} },
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

    if (url.pathname === "/global/health") return json({ healthy: true, version: "test" })
    if (url.pathname === "/global/config") {
      return json({ $schema: "https://opencode.ai/config.json" })
    }
    if (url.pathname === "/provider") {
      if (scenario === "composer-enterprise-empty" && providerResponses.empty) {
        return json({ all: [], connected: [], default: {} })
      }
      if (scenario === "composer-enterprise-empty" && providerResponses.deferred) {
        return new Promise<Response>((resolve) => {
          providerResponses.pending.push(resolve)
          setProviderPending(providerResponses.pending.length)
        })
      }
      if (
        !scenario?.startsWith("company") &&
        scenario !== "connect" &&
        scenario !== "settings" &&
        scenario !== "composer-enterprise-empty"
      ) {
        return json({ all: [], connected: [], default: {} })
      }
      const model = (providerID: string, id: string, name: string, url: string) => ({
        id,
        providerID,
        name,
        api: { id, url, npm: "@ai-sdk/openai-compatible" },
        status: "active",
      })
      return json({
        all: [
          {
            id: "company-llm",
            name: "Company LLM",
            source: "config",
            env: [],
            options: {},
            models: {
              "company-code": model("company-llm", "company-code", "Company Code", "https://llm.company.test/v1"),
              ...(scenario === "company-mismatch"
                ? {
                    "pending-model": model(
                      "company-llm",
                      "pending-model",
                      "Pending Model",
                      "https://pending.company.test/v1",
                    ),
                  }
                : {}),
            },
          },
          {
            id: "company-llm-2",
            name: "Company Reasoning",
            source: "config",
            env: [],
            options: {},
            models: {
              "company-reasoning": model(
                "company-llm-2",
                "company-reasoning",
                "Company Reasoning",
                "https://reasoning.company.test/v1",
              ),
            },
          },
        ],
        connected: scenario === "composer-enterprise-empty" ? ["company-llm"] : [],
        default: { "company-llm": "company-code", "company-llm-2": "company-reasoning" },
      })
    }
    if (url.pathname === "/path") {
      return json({
        home: "/home",
        state: "/state",
        config: "/config",
        worktree: "/repo",
        directory: "/repo",
      })
    }
    if (url.pathname === "/session") return json([])
    if (url.pathname === "/agent") {
      return json([
        {
          name: "build",
          mode: "primary",
          model:
            scenario === "composer-enterprise-empty"
              ? { providerID: "company-llm", modelID: "company-code" }
              : undefined,
        },
      ])
    }
    if (url.pathname === "/config") return json({})
    if (url.pathname === "/session/status") return json({})
    if (url.pathname === "/project/current") return json({ id: "project", worktree: "/repo" })
    if (url.pathname === "/vcs") return json(null)
    if (url.pathname === "/api/reference") return json({ data: [] })
    if (url.pathname === "/permission" || url.pathname === "/question" || url.pathname === "/command") {
      return json([])
    }
    if (url.pathname === "/mcp") return json({})
    if (url.pathname === "/experimental/resource" || url.pathname === "/lsp") return json([])
    if (url.pathname === "/project") return json([])
    if (/^\/provider\/[^/]+\/diagnostics$/.test(url.pathname)) {
      if (behavior.diagnosticOutcome === "network-error") {
        throw new Error("transport failure with private detail")
      }
      const value = await new Promise<unknown>((resolve) => {
        diagnostic.resolve = resolve
        setDiagnosticPending(true)
      })
      diagnostic.resolve = undefined
      setDiagnosticPending(false)
      return json(value)
    }
    if (url.pathname === "/global/event") {
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
    openLink(url) {
      setObservations("externalLinks", observations.externalLinks.length, url)
    },
    async restart() {
      setObservations("restartSnapshots", observations.restartSnapshots.length, [
        inputValue("API key"),
        inputValue("Secret header"),
        inputValue("Secret value"),
      ])
    },
    back() {},
    forward() {},
    async notify() {},
    async openDirectoryPickerDialog() {
      return null
    },
    async getDefaultServer() {
      return ServerConnection.key(remote)
    },
    async setDefaultServer(key) {
      setObservations("defaultWrites", observations.defaultWrites.length, key)
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
          name: input.name,
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
                name: input.name,
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
      async updateModel(input) {
        const provider = catalogState.value.providers.find((item) => item.id === input.providerID)
        if (provider)
          provider.models = provider.models.map((model) =>
            model.id === input.modelID ? { ...model, name: input.name } : model,
          )
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
        return { version: "kernexa-1", markdown: GUIDE_MARKDOWN }
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
      const response = json({ all: [], connected: [], default: {} })
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

function QueryProvider(props: ParentProps) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, refetchOnMount: false, refetchOnWindowFocus: false } },
        })
      }
    >
      {props.children}
    </QueryClientProvider>
  )
}

function ServerTree(props: ParentProps<{ harness: Harness; platform?: Platform }>) {
  return (
    <PlatformProvider value={props.platform ?? props.harness.platform}>
      <LanguageProvider locale="en">
        <QueryProvider>
          <MemoryRouter history={props.harness.history}>
            <Route
              path="*"
              component={() => (
                <ServerProvider
                  defaultServer={ServerConnection.key(props.harness.remote)}
                  servers={[props.harness.sidecar, props.harness.remote]}
                >
                  <GlobalProvider>{props.children}</GlobalProvider>
                </ServerProvider>
              )}
            />
          </MemoryRouter>
        </QueryProvider>
      </LanguageProvider>
    </PlatformProvider>
  )
}

function DialogTree(props: ParentProps<{ harness: Harness }>) {
  return (
    <ServerTree harness={props.harness}>
      <DialogProvider>
        <ServerSDKProvider>
          <ServerSyncProvider>{props.children}</ServerSyncProvider>
        </ServerSDKProvider>
      </DialogProvider>
    </ServerTree>
  )
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
  const server = useServer()
  useServerHealth(
    () => server.list,
    () => true,
  )
  return (
    <>
      <output data-testid="server-list">{server.list.map(ServerConnection.key).join(",")}</output>
      <output data-testid="active-server">{server.key}</output>
      <Observations harness={props.harness} />
    </>
  )
}

function ServerScenario(props: { harness: Harness }) {
  return (
    <PlatformProvider value={props.harness.platform}>
      <ServerProvider
        defaultServer={ServerConnection.key(props.harness.remote)}
        servers={[props.harness.sidecar, props.harness.remote]}
      >
        <HealthConsumer harness={props.harness} />
      </ServerProvider>
    </PlatformProvider>
  )
}

function ControllerConsumer(props: { harness: Harness }) {
  const [operations, setOperations] = createStore<Record<string, string>>({})
  const [closeCalls, setCloseCalls] = createSignal(0)
  const controller = useServerManagementController({ onSelect: () => setCloseCalls((value) => value + 1) })
  const server = useServer()
  const settings = useSettings()
  const tabs = useTabs()
  const location = useLocation()
  const invoke = (name: string, action: () => unknown) => {
    setOperations(name, "pending")
    void Promise.resolve()
      .then(action)
      .then(
        () => setOperations(name, "resolved"),
        (error: unknown) => setOperations(name, error instanceof Error ? error.message : String(error)),
      )
  }

  return (
    <>
      <div data-testid="controller-controls">
        <button
          type="button"
          disabled={!settings.ready() || !tabs.ready()}
          onClick={() => invoke("add", controller.startAdd)}
        >
          Invoke add
        </button>
        <button
          type="button"
          disabled={!settings.ready() || !tabs.ready()}
          onClick={() => invoke("select", () => controller.select(props.harness.remote, true))}
        >
          Invoke select
        </button>
        <button
          type="button"
          disabled={!settings.ready() || !tabs.ready()}
          onClick={() => invoke("remove", () => controller.handleRemove(ServerConnection.key(props.harness.remote)))}
        >
          Invoke remove
        </button>
        <button
          type="button"
          disabled={!settings.ready() || !tabs.ready()}
          onClick={() => invoke("default", () => controller.setDefault(ServerConnection.key(props.harness.remote)))}
        >
          Invoke default
        </button>
      </div>
      <output data-testid="controller-ready">{String(settings.ready() && tabs.ready())}</output>
      <output data-testid="controller-results">{JSON.stringify(operations)}</output>
      <output data-testid="controller-location">{location.pathname}</output>
      <output data-testid="controller-active">{server.key}</output>
      <output data-testid="controller-close-calls">{closeCalls()}</output>
      <Observations harness={props.harness} />
      <ToastRegion v2={false} />
    </>
  )
}

function ControllerScenario(props: { harness: Harness }) {
  return (
    <ServerTree harness={props.harness}>
      <SettingsProvider>
        <TabsProvider>
          <ControllerConsumer harness={props.harness} />
        </TabsProvider>
      </SettingsProvider>
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
      <WindowsAppMenu command={command} platform={platform} variant="v2" />
    </div>
  )
}

function CompanyGuideTree(props: ParentProps<{ harness: Harness; platform?: Platform }>) {
  return (
    <ServerTree harness={props.harness} platform={props.platform}>
      <DialogProvider>
        <ServerSDKProvider>
          <ServerSyncProvider>
            <SettingsProvider>
              <CommandProvider>
                <MarkedProvider>
                  <DesktopCommands />
                  {props.children}
                </MarkedProvider>
              </CommandProvider>
            </SettingsProvider>
          </ServerSyncProvider>
        </ServerSDKProvider>
      </DialogProvider>
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
  setV2Toast(true)
  const company = useCompanyProviderSettingsState()
  return (
    <>
      <button type="button" disabled={company.checking()} onClick={company.testConnection}>
        {company.checking() ? "Testing settings connection" : "Settings test connection"}
      </button>
      <output data-testid="settings-credential-status">{company.status()}</output>
      <ToastRegion v2 />
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
      <Show when={props.v2} fallback={<SettingsProviders />}>
        <SettingsProvidersV2 />
      </Show>
    </DialogTree>
  )
}

function ComposerScenario(props: { harness: Harness; enterprise: boolean }) {
  const Router: Component<BaseRouterProps> = (routerProps) => (
    <MemoryRouter history={props.harness.history} root={routerProps.root} base={routerProps.base}>
      {routerProps.children}
    </MemoryRouter>
  )
  const platform = props.enterprise ? props.harness.platform : { ...props.harness.platform, enterprise: undefined }
  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale="en">
        <AppInterface
          router={Router}
          defaultServer={ServerConnection.key(props.harness.sidecar)}
          canonicalLocalServer={ServerConnection.key(props.harness.sidecar)}
          servers={[props.harness.sidecar]}
          disableHealthCheck
          serverScoped={<ComposerControls harness={props.harness} />}
        />
        <Observations harness={props.harness} />
      </AppBaseProviders>
    </PlatformProvider>
  )
}

function ComposerControls(props: { harness: Harness }) {
  const queryClient = useQueryClient()
  return (
    <div class="fixed left-2 top-2 z-[10000]">
      <button
        type="button"
        onClick={() => {
          props.harness.refreshProviders()
          void queryClient.invalidateQueries({
            predicate: (query) => query.queryKey[2] === "providers",
          })
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
