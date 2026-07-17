import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  applyCompanyProviderCredentialMutation,
  COMPANY_PROVIDER_FAILURE_MESSAGE,
  companyProviderCanStart,
  companyProviderCredentialInput,
  companyProviderCredentialModels,
  companyProviderDiagnosticResult,
  companyProviderModelCredentialStatus,
  diagnoseCompanyProvider,
  type CompanyProviderAction,
  type CompanyProviderDiagnosticResult,
  type CredentialMutationResult,
} from "./dialog-company-provider-state"

export function useCompanyProviderSettingsState() {
  const platform = usePlatform()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [catalog, catalogActions] = createResource(
    () => platform.enterprise,
    (enterprise) => enterprise?.credentialCatalog(),
  )
  const models = createMemo(() => {
    if (!catalog.latest || !serverSync().data.ready) return []
    return companyProviderCredentialModels(serverSync().data.provider.all.get("company-llm"), catalog.latest)
  })
  const defaultModel = createMemo(
    () => models().find((model) => model.isDefault) ?? models().find((model) => model.synchronized),
  )
  const [checking, setChecking] = createSignal(false)
  const testConnection = async () => {
    const model = defaultModel()
    if (!companyProviderCanStart(checking() ? "diagnose" : undefined, Boolean(model?.synchronized))) return
    if (!model) return
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
    if (catalog.loading || !serverSync().data.ready) return "Checking credentials..."
    if (catalog.error) return language.t("common.requestFailed")
    const model = defaultModel()
    if (!model) return "Credentials not configured"
    return companyProviderModelCredentialStatus(model, language.t("common.requestFailed"))
  }

  return {
    models,
    defaultModel,
    checking,
    status: statusLabel,
    refreshStatus: catalogActions.refetch,
    testConnection,
  }
}

export function DialogCompanyProvider(props: { onBack?: () => void }) {
  const dialog = useDialog()
  const platform = usePlatform()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [catalog, catalogActions] = createResource(
    () => platform.enterprise,
    (enterprise) => enterprise?.credentialCatalog(),
  )
  const models = createMemo(() => {
    if (!catalog.latest || !serverSync().data.ready) return []
    return companyProviderCredentialModels(serverSync().data.provider.all.get("company-llm"), catalog.latest)
  })
  const [state, setState] = createStore({
    apiKey: "",
    headers: [{ key: "", value: "" }],
    modelID: "",
    action: undefined as CompanyProviderAction,
    result: undefined as CompanyProviderDiagnosticResult | undefined,
    error: undefined as string | undefined,
  })
  const [readinessProvider, setReadinessProvider] = createSignal<{
    modelID: string
    result: CompanyProviderDiagnosticResult
  }>()
  const [readiness] = createResource(
    () => {
      const provider = readinessProvider()
      if (!provider || provider.modelID !== state.modelID) return
      return { enterprise: platform.enterprise, provider: provider.result }
    },
    (input) => input.enterprise?.readiness(input.provider),
  )

  createEffect(() => {
    if (models().some((model) => model.id === state.modelID)) return
    setState(
      "modelID",
      models().find((model) => model.isDefault)?.id ?? models().find((model) => model.synchronized)?.id ?? "",
    )
  })

  const resetSecrets = () => {
    setState("apiKey", "")
    setState("headers", [{ key: "", value: "" }])
  }

  const selectModel = (modelID: string) => {
    if (modelID === state.modelID) return
    resetSecrets()
    setState("result", undefined)
    setState("error", undefined)
    setReadinessProvider(undefined)
    setState("modelID", modelID)
  }

  const mutateCredentials = async (
    nextAction: Exclude<CompanyProviderAction, "diagnose" | undefined>,
    mutation: () => Promise<CredentialMutationResult>,
  ) => {
    if (!companyProviderCanStart(state.action, true)) return
    setState("action", nextAction)
    setState("error", undefined)
    const response = await applyCompanyProviderCredentialMutation({
      mutation,
      clearLocal: resetSecrets,
      restart: () => platform.restart(),
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({
        error:
          error instanceof Error && error.message.includes("Enterprise credential model is not configured")
            ? ("catalog" as const)
            : ("request" as const),
      }),
    )
    if ("error" in response) {
      setState(
        "error",
        response.error === "catalog"
          ? "The model catalog changed. Restart the desktop app before configuring credentials."
          : language.t("common.requestFailed"),
      )
      setState("action", undefined)
      return
    }

    await catalogActions.refetch()
    setState("action", undefined)
  }

  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    const enterprise = platform.enterprise
    if (!enterprise) return
    if (!selectedModel()?.synchronized) return
    const input = companyProviderCredentialInput(state.apiKey, state.headers)
    if (!companyProviderCanStart(state.action, Object.keys(input).length > 0)) return
    await mutateCredentials("save", () => enterprise.setCredentials({ modelID: state.modelID, ...input }))
  }

  const clear = async () => {
    const enterprise = platform.enterprise
    if (!enterprise || !selectedModel()?.synchronized || !selectedModel()?.credentialStatus?.configured) return
    await mutateCredentials("clear", () => enterprise.clearCredentials(state.modelID))
  }

  const diagnose = async () => {
    if (!companyProviderCanStart(state.action, Boolean(selectedModel()?.synchronized))) return
    const modelID = state.modelID
    setState("result", undefined)
    setState("action", "diagnose")
    setState("error", undefined)
    const response = await diagnoseCompanyProvider(
      (input) => serverSDK().client.provider.diagnose(input),
      state.modelID,
    )
      .then((value) => value.data)
      .catch(() => undefined)
    if (state.modelID !== modelID) {
      setState("action", undefined)
      return
    }
    const result = companyProviderDiagnosticResult(response, language.t("common.requestFailed"))
    setState("result", result)
    setReadinessProvider({ modelID, result })
    setState("action", undefined)
  }

  const statusLabel = () => {
    if (catalog.loading || !serverSync().data.ready) return "Checking credentials..."
    if (catalog.error) return language.t("common.requestFailed")
    const model = selectedModel()
    if (!model) return "Credentials not configured"
    return companyProviderModelCredentialStatus(model, language.t("common.requestFailed"))
  }

  const selectedModel = createMemo(() => models().find((model) => model.id === state.modelID))
  const editorDisabled = () => state.action !== undefined || !selectedModel()?.synchronized
  const input = createMemo(() => companyProviderCredentialInput(state.apiKey, state.headers))
  const diagnosticStatus = () => {
    if (state.action === "diagnose") return "Testing Company LLM connection"
    if (!state.result) return "Ready to test Company LLM connection"
    if (state.result.ok) return "Company LLM connection test completed successfully"
    return ""
  }

  return (
    <Dialog title="Company LLM" size="large" class="w-full max-w-[900px]">
      <form class="flex min-w-0 flex-col gap-4 px-4 pb-4" onSubmit={save}>
        <Show when={catalog.error}>
          <p
            class="rounded-md border border-border-danger-base px-3 py-2 text-12-regular text-text-danger-base"
            role="alert"
          >
            Credential settings could not be loaded. Restart the desktop app and try again.
          </p>
        </Show>
        <Show when={models().some((model) => !model.synchronized)}>
          <p
            class="rounded-md border border-border-warning-base bg-surface-warning-strong/10 px-3 py-2 text-12-regular text-text-strong"
            role="alert"
          >
            The desktop and server model catalogs differ. Restart the desktop app before configuring affected models.
          </p>
        </Show>

        <div class="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)]">
          <div class="flex min-w-0 flex-col gap-2" aria-label="Enterprise models">
            <span class="text-12-medium text-text-weak">Models</span>
            <Show
              when={!catalog.loading && serverSync().data.ready}
              fallback={<span class="text-12-regular text-text-weak">Loading models...</span>}
            >
              <For each={models()} fallback={<span class="text-12-regular text-text-weak">No configured models</span>}>
                {(model) => (
                  <button
                    type="button"
                    data-testid={`company-model-${model.id}`}
                    aria-pressed={model.id === state.modelID}
                    class="flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2 text-left"
                    classList={{
                      "border-border-focus bg-surface-raised-base": model.id === state.modelID,
                      "border-border-weak-base bg-surface-base": model.id !== state.modelID,
                    }}
                    disabled={state.action !== undefined}
                    onClick={() => selectModel(model.id)}
                  >
                    <span class="flex min-w-0 items-center justify-between gap-2">
                      <span class="truncate text-13-medium text-text-strong">{model.name}</span>
                      <Show when={model.isDefault}>
                        <span class="rounded bg-surface-info-base/20 px-1.5 py-0.5 text-10-medium text-text-strong">
                          Default
                        </span>
                      </Show>
                    </span>
                    <span class="truncate text-11-regular text-text-weak">{model.id}</span>
                    <span class="break-all text-11-regular text-text-weak">{model.baseURL}</span>
                    <span class="text-11-medium text-text-strong">
                      {companyProviderModelCredentialStatus(model, language.t("common.requestFailed"))}
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>

          <div class="flex min-w-0 flex-col gap-4">
            <TextField label="Base URL" value={selectedModel()?.baseURL ?? ""} disabled />

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
              value={state.apiKey}
              disabled={editorDisabled()}
              onChange={(value) => setState("apiKey", value)}
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
                    disabled={editorDisabled()}
                    onClick={() => setState("headers", state.headers.length, { key: "", value: "" })}
                  />
                </Tooltip>
              </div>
              <For each={state.headers}>
                {(header, index) => (
                  <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-start gap-2">
                    <TextField
                      label="Secret header"
                      hideLabel
                      placeholder="Header name"
                      autocomplete="off"
                      value={header.key}
                      disabled={editorDisabled()}
                      onChange={(value) => setState("headers", index(), "key", value)}
                    />
                    <TextField
                      label="Secret value"
                      hideLabel
                      type="password"
                      placeholder="Secret value"
                      autocomplete="off"
                      value={header.value}
                      disabled={editorDisabled()}
                      onChange={(value) => setState("headers", index(), "value", value)}
                    />
                    <Tooltip value="Remove secret header" placement="top">
                      <IconButton
                        type="button"
                        icon="trash"
                        variant="ghost"
                        class="mt-1.5"
                        aria-label="Remove secret header"
                        disabled={editorDisabled() || state.headers.length === 1}
                        onClick={() => setState("headers", (rows) => rows.filter((_, row) => row !== index()))}
                      />
                    </Tooltip>
                  </div>
                )}
              </For>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" disabled={!Object.keys(input()).length || editorDisabled()}>
                {state.action === "save" ? language.t("common.saving") : language.t("common.save")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={editorDisabled() || !state.modelID}
                onClick={diagnose}
              >
                {state.action === "diagnose" ? "Testing..." : "Test connection"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={editorDisabled() || !selectedModel()?.credentialStatus?.configured}
                onClick={clear}
              >
                {state.action === "clear" ? "Clearing..." : "Clear credentials"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={state.action !== undefined}
                onClick={props.onBack ?? dialog.close}
              >
                {language.t("common.cancel")}
              </Button>
            </div>
          </div>
        </div>

        <span class="sr-only" data-slot="company-diagnostic-status" role="status" aria-live="polite" aria-atomic="true">
          {diagnosticStatus()}
        </span>

        <Show when={state.error}>
          {(message) => (
            <p class="text-12-regular text-text-danger-base" role="alert">
              {message()}
            </p>
          )}
        </Show>

        <Show when={state.result}>
          {(diagnostic) => (
            <div
              data-slot="company-diagnostic-result"
              class="grid min-w-0 grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-border-weak-base pt-3 text-12-regular sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4"
              role={diagnostic().ok ? undefined : "alert"}
              aria-atomic="true"
            >
              <span class="min-w-0 break-words text-text-weak">Basic response</span>
              <span class="min-w-0 break-words text-right text-text-strong capitalize">
                {diagnostic().checks.basic}
              </span>
              <span class="min-w-0 break-words text-text-weak">Streaming</span>
              <span class="min-w-0 break-words text-right text-text-strong capitalize">
                {diagnostic().checks.streaming}
              </span>
              <span class="min-w-0 break-words text-text-weak">Tool calling</span>
              <span class="min-w-0 break-words text-right text-text-strong capitalize">
                {diagnostic().checks.toolCall}
              </span>
              <Show when={diagnostic().failure}>
                {(failure) => (
                  <>
                    <span class="min-w-0 break-words text-text-weak">Failure ({failure().kind})</span>
                    <span class="min-w-0 max-w-72 break-words text-right text-text-strong">{failure().message}</span>
                  </>
                )}
              </Show>
            </div>
          )}
        </Show>

        <Show when={readinessProvider()?.modelID === state.modelID ? readiness.latest : undefined}>
          {(report) => (
            <details class="border-t border-border-weak-base pt-3 text-12-regular">
              <summary class="cursor-pointer text-text-strong capitalize">
                Offline readiness: {report().overall}
              </summary>
              <div class="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2">
                <For each={report().checks}>
                  {(check) => (
                    <>
                      <span class="min-w-0 break-words text-text-weak">{check.message}</span>
                      <span class="min-w-0 break-words text-right text-text-strong capitalize">{check.status}</span>
                    </>
                  )}
                </For>
              </div>
            </details>
          )}
        </Show>
      </form>
    </Dialog>
  )
}
