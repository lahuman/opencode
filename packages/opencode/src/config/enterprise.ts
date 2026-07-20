export * as ConfigEnterprise from "./enterprise"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import path from "node:path"
import { mapValues, omit } from "remeda"
import { ConfigPlugin } from "./plugin"

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

export type Policy = ReturnType<typeof settings>
export type EnforcementPolicy = Pick<Policy, "enabled" | "defaultsPath" | "allowedOrigins" | "catalog">
export type DefaultsPolicy = Pick<
  Policy,
  "enabled" | "defaultsPath" | "allowedOrigins" | "catalog" | "skillPaths"
> & { guidePath?: string }
type Info = ConfigV1.Info & { plugin_origins?: ConfigPlugin.Origin[] }
type EnterpriseProviderCatalog = {
  schemaVersion: 1
  default?: { providerID: string; modelID: string }
  providers: {
    id: string
    name: string
    baseURL: string
    models: { id: string; name: string }[]
  }[]
}

export function settings() {
  const enabled = process.env.OPENCODE_ENTERPRISE_OFFLINE === "1"
  const catalog = enabled ? enterpriseCatalog() : { schemaVersion: 1 as const, providers: [] }
  return {
    enabled,
    defaultsPath: enabled ? process.env.OPENCODE_ENTERPRISE_DEFAULTS_PATH : undefined,
    guidePath: enabled ? process.env.OPENCODE_ENTERPRISE_GUIDE_PATH : undefined,
    catalog,
    defaultModel: catalog.default ? `${catalog.default.providerID}/${catalog.default.modelID}` : undefined,
    skillPaths: enabled ? enterpriseSkillPaths() : [],
    allowedOrigins: new Set(
      (enabled ? process.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS : undefined)
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => new URL(item).origin) ?? [],
    ),
  }
}

export function upgradeAllowed(policy: Pick<Policy, "enabled"> = settings()) {
  return !policy.enabled
}

export function publicInfo(info: Info, policy: Pick<Policy, "enabled"> = settings()): Info {
  return sanitizeWrite(info, policy)
}

export function sanitizeWrite(info: Info, policy: Pick<Policy, "enabled"> = settings()): Info {
  if (!policy.enabled) return info
  if (!info.provider) return { ...info }
  return {
    ...info,
    provider: mapValues(info.provider, (provider) => ({
      ...provider,
      ...(provider.options ? { options: omit(provider.options, ["key", "apiKey", "headers"]) } : {}),
      ...(provider.models
        ? {
            models: mapValues(provider.models, (model) => ({
              ...omit(model, ["headers"]),
              ...(model.options ? { options: omit(model.options, ["key", "apiKey", "headers"]) } : {}),
            })),
          }
        : {}),
    })),
  }
}

export function materializeDefaults(info: Info, policy: DefaultsPolicy = settings()): Info {
  if (!policy.enabled) return info
  const guidePath = policy.guidePath
  return {
    ...info,
    ...(info.model
      ? {}
      : policy.catalog.default
        ? { model: `${policy.catalog.default.providerID}/${policy.catalog.default.modelID}` }
        : {}),
    ...(policy.skillPaths.length
      ? {
          skills: {
            ...info.skills,
            paths: [...new Set([...policy.skillPaths, ...(info.skills?.paths ?? [])])],
          },
        }
      : {}),
    ...(guidePath
      ? { instructions: [guidePath, ...(info.instructions ?? []).filter((item) => item !== guidePath)] }
      : {}),
    provider: {
      ...info.provider,
      ...Object.fromEntries(
        policy.catalog.providers.map((provider) => [
          provider.id,
          {
            npm: OPENAI_COMPATIBLE,
            name: provider.name,
            options: { baseURL: provider.baseURL },
            models: Object.fromEntries(provider.models.map((model) => [model.id, { name: model.name }])),
          },
        ]),
      ),
    },
  }
}

function enterpriseSkillPaths() {
  const value: unknown = (() => {
    try {
      return JSON.parse(process.env.OPENCODE_ENTERPRISE_SKILL_PATHS ?? "[]")
    } catch {
      return []
    }
  })()
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return []
  return value.filter(path.isAbsolute)
}

export function enforce(info: Info, policy: EnforcementPolicy = settings()): Info {
  if (!policy.enabled) return info

  const provider = Object.fromEntries(
    policy.catalog.providers.map((item) => {
      const current = info.provider?.[item.id]
      return [
        item.id,
        {
          ...current,
          api: item.baseURL,
          npm: OPENAI_COMPATIBLE,
          name: item.name,
          env: Array<string>(),
          options: {
            ...omit(current?.options ?? {}, ["key", "apiKey", "headers", "baseURL"]),
            baseURL: item.baseURL,
          },
          models: Object.fromEntries(
            item.models.map((model) => {
              const configured = current?.models?.[model.id]
              return [
                model.id,
                {
                  ...omit(configured ?? {}, ["headers", "name"]),
                  id: model.id,
                  name: model.name,
                  provider: {
                    ...configured?.provider,
                    npm: OPENAI_COMPATIBLE,
                    api: item.baseURL,
                  },
                  options: omit(configured?.options ?? {}, ["key", "apiKey", "headers"]),
                },
              ]
            }),
          ),
        },
      ] as const
    }),
  )
  const plugin_origins = (info.plugin_origins ?? []).filter((item) =>
    ConfigPlugin.pluginSpecifier(item.spec).startsWith("file://"),
  )
  const model = policy.catalog.providers.some((item) =>
    item.models.some((candidate) => info.model === `${item.id}/${candidate.id}`),
  )
    ? info.model
    : policy.catalog.default
      ? `${policy.catalog.default.providerID}/${policy.catalog.default.modelID}`
      : undefined
  return {
    ...info,
    model,
    provider,
    enabled_providers: Object.keys(provider),
    plugin: plugin_origins.map((item) => item.spec),
    plugin_origins,
    share: "disabled",
    autoupdate: false,
  }
}

function enterpriseCatalog(): EnterpriseProviderCatalog {
  const value: unknown = (() => {
    try {
      return JSON.parse(process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG ?? "")
    } catch {
      return undefined
    }
  })()
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.providers)) {
    return { schemaVersion: 1, providers: [] }
  }
  const providers = value.providers.flatMap((provider) => {
    if (!isRecord(provider) || !Array.isArray(provider.models)) return []
    if (typeof provider.id !== "string" || typeof provider.name !== "string" || typeof provider.baseURL !== "string") {
      return []
    }
    const models = provider.models.flatMap((model) => {
      if (!isRecord(model) || typeof model.id !== "string" || typeof model.name !== "string") return []
      return [{ id: model.id, name: model.name }]
    })
    if (models.length !== provider.models.length) return []
    return [{ id: provider.id, name: provider.name, baseURL: provider.baseURL, models }]
  })
  if (providers.length !== value.providers.length) return { schemaVersion: 1, providers: [] }
  if (value.default === undefined) return { schemaVersion: 1, providers }
  if (!isRecord(value.default)) return { schemaVersion: 1, providers: [] }
  if (typeof value.default.providerID !== "string" || typeof value.default.modelID !== "string") {
    return { schemaVersion: 1, providers: [] }
  }
  const catalogDefault = { providerID: value.default.providerID, modelID: value.default.modelID }
  if (
    !providers.some(
      (provider) =>
        provider.id === catalogDefault.providerID &&
        provider.models.some((model) => model.id === catalogDefault.modelID),
    )
  ) {
    return { schemaVersion: 1, providers: [] }
  }
  return {
    schemaVersion: 1,
    default: { providerID: catalogDefault.providerID, modelID: catalogDefault.modelID },
    providers,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
