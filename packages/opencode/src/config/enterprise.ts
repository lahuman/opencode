export * as ConfigEnterprise from "./enterprise"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { mapValues, omit } from "remeda"
import { ConfigPlugin } from "./plugin"

const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

export type Policy = ReturnType<typeof settings>
export type EnforcementPolicy = Pick<Policy, "enabled" | "defaultsPath" | "allowedOrigins">
export type DefaultsPolicy = Pick<
  Policy,
  "enabled" | "defaultsPath" | "allowedOrigins" | "baseURL" | "modelID" | "modelName"
> & { guidePath?: string }
type Info = ConfigV1.Info & { plugin_origins?: ConfigPlugin.Origin[] }

export function settings() {
  const enabled = process.env.OPENCODE_ENTERPRISE_OFFLINE === "1"
  return {
    enabled,
    defaultsPath: enabled ? process.env.OPENCODE_ENTERPRISE_DEFAULTS_PATH : undefined,
    baseURL: enabled ? process.env.OPENCODE_ENTERPRISE_BASE_URL : undefined,
    modelID: enabled ? process.env.OPENCODE_ENTERPRISE_MODEL_ID : undefined,
    modelName: enabled ? process.env.OPENCODE_ENTERPRISE_MODEL_NAME : undefined,
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

export function materializeDefaults(info: Info, policy: DefaultsPolicy = settings()): Info {
  if (!policy.enabled) return info
  if (!policy.baseURL || !policy.modelID || !policy.modelName) {
    throw new Error("Enterprise provider metadata is incomplete")
  }
  const current = info.provider?.["company-llm"]
  return {
    ...info,
    model: info.model ?? `company-llm/${policy.modelID}`,
    provider: {
      ...info.provider,
      "company-llm": {
        ...current,
        npm: OPENAI_COMPATIBLE,
        name: current?.name ?? "Company LLM",
        options: { ...current?.options, baseURL: policy.baseURL },
        models: {
          ...current?.models,
          [policy.modelID]: {
            name: policy.modelName,
            ...current?.models?.[policy.modelID],
          },
        },
      },
    },
  }
}

export function enforce(info: Info, policy: EnforcementPolicy = settings()): Info {
  if (!policy.enabled) return info

  const provider = Object.fromEntries(
    Object.entries(info.provider ?? {}).flatMap((entry) => {
      if (entry[1].npm !== OPENAI_COMPATIBLE) return []
      if (typeof entry[1].options?.baseURL !== "string") return []
      try {
        const url = new URL(entry[1].options.baseURL)
        if (url.protocol !== "http:" && url.protocol !== "https:") return []
        if (url.username || url.password || !policy.allowedOrigins.has(url.origin)) return []
        return [
          [
            entry[0],
            {
              ...entry[1],
              env: Array<string>(),
              options: omit(entry[1].options, ["apiKey", "headers"]),
              models: mapValues(entry[1].models ?? {}, (model) => ({
                ...omit(model, ["headers"]),
                provider: { ...model.provider, npm: OPENAI_COMPATIBLE },
                options: omit(model.options ?? {}, ["apiKey", "headers"]),
              })),
            },
          ],
        ] as const
      } catch {
        return []
      }
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
