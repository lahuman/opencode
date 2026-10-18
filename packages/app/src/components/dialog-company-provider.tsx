import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { EnterpriseDialog, EnterpriseField } from "@/providers/enterprise/presentation"
import { IconButton } from "@opencode/ui/icon-button"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform, type EnterpriseProviderCatalogView } from "@/runtime/platform/platform"
import { useServerSDK } from "@/runtime/server/client"
import { showToast } from "@/shell/notifications/toast"
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import {
  applyEnterpriseProviderUpdate,
  COMPANY_PROVIDER_FAILURE_MESSAGE,
  enterpriseProviderMessageKey,
  companyProviderCanStart,
  companyProviderDiagnosticResult,
  diagnoseCompanyProvider,
  enterpriseDeleteConfirmation,
  enterpriseProviderFailureKey,
  enterpriseProviderPresentation,
  providerCredentialIntent,
  validateEnterpriseProviderForm,
  type CompanyProviderAction,
  type CompanyProviderDiagnosticResult,
  type EnterpriseDeleteConfirmation,
  type ProviderCredentialMode,
} from "./dialog-company-provider-state"

export function useCompanyProviderSettingsState() {
  const platform = usePlatform()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [catalog, catalogActions] = createResource(
    () => platform.enterprise,
    (enterprise) => enterprise?.providerCatalog(),
  )
  const providers = createMemo(() => catalog.latest?.providers ?? [])
  const defaultProvider = createMemo(() =>
    providers().find((provider) => provider.id === catalog.latest?.default?.providerID),
  )
  const defaultModel = createMemo(() =>
    defaultProvider()?.models.find((model) => model.id === catalog.latest?.default?.modelID),
  )
  const [checking, setChecking] = createSignal(false)

  const testConnection = async () => {
    const provider = defaultProvider()
    const model = defaultModel()
    if (!companyProviderCanStart(checking() ? "diagnose" : undefined, Boolean(provider && model))) return
    if (!provider || !model) return
    setChecking(true)
    const response = await diagnoseCompanyProvider(
      (input) => serverSDK.api.provider.diagnose(input),
      provider.id,
      model.id,
    )
      .then((value) => value.data)
      .catch(() => undefined)
    const result = companyProviderDiagnosticResult(response, language.t("common.requestFailed"))
    setChecking(false)
    if (result.ok) {
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("enterprise.provider.copy.enterpriseProviderConnectionSucceeded"),
        description: `${provider.id} / ${model.id}`,
      })
      return
    }
    showToast({
      variant: "error",
      title: language.t(enterpriseProviderMessageKey(COMPANY_PROVIDER_FAILURE_MESSAGE)),
      description: result.failure?.message ?? "connection",
    })
  }

  const status = () => {
    if (catalog.loading) return language.t("enterprise.provider.copy.loadingProviders")
    if (catalog.error) return language.t("common.requestFailed")
    const provider = defaultProvider()
    if (!provider) return language.t("enterprise.provider.copy.noDefaultModel")
    return provider.credentials.configured
      ? language.t("enterprise.provider.copy.credentialsConfigured")
      : language.t("enterprise.provider.copy.credentialsNotConfigured")
  }

  return {
    catalog,
    providers,
    defaultProvider,
    defaultModel,
    checking,
    status,
    refreshStatus: catalogActions.refetch,
    testConnection,
  }
}

type ProviderEditor = "create-provider" | "edit-provider" | "create-model" | undefined

export function DialogCompanyProvider(props: { onBack?: () => void }) {
  const dialog = useDialog()
  const platform = usePlatform()
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const [catalog, catalogActions] = createResource(
    () => platform.enterprise,
    (enterprise) => enterprise?.providerCatalog(),
  )
  const [state, setState] = createStore({
    selectedProviderID: "",
    selectedModelID: "",
    editor: undefined as ProviderEditor,
    action: undefined as CompanyProviderAction,
    confirm: undefined as EnterpriseDeleteConfirmation | undefined,
    error: undefined as string | undefined,
    result: undefined as CompanyProviderDiagnosticResult | undefined,
  })
  const [providerForm, setProviderForm] = createStore({
    providerID: "",
    baseURL: "",
    models: [] as { id: string }[],
    credentialMode: "preserve" as ProviderCredentialMode,
    apiKey: "",
    headers: [{ key: "", value: "" }],
  })
  const [modelForm, setModelForm] = createStore({ id: "" })
  let confirmationTrigger: HTMLElement | undefined
  let confirmationButton: HTMLButtonElement | undefined
  const [readinessProvider, setReadinessProvider] = createSignal<{
    providerID: string
    modelID: string
    result: CompanyProviderDiagnosticResult
  }>()
  const [readiness] = createResource(
    () => {
      const value = readinessProvider()
      return value && value.providerID === state.selectedProviderID && value.modelID === state.selectedModelID
        ? { enterprise: platform.enterprise, result: value.result }
        : false
    },
    (input) => input.enterprise?.readiness(input.result),
  )
  const providers = createMemo(() => catalog.latest?.providers ?? [])
  const selectedProvider = createMemo(() => providers().find((provider) => provider.id === state.selectedProviderID))
  const selectedModel = createMemo(() => selectedProvider()?.models.find((model) => model.id === state.selectedModelID))

  createEffect(() => {
    const value = catalog.latest
    if (!value) return
    const provider = value.providers.find((item) => item.id === state.selectedProviderID)
    if (!provider) {
      const next = value.providers.find((item) => item.id === value.default?.providerID) ?? value.providers[0]
      setState({ selectedProviderID: next?.id ?? "", selectedModelID: defaultModelID(value, next?.id) })
      return
    }
    if (provider.models.some((model) => model.id === state.selectedModelID)) return
    setState("selectedModelID", defaultModelID(value, provider.id))
  })

  const resetSecrets = () => {
    setProviderForm("credentialMode", "preserve")
    setProviderForm("apiKey", "")
    setProviderForm("headers", [{ key: "", value: "" }])
  }
  const clearTransient = () => {
    resetSecrets()
    setState("result", undefined)
    setState("error", undefined)
    setReadinessProvider(undefined)
  }
  const selectProvider = (providerID: string) => {
    if (state.action !== undefined || providerID === state.selectedProviderID) return
    clearTransient()
    setState("editor", undefined)
    setState("confirm", undefined)
    setState("selectedProviderID", providerID)
    setState("selectedModelID", defaultModelID(catalog.latest, providerID))
  }
  const selectModel = (modelID: string) => {
    if (state.action !== undefined || modelID === state.selectedModelID) return
    clearTransient()
    setState("editor", undefined)
    setState("confirm", undefined)
    setState("selectedModelID", modelID)
  }

  const beginProviderEditor = (mode: "create" | "edit") => {
    const provider = selectedProvider()
    clearTransient()
    setState("confirm", undefined)
    setState("editor", mode === "create" ? "create-provider" : "edit-provider")
    setProviderForm({
      providerID: mode === "edit" ? (provider?.id ?? "") : "",
      baseURL: mode === "edit" ? (provider?.baseURL ?? "") : "",
      models: mode === "edit" ? (provider?.models.map((model) => ({ ...model })) ?? []) : [],
      credentialMode: mode === "create" ? "replace" : "preserve",
      apiKey: "",
      headers: [{ key: "", value: "" }],
    })
  }
  const beginModelEditor = () => {
    setState("error", undefined)
    setState("confirm", undefined)
    setState("editor", "create-model")
    setModelForm({ id: "" })
  }

  const mutate = async (
    action: Exclude<CompanyProviderAction, undefined>,
    mutation: () => Promise<EnterpriseProviderCatalogView>,
  ) => {
    if (state.action !== undefined) return false
    setState("action", action)
    setState("error", undefined)
    const result = await mutation().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    setState("action", undefined)
    if ("error" in result) {
      resetSecrets()
      setState("error", language.t(enterpriseProviderFailureKey(result.error)))
      return false
    }
    catalogActions.mutate(result.value)
    return true
  }

  const saveProvider = async (event: SubmitEvent) => {
    event.preventDefault()
    const enterprise = platform.enterprise
    if (!enterprise) return
    const mode =
      state.editor === "edit-provider"
        ? ({ type: "edit", providerID: state.selectedProviderID } as const)
        : ({ type: "create" } as const)
    const value = validateEnterpriseProviderForm({
      mode,
      providerID: providerForm.providerID,
      baseURL: providerForm.baseURL,
      models: providerForm.models,
      existingProviderIDs: new Set(providers().map((provider) => provider.id)),
    })
    if (value.error) {
      setState("error", language.t(enterpriseProviderMessageKey(value.error)))
      return
    }
    const credentials = providerCredentialIntent(providerForm.credentialMode, providerForm.apiKey, providerForm.headers)
    if ("error" in credentials && credentials.error) {
      setState("error", language.t(enterpriseProviderMessageKey(credentials.error)))
      return
    }
    const replacement =
      credentials.mode === "replace" && "credentials" in credentials ? credentials.credentials : undefined
    const created = mode.type === "create"
    const complete = await mutate("save", () => {
      if (created) {
        return enterprise.createProvider({
          provider: { id: value.providerID, baseURL: value.baseURL, models: value.models },
          ...(replacement ? { credentials: replacement } : {}),
        })
      }
      return applyEnterpriseProviderUpdate({
        providerID: value.providerID,
        baseURL: value.baseURL,
        credentials: replacement
          ? { mode: "replace", credentials: replacement }
          : credentials.mode === "clear"
            ? { mode: "clear" }
            : { mode: "preserve" },
        updateProvider: (input) => enterprise.updateProvider(input),
        mutate: catalogActions.mutate,
      })
    })
    if (!complete) return
    setState({ selectedProviderID: value.providerID, editor: undefined, confirm: undefined })
    resetSecrets()
  }

  const saveModel = async (event: SubmitEvent) => {
    event.preventDefault()
    const enterprise = platform.enterprise
    const provider = selectedProvider()
    if (!enterprise || !provider) return
    const modelID = modelForm.id.trim()
    const duplicate = provider.models.some(
      (model) => model.id.toLowerCase() === modelID.toLowerCase(),
    )
    if (!modelID || duplicate) {
      setState(
        "error",
        duplicate
          ? language.t("enterprise.provider.copy.modelIDAlreadyExists")
          : language.t("enterprise.provider.copy.modelIDIsRequired"),
      )
      return
    }
    const complete = await mutate("save", () =>
      enterprise.createModel({ providerID: provider.id, model: { id: modelID } }),
    )
    if (!complete) return
    setState({ selectedModelID: modelID, editor: undefined })
  }

  const setDefault = async () => {
    const enterprise = platform.enterprise
    const provider = selectedProvider()
    const model = selectedModel()
    if (!enterprise || !provider || !model) return
    await mutate("default", () => enterprise.setDefaultModel({ providerID: provider.id, modelID: model.id }))
  }
  const confirmDelete = async () => {
    const enterprise = platform.enterprise
    const target = state.confirm
    if (!enterprise || !target) return
    const complete = await mutate("delete", () =>
      target.type === "provider"
        ? enterprise.deleteProvider(target.providerID)
        : enterprise.deleteModel({ providerID: target.providerID, modelID: target.modelID }),
    )
    if (!complete) return
    setState({ confirm: undefined, editor: undefined })
    queueMicrotask(() => {
      if (confirmationTrigger?.isConnected) confirmationTrigger.focus()
    })
  }
  const requestDelete = (target: EnterpriseDeleteConfirmation, trigger: HTMLElement) => {
    confirmationTrigger = trigger
    setState("confirm", target)
    queueMicrotask(() => confirmationButton?.focus())
  }
  const cancelDelete = () => {
    setState("confirm", undefined)
    queueMicrotask(() => confirmationTrigger?.focus())
  }
  const diagnose = async () => {
    const provider = selectedProvider()
    const model = selectedModel()
    if (!provider || !model || !companyProviderCanStart(state.action, true)) return
    const providerID = provider.id
    const modelID = model.id
    setState({ action: "diagnose", result: undefined, error: undefined })
    const response = await diagnoseCompanyProvider(
      (input) => serverSDK.api.provider.diagnose(input),
      providerID,
      modelID,
    )
      .then((value) => value.data)
      .catch(() => undefined)
    setState("action", undefined)
    if (state.selectedProviderID !== providerID || state.selectedModelID !== modelID) return
    const result = companyProviderDiagnosticResult(response, language.t("common.requestFailed"))
    setState("result", result)
    setReadinessProvider({ providerID, modelID, result })
  }

  const pairLabel = () => {
    const provider = selectedProvider()
    const model = selectedModel()
    if (!provider || !model) return language.t("enterprise.provider.copy.enterpriseProvider")
    return `${provider.id} / ${model.id}`
  }
  const diagnosticStatus = () => {
    if (state.action === "diagnose")
      return language.t("enterprise.provider.copy.testingConnection", { pair: pairLabel() })
    if (!state.result)
      return selectedModel()
        ? language.t("enterprise.provider.copy.readyToTestConnection", { pair: pairLabel() })
        : language.t("enterprise.provider.copy.selectAModelToTest")
    if (state.result.ok) return language.t("enterprise.provider.copy.connectionCompleted", { pair: pairLabel() })
    return ""
  }
  const pending = () => state.action !== undefined
  const locked = () => pending() || state.confirm !== undefined

  return (
    <EnterpriseDialog
      title={language.t("enterprise.provider.copy.enterpriseProviders")}
      size="large"
      class="w-full max-w-[980px]"
      preventClose={locked()}
    >
      <div class="flex max-h-[min(720px,calc(100vh-96px))] min-w-0 flex-col gap-4 overflow-y-auto px-4 pb-4">
        <Show when={catalog.error}>
          <p
            class="rounded-md border border-border-danger-base px-3 py-2 text-12-regular text-text-danger-base"
            role="alert"
          >
            {language.t("enterprise.provider.copy.providerSettingsCouldNotBeLoadedRestartTheDesktopAppAndTryAgain")}
          </p>
        </Show>
        <Show when={state.error}>
          {(message) => (
            <div
              class="flex items-center justify-between gap-3 rounded-md border border-border-danger-base px-3 py-2"
              role="alert"
            >
              <span class="text-12-regular text-text-danger-base">{message()}</span>
              <Button
                type="button"
                size="small"
                variant="ghost"
                disabled={locked()}
                onClick={() => {
                  resetSecrets()
                  setState("error", undefined)
                }}
              >
                {language.t("enterprise.provider.copy.dismissError")}
              </Button>
            </div>
          )}
        </Show>

        <div class="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.25fr)]">
          <section
            class="flex min-w-0 flex-col gap-2"
            aria-label={language.t("enterprise.provider.copy.enterpriseProviders")}
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-12-medium text-text-weak">{language.t("enterprise.provider.copy.providers")}</span>
              <Button
                type="button"
                size="small"
                variant="outline"
                disabled={locked()}
                onClick={() => beginProviderEditor("create")}
              >
                {language.t("enterprise.provider.copy.createProvider")}
              </Button>
            </div>
            <Show
              when={!catalog.loading}
              fallback={
                <span class="text-12-regular text-text-weak">
                  {language.t("enterprise.provider.copy.loadingProviders")}
                </span>
              }
            >
              <For
                each={providers()}
                fallback={
                  <span class="py-4 text-12-regular text-text-weak">
                    {language.t("enterprise.provider.copy.noEnterpriseProvidersConfigured")}
                  </span>
                }
              >
                {(provider) => {
                  const presentation = () => enterpriseProviderPresentation(catalog.latest!, provider)
                  return (
                    <button
                      type="button"
                      data-testid={`enterprise-provider-${provider.id}`}
                      aria-pressed={provider.id === state.selectedProviderID}
                      class="flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2 text-left"
                      classList={{
                        "border-border-focus bg-surface-raised-base": provider.id === state.selectedProviderID,
                        "border-border-weak-base bg-surface-base": provider.id !== state.selectedProviderID,
                      }}
                      disabled={locked()}
                      onClick={() => selectProvider(provider.id)}
                    >
                      <span class="flex min-w-0 items-center justify-between gap-2">
                        <span class="truncate text-13-medium text-text-strong">{provider.id}</span>
                        <Show when={presentation().isDefaultProvider}>
                          <span class="rounded bg-surface-info-base/20 px-1.5 py-0.5 text-10-medium text-text-strong">
                            {language.t("enterprise.provider.copy.default")}
                          </span>
                        </Show>
                      </span>
                      <span class="break-all text-11-regular text-text-weak">{provider.baseURL}</span>
                      <span class="text-11-regular text-text-weak">
                        {language.plural("enterprise.provider.modelCount", provider.models.length)}
                      </span>
                      <span class="text-11-medium text-text-strong">
                        {language.t(enterpriseProviderMessageKey(presentation().credentials))}
                      </span>
                      <Show when={presentation().defaultModel}>
                        {(model) => (
                          <span class="text-11-regular text-text-weak">
                            {language.t("enterprise.provider.copy.defaultModel", { model: model() })}
                          </span>
                        )}
                      </Show>
                    </button>
                  )
                }}
              </For>
            </Show>
          </section>

          <section
            class="flex min-w-0 flex-col gap-4"
            aria-label={language.t("enterprise.provider.copy.providerDetails")}
          >
            <Show when={state.editor === "create-provider" || state.editor === "edit-provider"}>
              <form class="flex min-w-0 flex-col gap-3" onSubmit={saveProvider}>
                <h3 class="text-14-medium text-text-strong">
                  {state.editor === "create-provider"
                    ? language.t("enterprise.provider.copy.createProvider")
                    : language.t("enterprise.provider.copy.editProvider")}
                </h3>
                <EnterpriseField
                  label={language.t("enterprise.provider.copy.providerID")}
                  value={providerForm.providerID}
                  disabled={locked() || state.editor === "edit-provider"}
                  onChange={(value) => setProviderForm("providerID", value)}
                />
                <EnterpriseField
                  label={language.t("enterprise.provider.copy.baseURL")}
                  value={providerForm.baseURL}
                  disabled={locked()}
                  onChange={(value) => setProviderForm("baseURL", value)}
                />
                <div class="flex min-w-0 flex-col gap-2">
                  <span class="text-12-medium text-text-weak">{language.t("enterprise.provider.copy.models")}</span>
                  <For
                    each={providerForm.models}
                    fallback={
                      <span class="text-11-regular text-text-weak">
                        {language.t("enterprise.provider.copy.thisProviderHasZeroModels")}
                      </span>
                    }
                  >
                    {(model, index) => (
                      <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_32px] items-start gap-2">
                        <EnterpriseField
                          label={language.t("enterprise.provider.copy.modelIDOrdinal", { ordinal: index() + 1 })}
                          value={model.id}
                          disabled={locked() || state.editor === "edit-provider"}
                          onChange={(value) => setProviderForm("models", index(), "id", value)}
                        />
                        <Tooltip value={language.t("enterprise.provider.copy.removeInitialModel")} placement="top">
                          <IconButton
                            type="button"
                            icon={<Icon name="trash" />}
                            variant="ghost"
                            class="mt-1.5"
                            aria-label={language.t("enterprise.provider.copy.removeInitialModel")}
                            disabled={locked() || state.editor === "edit-provider"}
                            onClick={() =>
                              setProviderForm("models", (models) => models.filter((_, row) => row !== index()))
                            }
                          />
                        </Tooltip>
                      </div>
                    )}
                  </For>
                  <Show when={state.editor === "create-provider"}>
                    <Button
                      type="button"
                      size="small"
                      variant="ghost"
                      disabled={locked()}
                      onClick={() => setProviderForm("models", providerForm.models.length, { id: "" })}
                    >
                      {language.t("enterprise.provider.copy.addInitialModel")}
                    </Button>
                  </Show>
                </div>
                <label class="flex min-w-0 flex-col gap-1 text-12-medium text-text-weak">
                  {language.t("enterprise.provider.copy.credentialAction")}
                  <select
                    class="h-8 rounded-md border border-border-weak-base bg-surface-base px-2 text-13-regular text-text-strong"
                    value={providerForm.credentialMode}
                    disabled={locked()}
                    onChange={(event) => {
                      resetSecrets()
                      const value = event.currentTarget.value
                      setProviderForm(
                        "credentialMode",
                        value === "replace" ? "replace" : value === "clear" ? "clear" : "preserve",
                      )
                    }}
                  >
                    <option value="preserve">{language.t("enterprise.provider.copy.preserveCredentials")}</option>
                    <option value="replace">{language.t("enterprise.provider.copy.replaceCredentials")}</option>
                    <option value="clear">{language.t("enterprise.provider.copy.clearCredentials")}</option>
                  </select>
                </label>
                <Show when={providerForm.credentialMode === "replace"}>
                  <EnterpriseField
                    label={language.t("enterprise.provider.copy.apiKey")}
                    type="password"
                    autocomplete="off"
                    value={providerForm.apiKey}
                    disabled={locked()}
                    onChange={(value) => setProviderForm("apiKey", value)}
                  />
                  <div class="flex min-w-0 flex-col gap-2">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-12-medium text-text-weak">
                        {language.t("enterprise.provider.copy.secretHeaders")}
                      </span>
                      <IconButton
                        type="button"
                        icon={<Icon name="plus-small" />}
                        variant="ghost"
                        aria-label={language.t("enterprise.provider.copy.addSecretHeader")}
                        disabled={locked()}
                        onClick={() => setProviderForm("headers", providerForm.headers.length, { key: "", value: "" })}
                      />
                    </div>
                    <For each={providerForm.headers}>
                      {(header, index) => (
                        <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-start gap-2">
                          <EnterpriseField
                            label={language.t("enterprise.provider.copy.secretHeader")}
                            hideLabel
                            placeholder={language.t("enterprise.provider.copy.headerName")}
                            autocomplete="off"
                            value={header.key}
                            disabled={locked()}
                            onChange={(value) => setProviderForm("headers", index(), "key", value)}
                          />
                          <EnterpriseField
                            label={language.t("enterprise.provider.copy.secretValue")}
                            hideLabel
                            type="password"
                            placeholder={language.t("enterprise.provider.copy.secretValue")}
                            autocomplete="off"
                            value={header.value}
                            disabled={locked()}
                            onChange={(value) => setProviderForm("headers", index(), "value", value)}
                          />
                          <IconButton
                            type="button"
                            icon={<Icon name="trash" />}
                            variant="ghost"
                            class="mt-1.5"
                            aria-label={language.t("enterprise.provider.copy.removeSecretHeader")}
                            disabled={locked() || providerForm.headers.length === 1}
                            onClick={() =>
                              setProviderForm("headers", (headers) => headers.filter((_, row) => row !== index()))
                            }
                          />
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <div class="flex flex-wrap gap-2">
                  <Button type="submit" variant="neutral" disabled={locked()}>
                    {state.action === "save"
                      ? language.t("enterprise.provider.copy.saving")
                      : language.t("enterprise.provider.copy.saveProvider")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={locked()}
                    onClick={() => {
                      resetSecrets()
                      setState("editor", undefined)
                    }}
                  >
                    {language.t("enterprise.provider.copy.cancelEdit")}
                  </Button>
                </div>
              </form>
            </Show>

            <Show when={state.editor === "create-model"}>
              <form class="flex min-w-0 flex-col gap-3" onSubmit={saveModel}>
                <h3 class="text-14-medium text-text-strong">
                  {language.t("enterprise.provider.copy.addModel")}
                </h3>
                <EnterpriseField
                  label={language.t("enterprise.provider.copy.modelID")}
                  value={modelForm.id}
                  disabled={locked()}
                  onChange={(value) => setModelForm("id", value)}
                />
                <div class="flex flex-wrap gap-2">
                  <Button type="submit" variant="neutral" disabled={locked()}>
                    {state.action === "save"
                      ? language.t("enterprise.provider.copy.saving")
                      : language.t("enterprise.provider.copy.saveModel")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={locked()}
                    onClick={() => setState("editor", undefined)}
                  >
                    {language.t("enterprise.provider.copy.cancelEdit")}
                  </Button>
                </div>
              </form>
            </Show>

            <Show when={!state.editor && selectedProvider()}>
              {(provider) => (
                <div class="flex min-w-0 flex-col gap-4">
                  <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0">
                      <h3 class="truncate text-14-medium text-text-strong">{provider().id}</h3>
                      <p class="break-all text-12-regular text-text-weak">{provider().baseURL}</p>
                      <p class="text-12-regular text-text-weak" role="status">
                        {language.t(
                          enterpriseProviderMessageKey(
                            enterpriseProviderPresentation(catalog.latest!, provider()).credentials,
                          ),
                        )}
                      </p>
                      <Show when={provider().credentials.headerNames.length}>
                        <p class="text-11-regular text-text-weak">
                          {language.t("enterprise.provider.copy.configuredHeaders", {
                            headers: provider().credentials.headerNames.join(", "),
                          })}
                        </p>
                      </Show>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="small"
                        variant="outline"
                        disabled={locked()}
                        onClick={() => beginProviderEditor("edit")}
                      >
                        {language.t("enterprise.provider.copy.editProvider")}
                      </Button>
                      <Button
                        type="button"
                        size="small"
                        variant="outline"
                        disabled={locked()}
                        onClick={(event: MouseEvent & { currentTarget: HTMLButtonElement }) =>
                          requestDelete(enterpriseDeleteConfirmation("provider", provider().id), event.currentTarget)
                        }
                      >
                        {language.t("enterprise.provider.copy.deleteProvider")}
                      </Button>
                    </div>
                  </div>

                  <div class="flex min-w-0 flex-col gap-2">
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-12-medium text-text-weak">{language.t("enterprise.provider.copy.models")}</span>
                      <Button
                        type="button"
                        size="small"
                        variant="outline"
                        disabled={locked()}
                        onClick={beginModelEditor}
                      >
                        {language.t("enterprise.provider.copy.addModel")}
                      </Button>
                    </div>
                    <For
                      each={provider().models}
                      fallback={
                        <span class="py-3 text-12-regular text-text-weak">
                          {language.t("enterprise.provider.copy.noModelsConfigured")}
                        </span>
                      }
                    >
                      {(model) => (
                        <button
                          type="button"
                          data-testid={`enterprise-model-${provider().id}-${model.id}`}
                          aria-pressed={model.id === state.selectedModelID}
                          class="flex min-w-0 items-center justify-between gap-2 rounded-md border px-3 py-2 text-left"
                          classList={{
                            "border-border-focus bg-surface-raised-base": model.id === state.selectedModelID,
                            "border-border-weak-base bg-surface-base": model.id !== state.selectedModelID,
                          }}
                          disabled={locked()}
                          onClick={() => selectModel(model.id)}
                        >
                          <span class="min-w-0">
                            <span class="block truncate text-13-medium text-text-strong">{model.id}</span>
                          </span>
                          <Show
                            when={
                              catalog.latest?.default?.providerID === provider().id &&
                              catalog.latest?.default?.modelID === model.id
                            }
                          >
                            <span class="rounded bg-surface-info-base/20 px-1.5 py-0.5 text-10-medium text-text-strong">
                              {language.t("enterprise.provider.copy.default")}
                            </span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>

                  <div class="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        locked() ||
                        !selectedModel() ||
                        (catalog.latest?.default?.providerID === provider().id &&
                          catalog.latest?.default?.modelID === selectedModel()?.id)
                      }
                      onClick={setDefault}
                    >
                      {language.t("enterprise.provider.copy.setDefault")}
                    </Button>
                    <Button type="button" variant="outline" disabled={locked() || !selectedModel()} onClick={diagnose}>
                      {state.action === "diagnose"
                        ? language.t("enterprise.provider.copy.testing")
                        : language.t("enterprise.provider.copy.testConnection")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={locked() || !selectedModel()}
                      onClick={(event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
                        const model = selectedModel()
                        if (model)
                          requestDelete(
                            enterpriseDeleteConfirmation("model", provider().id, model.id),
                            event.currentTarget,
                          )
                      }}
                    >
                      {language.t("enterprise.provider.copy.deleteModel")}
                    </Button>
                  </div>
                </div>
              )}
            </Show>
          </section>
        </div>

        <Show when={state.confirm}>
          {(target) => {
            const value = target()
            const name = value.type === "provider" ? value.providerID : value.modelID
            return (
              <div
                class="rounded-md border border-border-danger-base px-3 py-3"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="enterprise-delete-title"
                aria-describedby="enterprise-delete-description"
                onKeyDown={containConfirmationFocus}
              >
                <h3 id="enterprise-delete-title" class="text-13-medium text-text-strong">
                  {language.t(
                    value.type === "provider"
                      ? "enterprise.provider.copy.deleteProviderNamed"
                      : "enterprise.provider.copy.deleteModelNamed",
                    { name },
                  )}
                </h3>
                <p id="enterprise-delete-description" class="mt-1 text-12-regular text-text-strong">
                  {value.type === "provider"
                    ? language.t("enterprise.provider.copy.allModelsAndCredentialsForThisProviderWillBeRemoved")
                    : language.t("enterprise.provider.copy.conversationHistoryRemainsAvailable")}
                </p>
                <div class="mt-2 flex gap-2">
                  <Button
                    ref={(element: HTMLButtonElement) => {
                      confirmationButton = element
                    }}
                    type="button"
                    size="small"
                    variant="neutral"
                    disabled={pending()}
                    onClick={confirmDelete}
                  >
                    Confirm delete {value.type}
                  </Button>
                  <Button type="button" size="small" variant="ghost" disabled={pending()} onClick={cancelDelete}>
                    {language.t("enterprise.provider.copy.cancelDelete")}
                  </Button>
                </div>
              </div>
            )
          }}
        </Show>

        <span class="sr-only" data-slot="company-diagnostic-status" role="status" aria-live="polite" aria-atomic="true">
          {diagnosticStatus()}
        </span>
        <Show when={state.result}>
          {(diagnostic) => (
            <div
              data-slot="company-diagnostic-result"
              class="grid min-w-0 grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-border-weak-base pt-3 text-12-regular sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-4"
              role={diagnostic().ok ? undefined : "alert"}
              aria-atomic="true"
            >
              <span class="min-w-0 break-words text-text-weak">
                {language.t("enterprise.provider.copy.providerModel")}
              </span>
              <span class="min-w-0 break-words text-right text-text-strong">{pairLabel()}</span>
              <span class="min-w-0 break-words text-text-weak">
                {language.t("enterprise.provider.copy.basicResponse")}
              </span>
              <span class="min-w-0 break-words text-right text-text-strong capitalize">
                {diagnostic().checks.basic}
              </span>
              <span class="min-w-0 break-words text-text-weak">{language.t("enterprise.provider.copy.streaming")}</span>
              <span class="min-w-0 break-words text-right text-text-strong capitalize">
                {diagnostic().checks.streaming}
              </span>
              <span class="min-w-0 break-words text-text-weak">
                {language.t("enterprise.provider.copy.toolCalling")}
              </span>
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
        <Show
          when={
            readinessProvider()?.providerID === state.selectedProviderID &&
            readinessProvider()?.modelID === state.selectedModelID
              ? readiness.latest
              : undefined
          }
        >
          {(report) => (
            <details class="border-t border-border-weak-base pt-3 text-12-regular">
              <summary class="cursor-pointer text-text-strong capitalize" tabIndex={state.confirm ? -1 : undefined}>
                {language.t("enterprise.provider.copy.offlineReadiness", { status: report().overall })}
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
        <div class="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            disabled={locked()}
            onClick={() => {
              resetSecrets()
              if (props.onBack) {
                props.onBack()
                return
              }
              dialog.close()
            }}
          >
            {language.t("common.close")}
          </Button>
        </div>
      </div>
    </EnterpriseDialog>
  )
}

function containConfirmationFocus(event: KeyboardEvent & { currentTarget: HTMLDivElement }) {
  if (event.key !== "Tab") return
  const controls = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((control) => control.tabIndex >= 0)
  if (!controls.length) return
  const current = controls.indexOf(document.activeElement as HTMLElement)
  const next = event.shiftKey
    ? controls[(current <= 0 ? controls.length : current) - 1]
    : controls[(current + 1) % controls.length]
  event.preventDefault()
  next.focus()
}

function defaultModelID(catalog: EnterpriseProviderCatalogView | undefined, providerID: string | undefined) {
  const provider = catalog?.providers.find((item) => item.id === providerID)
  if (!provider) return ""
  if (
    catalog?.default?.providerID === provider.id &&
    provider.models.some((model) => model.id === catalog.default?.modelID)
  )
    return catalog.default.modelID
  return provider.models[0]?.id ?? ""
}
