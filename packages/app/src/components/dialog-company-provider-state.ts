export type CompanyConfig = {
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

export type CompanyProviderAction = "save" | "clear" | "diagnose" | undefined
export type CredentialMutationResult = { restartRequired: boolean }

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
