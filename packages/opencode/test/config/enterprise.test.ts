import { expect, test } from "bun:test"
import { ConfigEnterprise } from "@/config/enterprise"

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
