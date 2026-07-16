import { ProviderV2 } from "@opencode-ai/core/provider"
import { Option, Schema } from "effect"
import { isRecord } from "@/util/record"

const Credentials = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
})
const decode = Schema.decodeUnknownOption(Credentials)
let currentCredentials: typeof Credentials.Type = { headers: {} }
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
  currentCredentials = Option.getOrElse(decode(input), () => ({ headers: {} }))
}

export function options(providerID: ProviderV2.ID, current: Record<string, unknown>) {
  if (providerID !== ProviderV2.ID.make("company-llm")) return current
  const credentialHeaderNames = new Set(Object.keys(currentCredentials.headers).map((name) => name.toLowerCase()))
  return {
    ...current,
    fetch: enterpriseFetch,
    ...(currentCredentials.apiKey ? { apiKey: currentCredentials.apiKey } : {}),
    ...(Object.keys(currentCredentials.headers).length
      ? {
          headers: {
            ...(isRecord(current.headers)
              ? Object.fromEntries(
                  Object.entries(current.headers).filter(([name]) => !credentialHeaderNames.has(name.toLowerCase())),
                )
              : {}),
            ...currentCredentials.headers,
          },
        }
      : {}),
  }
}

export * as ProviderEnterprise from "./enterprise"
