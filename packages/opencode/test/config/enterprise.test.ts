import { expect, test } from "bun:test"
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
          options: { baseURL: "https://llm.corp.example/v1" },
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
})

test("materializes company provider metadata as structured defaults", () => {
  const result = ConfigEnterprise.materializeDefaults(
    { provider: { "company-llm": { models: {} } } },
    {
      enabled: true,
      defaultsPath: "C:/app/enterprise/opencode.jsonc",
      allowedOrigins: new Set(["https://llm.corp.example"]),
      baseURL: "https://llm.corp.example/v1",
      modelID: "company-code",
      modelName: "Company Code",
    },
  )
  expect(result.model).toBe("company-llm/company-code")
  expect(result.provider?.["company-llm"]?.options?.baseURL).toBe("https://llm.corp.example/v1")
  expect(result.provider?.["company-llm"]?.models?.["company-code"]?.name).toBe("Company Code")
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
