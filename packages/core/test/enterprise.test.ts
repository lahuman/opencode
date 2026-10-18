import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Info } from "@opencode/schema/config"
import { Schema } from "effect"
import { Enterprise } from "../src/enterprise"

const names = [
  "OPENCODE_ENTERPRISE_PROVIDER_CATALOG",
  "OPENCODE_ENTERPRISE_ALLOWED_ORIGINS",
  "OPENCODE_ENTERPRISE_SKILL_PATHS",
] as const
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))

beforeEach(() => {
  process.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS = "https://llm.internal"
  process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG = JSON.stringify({
    schemaVersion: 1,
    default: { providerID: "company", modelID: "model" },
    providers: [
      { id: "company", name: "Company", baseURL: "https://llm.internal/v1", models: [{ id: "model", name: "Model" }] },
    ],
  })
  process.env.OPENCODE_ENTERPRISE_SKILL_PATHS = "[]"
})

afterEach(() => {
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name]
    else process.env[name] = previous[name]
  }
  Enterprise.setCredentials({ schemaVersion: 3, providers: {} })
})

describe("enterprise runtime policy", () => {
  test.each(["", "https://unrelated.internal"])(
    "accepts registered providers independently of the build origin list: %s",
    (origins) => {
      process.env.OPENCODE_ENTERPRISE_ALLOWED_ORIGINS = origins
      const policy = Enterprise.settings()
      expect(policy.catalog.providers[0]?.baseURL).toBe("https://llm.internal/v1")
      expect(() => Enterprise.requireURL("https://llm.internal/v1")).toThrow()
    },
  )

  test.each([
    ["https://llm.internal/v1", true],
    ["https://llm.internal.evil/v1", false],
    ["https://llm.internal:8443/v1", false],
    ["https://user:secret@llm.internal/v1", false],
    ["http://llm.internal/v1", false],
    ["file:///etc/passwd", false],
  ])("validates the exact allowed origin before network access: %s", (url, allowed) => {
    if (allowed) expect(Enterprise.requireURL(url).origin).toBe("https://llm.internal")
    else expect(() => Enterprise.requireURL(url)).toThrow()
  })

  test.each(["file:///etc/passwd", "https://user:secret@llm.internal/v1"])(
    "rejects invalid registered provider endpoints: %s",
    (baseURL) => {
      const catalog = JSON.parse(process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG!)
      catalog.providers[0].baseURL = baseURL
      process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG = JSON.stringify(catalog)
      expect(() => Enterprise.settings()).toThrow()
    },
  )

  test("rejects invalid defaults and duplicate providers instead of selecting a public fallback", () => {
    const catalog = JSON.parse(process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG!)
    catalog.default.modelID = "missing"
    process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG = JSON.stringify(catalog)
    expect(() => Enterprise.settings()).toThrow("Invalid enterprise default model")
    catalog.default.modelID = "model"
    catalog.providers.push(catalog.providers[0])
    process.env.OPENCODE_ENTERPRISE_PROVIDER_CATALOG = JSON.stringify(catalog)
    expect(() => Enterprise.settings()).toThrow("Duplicate enterprise provider ID")
  })

  test("keeps request credentials out of canonical public configuration", () => {
    const info = Schema.decodeUnknownSync(Info)({
      providers: {
        company: {
          settings: { baseURL: "https://llm.internal/v1", apiKey: "config-secret", timeout: 5000 },
          headers: { Authorization: "config-token" },
          models: { model: { settings: { apiKey: "model-secret" }, headers: { "x-key": "model-token" } } },
        },
      },
    })
    Enterprise.setCredentials({
      schemaVersion: 3,
      providers: { company: { apiKey: "stored-secret", headers: { "X-Gateway": "stored-token" } } },
    })
    const exposed = Enterprise.sanitize(info)
    expect(exposed.providers?.company.settings).toEqual({ baseURL: "https://llm.internal/v1", timeout: 5000 })
    expect(JSON.stringify(exposed)).not.toMatch(
      /config-secret|config-token|model-secret|model-token|stored-secret|stored-token/,
    )
    expect(Enterprise.requestHeaders("company")).toEqual({
      Authorization: "Bearer stored-secret",
      "X-Gateway": "stored-token",
    })
    expect(Enterprise.requestHeaders("other")).toEqual({})
  })
})
