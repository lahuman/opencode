import { expect, test } from "bun:test"
import path from "node:path"
import { ConfigEnterprise } from "@/config/enterprise"

test("enterprise policy disables server upgrades", () => {
  expect(ConfigEnterprise.upgradeAllowed({ enabled: true })).toBe(false)
})

test("enterprise enforcement keeps local plugins and removes registry plugins", () => {
  const local = { spec: "file:///C:/project/.opencode/plugins/company.ts", source: "project", scope: "local" as const }
  const registry = { spec: "public-plugin@latest", source: "project", scope: "local" as const }
  const result = ConfigEnterprise.enforce(
    {
      plugin: [local.spec, registry.spec],
      plugin_origins: [local, registry],
    },
    {
      enabled: true,
      defaultsPath: undefined,
      allowedOrigins: new Set(["https://llm.corp.example"]),
    },
  )
  expect(result.plugin).toEqual([local.spec])
  expect(result.plugin_origins).toEqual([local])
})

test("enterprise enforcement overrides retained model SDKs", () => {
  const result = ConfigEnterprise.enforce(
    {
      provider: {
        company: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://llm.corp.example/v1" },
          models: { default: { provider: { npm: "untrusted-sdk" } } },
        },
      },
    },
    {
      enabled: true,
      defaultsPath: undefined,
      allowedOrigins: new Set(["https://llm.corp.example"]),
    },
  )
  expect(result.provider?.company?.models?.default?.provider?.npm).toBe("@ai-sdk/openai-compatible")
})

test("enterprise enforcement clears provider credential env", () => {
  const result = ConfigEnterprise.enforce(
    {
      provider: {
        company: {
          npm: "@ai-sdk/openai-compatible",
          env: ["COMPANY_API_KEY"],
          options: {
            baseURL: "https://llm.corp.example/v1",
            key: "provider-secret-key",
            apiKey: "provider-api-secret",
            headers: { Authorization: "provider-header-secret" },
          },
          models: {
            default: {
              headers: { Authorization: "model-header-secret" },
              options: {
                key: "model-secret-key",
                apiKey: "model-api-secret",
                headers: { Authorization: "model-option-header-secret" },
              },
            },
          },
        },
      },
    },
    {
      enabled: true,
      defaultsPath: undefined,
      allowedOrigins: new Set(["https://llm.corp.example"]),
    },
  )
  expect(result.provider?.company?.env).toEqual([])
  expect(result.provider?.company?.options).toEqual({ baseURL: "https://llm.corp.example/v1" })
  expect(result.provider?.company?.models?.default?.headers).toBeUndefined()
  expect(result.provider?.company?.models?.default?.options).toEqual({})
})

test("materializes only catalog company provider metadata as structured defaults", () => {
  const result = ConfigEnterprise.materializeDefaults(
    {
      provider: {
        "company-llm": {
          models: {
            rogue: { name: "Project Rogue", provider: { api: "https://llm.corp.example/rogue" } },
          },
        },
      },
    },
    {
      enabled: true,
      defaultsPath: "C:/app/enterprise/opencode.jsonc",
      allowedOrigins: new Set(["https://llm.corp.example"]),
      models: [
        { id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" },
        { id: "company-fast", name: "Company Fast", baseURL: "https://fast.corp.example/v1" },
      ],
      defaultModelID: "company-code",
      skillPaths: ["C:/app/enterprise/skill-packs/ponytail/skills"],
    },
  )
  expect(result.model).toBe("company-llm/company-code")
  expect(result.provider?.["company-llm"]?.models?.["company-code"]?.name).toBe("Company Code")
  expect(result.provider?.["company-llm"]?.models?.["company-code"]?.provider?.api).toBe(
    "https://llm.corp.example/v1",
  )
  expect(result.provider?.["company-llm"]?.models?.["company-fast"]?.provider?.api).toBe(
    "https://fast.corp.example/v1",
  )
  expect(result.provider?.["company-llm"]?.options?.baseURL).toBeUndefined()
  expect(result.provider?.["company-llm"]?.models?.rogue).toBeUndefined()
  expect(result.skills?.paths).toEqual(["C:/app/enterprise/skill-packs/ponytail/skills"])
})

test("materializes verified enterprise skill paths without duplicating project configuration", () => {
  const skillPath = "C:/app/enterprise/skill-packs/superpowers/skills"
  const result = ConfigEnterprise.materializeDefaults(
    { skills: { paths: ["project-skills"] } },
    {
      enabled: true,
      defaultsPath: "C:/app/enterprise/opencode.jsonc",
      allowedOrigins: new Set(["https://llm.corp.example"]),
      models: [{ id: "company-code", name: "Company Code", baseURL: "https://llm.corp.example/v1" }],
      defaultModelID: "company-code",
      skillPaths: [skillPath],
    },
  )

  expect(result.skills?.paths).toEqual([skillPath, "project-skills"])
})

test("accepts only absolute enterprise skill paths from the sidecar environment", () => {
  using offline = environment("OPENCODE_ENTERPRISE_OFFLINE", "1")
  const absolute = path.resolve("enterprise-skills")
  using skillPaths = environment("OPENCODE_ENTERPRISE_SKILL_PATHS", JSON.stringify([absolute, "relative-skills"]))

  expect(ConfigEnterprise.settings().skillPaths).toEqual([absolute])
})

test("enterprise enforcement rejects a provider when any model URL is outside policy", () => {
  const policy = {
    enabled: true,
    defaultsPath: undefined,
    allowedOrigins: new Set(["https://code.corp.example", "https://reasoning.corp.example"]),
  }
  const provider = {
    "company-llm": {
      npm: "@ai-sdk/openai-compatible",
      models: {
        code: { provider: { api: "https://code.corp.example/v1" } },
        reasoning: { provider: { api: "https://reasoning.corp.example/v1" } },
      },
    },
  }

  expect(Object.keys(ConfigEnterprise.enforce({ provider }, policy).provider ?? {})).toEqual(["company-llm"])
  expect(
    ConfigEnterprise.enforce(
      {
        provider: {
          ...provider,
          "company-llm": {
            ...provider["company-llm"],
            models: {
              ...provider["company-llm"].models,
              reasoning: { provider: { api: "https://unapproved.example/v1" } },
            },
          },
        },
      },
      policy,
    ).provider,
  ).toEqual({})
})

function environment(key: string, value: string) {
  const previous = process.env[key]
  process.env[key] = value
  return {
    [Symbol.dispose]() {
      if (previous === undefined) {
        delete process.env[key]
        return
      }
      process.env[key] = previous
    },
  }
}

test("enterprise enforcement rejects provider and model URLs with queries or fragments", () => {
  const policy = {
    enabled: true,
    defaultsPath: undefined,
    allowedOrigins: new Set(["https://code.corp.example"]),
  }
  const provider = (api: string) => ({
    "company-llm": {
      npm: "@ai-sdk/openai-compatible",
      models: { code: { provider: { api } } },
    },
  })

  expect(ConfigEnterprise.enforce({ provider: provider("https://code.corp.example/v1?api_key=secret") }, policy).provider).toEqual({})
  expect(ConfigEnterprise.enforce({ provider: provider("https://code.corp.example/v1#secret") }, policy).provider).toEqual({})
  expect(
    ConfigEnterprise.enforce(
      {
        provider: {
          "company-llm": {
            ...provider("https://code.corp.example/v1")["company-llm"],
            options: { baseURL: "https://code.corp.example/v1?api_key=secret" },
          },
        },
      },
      policy,
    ).provider,
  ).toEqual({})
})

test("enterprise enforcement removes company models outside the configured catalog", () => {
  const result = ConfigEnterprise.enforce(
    {
      provider: {
        "company-llm": {
          npm: "@ai-sdk/openai-compatible",
          models: {
            code: { provider: { api: "https://code.corp.example/v1" } },
            rogue: { provider: { api: "https://code.corp.example/rogue" } },
          },
        },
      },
    },
    {
      enabled: true,
      defaultsPath: undefined,
      allowedOrigins: new Set(["https://code.corp.example"]),
      models: [{ id: "code" }],
    },
  )

  expect(Object.keys(result.provider?.["company-llm"]?.models ?? {})).toEqual(["code"])
})

test("enterprise public config removes secret provider options without mutation", () => {
  const info = {
    provider: {
      "company-llm": {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: "https://llm.corp.example/v1",
          key: "provider-secret-key",
          apiKey: "secret-key",
          headers: { Authorization: "secret-header" },
        },
        models: {
          "company-code": {
            name: "Company Code",
            headers: { "X-Model-Token": "model-secret-header" },
            options: {
              temperature: 0,
              key: "model-secret-key",
              apiKey: "model-secret-key",
              headers: { Authorization: "model-secret" },
            },
          },
        },
      },
    },
  }
  const policy = {
    enabled: true,
    defaultsPath: undefined,
    allowedOrigins: new Set(["https://llm.corp.example"]),
  }
  const result = ConfigEnterprise.publicInfo(info, policy)

  expect(result.provider?.["company-llm"]?.options).toEqual({ baseURL: "https://llm.corp.example/v1" })
  expect(result.provider?.["company-llm"]?.models?.["company-code"]?.headers).toBeUndefined()
  expect(result.provider?.["company-llm"]?.models?.["company-code"]?.options).toEqual({ temperature: 0 })
  expect(info.provider["company-llm"].options.apiKey).toBe("secret-key")
  expect(info.provider["company-llm"].models["company-code"].headers).toEqual({
    "X-Model-Token": "model-secret-header",
  })
  expect(ConfigEnterprise.publicInfo(info, { ...policy, enabled: false })).toBe(info)
})

test("enterprise write sanitizer is non-mutating and leaves ordinary config untouched", () => {
  const info = {
    provider: {
      custom: {
        options: { baseURL: "https://example.com/v1", key: "secret", apiKey: "secret", timeout: 1_000 },
        models: {
          model: {
            headers: { Authorization: "secret" },
            options: { temperature: 0, key: "secret", apiKey: "secret", headers: { Authorization: "secret" } },
          },
        },
      },
    },
  }
  const policy = {
    enabled: true,
    defaultsPath: undefined,
    allowedOrigins: new Set<string>(),
  }

  expect(ConfigEnterprise.sanitizeWrite(info, policy)).toEqual({
    provider: {
      custom: {
        options: { baseURL: "https://example.com/v1", timeout: 1_000 },
        models: { model: { options: { temperature: 0 } } },
      },
    },
  })
  expect(info.provider.custom.options.apiKey).toBe("secret")
  expect(info.provider.custom.models.model.headers).toEqual({ Authorization: "secret" })
  expect(ConfigEnterprise.sanitizeWrite(info, { ...policy, enabled: false })).toBe(info)
})
