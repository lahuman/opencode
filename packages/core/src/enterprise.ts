export * as Enterprise from "./enterprise.js"

import path from "node:path"
import { Schema, Struct } from "effect"
import { Info } from "@opencode/schema/config"
import type { ConfigProvider } from "@opencode/schema/config/provider"

const Catalog = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  default: Schema.optionalKey(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
  providers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      baseURL: Schema.String,
      models: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
})

const Credentials = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  providers: Schema.Record(
    Schema.String,
    Schema.Struct({ apiKey: Schema.optionalKey(Schema.String), headers: Schema.Record(Schema.String, Schema.String) }),
  ),
})

let credentials: typeof Credentials.Type = { schemaVersion: 3, providers: {} }

export function enabled() {
  return process.env.OPENCODE_ENTERPRISE_OFFLINE === "1"
}

export function settings() {
  const catalog = Schema.decodeUnknownSync(Schema.fromJsonString(Catalog))(
    process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG ?? '{"schemaVersion":1,"providers":[]}',
  )
  const allowedOrigins = new Set(
    (process.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const url = new URL(value)
        if (url.username || url.password || !["http:", "https:"].includes(url.protocol))
          throw new Error("Invalid enterprise allowed origin")
        return url.origin
      }),
  )
  if (new Set(catalog.providers.map((provider) => provider.id)).size !== catalog.providers.length)
    throw new Error("Duplicate enterprise provider ID")
  // Registered LLM endpoints are independent of the build's web-access policy.
  const providerOrigins = new Set<string>()
  for (const provider of catalog.providers) {
    if (!provider.id.trim()) throw new Error("Invalid enterprise provider")
    providerOrigins.add(parseHTTPURL(provider.baseURL).origin)
    if (
      new Set(provider.models.map((model) => model.id)).size !== provider.models.length ||
      provider.models.some((model) => !model.id.trim())
    )
      throw new Error("Invalid enterprise models")
  }
  if (
    catalog.default &&
    !catalog.providers.some(
      (provider) =>
        provider.id === catalog.default?.providerID &&
        provider.models.some((model) => model.id === catalog.default?.modelID),
    )
  )
    throw new Error("Invalid enterprise default model")
  const skills = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
    process.env.OPENCODE_ENTERPRISE_SKILL_PATHS ?? "[]",
  )
  if (skills.some((value) => !path.isAbsolute(value))) throw new Error("Enterprise skill paths must be absolute")
  return {
    catalog,
    allowedOrigins,
    providerOrigins,
    skills,
    defaultsPath: process.env.OPENCODE_ENTERPRISE_DEFAULTS_PATH,
    guidePath: process.env.OPENCODE_ENTERPRISE_GUIDE_PATH,
  }
}

export function requireURL(value: string, allowedOrigins = settings().allowedOrigins) {
  const url = parseHTTPURL(value)
  if (!allowedOrigins.has(url.origin)) throw new Error("Enterprise offline policy blocked the destination")
  return url
}

function parseHTTPURL(value: string) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Enterprise endpoints require HTTP(S) URLs without embedded credentials")
  return url
}

// Only the desktop's authenticated process boundary supplies decrypted credentials.
// They never enter a config document, catalog response, child environment, or log.
export function setCredentials(value: unknown) {
  const decoded = Schema.decodeUnknownExit(Credentials)(value)
  if (decoded._tag === "Failure") throw new Error("Invalid enterprise credentials")
  credentials = decoded.value
}

export function requestHeaders(providerID: string): Record<string, string> {
  const value = credentials.providers[providerID]
  return {
    ...(value?.apiKey ? { Authorization: `Bearer ${value.apiKey}` } : {}),
    ...value?.headers,
  }
}

export function sanitize(info: Info) {
  const settings = (value: ConfigProvider.Settings | undefined) =>
    value && Struct.omit(value, ["apiKey", "key", "headers"])
  return new Info({
    ...info,
    providers: info.providers && Object.fromEntries(
      Object.entries(info.providers).map(([id, provider]) => [id, {
        ...provider,
        headers: undefined,
        settings: settings(provider.settings),
        models: provider.models && Object.fromEntries(
          Object.entries(provider.models).map(([id, model]) => [id, {
            ...model,
            headers: undefined,
            settings: settings(model.settings),
          }]),
        ),
      }]),
    ),
  })
}
