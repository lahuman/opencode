import "@/index.css"
import { MemoryRouter, Route, createMemoryHistory, useLocation } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { DialogProvider, useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal, ErrorBoundary, type JSX, Match, onMount, type ParentProps, Switch } from "solid-js"
import { render } from "solid-js/web"
import { createStore } from "solid-js/store"
import { DialogCompanyProvider } from "@/components/dialog-company-provider"
import { DialogConnectProvider } from "@/components/dialog-connect-provider"
import { useServerManagementController } from "@/components/dialog-select-server"
import { GlobalProvider } from "@/context/global"
import { LanguageProvider } from "@/context/language"
import { type Platform, PlatformProvider } from "@/context/platform"
import { ServerConnection, ServerProvider, useServer } from "@/context/server"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TabsProvider, useTabs } from "@/context/tabs"
import { ToastRegion } from "@/utils/toast"
import { useServerHealth } from "@/utils/server-health"

const DIAGNOSTIC_SUCCESS = {
  ok: true,
  checks: { basic: "pass", streaming: "pass", toolCall: "pass" },
} as const
const DIAGNOSTIC_FAILURE = {
  ok: false,
  checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
  failure: { kind: "connection", message: "private server detail" },
} as const

type RequestRecord = { host: string; method: string; path: string; body?: unknown }
type CredentialInput = { apiKey?: string; headers?: Record<string, string> }
type CredentialMode = "restart" | "no-restart" | "error"
type DiagnosticOutcome = "success" | "failure"

function createHarness() {
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
      new Map([
        [
          "server",
          JSON.stringify({ list: [remote], projects: {}, lastProject: {}, recentlyClosed: {} }),
        ],
      ]),
    ],
  ])
  const [observations, setObservations] = createStore({
    requests: [] as RequestRecord[],
    storageWrites: [] as Array<{ name: string; key: string; value: string | null }>,
    credentialInputs: [] as CredentialInput[],
    defaultWrites: [] as Array<ServerConnection.Key | null>,
    restartSnapshots: [] as string[][],
  })
  const [diagnosticPending, setDiagnosticPending] = createSignal(false)
  const behavior = {
    configured: false,
    credentialMode: "restart" as CredentialMode,
    diagnosticOutcome: "success" as DiagnosticOutcome,
  }
  const diagnostic = { resolve: undefined as ((value: unknown) => void) | undefined }
  const history = createMemoryHistory()
  history.set({ value: "/", scroll: false, replace: true })

  const storage = (name = "default.dat") => {
    const values = stores.get(name) ?? new Map<string, string>()
    stores.set(name, values)
    return {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        setObservations("storageWrites", observations.storageWrites.length, { name, key, value })
        values.set(key, value)
      },
      removeItem: async (key: string) => {
        setObservations("storageWrites", observations.storageWrites.length, { name, key, value: null })
        values.delete(key)
      },
    }
  }

  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })
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
      host: url.host,
      method: request.method,
      path: url.pathname,
      body,
    })

    if (url.pathname === "/global/health") return json({ healthy: true, version: "test" })
    if (url.pathname === "/global/config") {
      return json({
        provider: {
          "company-llm": {
            options: { baseURL: "https://llm.company.test/v1" },
            models: { "company-code": { name: "Company Code" } },
          },
        },
      })
    }
    if (url.pathname === "/provider") return json({ all: [], connected: [], default: {} })
    if (url.pathname === "/path") {
      return json({
        home: "/home",
        state: "/state",
        config: "/config",
        worktree: "/repo",
        directory: "/repo",
      })
    }
    if (url.pathname === "/project") return json([])
    if (url.pathname === "/provider/company-llm/diagnostics") {
      const value = await new Promise<unknown>((resolve) => {
        diagnostic.resolve = resolve
        setDiagnosticPending(true)
      })
      diagnostic.resolve = undefined
      setDiagnosticPending(false)
      return json(value)
    }
    if (url.pathname === "/global/event") {
      return new Promise<Response>((_resolve, reject) => {
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
    openLink() {},
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
      async credentialStatus() {
        return { configured: behavior.configured }
      },
      async setCredentials(input) {
        setObservations("credentialInputs", observations.credentialInputs.length, input)
        if (behavior.credentialMode === "error") throw new Error("secure storage failed")
        behavior.configured = true
        return { restartRequired: behavior.credentialMode === "restart" }
      },
      async clearCredentials() {
        behavior.configured = false
        return { restartRequired: behavior.credentialMode === "restart" }
      },
    },
  }

  return {
    behavior,
    diagnosticPending,
    history,
    observations,
    platform,
    remote,
    resolveDiagnostic() {
      diagnostic.resolve?.(behavior.diagnosticOutcome === "success" ? DIAGNOSTIC_SUCCESS : DIAGNOSTIC_FAILURE)
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

function ServerTree(props: ParentProps<{ harness: Harness }>) {
  return (
    <PlatformProvider value={props.harness.platform}>
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
      <output data-testid="default-writes">{JSON.stringify(props.harness.observations.defaultWrites)}</output>
      <output data-testid="restart-snapshots">{JSON.stringify(props.harness.observations.restartSnapshots)}</output>
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
        <button type="button" disabled={!settings.ready() || !tabs.ready()} onClick={() => invoke("add", controller.startAdd)}>
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
        <button type="button" onClick={() => (props.harness.behavior.diagnosticOutcome = "success")}>
          Diagnostic success
        </button>
        <button type="button" onClick={() => (props.harness.behavior.diagnosticOutcome = "failure")}>
          Diagnostic failure
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

function Fixture() {
  const harness = createHarness()
  const scenario = new URLSearchParams(window.location.search).get("scenario")
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
