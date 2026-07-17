export * as ConfigEnterprise from "./enterprise"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import path from "node:path"
import { mapValues, omit } from "remeda"
import { ConfigPlugin } from "./plugin"

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

export type Policy = ReturnType<typeof settings>
export type EnforcementPolicy = Pick<Policy, "enabled" | "defaultsPath" | "allowedOrigins"> & {
  models?: { id: string }[]
}
export type DefaultsPolicy = Pick<
  Policy,
  "enabled" | "defaultsPath" | "allowedOrigins" | "models" | "defaultModelID" | "skillPaths"
> & { guidePath?: string }
type Info = ConfigV1.Info & { plugin_origins?: ConfigPlugin.Origin[] }

export function settings() {
  const enabled = process.env.OPENCODE_ENTERPRISE_OFFLINE === "1"
  const models = enabled ? enterpriseModels() : []
  return {
    enabled,
    defaultsPath: enabled ? process.env.OPENCODE_ENTERPRISE_DEFAULTS_PATH : undefined,
    guidePath: enabled ? process.env.OPENCODE_ENTERPRISE_GUIDE_PATH : undefined,
    models,
    defaultModelID: enabled
      ? process.env.OPENCODE_ENTERPRISE_DEFAULT_MODEL_ID ?? models[0]?.id
      : undefined,
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

export function publicInfo(info: Info, policy: EnforcementPolicy = settings()): Info {
  return sanitizeWrite(info, policy)
}

export function sanitizeWrite(info: Info, policy: EnforcementPolicy = settings()): Info {
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
  if (!policy.models.length || !policy.defaultModelID || !policy.models.some((model) => model.id === policy.defaultModelID)) {
    throw new Error("Enterprise provider metadata is incomplete")
  }
  const guidePath = policy.guidePath
  const current = info.provider?.["company-llm"]
  return {
    ...info,
    model: info.model ?? `company-llm/${policy.defaultModelID}`,
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
      "company-llm": {
        ...current,
        npm: OPENAI_COMPATIBLE,
        name: current?.name ?? "Company LLM",
        ...(current?.options ? { options: current.options } : {}),
        models: {
          ...Object.fromEntries(
            policy.models.map((model) => {
              const configured = current?.models?.[model.id]
              return [
                model.id,
                {
                  name: model.name,
                  ...configured,
                  provider: {
                    npm: OPENAI_COMPATIBLE,
                    api: model.baseURL,
                    ...configured?.provider,
                  },
                },
              ]
            }),
          ),
        },
      },
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
    Object.entries(info.provider ?? {}).flatMap((entry) => {
      if (entry[1].npm !== OPENAI_COMPATIBLE) return []
      const providerURL = typeof entry[1].options?.baseURL === "string" ? entry[1].options.baseURL : undefined
      if (providerURL && !allowedURL(providerURL, policy.allowedOrigins)) return []
      const models = entry[1].models ?? {}
      if (
        !Object.keys(models).length ||
        Object.values(models).some((model) => {
          const url = typeof model.provider?.api === "string" ? model.provider.api : providerURL
          return !url || !allowedURL(url, policy.allowedOrigins)
        })
      ) {
        return []
      }
      const retainedModels =
        entry[0] === "company-llm" && policy.models
          ? Object.fromEntries(
              Object.entries(models).filter(([modelID]) => policy.models?.some((model) => model.id === modelID)),
            )
          : models
      if (!Object.keys(retainedModels).length) return []
      return [
        [
          entry[0],
          {
            ...entry[1],
            env: Array<string>(),
            options: omit(entry[1].options ?? {}, ["key", "apiKey", "headers"]),
            models: mapValues(retainedModels, (model) => ({
              ...omit(model, ["headers"]),
              provider: { ...model.provider, npm: OPENAI_COMPATIBLE },
              options: omit(model.options ?? {}, ["key", "apiKey", "headers"]),
            })),
          },
        ],
      ] as const
    }),
  )
  const plugin_origins = (info.plugin_origins ?? []).filter((item) =>
    ConfigPlugin.pluginSpecifier(item.spec).startsWith("file://"),
  )
  return {
    ...info,
    provider,
    enabled_providers: Object.keys(provider),
    plugin: plugin_origins.map((item) => item.spec),
    plugin_origins,
    share: "disabled",
    autoupdate: false,
  }
}

function enterpriseModels() {
  if (!process.env.OPENCODE_ENTERPRISE_MODELS) {
    const id = process.env.OPENCODE_ENTERPRISE_MODEL_ID
    const name = process.env.OPENCODE_ENTERPRISE_MODEL_NAME
    const baseURL = process.env.OPENCODE_ENTERPRISE_BASE_URL
    return id && name && baseURL ? [{ id, name, baseURL }] : []
  }
  const value: unknown = (() => {
    try {
      return JSON.parse(process.env.OPENCODE_ENTERPRISE_MODELS)
    } catch {
      return []
    }
  })()
  if (!Array.isArray(value)) return []
  return value.flatMap((model) => {
    if (typeof model !== "object" || model === null || Array.isArray(model)) return []
    if (!("id" in model) || !("name" in model) || !("baseURL" in model)) return []
    if (typeof model.id !== "string" || typeof model.name !== "string" || typeof model.baseURL !== "string") return []
    return [{ id: model.id, name: model.name, baseURL: model.baseURL }]
  })
}

function allowedURL(value: string, allowedOrigins: Set<string>) {
  try {
    const url = new URL(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      allowedOrigins.has(url.origin)
    )
  } catch {
    return false
  }
}
