import type {
  CredentialReplacement,
  EnterpriseProvider,
  EnterpriseProviderCatalogView,
  EnterpriseProviderModel,
} from "@/context/platform"

export type CompanyProviderDiagnosticResult = {
  ok: boolean
  checks: {
    basic: "pass" | "fail" | "skipped"
    streaming: "pass" | "fail" | "skipped"
    toolCall: "pass" | "fail" | "skipped"
  }
  failure?: { kind: string; message: string }
}

export type CompanyProviderAction = "save" | "clear" | "diagnose" | "delete" | "default" | undefined

export type EnterpriseProviderFormMode = { type: "create" } | { type: "edit"; providerID: string }
export type EnterpriseProviderFormInput = {
  mode: EnterpriseProviderFormMode
  providerID: string
  name: string
  baseURL: string
  models: EnterpriseProviderModel[]
  existingProviderIDs: Set<string>
}
export type EnterpriseProviderFormResult = {
  providerID: string
  name: string
  baseURL: string
  models: EnterpriseProviderModel[]
  error?: string
}
export type ProviderCredentialMode = "preserve" | "replace" | "clear"
export type ProviderCredentialIntent =
  | { mode: "preserve" }
  | { mode: "clear" }
  | { mode: "replace"; credentials: CredentialReplacement; error?: undefined }
  | { mode: "replace"; error: string; credentials?: undefined }
export type EnterpriseDeleteConfirmation =
  | { type: "provider"; providerID: string }
  | { type: "model"; providerID: string; modelID: string }

export const COMPANY_PROVIDER_FAILURE_MESSAGE =
  "Enterprise provider connection test failed. Check the server and try again."

export function validateEnterpriseProviderForm(input: EnterpriseProviderFormInput): EnterpriseProviderFormResult {
  const providerID = (input.mode.type === "edit" ? input.mode.providerID : input.providerID).trim()
  const name = input.name.trim()
  const baseURL = input.baseURL.trim()
  const models = input.models.map((model) => ({ id: model.id.trim(), name: model.name.trim() }))
  const value = { providerID, name, baseURL, models }

  if (!providerID) return { ...value, error: "Provider ID is required" }
  if (!name) return { ...value, error: "Provider name is required" }
  if (!baseURL) return { ...value, error: "Base URL is required" }
  if (
    input.mode.type === "create" &&
    [...input.existingProviderIDs].some((id) => id.toLowerCase() === providerID.toLowerCase())
  )
    return { ...value, error: "Provider ID already exists" }

  const url = URL.parse(baseURL)
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
    return { ...value, error: "Base URL must use http or https" }
  if (url.username || url.password || url.search || url.hash)
    return { ...value, error: "Base URL cannot include credentials, query parameters, or fragments" }
  if (models.some((model) => !model.id)) return { ...value, error: "Model ID is required" }
  if (models.some((model) => !model.name)) return { ...value, error: "Model name is required" }
  if (new Set(models.map((model) => model.id.toLowerCase())).size !== models.length)
    return { ...value, error: "Model IDs must be unique" }
  return value
}

export function providerCredentialIntent(
  mode: ProviderCredentialMode,
  apiKey: string,
  headers: { key: string; value: string }[],
): ProviderCredentialIntent {
  if (mode === "preserve") return { mode }
  if (mode === "clear") return { mode }

  const complete = headers.filter((header) => header.key.trim() || header.value.trim())
  if (complete.some((header) => !header.key.trim() || !header.value.trim()))
    return { mode, error: "Secret headers require a name and value" }
  const keys = complete.map((header) => header.key.trim().toLowerCase())
  if (new Set(keys).size !== keys.length) return { mode, error: "Secret header names must be unique" }
  const secret = apiKey.trim()
  return {
    mode,
    credentials: {
      ...(secret ? { apiKey: secret } : {}),
      headers: Object.fromEntries(complete.map((header) => [header.key.trim(), header.value.trim()])),
    },
  }
}

export async function applyEnterpriseProviderUpdate<T>(input: {
  providerID: string
  name: string
  baseURL: string
  credentials: { mode: "preserve" } | { mode: "clear" } | { mode: "replace"; credentials: CredentialReplacement }
  updateProvider: (value: {
    providerID: string
    name: string
    baseURL: string
    credentials?: CredentialReplacement
    clearCredentials?: true
  }) => Promise<T>
  mutate: (value: T) => void
}) {
  const updated = await input.updateProvider({
    providerID: input.providerID,
    name: input.name,
    baseURL: input.baseURL,
    ...(input.credentials.mode === "replace"
      ? { credentials: input.credentials.credentials }
      : input.credentials.mode === "clear"
        ? { clearCredentials: true as const }
        : {}),
  })
  input.mutate(updated)
  return updated
}

export function enterpriseProviderFailureKey(failure: unknown) {
  const code =
    typeof failure === "object" && failure !== null && "code" in failure && typeof failure.code === "string"
      ? failure.code
      : failure instanceof Error
        ? failure.message
        : String(failure)
  if (code.includes("restart_failed_recovery_failed")) return "settings.skills.error.recoveryFailed" as const
  if (code.includes("restart_failed_rolled_back")) return "settings.skills.error.rolledBack" as const
  return "common.requestFailed" as const
}

export function enterpriseProviderPresentation(
  catalog: EnterpriseProviderCatalogView,
  provider: EnterpriseProviderCatalogView["providers"][number],
) {
  const model = provider.models.find(
    (item) => catalog.default?.providerID === provider.id && item.id === catalog.default.modelID,
  )
  return {
    modelCount: `${provider.models.length} ${provider.models.length === 1 ? "model" : "models"}`,
    credentials: provider.credentials.errorCode
      ? "Credentials must be re-entered"
      : provider.credentials.configured
        ? "Credentials configured"
        : "Credentials not configured",
    defaultModel: model?.name,
    isDefaultProvider: Boolean(model),
  }
}

export function enterpriseDeleteConfirmation(type: "provider", providerID: string): EnterpriseDeleteConfirmation
export function enterpriseDeleteConfirmation(
  type: "model",
  providerID: string,
  modelID: string,
): EnterpriseDeleteConfirmation
export function enterpriseDeleteConfirmation(type: "provider" | "model", providerID: string, modelID?: string) {
  if (type === "provider") return { type, providerID }
  return { type, providerID, modelID: modelID ?? "" }
}

export function companyProviderCanStart(action: CompanyProviderAction, ready: boolean) {
  return action === undefined && ready
}

export function diagnoseCompanyProvider<T>(
  diagnose: (input: { providerID: string; modelID: string; checkToolCall: boolean }) => T,
  providerID: string,
  modelID: string,
) {
  return diagnose({ providerID, modelID, checkToolCall: true })
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

export function providerFormFromCatalog(provider: EnterpriseProvider): EnterpriseProviderFormResult {
  return {
    providerID: provider.id,
    name: provider.name,
    baseURL: provider.baseURL,
    models: provider.models.map((model) => ({ ...model })),
  }
}
