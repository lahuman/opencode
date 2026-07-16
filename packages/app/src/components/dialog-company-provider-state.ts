export type CompanyConfig = {
  model?: string
  provider?: Record<
    string,
    {
      options?: { baseURL?: unknown; [key: string]: unknown }
      models?: Record<string, { name?: string; provider?: { api?: unknown } }>
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

export type CompanyProviderAction = "save" | "clear" | "diagnose" | undefined
export type CredentialMutationResult = { restartRequired: boolean }
export type CompanyCredentialCatalog = {
  defaultModelID: string
  models: {
    id: string
    name: string
    baseURL: string
    credentialStatus: { configured: boolean; errorCode?: string }
  }[]
}
export type CompanyProviderCredentialModel = {
  id: string
  name: string
  baseURL: string
  isDefault: boolean
  synchronized: boolean
  credentialStatus: { configured: boolean; errorCode?: string } | undefined
}

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
    baseURL: typeof model.provider?.api === "string" ? model.provider.api : "",
  }))
}

export function companyProviderConfig(config: CompanyConfig) {
  const models = companyProviderModels(config)
  const configured = config.model?.startsWith("company-llm/") ? config.model.slice("company-llm/".length) : undefined
  return {
    models,
    defaultModelID: configured && models.some((model) => model.id === configured) ? configured : (models[0]?.id ?? ""),
  }
}

export function companyProviderCredentialModels(
  config: CompanyConfig,
  catalog: CompanyCredentialCatalog,
): CompanyProviderCredentialModel[] {
  const serverModels = companyProviderModels(config)
  const server = new Map(serverModels.map((model) => [model.id, model]))
  const main = new Set(catalog.models.map((model) => model.id))
  return [
    ...catalog.models.map((model) => ({
      ...model,
      isDefault: model.id === catalog.defaultModelID,
      synchronized: server.get(model.id)?.baseURL === model.baseURL,
    })),
    ...serverModels.flatMap((model) =>
      main.has(model.id)
        ? []
        : [
            {
              ...model,
              isDefault: false,
              synchronized: false,
              credentialStatus: undefined,
            },
          ],
    ),
  ]
}

export function companyProviderModelCredentialStatus(model: CompanyProviderCredentialModel, failureMessage: string) {
  if (!model.synchronized) return "Restart required"
  return companyProviderCredentialStatus(
    {
      loading: false,
      configured: model.credentialStatus?.configured,
      error: model.credentialStatus?.errorCode,
    },
    failureMessage,
  )
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
  if (status.error === "credential_decryption_failed" || status.error === "credential_encryption_unavailable")
    return "Credentials must be re-entered"
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
