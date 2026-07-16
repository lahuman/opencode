import { ProviderV2 } from "@opencode-ai/core/provider"
import { Option, Schema } from "effect"
import { isRecord } from "@/util/record"

const Credentials = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
})
const CredentialStore = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  models: Schema.Record(Schema.String, Credentials),
})
const decode = Schema.decodeUnknownOption(CredentialStore)
let currentCredentials: typeof CredentialStore.Type = { schemaVersion: 2, models: {} }
const enterpriseFetch: typeof fetch = Object.assign(
  async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetch(request, {
      ...init,
      redirect: "manual",
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel().catch(() => undefined)
    throw new Error("Company LLM redirects are disabled")
  },
  { preconnect: fetch.preconnect },
)

export function setCredentials(input: unknown) {
  currentCredentials = Option.getOrElse(decode(input), () => ({ schemaVersion: 2, models: {} }))
}

export function options(providerID: ProviderV2.ID, modelID: string, current: Record<string, unknown>) {
  if (providerID !== ProviderV2.ID.make("company-llm")) return current
  const credentials = currentCredentials.models[modelID] ?? { headers: {} }
  const credentialHeaderNames = new Set(Object.keys(credentials.headers).map((name) => name.toLowerCase()))
  return {
    ...current,
    fetch: enterpriseFetch,
    ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
    ...(Object.keys(credentials.headers).length
      ? {
          headers: {
            ...(isRecord(current.headers)
              ? Object.fromEntries(
                  Object.entries(current.headers).filter(([name]) => !credentialHeaderNames.has(name.toLowerCase())),
                )
              : {}),
            ...credentials.headers,
          },
        }
      : {}),
  }
}

export * as ProviderEnterprise from "./enterprise"
