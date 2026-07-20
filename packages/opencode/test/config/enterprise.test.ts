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
      catalog: { schemaVersion: 1, providers: [] },
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
      catalog: {
        schemaVersion: 1,
        providers: [
          {
            id: "company",
            name: "Company",
            baseURL: "https://llm.corp.example/v1",
            models: [{ id: "default", name: "Default" }],
          },
        ],
      },
    },
  )
  expect(result.provider?.company?.models?.default?.provider?.npm).toBe("@ai-sdk/openai-compatible")
})

test("enterprise enforcement rebuilds registered providers from the runtime catalog", () => {
  const policy = {
    enabled: true,
    defaultsPath: undefined,
    guidePath: undefined,
    skillPaths: [],
    allowedOrigins: new Set<string>(),
    catalog: {
      schemaVersion: 1 as const,
      default: { providerID: "internal", modelID: "code" },
      providers: [
        {
          id: "internal",
          name: "Internal",
          baseURL: "https://arbitrary.example/v1",
          models: [{ id: "code", name: "Code" }],
        },
      ],
    },
  }
  const result = ConfigEnterprise.enforce(
    {
      provider: {
        internal: {
          npm: "other-package",
          options: { baseURL: "https://attacker.example/v1" },
          models: { code: { name: "Changed" } },
        },
        injected: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://injected.example/v1" },
          models: { model: {} },
        },
      },
    },
    policy,
  )

  expect(Object.keys(result.provider ?? {})).toEqual(["internal"])
  expect(result.provider?.internal.npm).toBe("@ai-sdk/openai-compatible")
  expect(result.provider?.internal.options?.baseURL).toBe("https://arbitrary.example/v1")
})

test("enterprise enforcement supplies the catalog default when merged config has no model", () => {
  const result = ConfigEnterprise.enforce(
    {},
    {
      enabled: true,
      defaultsPath: undefined,
      allowedOrigins: new Set<string>(),
      catalog: {
        schemaVersion: 1,
        default: { providerID: "internal", modelID: "code" },
        providers: [
          {
            id: "internal",
            name: "Internal",
            baseURL: "https://internal.example/v1",
            models: [{ id: "code", name: "Code" }],
          },
        ],
      },
    },
  )

  expect(result.model).toBe("internal/code")
})

test("enterprise enforcement replaces a stale project model with the catalog default", () => {
  const result = ConfigEnterprise.enforce(
    { model: "deleted/old" },
    {
      enabled: true,
      defaultsPath: undefined,
      allowedOrigins: new Set<string>(),
      catalog: {
        schemaVersion: 1,
        default: { providerID: "internal", modelID: "code" },
        providers: [
          {
            id: "internal",
            name: "Internal",
            baseURL: "https://internal.example/v1",
            models: [{ id: "code", name: "Code" }],
          },
        ],
      },
    },
  )

  expect(result.model).toBe("internal/code")
})

test("enterprise enforcement overwrites a registered provider's legacy API endpoint", () => {
  const result = ConfigEnterprise.enforce(
    {
      provider: {
        internal: {
          api: "https://attacker.example/v1",
          models: { code: {} },
        },
      },
    },
    {
      enabled: true,
      defaultsPath: undefined,
      allowedOrigins: new Set<string>(),
      catalog: {
        schemaVersion: 1,
        providers: [
          {
            id: "internal",
            name: "Internal",
            baseURL: "https://internal.example/v1",
            models: [{ id: "code", name: "Code" }],
          },
        ],
      },
    },
  )

  expect(result.provider?.internal.api).toBe("https://internal.example/v1")
  expect(result.provider?.internal.options?.baseURL).toBe("https://internal.example/v1")
})

test("enterprise enforcement overwrites a registered model's configured ID", () => {
  const result = ConfigEnterprise.enforce(
    {
      provider: {
        internal: {
          models: { code: { id: "attacker-model" } },
        },
      },
    },
    {
      enabled: true,
      defaultsPath: undefined,
      allowedOrigins: new Set<string>(),
      catalog: {
        schemaVersion: 1,
        providers: [
          {
            id: "internal",
            name: "Internal",
            baseURL: "https://internal.example/v1",
            models: [{ id: "code", name: "Code" }],
          },
        ],
      },
    },
  )

  expect(result.provider?.internal.models?.code?.id).toBe("code")
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
      catalog: {
        schemaVersion: 1,
        providers: [
          {
            id: "company",
            name: "Company",
            baseURL: "https://llm.corp.example/v1",
            models: [{ id: "default", name: "Default" }],
          },
        ],
      },
    },
  )
  expect(result.provider?.company?.env).toEqual([])
  expect(result.provider?.company?.options).toEqual({ baseURL: "https://llm.corp.example/v1" })
  expect(result.provider?.company?.models?.default?.headers).toBeUndefined()
  expect(result.provider?.company?.models?.default?.options).toEqual({})
})

test("materializes runtime provider catalog metadata as structured defaults", () => {
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
      catalog: {
        schemaVersion: 1,
        default: { providerID: "company-llm", modelID: "company-code" },
        providers: [
          {
            id: "company-llm",
            name: "Company LLM",
            baseURL: "https://llm.corp.example/v1",
            models: [
              { id: "company-code", name: "Company Code" },
              { id: "company-fast", name: "Company Fast" },
            ],
          },
        ],
      },
      skillPaths: ["C:/app/enterprise/skill-packs/ponytail/skills"],
    },
  )
  expect(result.model).toBe("company-llm/company-code")
  expect(result.provider?.["company-llm"]?.models?.["company-code"]?.name).toBe("Company Code")
  expect(result.provider?.["company-llm"]?.models?.["company-fast"]?.name).toBe("Company Fast")
  expect(result.provider?.["company-llm"]?.options?.baseURL).toBe("https://llm.corp.example/v1")
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
      catalog: { schemaVersion: 1, providers: [] },
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

test("loads the runtime provider catalog and default only in enterprise mode", () => {
  const catalog = {
    schemaVersion: 1,
    default: { providerID: "internal", modelID: "code" },
    providers: [
      {
        id: "internal",
        name: "Internal",
        baseURL: "https://internal.example/v1",
        models: [{ id: "code", name: "Code" }],
      },
    ],
  }
  using runtimeCatalog = environment("OPENCODE_ENTERPRISE_PROVIDER_CATALOG", JSON.stringify(catalog))

  expect(ConfigEnterprise.settings()).toMatchObject({
    enabled: false,
    catalog: { schemaVersion: 1, providers: [] },
    defaultModel: undefined,
  })
  using offline = environment("OPENCODE_ENTERPRISE_OFFLINE", "1")
  expect(ConfigEnterprise.settings()).toMatchObject({
    enabled: true,
    catalog,
    defaultModel: "internal/code",
  })
})

test("enterprise enforcement overwrites configured model identity and endpoint", () => {
  const policy = {
    enabled: true,
    defaultsPath: undefined,
    allowedOrigins: new Set<string>(),
    catalog: {
      schemaVersion: 1 as const,
      providers: [
        {
          id: "company-llm",
          name: "Company",
          baseURL: "https://code.corp.example/v1",
          models: [{ id: "code", name: "Code" }],
        },
      ],
    },
  }
  const provider = {
    "company-llm": {
      npm: "untrusted-sdk",
      models: {
        code: {
          name: "Changed",
          provider: { npm: "untrusted-sdk", api: "https://unapproved.example/v1" },
          limit: { context: 123, output: 456 },
        },
      },
    },
  }

  const result = ConfigEnterprise.enforce({ provider }, policy)
  expect(result.provider?.["company-llm"]?.models?.code).toMatchObject({
    name: "Code",
    provider: { npm: "@ai-sdk/openai-compatible", api: "https://code.corp.example/v1" },
    limit: { context: 123 },
  })
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

test("enterprise enforcement disables every provider for an empty catalog", () => {
  const result = ConfigEnterprise.enforce(
    {
      provider: {
        injected: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://injected.example/v1" },
          models: { model: {} },
        },
      },
    },
    {
      enabled: true,
      defaultsPath: undefined,
      allowedOrigins: new Set<string>(),
      catalog: { schemaVersion: 1, providers: [] },
    },
  )

  expect(result.provider).toEqual({})
  expect(result.enabled_providers).toEqual([])
  expect(result.share).toBe("disabled")
  expect(result.autoupdate).toBe(false)
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
      catalog: {
        schemaVersion: 1,
        providers: [
          {
            id: "company-llm",
            name: "Company",
            baseURL: "https://code.corp.example/v1",
            models: [{ id: "code", name: "Code" }],
          },
        ],
      },
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
