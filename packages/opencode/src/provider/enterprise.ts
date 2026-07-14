import { ProviderV2 } from "@opencode-ai/core/provider"
import { Option, Schema } from "effect"
import { isRecord } from "@/util/record"

const Credentials = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  headers: Schema.Record(Schema.String, Schema.String),
})
const decode = Schema.decodeUnknownOption(Credentials)
let currentCredentials: typeof Credentials.Type = { headers: {} }

export function setCredentials(input: unknown) {
  currentCredentials = Option.getOrElse(decode(input), () => ({ headers: {} }))
}

export function options(providerID: ProviderV2.ID, current: Record<string, unknown>) {
  if (providerID !== ProviderV2.ID.make("company-llm")) return current
  return {
    ...current,
    ...(currentCredentials.apiKey ? { apiKey: currentCredentials.apiKey } : {}),
    ...(Object.keys(currentCredentials.headers).length
      ? {
          headers: {
            ...(isRecord(current.headers) ? current.headers : {}),
            ...currentCredentials.headers,
          },
        }
      : {}),
  }
}

export * as ProviderEnterprise from "./enterprise"
