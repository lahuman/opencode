import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"

type CompanyConfig = {
  provider?: Record<
    string,
    {
      options?: { baseURL?: unknown; [key: string]: unknown }
      models?: Record<string, { name?: string }>
    }
  >
}

export type CompanyProviderDiagnosticResult = {
  ok: boolean
  checks: {
    basic: "pass" | "fail" | "skipped"
    streaming: "pass" | "fail" | "skipped"
    toolCall: "pass" | "fail" | "skipped"
  }
  failure?: { kind: string; message: string }
}

type CompanyProviderAction = "save" | "clear" | "diagnose" | undefined
type CredentialMutationResult = { restartRequired: boolean }

export const COMPANY_PROVIDER_FAILURE_MESSAGE = "Company LLM connection test failed. Check the server and try again."

export function companyProviderCredentialInput(apiKey: string, headers: { key: string; value: string }[]) {
  const values = new Map<string, readonly [string, string]>()
  headers.forEach((header) => {
    const key = header.key.trim()
    const value = header.value.trim()
    if (!key || !value) return
    values.set(key.toLowerCase(), [key, value])
  })
  const entries = Object.fromEntries([...values.values()])
  const secret = apiKey.trim()
  return {
    ...(secret ? { apiKey: secret } : {}),
    ...(Object.keys(entries).length ? { headers: entries } : {}),
  }
}

export function companyProviderModels(config: CompanyConfig) {
  return Object.entries(config.provider?.["company-llm"]?.models ?? {}).map(([id, model]) => ({
    id,
    name: model.name ?? id,
  }))
}

export function companyProviderConfig(config: CompanyConfig) {
  const baseURL = config.provider?.["company-llm"]?.options?.baseURL
  return {
    baseURL: typeof baseURL === "string" ? baseURL : "",
    models: companyProviderModels(config),
  }
}

export function companyProviderCanStart(action: CompanyProviderAction, ready: boolean) {
  return action === undefined && ready
}

export function companyProviderShouldRestart(result?: CredentialMutationResult) {
  return result?.restartRequired === true
}

export function companyProviderCredentialStatus(
  status: { loading: boolean; configured?: boolean; error?: unknown },
  failureMessage: string,
) {
  if (status.loading) return "Checking credentials..."
  if (status.error) return failureMessage
  return status.configured ? "Credentials configured" : "Credentials not configured"
}

export async function applyCompanyProviderCredentialMutation(input: {
  mutation: () => Promise<CredentialMutationResult>
  clearLocal: () => void
  restart: () => Promise<void>
}) {
  const result = await input.mutation()
  input.clearLocal()
  if (companyProviderShouldRestart(result)) await input.restart()
  return result
}

export function diagnoseCompanyProvider<T>(
  diagnose: (input: { providerID: string; modelID: string; checkToolCall: boolean }) => T,
  modelID: string,
) {
  return diagnose({ providerID: "company-llm", modelID, checkToolCall: true })
}

export function companyProviderDiagnosticResult(
  result: CompanyProviderDiagnosticResult | undefined,
  failureMessage: string,
) {
  return (
    result ?? {
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: { kind: "connection", message: failureMessage },
    }
  )
}

export function useCompanyProviderSettingsState() {
  const platform = usePlatform()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const config = createMemo(() => companyProviderConfig(serverSync().data.config))
  const [checking, setChecking] = createSignal(false)
  const [status, statusActions] = createResource(
    () => platform.enterprise,
    (enterprise) => enterprise.credentialStatus(),
  )

  const testConnection = async () => {
    const model = config().models[0]
    if (!companyProviderCanStart(checking() ? "diagnose" : undefined, Boolean(model))) return
    setChecking(true)
    const response = await diagnoseCompanyProvider((input) => serverSDK().client.provider.diagnose(input), model.id)
      .then((value) => value.data)
      .catch(() => undefined)
    const result = companyProviderDiagnosticResult(response, language.t("common.requestFailed"))
    setChecking(false)
    if (result.ok) {
      showToast({
        variant: "success",
        icon: "circle-check",
        title: "Company LLM connection succeeded",
        description: model.name,
      })
      return
    }
    showToast({
      variant: "error",
      title: COMPANY_PROVIDER_FAILURE_MESSAGE,
      description: result.failure?.message ?? "connection",
    })
  }

  const statusLabel = () => {
    return companyProviderCredentialStatus(
      { loading: status.loading, error: status.error, configured: status.latest?.configured },
      language.t("common.requestFailed"),
    )
  }

  return {
    config,
    checking,
    status: statusLabel,
    refreshStatus: statusActions.refetch,
    testConnection,
  }
}

export function DialogCompanyProvider(props: { onBack?: () => void }) {
  const dialog = useDialog()
  const platform = usePlatform()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [apiKey, setApiKey] = createSignal("")
  const [headers, setHeaders] = createStore([{ key: "", value: "" }])
  const config = createMemo(() => companyProviderConfig(serverSync().data.config))
  const [modelID, setModelID] = createSignal(config().models[0]?.id ?? "")
  const [action, setAction] = createSignal<CompanyProviderAction>()
  const [result, setResult] = createSignal<CompanyProviderDiagnosticResult>()
  const [error, setError] = createSignal<string>()
  const [status, statusActions] = createResource(
    () => platform.enterprise,
    (enterprise) => enterprise.credentialStatus(),
  )

  createEffect(() => {
    if (config().models.some((model) => model.id === modelID())) return
    setModelID(config().models[0]?.id ?? "")
  })

  const resetSecrets = () => {
    setApiKey("")
    setHeaders([{ key: "", value: "" }])
  }

  const mutateCredentials = async (
    nextAction: Exclude<CompanyProviderAction, "diagnose" | undefined>,
    mutation: () => Promise<CredentialMutationResult>,
    configured: boolean,
  ) => {
    if (!companyProviderCanStart(action(), true)) return
    setAction(nextAction)
    setError()
    const response = await applyCompanyProviderCredentialMutation({
      mutation,
      clearLocal: resetSecrets,
      restart: () => platform.restart(),
    }).then(
      (value) => ({ value }),
      () => ({ error: true as const }),
    )
    if ("error" in response) {
      setError(language.t("common.requestFailed"))
      setAction()
      return
    }

    statusActions.mutate({ configured })
    setAction()
  }

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    const enterprise = platform.enterprise
    if (!enterprise) return
    const input = companyProviderCredentialInput(apiKey(), headers)
    if (!companyProviderCanStart(action(), Object.keys(input).length > 0)) return
    await mutateCredentials("save", () => enterprise.setCredentials(input), true)
  }

  const clear = async () => {
    const enterprise = platform.enterprise
    if (!enterprise || !status.latest?.configured) return
    await mutateCredentials("clear", () => enterprise.clearCredentials(), false)
  }

  const diagnose = async () => {
    if (!companyProviderCanStart(action(), Boolean(modelID()))) return
    setResult()
    setAction("diagnose")
    setError()
    const response = await diagnoseCompanyProvider((input) => serverSDK().client.provider.diagnose(input), modelID())
      .then((value) => value.data)
      .catch(() => undefined)
    setResult(companyProviderDiagnosticResult(response, language.t("common.requestFailed")))
    setAction()
  }

  const statusLabel = () => {
    return companyProviderCredentialStatus(
      { loading: status.loading, error: status.error, configured: status.latest?.configured },
      language.t("common.requestFailed"),
    )
  }

  const selectedModel = createMemo(() => config().models.find((model) => model.id === modelID()))
  const input = createMemo(() => companyProviderCredentialInput(apiKey(), headers))
  const diagnosticStatus = () => {
    if (action() === "diagnose") return "Testing Company LLM connection"
    if (!result()) return "Ready to test Company LLM connection"
    if (result()?.ok) return "Company LLM connection test completed successfully"
    return ""
  }

  return (
    <Dialog title="Company LLM">
      <form class="flex min-w-0 flex-col gap-4 px-4 pb-4" onSubmit={save}>
        <div class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField label="Base URL" value={config().baseURL} disabled />
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="text-12-medium text-text-weak">Model</label>
            <Select
              class="min-w-0"
              options={config().models}
              current={selectedModel()}
              value={(model) => model.id}
              label={(model) => model.name}
              placeholder="No configured models"
              triggerProps={{ "aria-label": "Company LLM model" }}
              onSelect={(model) => setModelID(model?.id ?? "")}
            />
          </div>
        </div>

        <div class="flex items-center justify-between gap-3 text-12-regular">
          <span class="text-text-weak">Credential status</span>
          <span class="text-text-strong" role="status" aria-live="polite" aria-atomic="true">
            {statusLabel()}
          </span>
        </div>

        <TextField
          label="API key"
          type="password"
          autocomplete="off"
          value={apiKey()}
          disabled={action() !== undefined}
          onChange={setApiKey}
        />

        <div class="flex min-w-0 flex-col gap-2">
          <div class="flex items-center justify-between gap-3">
            <span class="text-12-medium text-text-weak">Secret headers</span>
            <Tooltip value="Add secret header" placement="top">
              <IconButton
                type="button"
                icon="plus-small"
                variant="ghost"
                aria-label="Add secret header"
                disabled={action() !== undefined}
                onClick={() => setHeaders(headers.length, { key: "", value: "" })}
              />
            </Tooltip>
          </div>
          <For each={headers}>
            {(header, index) => (
              <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-start gap-2">
                <TextField
                  label="Secret header"
                  hideLabel
                  placeholder="Header name"
                  autocomplete="off"
                  value={header.key}
                  disabled={action() !== undefined}
                  onChange={(value) => setHeaders(index(), "key", value)}
                />
                <TextField
                  label="Secret value"
                  hideLabel
                  type="password"
                  placeholder="Secret value"
                  autocomplete="off"
                  value={header.value}
                  disabled={action() !== undefined}
                  onChange={(value) => setHeaders(index(), "value", value)}
                />
                <Tooltip value="Remove secret header" placement="top">
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    aria-label="Remove secret header"
                    disabled={action() !== undefined || headers.length === 1}
                    onClick={() => setHeaders((rows) => rows.filter((_, row) => row !== index()))}
                  />
                </Tooltip>
              </div>
            )}
          </For>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={!Object.keys(input()).length || action() !== undefined}>
            {action() === "save" ? language.t("common.saving") : language.t("common.save")}
          </Button>
          <Button type="button" variant="secondary" disabled={action() !== undefined || !modelID()} onClick={diagnose}>
            {action() === "diagnose" ? "Testing..." : "Test connection"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={action() !== undefined || !status.latest?.configured}
            onClick={clear}
          >
            {action() === "clear" ? "Clearing..." : "Clear credentials"}
          </Button>
          <Button type="button" variant="ghost" disabled={action() !== undefined} onClick={props.onBack ?? dialog.close}>
            {language.t("common.cancel")}
          </Button>
        </div>

        <span
          class="sr-only"
          data-slot="company-diagnostic-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {diagnosticStatus()}
        </span>

        <Show when={error()}>
          {(message) => (
            <p class="text-12-regular text-text-danger-base" role="alert">
              {message()}
            </p>
          )}
        </Show>

        <Show when={result()}>
          {(diagnostic) => (
            <div
              data-slot="company-diagnostic-result"
              class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 border-t border-border-weak-base pt-3 text-12-regular"
              role={diagnostic().ok ? undefined : "alert"}
              aria-atomic="true"
            >
              <span class="text-text-weak">Basic response</span>
              <span class="text-text-strong capitalize">{diagnostic().checks.basic}</span>
              <span class="text-text-weak">Streaming</span>
              <span class="text-text-strong capitalize">{diagnostic().checks.streaming}</span>
              <span class="text-text-weak">Tool calling</span>
              <span class="text-text-strong capitalize">{diagnostic().checks.toolCall}</span>
              <Show when={diagnostic().failure}>
                {(failure) => (
                  <>
                    <span class="text-text-weak">Failure ({failure().kind})</span>
                    <span class="max-w-72 text-right text-text-strong">{failure().message}</span>
                  </>
                )}
              </Show>
            </div>
          )}
        </Show>
      </form>
    </Dialog>
  )
}
