import { describe, expect, test } from "bun:test"
import {
  companyProviderCanStart,
  companyProviderConfig,
  companyProviderCredentialInput,
  companyProviderDiagnosticResult,
  companyProviderModels,
  companyProviderShouldRestart,
} from "./dialog-company-provider"
import { serverConnectionsForMode } from "./dialog-select-server"

describe("companyProviderCredentialInput", () => {
  test("trims secrets without placing them in provider config", () => {
    expect(companyProviderCredentialInput(" secret ", [{ key: " X-Token ", value: " value " }])).toEqual({
      apiKey: "secret",
      headers: { "X-Token": "value" },
    })
  })

  test("omits untouched credential kinds so main can preserve encrypted values", () => {
    expect(
      companyProviderCredentialInput("", [
        { key: "", value: "" },
        { key: "X-Key", value: "" },
        { key: "", value: "secret" },
      ]),
    ).toEqual({})
  })

  test("resolves duplicate header names case-insensitively with the last complete row", () => {
    expect(
      companyProviderCredentialInput("", [
        { key: " X-Token ", value: " first " },
        { key: "x-token", value: " second " },
        { key: "X-Other", value: " third " },
      ]),
    ).toEqual({
      headers: {
        "x-token": "second",
        "X-Other": "third",
      },
    })
  })
})

describe("company provider config", () => {
  test("reads configured company models", () => {
    expect(
      companyProviderModels({
        provider: { "company-llm": { models: { code: { name: "Company Code" } } } },
      }),
    ).toEqual([{ id: "code", name: "Company Code" }])
  })

  test("projects only public setup data from provider options", () => {
    const config = companyProviderConfig({
      provider: {
        "company-llm": {
          options: {
            baseURL: "https://llm.company.test/v1",
            apiKey: "must-not-escape",
            headers: { Authorization: "must-not-escape" },
          },
          models: { code: { name: "Company Code" }, fallback: {} },
        },
      },
    })

    expect(config).toEqual({
      baseURL: "https://llm.company.test/v1",
      models: [
        { id: "code", name: "Company Code" },
        { id: "fallback", name: "fallback" },
      ],
    })
    expect(JSON.stringify(config)).not.toContain("must-not-escape")
  })
})

describe("company provider operation state", () => {
  test("blocks missing prerequisites and double submission", () => {
    expect(companyProviderCanStart(undefined, true)).toBe(true)
    expect(companyProviderCanStart("diagnose", true)).toBe(false)
    expect(companyProviderCanStart(undefined, false)).toBe(false)
  })

  test("restarts only when the enterprise mutation requests it", () => {
    expect(companyProviderShouldRestart({ restartRequired: true })).toBe(true)
    expect(companyProviderShouldRestart({ restartRequired: false })).toBe(false)
    expect(companyProviderShouldRestart(undefined)).toBe(false)
  })

  test("creates a stable diagnostic result for network failures", () => {
    expect(companyProviderDiagnosticResult(undefined, "Request failed")).toEqual({
      ok: false,
      checks: { basic: "fail", streaming: "skipped", toolCall: "skipped" },
      failure: { kind: "connection", message: "Request failed" },
    })
  })
})

describe("serverConnectionsForMode", () => {
  const connections = [
    {
      displayName: "Local Server",
      type: "sidecar" as const,
      variant: "base" as const,
      http: { url: "http://127.0.0.1:4096" },
    },
    {
      displayName: "WSL",
      type: "sidecar" as const,
      variant: "wsl" as const,
      distro: "Ubuntu",
      http: { url: "http://127.0.0.1:4097" },
    },
    {
      displayName: "Remote",
      type: "http" as const,
      http: { url: "https://remote.example.test" },
    },
    {
      displayName: "SSH",
      type: "ssh" as const,
      host: "workstation",
      http: { url: "http://127.0.0.1:4098" },
    },
  ]

  test("returns only the built-in sidecar in enterprise mode", () => {
    expect(serverConnectionsForMode(true, connections)).toEqual([connections[0]])
  })

  test("preserves ordinary server choices", () => {
    expect(serverConnectionsForMode(false, connections)).toBe(connections)
  })
})
