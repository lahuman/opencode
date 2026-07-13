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
